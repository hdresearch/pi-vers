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
 *      trailing-newline write extension in, writes /root/prompt.txt, and
 *      launches pi in RPC mode with a system prompt that tells the
 *      inner agent to:
 *        a) Read /root/prompt.txt
 *        b) Do the work
 *        c) Write the result description to ~/vers_final.txt
 *   3. The tool streams the RPC output via `tail -f` over SSH and
 *      detects agent_end in real time (no polling).
 *   4. Returns the contents of ~/vers_final.txt to the manager.
 *      The VM stays running — the manager uses `vers_vm_copy` to
 *      pull artifacts, then `vers_vm_delete` when done.
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY       (required — used by pi inside the VM)
 *   VERS_RLM_GOLDEN_COMMIT  (optional — commit ID of a pre-built golden
 *                            image with Node + pi already installed. When
 *                            set, vers_rlm_run restores from this snapshot
 *                            instead of creating a fresh VM + bootstrapping,
 *                            saving ~40-50s per call.)
 *
 * Performance features:
 *   - Golden-ready sentinel: when the golden image has /root/.rlm/.golden-ready,
 *     static files (trailing-newline.ts, system-prompt.txt, launch-pi.sh) are
 *     already baked in — only prompt.txt and the API key need to be written.
 *   - SSH streaming: tail -f for real-time event detection (no polling)
 *     with automatic reconnect on SSH drops.
 *
 * The inner pi agent gets only: read, bash, edit, write (with the
 * trailing-newline write override so files are POSIX-conformant).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execFile, spawn } from "node:child_process";
import { writeFile, mkdir, readFile, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename, relative } from "node:path";

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

/** Upload a local file to the VM (binary-safe, via stdin pipe) */
function sshUploadFile(keyPath: string, vmId: string, localPath: string, remotePath: string): Promise<void> {
	return new Promise(async (resolve, reject) => {
		let content: Buffer;
		try {
			content = await readFile(localPath);
		} catch (err: any) {
			reject(new Error(`Failed to read local file ${localPath}: ${err.message}`));
			return;
		}
		const child = spawn("ssh", [
			...sshBaseArgs(keyPath, vmId),
			`mkdir -p "$(dirname '${remotePath}')" && cat > '${remotePath}'`,
		], { stdio: ["pipe", "pipe", "pipe"] });
		let stderr = "";
		child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) reject(new Error(`sshUploadFile ${localPath} → ${remotePath} failed (${code}): ${stderr}`));
			else resolve();
		});
		child.stdin!.end(content);
	});
}

/**
 * Recursively upload a local directory to a remote path on the VM.
 * Uses tar over SSH for efficiency.
 */
function sshUploadDirectory(keyPath: string, vmId: string, localDir: string, remoteDir: string): Promise<void> {
	return new Promise((resolve, reject) => {
		// Use tar to stream the directory contents over SSH
		const tarChild = spawn("tar", ["-cf", "-", "-C", localDir, "."], {
			stdio: ["ignore", "pipe", "pipe"],
		});

		const sshChild = spawn("ssh", [
			...sshBaseArgs(keyPath, vmId),
			`mkdir -p '${remoteDir}' && tar -xf - -C '${remoteDir}'`,
		], { stdio: ["pipe", "pipe", "pipe"] });

		let tarStderr = "";
		let sshStderr = "";
		tarChild.stderr?.on("data", (d: Buffer) => { tarStderr += d.toString(); });
		sshChild.stderr?.on("data", (d: Buffer) => { sshStderr += d.toString(); });

		tarChild.stdout!.pipe(sshChild.stdin!);

		let tarDone = false;
		let sshDone = false;
		let tarCode = 0;
		let sshCode = 0;
		let finished = false;

		function checkDone() {
			if (finished || !tarDone || !sshDone) return;
			finished = true;
			if (sshCode !== 0) {
				reject(new Error(`sshUploadDirectory ${localDir} → ${remoteDir} SSH failed (${sshCode}): ${sshStderr}`));
			} else if (tarCode !== 0) {
				reject(new Error(`sshUploadDirectory ${localDir} → ${remoteDir} tar failed (${tarCode}): ${tarStderr}`));
			} else {
				resolve();
			}
		}

		tarChild.on("error", (err) => { if (!finished) { finished = true; reject(err); } });
		sshChild.on("error", (err) => { if (!finished) { finished = true; reject(err); } });
		tarChild.on("close", (code) => { tarCode = code ?? 0; tarDone = true; checkDone(); });
		sshChild.on("close", (code) => { sshCode = code ?? 0; sshDone = true; checkDone(); });
	});
}

/**
 * Upload volumes to the VM.
 * volumes is a dict mapping host_path → vm_path (like Docker -v syntax).
 * If host_path is a directory, recursively copies its contents.
 * If host_path is a file, copies it to the vm_path.
 */
async function uploadVolumes(
	keyPath: string,
	vmId: string,
	volumes: Record<string, string>,
	notify: (text: string) => void,
): Promise<void> {
	const entries = Object.entries(volumes);
	if (entries.length === 0) return;

	notify(`Uploading ${entries.length} volume(s) to VM...`);

	for (const [hostPath, vmPath] of entries) {
		let st;
		try {
			st = await stat(hostPath);
		} catch (err: any) {
			throw new Error(`Volume mount failed: local path ${hostPath} does not exist: ${err.message}`);
		}

		if (st.isDirectory()) {
			await sshUploadDirectory(keyPath, vmId, hostPath, vmPath);
		} else {
			await sshUploadFile(keyPath, vmId, hostPath, vmPath);
		}
	}

	notify(`Uploaded ${entries.length} volume(s) to VM.`);
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
	"1. Read /root/prompt.txt to see your task.",
	"2. Complete the task using the tools available to you (read, bash, edit, write).",
	"3. When you are COMPLETELY done, write a short instruction to /root/vers_final.txt",
	"   telling the manager agent what to copy back. The format is a short message",
	"   describing what files to retrieve. For example:",
	'     "Copy /root/hello.txt"',
	"   or:",
	'     "Copy /root/workspace/output/ (directory)"',
	"",
	"IMPORTANT:",
	"- ALWAYS use absolute paths starting with /root/ — do NOT use ~/",
	"  (the ~ shortcut is not expanded by the write tool).",
	"- /root/vers_final.txt is the ONLY channel back to the manager. Write it LAST.",
	"- Do NOT write to /root/vers_final.txt until all work is finished.",
	"- The manager will use vers_vm_copy to pull the files you mention.",
	"- Work in /root/ or /root/workspace/.",
	"- NETWORKING: This VM is behind an IPv6 TLS proxy. Any server or service you",
	"  start MUST bind to IPv6 (:: or [::]) in addition to IPv4, otherwise it will",
	"  not be reachable from outside the VM. For example, in nginx use",
	"  'listen [::]:PORT;' alongside 'listen PORT;'. For Node.js use hostname '::'.",
	"  For Python use host='::'. Binding only to 0.0.0.0 will NOT work.",
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
	goldenReady: boolean,
	signal?: AbortSignal,
): Promise<RpcResult> {
	if (!goldenReady) {
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
	} else {
		// Golden-ready path: inject the API key via env file
		// (launch-pi.sh, trailing-newline.ts are pre-baked)
		await sshWriteFile(keyPath, vmId, "/root/.rlm/env",
			`export ANTHROPIC_API_KEY='${anthropicApiKey}'`);
		// Always overwrite system-prompt.txt so code changes take effect
		// without rebuilding the golden image.
		await sshWriteFile(keyPath, vmId, "/root/.rlm/system-prompt.txt", INNER_SYSTEM_PROMPT);
	}

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
		"sleep 1",
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
	const promptJson = JSON.stringify({ type: "prompt", message: `Read /root/prompt.txt and complete the task described there.` }) + "\n";
	await sshWriteToFifo(keyPath, vmId, RPC_IN, promptJson);

	// Tail the RPC output and wait for agent_end or vers_final.txt to appear
	return await waitForCompletion(keyPath, vmId, RPC_OUT, RPC_ERR, signal);
}

async function waitForRpcReady(keyPath: string, vmId: string, fifoPath: string, outPath: string, timeoutMs: number): Promise<boolean> {
	// Use tail -f to stream the output file and detect the get_state response
	// in real time instead of polling with repeated SSH commands.
	return new Promise<boolean>((resolve) => {
		let resolved = false;
		let tailChild: ReturnType<typeof spawn> | null = null;
		let lineBuf = "";
		let attempts = 0;

		const timeout = setTimeout(() => {
			if (!resolved) { resolved = true; cleanup(); resolve(false); }
		}, timeoutMs);

		function cleanup() {
			clearTimeout(timeout);
			clearInterval(probeInterval);
			if (tailChild) { try { tailChild.kill("SIGTERM"); } catch {} tailChild = null; }
		}

		// Start tail -f to watch for responses in real time
		const args = sshBaseArgs(keyPath, vmId);
		tailChild = spawn("ssh", [...args, `tail -f -n +1 ${outPath} 2>/dev/null`], {
			stdio: ["ignore", "pipe", "pipe"],
		});

		tailChild.stdout!.on("data", (data: Buffer) => {
			if (resolved) return;
			lineBuf += data.toString();
			const lines = lineBuf.split("\n");
			lineBuf = lines.pop() || "";
			for (const line of lines) {
				if (line.includes('"get_state"') || line.includes('"response"')) {
					if (!resolved) { resolved = true; cleanup(); resolve(true); }
					return;
				}
			}
		});

		tailChild.on("close", () => {
			// tail -f exited (SSH drop) — if not resolved, will timeout
			tailChild = null;
		});

		tailChild.on("error", () => { tailChild = null; });

		// Send get_state probes periodically
		const probeInterval = setInterval(async () => {
			if (resolved) return;
			attempts++;
			try {
				await sshWriteToFifo(keyPath, vmId, fifoPath, JSON.stringify({ id: `probe-${attempts}`, type: "get_state" }) + "\n");
			} catch {
				// FIFO not ready yet
			}
		}, 1000);
	});
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

	return new Promise<RpcResult>((resolve, reject) => {
		let agentOutput = "";
		let lineBuf = "";
		let resolved = false;
		let tailChild: ReturnType<typeof spawn> | null = null;
		let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
		let linesProcessed = 0;

		const timeout = setTimeout(() => {
			if (resolved) return;
			resolved = true;
			cleanup();

			// Timed out — try one final check for vers_final.txt
			sshExec(keyPath, vmId,
				`cat /root/vers_final.txt 2>/dev/null || cat '/root/~/vers_final.txt' 2>/dev/null || true`, 10_000)
				.then((check) => {
					if (check.stdout.trim()) {
						resolve({ agentOutput, finalTxt: check.stdout.trim(), vmId });
						return;
					}
					// Get pi stderr for diagnostics
					return sshExec(keyPath, vmId, `tail -50 ${errPath} 2>/dev/null || true`, 10_000)
						.then((errLog) => errLog.stdout)
						.catch(() => "");
				})
				.then((piStderr) => {
					if (typeof piStderr === "string") {
						reject(new Error(
							`RLM agent on VM ${vmId} timed out after ${MAX_WAIT_MS / 1000}s without completing.\n` +
							`Agent output so far:\n${agentOutput.slice(-2000)}\n` +
							`pi stderr (tail):\n${(piStderr || "").slice(-1000)}`
						));
					}
				})
				.catch(() => {
					reject(new Error(
						`RLM agent on VM ${vmId} timed out after ${MAX_WAIT_MS / 1000}s without completing.\n` +
						`Agent output so far:\n${agentOutput.slice(-2000)}`
					));
				});
		}, MAX_WAIT_MS);

		function cleanup() {
			clearTimeout(timeout);
			if (reconnectTimer) clearTimeout(reconnectTimer);
			if (tailChild) { try { tailChild.kill("SIGTERM"); } catch {} tailChild = null; }
		}

		function finish(finalTxt: string) {
			if (resolved) return;
			resolved = true;
			cleanup();
			resolve({ agentOutput, finalTxt, vmId });
		}

		function processLine(line: string) {
			linesProcessed++;
			if (!line.trim()) return;
			try {
				const event = JSON.parse(line);
				if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
					agentOutput += event.assistantMessageEvent.delta;
				}
				if (event.type === "agent_end") {
					// Agent finished — fetch vers_final.txt
					fetchFinalTxt(keyPath, vmId, 15_000).then((txt) => finish(txt));
				}
			} catch { /* not JSON */ }
		}

		// Catch up any lines written while we weren't tailing
		async function catchUpAndTail() {
			if (resolved) return;

			// Catch up missed lines (on reconnect)
			if (linesProcessed > 0) {
				try {
					const wcResult = await sshExec(keyPath, vmId, `wc -l < ${outPath} 2>/dev/null || echo 0`, 10_000);
					const totalLines = parseInt(wcResult.stdout.trim(), 10) || 0;
					const startLine = linesProcessed + 1;
					if (totalLines >= startLine) {
						const catchUp = await sshExec(keyPath, vmId, `sed -n '${startLine},${totalLines}p' ${outPath}`, 10_000);
						if (catchUp.stdout) {
							for (const l of catchUp.stdout.split("\n")) {
								if (l && !resolved) processLine(l);
							}
						}
					}
				} catch { /* best effort */ }
			}

			if (resolved) return;

			// Start streaming via tail -f
			const args = sshBaseArgs(keyPath, vmId);
			const startLine = linesProcessed > 0 ? linesProcessed + 1 : 1;
			tailChild = spawn("ssh", [...args, `tail -f -n +${startLine} ${outPath}`], {
				stdio: ["ignore", "pipe", "pipe"],
			});

			tailChild.stdout!.on("data", (data: Buffer) => {
				if (resolved) return;
				lineBuf += data.toString();
				const lines = lineBuf.split("\n");
				lineBuf = lines.pop() || "";
				for (const line of lines) {
					if (!resolved) processLine(line);
				}
			});

			tailChild.on("close", () => {
				tailChild = null;
				if (!resolved) {
					// SSH dropped — reconnect after a short delay
					lineBuf = "";
					reconnectTimer = setTimeout(() => catchUpAndTail(), 2000);
				}
			});

			tailChild.on("error", () => { tailChild = null; });
		}

		// Handle abort signal
		if (signal) {
			const onAbort = () => {
				if (resolved) return;
				resolved = true;
				cleanup();
				reject(new Error("Aborted"));
			};
			if (signal.aborted) { onAbort(); return; }
			signal.addEventListener("abort", onAbort, { once: true });
		}

		// Start streaming
		catchUpAndTail().catch(() => {
			if (!resolved) {
				reconnectTimer = setTimeout(() => catchUpAndTail(), 2000);
			}
		});
	});
}

/** One-shot fetch of vers_final.txt with retries (agent may still be flushing the write) */
async function fetchFinalTxt(keyPath: string, vmId: string, timeoutMs: number): Promise<string> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const check = await sshExec(keyPath, vmId,
				`cat /root/vers_final.txt 2>/dev/null || cat '/root/~/vers_final.txt' 2>/dev/null || true`, 10_000);
			if (check.stdout.trim().length > 0) {
				return check.stdout.trim();
			}
		} catch {}
		await sleep(1000);
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
			"Use the `volumes` parameter to copy local files/directories into the " +
			"VM before the agent starts, like Docker volume mounts. The keys are " +
			"local (host) paths and the values are the destination paths inside " +
			"the VM.\n\n" +
			"Example: vers_rlm_run(prompt='Convert /app/data.csv to parquet', " +
			"volumes={'/app/data.csv': '/root/data.csv'}) " +
			"→ copies data.csv into the VM, then runs the agent.",
		parameters: Type.Object({
			prompt: Type.String({ description: "The task instruction for the inner agent" }),
			volumes: Type.Optional(Type.Record(Type.String(), Type.String(), {
				description: "Files/directories to copy into the VM before the agent starts. " +
					"Keys are local (host) paths, values are VM destination paths. " +
					"Like Docker -v syntax: { '/host/path': '/vm/path' }",
			})),
			vcpu_count: Type.Optional(Type.Number({ description: "vCPUs (default: 2)" })),
			mem_size_mib: Type.Optional(Type.Number({ description: "RAM in MiB (default: 2048)" })),
			fs_size_mib: Type.Optional(Type.Number({ description: "Disk in MiB (default: 4096)" })),
		}),
		async execute(_id, params, signal, onUpdate) {
			const {
				prompt,
				volumes = {},
				vcpu_count = 2,
				mem_size_mib = 2048,
				fs_size_mib = 4096,
			} = params as {
				prompt: string;
				volumes?: Record<string, string>;
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

			// Check for a pre-built golden image (set by benchmark harness)
			const goldenCommit = process.env.VERS_RLM_GOLDEN_COMMIT;

			let vmId: string;
			let keyPath: string;
			let goldenReady = false;

			if (goldenCommit) {
				// --- Fast path: restore from golden snapshot ---
				notify(`Restoring VM from golden commit ${goldenCommit.slice(0, 12)}...`);
				const vm = await versApi<{ vm_id: string }>("POST", "/vm/from_commit", {
					commit_id: goldenCommit,
				});
				vmId = vm.vm_id;
				activeVms.set(vmId, { vmId, prompt, finalTxt: "", status: "running" });

				notify(`VM ${vmId.slice(0, 12)} restored. Waiting for SSH...`);

				// Wait for SSH (restored VMs boot faster)
				keyPath = await ensureKeyFile(vmId);
				let sshReady = false;
				for (let i = 0; i < 30; i++) {
					try {
						const check = await sshExec(keyPath, vmId, "echo ready", 15_000);
						if (check.stdout.trim() === "ready") { sshReady = true; break; }
					} catch {}
					await sleep(1000);
				}
				if (!sshReady) {
					activeVms.set(vmId, { vmId, prompt, finalTxt: "", status: "error" });
					throw new Error(`VM ${vmId} restored but SSH unreachable after 30s`);
				}

				// Check if golden image has pre-baked static files
				try {
					const sentinel = await sshExec(keyPath, vmId, "cat /root/.rlm/.golden-ready 2>/dev/null || true", 5_000);
					goldenReady = sentinel.stdout.trim() === "1";
				} catch {}

				notify(`VM ${vmId.slice(0, 12)} ready (golden${goldenReady ? "+prebaked" : ""}). Writing prompt...`);
			} else {
				// --- Cold path: create fresh VM + full bootstrap ---
				notify("Creating Vers VM...");
				const vm = await versApi<{ vm_id: string }>("POST", "/vm/new_root?wait_boot=true", {
					vm_config: { vcpu_count, mem_size_mib, fs_size_mib },
				});
				vmId = vm.vm_id;
				activeVms.set(vmId, { vmId, prompt, finalTxt: "", status: "running" });

				notify(`VM ${vmId.slice(0, 12)} created. Waiting for SSH...`);

				// Wait for SSH
				keyPath = await ensureKeyFile(vmId);
				let sshReady = false;
				for (let i = 0; i < 30; i++) {
					try {
						const check = await sshExec(keyPath, vmId, "echo ready", 15_000);
						if (check.stdout.trim() === "ready") { sshReady = true; break; }
					} catch {}
					await sleep(1000);
				}
				if (!sshReady) {
					activeVms.set(vmId, { vmId, prompt, finalTxt: "", status: "error" });
					throw new Error(`VM ${vmId} created but SSH unreachable after 30s`);
				}

				notify(`VM ${vmId.slice(0, 12)} SSH ready. Bootstrapping Node + pi...`);

				// Bootstrap the VM
				await sshWriteFile(keyPath, vmId, "/root/bootstrap.sh", BOOTSTRAP_SCRIPT);
				const bootstrap = await sshExec(keyPath, vmId, "bash /root/bootstrap.sh", 180_000);
				if (!bootstrap.stdout.includes("bootstrap_done")) {
					activeVms.set(vmId, { vmId, prompt, finalTxt: "", status: "error" });
					throw new Error(`Bootstrap failed on VM ${vmId}:\nstdout: ${bootstrap.stdout}\nstderr: ${bootstrap.stderr}`);
				}

				notify(`VM ${vmId.slice(0, 12)} bootstrapped. Writing prompt + extension...`);
			}

			// --- Write prompt.txt (always needed — task-specific) ---
			await sshWriteFile(keyPath, vmId, "/root/prompt.txt", prompt);

			// --- Upload volumes (host files/dirs → VM paths) ---
			if (volumes && Object.keys(volumes).length > 0) {
				await uploadVolumes(keyPath, vmId, volumes, notify);
			}

			// --- Write static files only if not pre-baked in golden image ---
			if (!goldenReady) {
				await sshExec(keyPath, vmId, "mkdir -p /root/.rlm", 10_000);
				await sshWriteFile(keyPath, vmId, "/root/.rlm/trailing-newline.ts", TRAILING_NEWLINE_EXTENSION);
			}

			notify(`VM ${vmId.slice(0, 12)} ready. Launching pi agent...`);

			// --- Run pi RPC ---
			try {
				const result = await runPiRpc(keyPath, vmId, prompt, anthropicApiKey, goldenReady, signal);
				activeVms.set(vmId, { vmId, prompt, finalTxt: result.finalTxt, status: "done" });

				return {
					content: [{
						type: "text",
						text:
							`VM: ${vmId}\n\n` +
							`${result.finalTxt}`,
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
