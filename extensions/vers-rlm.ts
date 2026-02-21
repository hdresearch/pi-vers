/**
 * Vers RLM Extension
 *
 * Provides a single tool — `vers_rlm_run` — that spins up a Vers VM,
 * bootstraps pi inside it, feeds it a prompt, and waits for the inner
 * agent to finish.  The VM is kept alive after completion so the
 * orchestrating (manager) agent can copy files back.
 *
 * Flow:
 *   1. Manager calls `vers_rlm_run` with a prompt string.
 *   2. The tool creates a fresh VM, installs Node + pi, copies the
 *      trailing-newline write extension in, writes ~/prompt.txt, and
 *      launches pi in RPC mode with a system prompt that tells the
 *      inner agent to:
 *        a) Read ~/prompt.txt
 *        b) Do the work
 *        c) Write the result description to ~/vers_final.txt
 *   3. The tool polls ~/vers_final.txt on the VM until it appears
 *      (or the inner agent_end event fires).
 *   4. Returns the contents of ~/vers_final.txt to the manager.
 *      The VM stays running — the manager uses `vers_vm_copy` to
 *      pull artifacts, then `vers_vm_delete` when done.
 *
 * Environment variables inherited into the VM:
 *   ANTHROPIC_API_KEY  (required — used by pi inside the VM)
 *
 * The inner pi agent gets only: read, bash, edit, write (with the
 * trailing-newline write override so files are POSIX-conformant).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execFile, spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// =============================================================================
// Minimal Vers API Client (just what RLM needs)
// =============================================================================

const DEFAULT_BASE_URL = "https://api.vers.sh/api/v1";

function loadVersKeyFromDisk(): string {
	const homedir = process.env.HOME || process.env.USERPROFILE || "";
	try {
		const data = require("fs").readFileSync(join(homedir, ".vers", "keys.json"), "utf-8");
		const key = JSON.parse(data)?.keys?.VERS_API_KEY || "";
		if (key) return key;
	} catch {}
	try {
		const data = require("fs").readFileSync(join(homedir, ".vers", "config.json"), "utf-8");
		const parsed = JSON.parse(data);
		return parsed?.versApiKey || parsed?.api_key || "";
	} catch {}
	return "";
}

function resolveApiKey(explicit?: string): string {
	return explicit || process.env.VERS_API_KEY || loadVersKeyFromDisk() || "";
}

function resolveBaseUrl(): string {
	return (process.env.VERS_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
}

async function versApi<T>(method: string, path: string, body?: unknown): Promise<T> {
	const url = `${resolveBaseUrl()}${path}`;
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"Authorization": `Bearer ${resolveApiKey()}`,
	};
	const res = await fetch(url, {
		method,
		headers,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`Vers API ${method} ${path} (${res.status}): ${text}`);
	}
	const ct = res.headers.get("content-type") || "";
	if (ct.includes("application/json")) return res.json() as Promise<T>;
	return undefined as T;
}

// =============================================================================
// SSH helpers
// =============================================================================

interface SSHKeyInfo { ssh_port: number; ssh_private_key: string }

const keyFileCache = new Map<string, string>();

async function ensureKeyFile(vmId: string): Promise<string> {
	const existing = keyFileCache.get(vmId);
	if (existing) return existing;
	const info = await versApi<SSHKeyInfo>("GET", `/vm/${encodeURIComponent(vmId)}/ssh_key`);
	const keyDir = join(tmpdir(), "vers-ssh-keys");
	await mkdir(keyDir, { recursive: true });
	const keyPath = join(keyDir, `vers-rlm-${vmId.slice(0, 12)}.pem`);
	await writeFile(keyPath, info.ssh_private_key, { mode: 0o600 });
	keyFileCache.set(vmId, keyPath);
	return keyPath;
}

function sshBaseArgs(keyPath: string, vmId: string): string[] {
	const hostname = `${vmId}.vm.vers.sh`;
	return [
		"-i", keyPath,
		"-o", "StrictHostKeyChecking=no",
		"-o", "UserKnownHostsFile=/dev/null",
		"-o", "LogLevel=ERROR",
		"-o", "ConnectTimeout=30",
		"-o", `ProxyCommand=openssl s_client -connect ${hostname}:443 -servername ${hostname} -quiet 2>/dev/null`,
		`root@${hostname}`,
	];
}

function sshExec(keyPath: string, vmId: string, command: string, timeoutMs = 300_000): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return new Promise((resolve, reject) => {
		execFile("ssh", [...sshBaseArgs(keyPath, vmId), command], {
			maxBuffer: 10 * 1024 * 1024,
			timeout: timeoutMs,
		}, (err, stdout, stderr) => {
			if (err && typeof (err as any).code === "string" && (err as any).code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
				if (!(err as any).killed && (err as any).signal == null && stdout === "" && stderr === "") {
					reject(new Error(`SSH exec failed: ${err.message}`));
					return;
				}
			}
			const exitCode = (err as any)?.status ?? (err ? 1 : 0);
			resolve({ stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "", exitCode });
		});
	});
}

/** Write content to a file on the VM via stdin pipe (no shell escaping needed) */
function sshWriteFile(keyPath: string, vmId: string, remotePath: string, content: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("ssh", [
			...sshBaseArgs(keyPath, vmId),
			`mkdir -p "$(dirname '${remotePath}')" && cat > '${remotePath}'`,
		], { stdio: ["pipe", "pipe", "pipe"] });
		let stderr = "";
		child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) reject(new Error(`sshWriteFile ${remotePath} failed (${code}): ${stderr}`));
			else resolve();
		});
		child.stdin!.end(content);
	});
}

// =============================================================================
// Trailing-newline write extension source (copied into each VM)
// =============================================================================

// Using an array of lines joined at runtime avoids template-literal-in-
// template-literal escaping nightmares.
const TRAILING_NEWLINE_EXTENSION = [
	'import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";',
	'import { Type } from "@sinclair/typebox";',
	'import { mkdir, writeFile } from "node:fs/promises";',
	'import { dirname, resolve, isAbsolute } from "node:path";',
	'',
	'export default function (pi: ExtensionAPI) {',
	'  pi.registerTool({',
	'    name: "write",',
	'    label: "write",',
	'    description:',
	'      "Write content to a file. Creates the file if it doesn\'t exist, overwrites if it does. Automatically creates parent directories.",',
	'    parameters: Type.Object({',
	'      path: Type.String({ description: "Path to the file to write (relative or absolute)" }),',
	'      content: Type.String({ description: "Content to write to the file" }),',
	'    }),',
	'    async execute(toolCallId, params, signal, onUpdate, ctx) {',
	'      if (signal?.aborted) {',
	'        return { content: [{ type: "text" as const, text: "Operation aborted" }] };',
	'      }',
	'      let { path, content } = params;',
	'      if (path.startsWith("@")) path = path.slice(1);',
	'      if (content.length > 0 && !content.endsWith("\\n")) {',
	'        content = content + "\\n";',
	'      }',
	'      const absolutePath = isAbsolute(path) ? path : resolve(ctx.cwd, path);',
	'      const dir = dirname(absolutePath);',
	'      try {',
	'        await mkdir(dir, { recursive: true });',
	'        if (signal?.aborted) {',
	'          return { content: [{ type: "text" as const, text: "Operation aborted" }] };',
	'        }',
	'        await writeFile(absolutePath, content, "utf-8");',
	'        return {',
	'          content: [{ type: "text" as const, text: "Successfully wrote " + content.length + " bytes to " + path }],',
	'          details: undefined,',
	'        };',
	'      } catch (error: any) {',
	'        return {',
	'          content: [{ type: "text" as const, text: "Error writing file: " + error.message }],',
	'          details: { error: true },',
	'        };',
	'      }',
	'    },',
	'  });',
	'}',
].join("\n");

// =============================================================================
// Inner-agent system prompt (written to a file on the VM, not shell-escaped)
// =============================================================================

const INNER_SYSTEM_PROMPT = [
	"You are a coding agent running inside a Vers VM. Your job:",
	"",
	"1. Read ~/prompt.txt to see your task.",
	"2. Complete the task using the tools available to you (read, bash, edit, write).",
	"3. When you are COMPLETELY done, write a short instruction to ~/vers_final.txt",
	"   telling the manager agent what to copy back. The format is a short message",
	"   describing what files to retrieve. For example:",
	'     "Copy /root/hello.txt"',
	"   or:",
	'     "Copy /root/workspace/output/ (directory)"',
	"",
	"IMPORTANT:",
	"- ~/vers_final.txt is the ONLY channel back to the manager. Write it LAST.",
	"- Do NOT write to ~/vers_final.txt until all work is finished.",
	"- The manager will use vers_vm_copy to pull the files you mention.",
	"- Work in /root/ or /root/workspace/.",
].join("\n");

// =============================================================================
// Bootstrap script for a fresh Vers VM
// =============================================================================

const BOOTSTRAP_SCRIPT = `#!/bin/bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

# System deps (tmux needed for RPC daemon)
apt-get update -qq
apt-get install -y -qq curl git openssh-client tmux > /dev/null 2>&1

# Node.js via nvm
if ! command -v node &>/dev/null; then
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh 2>/dev/null | bash > /dev/null 2>&1
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  nvm install 22 > /dev/null 2>&1
fi

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

echo "node: $(node --version)"

# pi coding agent
npm install -g @mariozechner/pi-coding-agent > /dev/null 2>&1
echo "pi: $(pi --version)"

# Workspace
mkdir -p /root/workspace

echo "bootstrap_done"
`;

// =============================================================================
// RPC launch + event loop (modelled on pi-rpc-run.py, but driven from TS)
// =============================================================================

interface RpcResult {
	agentOutput: string;
	finalTxt: string;
	vmId: string;
}

async function runPiRpc(
	keyPath: string,
	vmId: string,
	prompt: string,
	anthropicApiKey: string,
	signal?: AbortSignal,
): Promise<RpcResult> {
	// Write the system prompt to a file on the VM — avoids shell escaping entirely
	await sshWriteFile(keyPath, vmId, "/root/.rlm/system-prompt.txt", INNER_SYSTEM_PROMPT);

	// Write a launcher script that sources nvm, sets env vars, and starts pi.
	// This avoids quoting hell with tmux send-keys / new-session commands.
	// The system prompt is read into a variable so we don't have to worry
	// about embedded quotes breaking a "$(cat ...)" expansion.
	const launcherScript = [
		"#!/bin/bash",
		"set -e",
		'export NVM_DIR="$HOME/.nvm"',
		'[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"',
		`export ANTHROPIC_API_KEY='${anthropicApiKey}'`,
		"export GIT_EDITOR=true",
		"cd /root",
		'SYSPROMPT=$(cat /root/.rlm/system-prompt.txt)',
		'exec pi \\',
		'  --mode rpc \\',
		'  --no-session \\',
		'  --no-extensions \\',
		'  --no-skills \\',
		'  --no-prompt-templates \\',
		'  --no-themes \\',
		'  --provider anthropic \\',
		'  --model claude-sonnet-4-20250514 \\',
		'  --tools read,bash,edit,write \\',
		'  -e /root/.rlm/trailing-newline.ts \\',
		'  --system-prompt "$SYSPROMPT"',
	].join("\n");
	await sshWriteFile(keyPath, vmId, "/root/.rlm/launch-pi.sh", launcherScript);
	await sshExec(keyPath, vmId, "chmod +x /root/.rlm/launch-pi.sh", 10_000);

	// Start pi inside tmux so it survives SSH drops
	const RPC_DIR = "/tmp/pi-rlm";
	const RPC_IN = `${RPC_DIR}/in`;
	const RPC_OUT = `${RPC_DIR}/out`;
	const RPC_ERR = `${RPC_DIR}/err`;

	const startScript = [
		"set -e",
		`mkdir -p ${RPC_DIR}`,
		`rm -f ${RPC_IN} ${RPC_OUT} ${RPC_ERR}`,
		`mkfifo ${RPC_IN}`,
		`touch ${RPC_OUT} ${RPC_ERR}`,
		"",
		"# Keeper holds the FIFO open so pi never gets EOF",
		`tmux new-session -d -s rlm-keeper "sleep infinity > ${RPC_IN}"`,
		"",
		"# Start pi via the launcher script, reading from FIFO",
		`tmux new-session -d -s rlm-pi "bash /root/.rlm/launch-pi.sh < ${RPC_IN} >> ${RPC_OUT} 2>> ${RPC_ERR}"`,
		"",
		"sleep 2",
		'tmux has-session -t rlm-pi 2>/dev/null && echo "rlm_started" || echo "rlm_failed"',
	].join("\n");

	const startResult = await sshExec(keyPath, vmId, startScript, 60_000);
	if (!startResult.stdout.includes("rlm_started")) {
		// Grab stderr from the RPC log for diagnostics
		const errLog = await sshExec(keyPath, vmId, `cat ${RPC_ERR} 2>/dev/null || true`).catch(() => ({ stdout: "" }));
		throw new Error(
			`Failed to start pi RPC on VM ${vmId}:\n` +
			`stdout: ${startResult.stdout}\nstderr: ${startResult.stderr}\n` +
			`pi stderr: ${(errLog as any).stdout || ""}`
		);
	}

	// Wait for pi to be ready — send get_state probes
	const ready = await waitForRpcReady(keyPath, vmId, RPC_IN, RPC_OUT, 45_000);
	if (!ready) {
		const errLog = await sshExec(keyPath, vmId, `cat ${RPC_ERR} 2>/dev/null || true`).catch(() => ({ stdout: "" }));
		throw new Error(`pi RPC on VM ${vmId} did not become ready within 45s. pi stderr:\n${(errLog as any).stdout || "(empty)"}`);
	}

	// Send the prompt
	const promptJson = JSON.stringify({ type: "prompt", message: `Read ~/prompt.txt and complete the task described there.` }) + "\n";
	await sshWriteToFifo(keyPath, vmId, RPC_IN, promptJson);

	// Tail the RPC output and wait for agent_end or vers_final.txt to appear
	return await waitForCompletion(keyPath, vmId, RPC_OUT, RPC_ERR, signal);
}

async function waitForRpcReady(keyPath: string, vmId: string, fifoPath: string, outPath: string, timeoutMs: number): Promise<boolean> {
	const start = Date.now();
	let attempts = 0;
	while (Date.now() - start < timeoutMs) {
		attempts++;
		// Send a get_state probe
		try {
			await sshWriteToFifo(keyPath, vmId, fifoPath, JSON.stringify({ id: `probe-${attempts}`, type: "get_state" }) + "\n");
		} catch {
			// FIFO not ready yet
		}

		await sleep(3000);

		// Check if we got a response
		try {
			const tail = await sshExec(keyPath, vmId, `tail -20 ${outPath} 2>/dev/null || true`, 10_000);
			if (tail.stdout.includes('"get_state"') || tail.stdout.includes('"response"')) {
				return true;
			}
		} catch { /* not ready */ }
	}
	return false;
}

function sshWriteToFifo(keyPath: string, vmId: string, fifoPath: string, content: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("ssh", [
			...sshBaseArgs(keyPath, vmId),
			`cat > ${fifoPath}`,
		], { stdio: ["pipe", "pipe", "pipe"] });
		let stderr = "";
		child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) reject(new Error(`Write to FIFO failed (${code}): ${stderr}`));
			else resolve();
		});
		child.stdin!.end(content);
	});
}

async function waitForCompletion(
	keyPath: string,
	vmId: string,
	outPath: string,
	errPath: string,
	signal?: AbortSignal,
): Promise<RpcResult> {
	const MAX_WAIT_MS = 10 * 60 * 1000; // 10 minutes
	const POLL_INTERVAL_MS = 5_000;
	const start = Date.now();

	let agentOutput = "";
	let lastLineCount = 0;

	while (Date.now() - start < MAX_WAIT_MS) {
		if (signal?.aborted) throw new Error("Aborted");

		await sleep(POLL_INTERVAL_MS);

		// Read new lines from the RPC output
		try {
			const wcResult = await sshExec(keyPath, vmId, `wc -l < ${outPath} 2>/dev/null || echo 0`, 10_000);
			const totalLines = parseInt(wcResult.stdout.trim(), 10) || 0;
			if (totalLines > lastLineCount) {
				const startLine = lastLineCount + 1;
				const newLines = await sshExec(keyPath, vmId, `sed -n '${startLine},${totalLines}p' ${outPath}`, 10_000);
				lastLineCount = totalLines;

				// Parse events — collect text output and detect agent_end
				for (const line of newLines.stdout.split("\n")) {
					if (!line.trim()) continue;
					try {
						const event = JSON.parse(line);
						if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
							agentOutput += event.assistantMessageEvent.delta;
						}
						if (event.type === "agent_end") {
							// Agent finished — now check for vers_final.txt
							const finalTxt = await pollForFinalTxt(keyPath, vmId, 15_000);
							return { agentOutput, finalTxt, vmId };
						}
					} catch { /* not JSON */ }
				}
			}
		} catch {
			// SSH blip — keep polling
		}

		// Also check if vers_final.txt appeared already (belt and suspenders)
		try {
			const check = await sshExec(keyPath, vmId, `test -f /root/vers_final.txt && cat /root/vers_final.txt`, 10_000);
			if (check.exitCode === 0 && check.stdout.trim().length > 0) {
				return { agentOutput, finalTxt: check.stdout.trim(), vmId };
			}
		} catch { /* not ready yet */ }
	}

	// Timed out — check if vers_final.txt exists anyway
	try {
		const check = await sshExec(keyPath, vmId, `cat /root/vers_final.txt 2>/dev/null || true`, 10_000);
		if (check.stdout.trim()) {
			return { agentOutput, finalTxt: check.stdout.trim(), vmId };
		}
	} catch {}

	// Get pi stderr for diagnostics
	let piStderr = "";
	try {
		const errLog = await sshExec(keyPath, vmId, `tail -50 ${errPath} 2>/dev/null || true`, 10_000);
		piStderr = errLog.stdout;
	} catch {}

	throw new Error(
		`RLM agent on VM ${vmId} timed out after ${MAX_WAIT_MS / 1000}s without completing.\n` +
		`Agent output so far:\n${agentOutput.slice(-2000)}\n` +
		`pi stderr (tail):\n${piStderr.slice(-1000)}`
	);
}

async function pollForFinalTxt(keyPath: string, vmId: string, timeoutMs: number): Promise<string> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const check = await sshExec(keyPath, vmId, `test -f /root/vers_final.txt && cat /root/vers_final.txt`, 10_000);
			if (check.exitCode === 0 && check.stdout.trim().length > 0) {
				return check.stdout.trim();
			}
		} catch {}
		await sleep(2000);
	}
	return "(vers_final.txt not found — agent may not have written it)";
}

function sleep(ms: number): Promise<void> {
	return new Promise(r => setTimeout(r, ms));
}

// =============================================================================
// Extension
// =============================================================================

export default function versRlmExtension(pi: ExtensionAPI) {
	// Track active RLM VMs so the manager can list / clean them up
	const activeVms = new Map<string, { vmId: string; prompt: string; finalTxt: string; status: "running" | "done" | "error" }>();

	pi.registerTool({
		name: "vers_rlm_run",
		label: "Run task in Vers RLM",
		description:
			"Spin up a fresh Vers VM with a pi agent inside it, give it a task, " +
			"and wait for it to finish. Returns the agent's final message (from " +
			"~/vers_final.txt) which typically says what files to copy back. " +
			"The VM stays alive after completion — use vers_vm_copy to retrieve " +
			"files and vers_vm_delete to clean up.\n\n" +
			"Example: vers_rlm_run(prompt='Create /root/hello.txt containing \"Hello, world!\"') " +
			"→ returns something like 'Copy /root/hello.txt' and the VM ID.",
		parameters: Type.Object({
			prompt: Type.String({ description: "The task instruction for the inner agent" }),
			vcpu_count: Type.Optional(Type.Number({ description: "vCPUs (default: 2)" })),
			mem_size_mib: Type.Optional(Type.Number({ description: "RAM in MiB (default: 2048)" })),
			fs_size_mib: Type.Optional(Type.Number({ description: "Disk in MiB (default: 4096)" })),
		}),
		async execute(_id, params, signal, onUpdate) {
			const {
				prompt,
				vcpu_count = 2,
				mem_size_mib = 2048,
				fs_size_mib = 4096,
			} = params as {
				prompt: string;
				vcpu_count?: number;
				mem_size_mib?: number;
				fs_size_mib?: number;
			};

			const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
			if (!anthropicApiKey) {
				throw new Error("ANTHROPIC_API_KEY environment variable is required for RLM VMs");
			}

			const notify = (text: string) => {
				if (onUpdate) onUpdate({ content: [{ type: "text", text }], details: {} });
			};

			// --- Step 1: Create VM ---
			notify("Creating Vers VM...");
			const vm = await versApi<{ vm_id: string }>("POST", "/vm/new_root?wait_boot=true", {
				vm_config: { vcpu_count, mem_size_mib, fs_size_mib },
			});
			const vmId = vm.vm_id;
			activeVms.set(vmId, { vmId, prompt, finalTxt: "", status: "running" });

			notify(`VM ${vmId.slice(0, 12)} created. Waiting for SSH...`);

			// --- Step 2: Wait for SSH ---
			const keyPath = await ensureKeyFile(vmId);
			let sshReady = false;
			for (let i = 0; i < 30; i++) {
				try {
					const check = await sshExec(keyPath, vmId, "echo ready", 15_000);
					if (check.stdout.trim() === "ready") { sshReady = true; break; }
				} catch {}
				await sleep(2000);
			}
			if (!sshReady) {
				activeVms.set(vmId, { vmId, prompt, finalTxt: "", status: "error" });
				throw new Error(`VM ${vmId} created but SSH unreachable after 60s`);
			}

			notify(`VM ${vmId.slice(0, 12)} SSH ready. Bootstrapping Node + pi...`);

			// --- Step 3: Bootstrap the VM ---
			await sshWriteFile(keyPath, vmId, "/root/bootstrap.sh", BOOTSTRAP_SCRIPT);
			const bootstrap = await sshExec(keyPath, vmId, "bash /root/bootstrap.sh", 180_000);
			if (!bootstrap.stdout.includes("bootstrap_done")) {
				activeVms.set(vmId, { vmId, prompt, finalTxt: "", status: "error" });
				throw new Error(`Bootstrap failed on VM ${vmId}:\nstdout: ${bootstrap.stdout}\nstderr: ${bootstrap.stderr}`);
			}

			notify(`VM ${vmId.slice(0, 12)} bootstrapped. Writing prompt + extension...`);

			// --- Step 4: Write prompt.txt and trailing-newline extension ---
			await sshWriteFile(keyPath, vmId, "/root/prompt.txt", prompt);
			await sshExec(keyPath, vmId, "mkdir -p /root/.rlm");
			await sshWriteFile(keyPath, vmId, "/root/.rlm/trailing-newline.ts", TRAILING_NEWLINE_EXTENSION);

			notify(`VM ${vmId.slice(0, 12)} ready. Launching pi agent...`);

			// --- Step 5: Run pi RPC ---
			try {
				const result = await runPiRpc(keyPath, vmId, prompt, anthropicApiKey, signal);
				activeVms.set(vmId, { vmId, prompt, finalTxt: result.finalTxt, status: "done" });

				return {
					content: [{
						type: "text",
						text:
							`RLM agent finished on VM ${vmId.slice(0, 12)}.\n\n` +
							`VM ID (full): ${vmId}\n\n` +
							`--- vers_final.txt ---\n${result.finalTxt}\n---\n\n` +
							`The VM is still running. Use vers_vm_copy to retrieve files, ` +
							`then vers_vm_delete to clean up.`,
					}],
					details: { vmId, finalTxt: result.finalTxt },
				};
			} catch (err) {
				activeVms.set(vmId, { vmId, prompt, finalTxt: "", status: "error" });
				throw new Error(
					`RLM agent failed on VM ${vmId}:\n${err instanceof Error ? err.message : String(err)}\n\n` +
					`The VM is still running (not deleted). You can SSH in for debugging ` +
					`or delete it with vers_vm_delete.`
				);
			}
		},
	});

	// --- vers_vm_delete: clean up VMs after copying files back ---
	pi.registerTool({
		name: "vers_vm_delete",
		label: "Delete Vers VM",
		description: "Delete a Vers VM by ID. Use after vers_vm_copy to clean up RLM VMs.",
		parameters: Type.Object({
			vmId: Type.String({ description: "VM ID to delete" }),
		}),
		async execute(_id, params) {
			const { vmId } = params as { vmId: string };
			const result = await versApi<{ vm_id: string }>("DELETE", `/vm/${encodeURIComponent(vmId)}`);
			activeVms.delete(vmId);
			return {
				content: [{ type: "text", text: `VM ${result.vm_id} deleted.` }],
				details: result,
			};
		},
	});

	// --- vers_rlm_list: see active RLM VMs ---
	pi.registerTool({
		name: "vers_rlm_list",
		label: "List RLM VMs",
		description: "List all VMs created by vers_rlm_run in this session, with their status and final output.",
		parameters: Type.Object({}),
		async execute() {
			if (activeVms.size === 0) {
				return { content: [{ type: "text", text: "No RLM VMs in this session." }], details: {} };
			}
			const lines: string[] = [];
			for (const [vmId, info] of activeVms) {
				lines.push(`  ${vmId.slice(0, 12)} [${info.status}] — ${info.prompt.slice(0, 80)}`);
				if (info.finalTxt) lines.push(`    → ${info.finalTxt.slice(0, 120)}`);
			}
			return {
				content: [{ type: "text", text: `RLM VMs (${activeVms.size}):\n${lines.join("\n")}` }],
				details: { vms: Array.from(activeVms.values()) },
			};
		},
	});
}
