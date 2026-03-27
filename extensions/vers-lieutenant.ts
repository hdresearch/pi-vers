/**
 * Vers Lieutenant Extension
 *
 * Persistent, conversational agent sessions running on Vers VMs or locally.
 * Unlike swarm agents (fire-and-forget, task-bound), lieutenants are
 * long-lived, accumulate context, and support multi-turn interaction.
 *
 * Supports two execution modes:
 *   - Remote (default): lieutenant runs on a Vers VM via SSH + RPC
 *   - Local: lieutenant runs as a local pi subprocess (no VM required)
 *
 * Tools:
 *   vers_lt_create  - Spawn a lieutenant on a new VM or locally
 *   vers_lt_send    - Send a message (prompt, steer, or follow-up)
 *   vers_lt_read    - Read latest output from a lieutenant
 *   vers_lt_status  - Status overview of all lieutenants
 *   vers_lt_pause   - Pause a lieutenant's VM (preserves full state)
 *   vers_lt_resume  - Resume a paused lieutenant
 *   vers_lt_destroy - Tear down a specific lieutenant (or all)
 *
 * Completion broadcast:
 *   When a lieutenant finishes a task (agent_end), the extension:
 *   1. Emits "vers:lt_completed" on pi.events (for other extensions)
 *   2. Injects a message into the orchestrator's conversation via pi.sendMessage()
 *      with deliverAs:"followUp" + triggerTurn:true — so the orchestrator sees the
 *      result without polling, and gets a turn to react.
 *   3. Renders with a custom message renderer showing ✅/⚠️ + summary.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import * as readline from "node:readline";
import { resolveAgentBinary } from "../src/core/agent-runtime.js";
import { resolveGoldenCommit } from "../src/core/golden.js";

// =============================================================================
// Path helpers — respect PI_CODING_AGENT_DIR and VERS_HOME
// =============================================================================

/**
 * Get the pi agent config directory.
 * Mirrors pi's own getAgentDir() logic: checks PI_CODING_AGENT_DIR env var,
 * falls back to ~/.pi/agent.
 */
function getPiAgentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) {
		if (envDir === "~") return homedir();
		if (envDir.startsWith("~/")) return join(homedir(), envDir.slice(2));
		return envDir;
	}
	return join(homedir(), ".pi", "agent");
}

/**
 * Get the Vers home directory for storing vers-specific state
 * (keys, lieutenant state, etc).
 *
 * Resolution order:
 *   1. VERS_HOME env var
 *   2. <pi-agent-dir>/../vers  (sibling of agent dir, e.g. ~/.lp_pi/vers or ~/.pi/vers)
 *
 * For keys specifically, also falls back to ~/.vers for backward compatibility.
 */
function getVersHome(): string {
	const envDir = process.env.VERS_HOME;
	if (envDir) {
		if (envDir === "~") return homedir();
		if (envDir.startsWith("~/")) return join(homedir(), envDir.slice(2));
		return envDir;
	}
	// Sibling of agent dir: ~/.lp_pi/agent -> ~/.lp_pi/vers, or ~/.pi/agent -> ~/.pi/vers
	const agentDir = getPiAgentDir();
	return join(agentDir, "..", "vers");
}

// =============================================================================
// Types
// =============================================================================

interface Lieutenant {
	name: string;
	role: string;
	vmId: string;            // "local-{name}" for local lieutenants
	isLocal: boolean;
	status: "starting" | "idle" | "working" | "paused" | "error";
	lastOutput: string;
	outputHistory: string[];  // Rolling buffer of complete responses
	taskCount: number;
	createdAt: string;
	lastActivityAt: string;
}

// =============================================================================
// Vers API helpers (duplicated from vers-swarm for extension independence)
// =============================================================================

function loadApiKey(): string {
	if (process.env.VERS_API_KEY) return process.env.VERS_API_KEY;

	// Try VERS_HOME / pi-agent-dir sibling first
	try {
		const data = require("fs").readFileSync(join(getVersHome(), "keys.json"), "utf-8");
		const key = JSON.parse(data)?.keys?.VERS_API_KEY || "";
		if (key) return key;
	} catch {}

	// Fall back to legacy ~/.vers/keys.json
	try {
		const data = require("fs").readFileSync(join(homedir(), ".vers", "keys.json"), "utf-8");
		return JSON.parse(data)?.keys?.VERS_API_KEY || "";
	} catch {}

	return "";
}

const BASE_URL = process.env.VERS_BASE_URL || "https://api.vers.sh/api/v1";

async function versApi<T>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch(`${BASE_URL}${path}`, {
		method,
		headers: {
			"Content-Type": "application/json",
			"Authorization": `Bearer ${loadApiKey()}`,
		},
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

interface SSHKeyInfo { ssh_port: number; ssh_private_key: string }

const keyCache = new Map<string, string>();

async function ensureKeyFile(vmId: string): Promise<string> {
	const existing = keyCache.get(vmId);
	if (existing) return existing;
	const info = await versApi<SSHKeyInfo>("GET", `/vm/${encodeURIComponent(vmId)}/ssh_key`);
	const keyDir = join(tmpdir(), "vers-ssh-keys");
	await mkdir(keyDir, { recursive: true });
	const keyPath = join(keyDir, `vers-${vmId.slice(0, 12)}.pem`);
	await writeFile(keyPath, info.ssh_private_key, { mode: 0o600 });
	keyCache.set(vmId, keyPath);
	return keyPath;
}

function sshArgs(keyPath: string, vmId: string): string[] {
	return [
		"-i", keyPath,
		"-o", "StrictHostKeyChecking=no",
		"-o", "UserKnownHostsFile=/dev/null",
		"-o", "LogLevel=ERROR",
		"-o", "ConnectTimeout=30",
		"-o", "ServerAliveInterval=15",
		"-o", "ServerAliveCountMax=4",
		"-o", `ProxyCommand=openssl s_client -connect %h:443 -servername %h -quiet 2>/dev/null`,
		`root@${vmId}.vm.vers.sh`,
	];
}

function sshExec(keyPath: string, vmId: string, command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return new Promise((resolve, reject) => {
		const args = sshArgs(keyPath, vmId);
		const child = spawn("ssh", [...args, command], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
		child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
		child.on("error", reject);
		child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 0 }));
	});
}

// =============================================================================
// Registry helpers (best-effort, silent on failure)
// =============================================================================

async function registryPost(entry: { id: string; name: string; role: string; address: string; registeredBy: string; metadata?: Record<string, unknown> }): Promise<void> {
	const infraUrl = process.env.VERS_INFRA_URL;
	const authToken = process.env.VERS_AUTH_TOKEN;
	if (!infraUrl || !authToken) return;
	try {
		await fetch(`${infraUrl}/registry/vms`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "Authorization": `Bearer ${authToken}` },
			body: JSON.stringify(entry),
			signal: AbortSignal.timeout(5000),
		});
	} catch { /* best effort */ }
}

async function registryDelete(vmId: string): Promise<void> {
	const infraUrl = process.env.VERS_INFRA_URL;
	const authToken = process.env.VERS_AUTH_TOKEN;
	if (!infraUrl || !authToken) return;
	try {
		await fetch(`${infraUrl}/registry/vms/${encodeURIComponent(vmId)}`, {
			method: "DELETE",
			headers: { "Authorization": `Bearer ${authToken}` },
			signal: AbortSignal.timeout(5000),
		});
	} catch { /* best effort */ }
}

async function registryList(): Promise<any[]> {
	const infraUrl = process.env.VERS_INFRA_URL;
	const authToken = process.env.VERS_AUTH_TOKEN;
	if (!infraUrl || !authToken) return [];
	try {
		const res = await fetch(`${infraUrl}/registry/vms`, {
			method: "GET",
			headers: { "Authorization": `Bearer ${authToken}` },
			signal: AbortSignal.timeout(5000),
		});
		if (!res.ok) return [];
		const data = await res.json() as any;
		return Array.isArray(data) ? data : (data.vms || []);
	} catch { return []; }
}

// =============================================================================
// RPC agent daemon (same architecture as vers-swarm)
// =============================================================================

const RPC_DIR = "/tmp/pi-rpc";
const RPC_IN = `${RPC_DIR}/in`;
const RPC_OUT = `${RPC_DIR}/out`;
const RPC_ERR = `${RPC_DIR}/err`;

interface RpcHandle {
	send: (cmd: object) => void;
	onEvent: (handler: (event: any) => void) => void;
	reconnectTail: () => void;
	kill: () => Promise<void>;
	vmId: string;
}

interface StartRpcOptions {
	llmProxyKey?: string;
	systemPrompt?: string;
}

async function startRpcAgent(keyPath: string, vmId: string, opts: StartRpcOptions): Promise<RpcHandle> {
	await sshExec(
		keyPath,
		vmId,
		`mkdir -p /etc/profile.d
touch /etc/profile.d/reef-agent.sh
if grep -q '^export VERS_VM_ID=' /etc/profile.d/reef-agent.sh 2>/dev/null; then
  sed -i "s|^export VERS_VM_ID=.*$|export VERS_VM_ID='${vmId}'|" /etc/profile.d/reef-agent.sh
else
  printf "\\nexport VERS_VM_ID='${vmId}'\\n" >> /etc/profile.d/reef-agent.sh
fi`,
	);

	const envExports = [
		opts.llmProxyKey
			? `export LLM_PROXY_KEY='${opts.llmProxyKey}'`
			: process.env.LLM_PROXY_KEY
				? `export LLM_PROXY_KEY='${process.env.LLM_PROXY_KEY}'`
				: "",
		process.env.VERS_API_KEY ? `export VERS_API_KEY='${loadApiKey()}'` : "",
		process.env.VERS_BASE_URL ? `export VERS_BASE_URL='${process.env.VERS_BASE_URL}'` : "",
		process.env.VERS_INFRA_URL ? `export VERS_INFRA_URL='${process.env.VERS_INFRA_URL}'` : "",
		process.env.VERS_AUTH_TOKEN ? `export VERS_AUTH_TOKEN='${process.env.VERS_AUTH_TOKEN}'` : "",
		`export VERS_VM_ID='${vmId}'`,
		process.env.PI_PATH ? `export PI_PATH='${process.env.PI_PATH}'` : "",
		process.env.PUNKIN_BIN ? `export PUNKIN_BIN='${process.env.PUNKIN_BIN}'` : "",
		`export PI_VERS_HOME='${process.env.PI_VERS_HOME || "/root/pi-vers"}'`,
		`export SERVICES_DIR='${process.env.SERVICES_DIR || "/root/reef/services-active"}'`,
		`export REEF_CHILD_AGENT='true'`,
		`export VERS_AGENT_ROLE='lieutenant'`,
		`export VERS_PARENT_AGENT='${process.env.VERS_AGENT_NAME || "orchestrator"}'`,
		`export GIT_EDITOR=true`,
	].filter(Boolean).join("; ");

	// Build pi command with optional system prompt
	let piCmd = `${resolveAgentBinary()} --mode rpc`;
	if (opts.systemPrompt) {
		// Write system prompt to a file on the VM, reference it
		const escaped = opts.systemPrompt.replace(/'/g, "'\\''");
		await sshExec(keyPath, vmId, `mkdir -p /root/.pi/agent && cat > /root/.pi/agent/system-prompt.md << 'SYSPROMPT_EOF'\n${escaped}\nSYSPROMPT_EOF`);
		piCmd += " --system-prompt /root/.pi/agent/system-prompt.md";
	}

	const startScript = `
		set -e
		mkdir -p ${RPC_DIR}
		rm -f ${RPC_IN} ${RPC_OUT} ${RPC_ERR}
		mkfifo ${RPC_IN}
		touch ${RPC_OUT} ${RPC_ERR}
		tmux new-session -d -s pi-keeper "sleep infinity > ${RPC_IN}"
		tmux new-session -d -s pi-rpc "${envExports}; cd /root/workspace; ${piCmd} < ${RPC_IN} >> ${RPC_OUT} 2>> ${RPC_ERR}"
		sleep 1
		tmux has-session -t pi-rpc 2>/dev/null && echo "daemon_started" || echo "daemon_failed"
	`;

	const startResult = await sshExec(keyPath, vmId, startScript);
	if (!startResult.stdout.includes("daemon_started")) {
		throw new Error(`Failed to start pi daemon on ${vmId}: ${startResult.stderr || startResult.stdout}`);
	}

	let eventHandler: ((event: any) => void) | undefined;
	let tailChild: ReturnType<typeof spawn> | null = null;
	let lineBuf = "";
	let killed = false;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let linesProcessed = 0;

	function startTail() {
		if (killed) return;
		const args = sshArgs(keyPath, vmId);
		const startLine = linesProcessed > 0 ? linesProcessed + 1 : 1;
		tailChild = spawn("ssh", [...args, `tail -f -n +${startLine} ${RPC_OUT}`], {
			stdio: ["ignore", "pipe", "pipe"],
		});

		tailChild.stdout!.on("data", (data: Buffer) => {
			lineBuf += data.toString();
			const lines = lineBuf.split("\n");
			lineBuf = lines.pop() || "";
			for (const line of lines) {
				linesProcessed++;
				if (!line.trim()) continue;
				try {
					const event = JSON.parse(line);
					if (eventHandler) eventHandler(event);
				} catch { /* not JSON */ }
			}
		});

		tailChild.on("close", () => {
			if (killed) return;
			lineBuf = "";
			reconnectTimer = setTimeout(() => startTail(), 3000);
		});
	}

	startTail();

	function send(cmd: object) {
		if (killed) return;
		const json = JSON.stringify(cmd) + "\n";
		const writeChild = spawn("ssh", [...sshArgs(keyPath, vmId), `cat > ${RPC_IN}`], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		writeChild.stdin.write(json);
		writeChild.stdin.end();
		writeChild.on("error", (err) => {
			console.error(`[vers-lt] send failed (${vmId.slice(0, 12)}): ${err.message}`);
		});
	}

	function reconnectTail() {
		if (tailChild) {
			try { tailChild.kill("SIGTERM"); } catch { /* ignore */ }
			tailChild = null;
		}
		if (reconnectTimer) clearTimeout(reconnectTimer);
		startTail();
	}

	async function kill() {
		killed = true;
		if (reconnectTimer) clearTimeout(reconnectTimer);
		if (tailChild) {
			try { tailChild.kill("SIGTERM"); } catch { /* ignore */ }
			tailChild = null;
		}
		try {
			await sshExec(keyPath, vmId, `
				tmux kill-session -t pi-rpc 2>/dev/null || true
				tmux kill-session -t pi-keeper 2>/dev/null || true
				rm -rf ${RPC_DIR}
			`);
		} catch { /* VM might already be gone */ }
	}

	return { send, onEvent: (h) => { eventHandler = h; }, reconnectTail, kill, vmId };
}

// =============================================================================
// Local RPC agent (no VM — spawns pi as a local child process)
// =============================================================================

interface LocalRpcOptions {
	llmProxyKey?: string;
	systemPrompt?: string;
	model?: string;
	cwd?: string;
}

function resolveModelProvider(): "vers" | "anthropic" {
	if (process.env.REEF_MODEL_PROVIDER === "anthropic") return "anthropic";
	if (!process.env.LLM_PROXY_KEY && process.env.ANTHROPIC_API_KEY) return "anthropic";
	return "vers";
}

const DEFAULT_LIEUTENANT_MODEL = "claude-opus-4-6-thinking";

async function startLocalRpcAgent(name: string, opts: LocalRpcOptions): Promise<RpcHandle> {
	// Create a dedicated workspace for this lieutenant under vers home
	const ltDir = join(getVersHome(), "lieutenants", name);
	const workDir = opts.cwd || join(ltDir, "workspace");
	const sessionDir = join(ltDir, "sessions");
	await mkdir(workDir, { recursive: true });
	await mkdir(sessionDir, { recursive: true });

	// Write system prompt file if provided
	if (opts.systemPrompt) {
		await writeFile(join(ltDir, "system-prompt.md"), opts.systemPrompt);
	}

	// Build pi command args
	const args = ["--mode", "rpc", "--session-dir", sessionDir];
	if (opts.systemPrompt) {
		args.push("--system-prompt", join(ltDir, "system-prompt.md"));
	}
	if (opts.model) {
		args.push("--model", opts.model);
	}

	// Build environment — inherit parent env, overlay API key if provided
	const env: Record<string, string> = { ...process.env as Record<string, string> };
	if (opts.llmProxyKey) {
		env.LLM_PROXY_KEY = opts.llmProxyKey;
	}
	env.VERS_PARENT_AGENT = process.env.VERS_AGENT_NAME || "orchestrator";

	// Spawn pi as a local child process
	const child: ChildProcess = spawn(resolveAgentBinary(), args, {
		cwd: workDir,
		env,
		stdio: ["pipe", "pipe", "pipe"],
	});

	if (!child.stdin || !child.stdout || !child.stderr) {
		throw new Error(`Failed to spawn pi process for lieutenant "${name}"`);
	}

	let eventHandler: ((event: any) => void) | undefined;
	let killed = false;
	let rl: readline.Interface | null = null;

	// Set up line reader for stdout (JSON events)
	rl = readline.createInterface({ input: child.stdout, terminal: false });
	rl.on("line", (line: string) => {
		if (!line.trim()) return;
		try {
			const event = JSON.parse(line);
			if (eventHandler) eventHandler(event);
		} catch { /* not JSON — ignore */ }
	});

	// Collect stderr for debugging
	let stderrBuf = "";
	child.stderr.on("data", (data: Buffer) => {
		stderrBuf += data.toString();
	});

	// Handle process exit
	child.on("exit", (code) => {
		if (!killed) {
			console.error(`[vers-lt] Local lieutenant "${name}" exited with code ${code}`);
		}
	});

	// Wait for process to initialize
	await new Promise<void>((resolve) => setTimeout(resolve, 500));
	if (child.exitCode !== null) {
		throw new Error(`Pi process for "${name}" exited immediately (code ${child.exitCode}). Stderr: ${stderrBuf}`);
	}

	function send(cmd: object) {
		if (killed || !child.stdin || child.exitCode !== null) return;
		const json = JSON.stringify(cmd) + "\n";
		try {
			child.stdin.write(json);
		} catch (err) {
			console.error(`[vers-lt] send failed for local lt "${name}": ${err instanceof Error ? err.message : err}`);
		}
	}

	function reconnectTail() {
		// No-op for local — stdout pipe is always connected
	}

	async function kill() {
		killed = true;
		if (rl) { rl.close(); rl = null; }
		if (child.exitCode === null) {
			child.kill("SIGTERM");
			// Wait for graceful exit, then force kill
			await new Promise<void>((resolve) => {
				const timeout = setTimeout(() => {
					try { child.kill("SIGKILL"); } catch { /* ignore */ }
					resolve();
				}, 3000);
				child.on("exit", () => {
					clearTimeout(timeout);
					resolve();
				});
			});
		}
	}

	return {
		send,
		onEvent: (h) => { eventHandler = h; },
		reconnectTail,
		kill,
		vmId: `local-${name}`,
	};
}

// =============================================================================
// Persistence — save/load lieutenant state to <vers-home>/lieutenants.json
// =============================================================================

interface PersistedLieutenant {
	name: string;
	role: string;
	vmId: string;
	isLocal: boolean;
	status: string;
	taskCount: number;
	createdAt: string;
	lastActivityAt: string;
}

interface PersistedState {
	lieutenants: PersistedLieutenant[];
	savedAt: string;
}

const STATE_PATH = join(getVersHome(), "lieutenants.json");

async function saveState(lieutenants: Map<string, Lieutenant>): Promise<void> {
	const state: PersistedState = {
		lieutenants: Array.from(lieutenants.values()).map(lt => ({
			name: lt.name,
			role: lt.role,
			vmId: lt.vmId,
			isLocal: lt.isLocal,
			status: lt.status,
			taskCount: lt.taskCount,
			createdAt: lt.createdAt,
			lastActivityAt: lt.lastActivityAt,
		})),
		savedAt: new Date().toISOString(),
	};
	await mkdir(getVersHome(), { recursive: true });
	await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

async function loadState(): Promise<PersistedLieutenant[]> {
	try {
		const data = await readFile(STATE_PATH, "utf-8");
		const state = JSON.parse(data) as PersistedState;
		return state.lieutenants || [];
	} catch {
		return [];
	}
}

/**
 * Reconnect to an existing lieutenant VM. Unlike startRpcAgent, this does NOT
 * start a new pi daemon — it assumes pi is already running in tmux on the VM.
 * We just need to:
 *   1. Get SSH key
 *   2. Verify tmux pi-rpc session exists
 *   3. Start tail -f on the output file (from end — skip old output)
 *   4. Return an RpcHandle for sending commands
 */
async function reconnectRpcAgent(vmId: string): Promise<RpcHandle> {
	const keyPath = await ensureKeyFile(vmId);

	// Verify pi is still running
	const check = await sshExec(keyPath, vmId, "tmux has-session -t pi-rpc 2>/dev/null && echo ok || echo gone");
	if (!check.stdout.includes("ok")) {
		throw new Error(`Pi RPC session not found on VM ${vmId}. It may have crashed.`);
	}

	let eventHandler: ((event: any) => void) | undefined;
	let tailChild: ReturnType<typeof spawn> | null = null;
	let lineBuf = "";
	let killed = false;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	// Start from end of file — we don't replay old output on reconnect
	let linesProcessed = -1; // sentinel: use tail -f -n 0 (new lines only)

	function startTail() {
		if (killed) return;
		const args = sshArgs(keyPath, vmId);
		// -n 0 on first connect (skip old output), -n +N on reconnect
		const tailArg = linesProcessed < 0 ? "-n 0" : `-n +${linesProcessed + 1}`;
		tailChild = spawn("ssh", [...args, `tail -f ${tailArg} ${RPC_OUT}`], {
			stdio: ["ignore", "pipe", "pipe"],
		});

		// After first connect, track lines for reconnect
		if (linesProcessed < 0) linesProcessed = 0;

		tailChild.stdout!.on("data", (data: Buffer) => {
			lineBuf += data.toString();
			const lines = lineBuf.split("\n");
			lineBuf = lines.pop() || "";
			for (const line of lines) {
				linesProcessed++;
				if (!line.trim()) continue;
				try {
					const event = JSON.parse(line);
					if (eventHandler) eventHandler(event);
				} catch { /* not JSON */ }
			}
		});

		tailChild.on("close", () => {
			if (killed) return;
			lineBuf = "";
			reconnectTimer = setTimeout(() => startTail(), 3000);
		});
	}

	startTail();

	function send(cmd: object) {
		if (killed) return;
		const json = JSON.stringify(cmd) + "\n";
		const writeChild = spawn("ssh", [...sshArgs(keyPath, vmId), `cat > ${RPC_IN}`], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		writeChild.stdin.write(json);
		writeChild.stdin.end();
		writeChild.on("error", (err) => {
			console.error(`[vers-lt] send failed (${vmId.slice(0, 12)}): ${err.message}`);
		});
	}

	function reconnectTail() {
		if (tailChild) {
			try { tailChild.kill("SIGTERM"); } catch { /* ignore */ }
			tailChild = null;
		}
		if (reconnectTimer) clearTimeout(reconnectTimer);
		startTail();
	}

	async function kill() {
		killed = true;
		if (reconnectTimer) clearTimeout(reconnectTimer);
		if (tailChild) {
			try { tailChild.kill("SIGTERM"); } catch { /* ignore */ }
			tailChild = null;
		}
		try {
			await sshExec(keyPath, vmId, `
				tmux kill-session -t pi-rpc 2>/dev/null || true
				tmux kill-session -t pi-keeper 2>/dev/null || true
				rm -rf ${RPC_DIR}
			`);
		} catch { /* VM might already be gone */ }
	}

	return { send, onEvent: (h) => { eventHandler = h; }, reconnectTail, kill, vmId };
}

// =============================================================================
// Extension
// =============================================================================

export default function versLieutenantExtension(pi: ExtensionAPI) {
	const lieutenants = new Map<string, Lieutenant>();
	const rpcHandles = new Map<string, RpcHandle>();

	/** Persist state after any mutation */
	async function persist() {
		try { await saveState(lieutenants); } catch (err) {
			console.error("[vers-lt] Failed to persist state:", err);
		}
	}

	function updateWidget(ctx?: { ui: { setWidget: (key: string, lines: string[] | undefined) => void } }) {
		if (!ctx) return;
		if (lieutenants.size === 0) {
			ctx.ui.setWidget("vers-lt", undefined);
			return;
		}
		const lines: string[] = [`─── Lieutenants (${lieutenants.size}) ───`];
		for (const [name, lt] of lieutenants) {
			const icon = lt.status === "working" ? "⟳" :
				lt.status === "idle" ? "●" :
				lt.status === "paused" ? "⏸" :
				lt.status === "error" ? "✗" : "○";
			const tasks = lt.taskCount > 0 ? ` (${lt.taskCount} tasks)` : "";
			const loc = lt.isLocal ? " [local]" : "";
			lines.push(`${icon} ${name}${loc}: ${lt.status}${tasks} — ${lt.role.slice(0, 40)}`);
		}
		ctx.ui.setWidget("vers-lt", lines);
	}

	// =========================================================================
	// Custom renderer for LT completion messages in TUI
	// =========================================================================

	pi.registerMessageRenderer("vers:lt_completed", (message, theme) => {
		const details = (message as any).details || {};
		const status = details.status === "error" ? "⚠️" : "✅";
		const name = details.lieutenant || "unknown";
		const content = typeof message.content === "string" ? message.content : "";

		// Compact single-line header + summary
		let rendered = theme.bold(theme.fg("accent", `${status} Lieutenant "${name}" completed`));
		if (content) {
			// Show just the summary portion, skip the header line we already rendered
			const lines = content.split("\n").filter((l: string) => !l.startsWith("["));
			const summaryText = lines.join("\n").trim();
			if (summaryText) {
				rendered += "\n" + theme.fg("dim", summaryText);
			}
		}
		return new Text(rendered, 0, 0);
	});

	// =========================================================================
	// Reconnection — restore lieutenants from previous session
	// =========================================================================

	function installEventHandler(lt: Lieutenant) {
		const handle = rpcHandles.get(lt.name);
		if (!handle) return;
		handle.onEvent((event) => {
			if (event.type === "agent_start") {
				lt.status = "working";
				lt.lastOutput = "";
				lt.lastActivityAt = new Date().toISOString();
				persist();
			} else if (event.type === "agent_end") {
				lt.status = "idle";
				lt.lastActivityAt = new Date().toISOString();
				if (lt.lastOutput.trim()) {
					lt.outputHistory.push(lt.lastOutput);
					if (lt.outputHistory.length > 20) lt.outputHistory.shift();
				}
				persist();

				// --- Completion broadcast ---
				// Build a concise summary from the last ~200 chars of output
				const rawOutput = lt.lastOutput.trim();
				const summary = rawOutput.length > 200
					? "..." + rawOutput.slice(-200)
					: rawOutput;
				const hasError = /\b(error|failed|exception|fatal)\b/i.test(rawOutput.slice(-500));
				const icon = hasError ? "⚠️" : "✅";

				// 1. Emit event on the shared extension bus
				pi.events.emit("vers:lt_completed", {
					name: lt.name,
					role: lt.role,
					status: hasError ? "error" : "success",
					summary,
					taskCount: lt.taskCount,
					timestamp: lt.lastActivityAt,
				});

				// 2. Inject a message into the orchestrator's conversation
				//    Use followUp + triggerTurn so it arrives after the current
				//    agent loop finishes, and wakes the orchestrator if idle.
				try {
					pi.sendMessage({
						customType: "vers:lt_completed",
						content: [
							`[${lt.name} completed] ${icon}`,
							summary ? `\n${summary}` : "",
							`\nUse vers_lt_read for the full output.`,
						].join(""),
						display: true,
						details: {
							lieutenant: lt.name,
							role: lt.role,
							status: hasError ? "error" : "success",
							taskCount: lt.taskCount,
						},
					}, {
						deliverAs: "followUp",
						triggerTurn: true,
					});
				} catch (err) {
					// Best effort — sendMessage may fail in RPC mode or during shutdown
					console.error(`[vers-lt] Failed to broadcast completion for ${lt.name}:`, err);
				}
			} else if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
				lt.lastOutput += event.assistantMessageEvent.delta;
			}
		});
	}

	// Attempt reconnection at startup (async, non-blocking)
	(async () => {
		const saved = await loadState();
		if (saved.length === 0) return;

		console.error(`[vers-lt] Found ${saved.length} saved lieutenant(s), attempting reconnection...`);

		for (const persisted of saved) {
			try {
				// Local LTs don't survive restarts — skip them
				if (persisted.isLocal) {
					console.error(`[vers-lt] ${persisted.name}: local lieutenant — cannot reconnect across sessions, removing.`);
					continue;
				}

				// Check VM status via Vers API
				let vmState: string;
				try {
					const info = await versApi<{ state: string }>("GET", `/vm/${encodeURIComponent(persisted.vmId)}/status`);
					vmState = info.state;
				} catch (err) {
					// VM no longer exists
					console.error(`[vers-lt] ${persisted.name}: VM ${persisted.vmId.slice(0, 12)} not found, removing.`);
					continue;
				}

				const lt: Lieutenant = {
					name: persisted.name,
					role: persisted.role,
					vmId: persisted.vmId,
					isLocal: false,
					status: "idle",
					lastOutput: "",
					outputHistory: [],
					taskCount: persisted.taskCount,
					createdAt: persisted.createdAt,
					lastActivityAt: persisted.lastActivityAt,
				};

				if (vmState === "Paused" || vmState === "paused") {
					lt.status = "paused";
					lieutenants.set(lt.name, lt);
					console.error(`[vers-lt] ${lt.name}: reconnected (paused)`);
					continue;
				}

				if (vmState !== "Running" && vmState !== "running") {
					console.error(`[vers-lt] ${lt.name}: VM in unexpected state "${vmState}", skipping.`);
					continue;
				}

				// VM is running — reconnect RPC (tail -f, command channel)
				const handle = await reconnectRpcAgent(lt.vmId);
				lieutenants.set(lt.name, lt);
				rpcHandles.set(lt.name, handle);
				installEventHandler(lt);
				console.error(`[vers-lt] ${lt.name}: reconnected (running, VM ${lt.vmId.slice(0, 12)})`);
			} catch (err) {
				console.error(`[vers-lt] ${persisted.name}: reconnection failed —`, err instanceof Error ? err.message : err);
			}
		}

		// Re-persist with only the successfully reconnected lieutenants
		if (lieutenants.size > 0) {
			await persist();
			console.error(`[vers-lt] ${lieutenants.size} lieutenant(s) reconnected.`);
		} else {
			// Clean up state file if nothing reconnected
			try { await writeFile(STATE_PATH, JSON.stringify({ lieutenants: [], savedAt: new Date().toISOString() })); } catch {}
		}
	})().catch(err => {
		console.error("[vers-lt] Reconnection failed:", err);
	});

	// --- vers_lt_create ---
	pi.registerTool({
		name: "vers_lt_create",
		label: "Create Lieutenant",
		description: [
			"Spawn a persistent agent session on a new Vers VM.",
			"The lieutenant stays alive across tasks, accumulates context,",
			"and can be paused/resumed. Give it a name and role.",
			"",
			"Set local=true to run as a local process instead of on a VM.",
			"Local mode requires no VM, no golden image — just spawns pi locally.",
			"Trade-off: no isolation (shares filesystem), no pause/resume,",
			"doesn't survive session restart. But works when VMs are unavailable.",
		].join(" "),
		parameters: Type.Object({
			name: Type.String({ description: "Short name for this lieutenant (e.g., 'infra', 'billing')" }),
			role: Type.String({ description: "Role description — becomes the lieutenant's system prompt context" }),
			commitId: Type.Optional(
				Type.String({ description: "Golden image commit ID to create VM from (optional if a default/root golden exists)" }),
			),
			llmProxyKey: Type.Optional(Type.String({ description: "Vers LLM proxy key override (sk-vers-...)" })),
			model: Type.Optional(Type.String({ description: "Model ID (default: claude-opus-4-6-thinking)" })),
			local: Type.Optional(Type.Boolean({ description: "Run locally as a subprocess instead of on a Vers VM (default: false)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { name, role, commitId, llmProxyKey, model, local } = params as {
				name: string; role: string; commitId?: string;
				llmProxyKey?: string; model?: string; local?: boolean;
			};
			const resolvedLlmProxyKey = llmProxyKey || process.env.LLM_PROXY_KEY || "";
			const resolvedModel = model?.trim() || DEFAULT_LIEUTENANT_MODEL;
			if (!resolvedLlmProxyKey) {
				throw new Error("LLM_PROXY_KEY is required for lieutenants.");
			}

			if (lieutenants.has(name)) {
				throw new Error(`Lieutenant '${name}' already exists. Destroy it first or use a different name.`);
			}

			// Build system prompt (shared between local and remote)
			const systemPrompt = [
				`You are a lieutenant agent named "${name}".`,
				`Your role: ${role}`,
				"",
				"You are a persistent, long-lived agent session managed by a coordinator.",
				"You accumulate context across multiple tasks. When given a new task,",
				"you have full memory of previous work in this session.",
				"",
				"You have access to all pi tools including file operations, bash, and",
				"any extensions installed on this machine.",
				"",
				"When you complete a task, end with a clear summary of what was done",
				"and any open questions or next steps.",
			].join("\n");

			if (local) {
				// ===== LOCAL MODE =====
				const handle = await startLocalRpcAgent(name, {
					llmProxyKey: resolvedLlmProxyKey,
					systemPrompt,
					model: resolvedModel,
				});

				// Wait for RPC ready
				const rpcReady = await new Promise<boolean>((resolve) => {
					let resolved = false;
					const timeout = setTimeout(() => { if (!resolved) { resolved = true; resolve(false); } }, 30000);
					handle.onEvent((event) => {
						if (!resolved && event.type === "response" && event.command === "get_state") {
							resolved = true;
							clearTimeout(timeout);
							resolve(true);
						}
					});
					let attempts = 0;
					const trySend = () => {
						if (resolved || attempts > 8) return;
						attempts++;
						handle.send({ id: "startup-check", type: "get_state" });
						setTimeout(trySend, 2000);
					};
					setTimeout(trySend, 1000);
				});

				if (!rpcReady) {
					await handle.kill();
					throw new Error(`Local pi RPC failed to start for "${name}"`);
				}

				const lt: Lieutenant = {
					name,
					role,
					vmId: `local-${name}`,
					isLocal: true,
					status: "idle",
					lastOutput: "",
					outputHistory: [],
					taskCount: 0,
					createdAt: new Date().toISOString(),
					lastActivityAt: new Date().toISOString(),
				};

				lieutenants.set(name, lt);
				rpcHandles.set(name, handle);
				installEventHandler(lt);

				handle.send({
					type: "set_model",
					provider: resolveModelProvider(),
					modelId: resolvedModel,
				});
				await persist();
				if (ctx) updateWidget(ctx);

				return {
					content: [{
						type: "text",
						text: [
							`Lieutenant "${name}" is ready (local mode).`,
							`  Workspace: ${join(getVersHome(), "lieutenants", name, "workspace")}`,
							`  Role: ${role}`,
							`  Status: idle — waiting for first task`,
							`  Note: local LTs share your filesystem and don't survive session restart.`,
						].join("\n"),
					}],
					details: { name, vmId: `local-${name}`, role, local: true },
				};
			}

			// ===== REMOTE MODE (existing behavior) =====
			const resolvedCommit = await resolveGoldenCommit({ commitId, ensure: true });

			// Create VM from golden commit
			const vm = await versApi<{ vm_id: string }>("POST", "/vm/from_commit", { commit_id: resolvedCommit.commitId });
			const vmId = vm.vm_id;

			// Wait for SSH
			let retries = 30;
			let keyPath = "";
			while (retries > 0) {
				try {
					keyPath = await ensureKeyFile(vmId);
					const check = await sshExec(keyPath, vmId, "echo ready");
					if (check.stdout.trim() === "ready") break;
				} catch { /* not ready yet */ }
				await new Promise(r => setTimeout(r, 2000));
				retries--;
			}
			if (retries === 0) {
				try { await versApi("DELETE", `/vm/${vmId}`); } catch { /* ignore */ }
				throw new Error(`VM ${vmId} failed to boot within 60s`);
			}

			// Start pi RPC daemon
			const handle = await startRpcAgent(keyPath, vmId, {
				llmProxyKey: resolvedLlmProxyKey,
				systemPrompt,
			});

			// Wait for RPC ready
			const rpcReady = await new Promise<boolean>((resolve) => {
				let resolved = false;
				const timeout = setTimeout(() => { if (!resolved) { resolved = true; resolve(false); } }, 45000);
				handle.onEvent((event) => {
					if (!resolved && event.type === "response" && event.command === "get_state") {
						resolved = true;
						clearTimeout(timeout);
						resolve(true);
					}
				});
				let attempts = 0;
				const trySend = () => {
					if (resolved || attempts > 8) return;
					attempts++;
					handle.send({ id: "startup-check", type: "get_state" });
					setTimeout(trySend, 3000);
				};
				setTimeout(trySend, 3000);
			});

			if (!rpcReady) {
				await handle.kill();
				try { await versApi("DELETE", `/vm/${vmId}`); } catch { /* ignore */ }
				throw new Error(`Pi RPC failed to start on ${vmId}`);
			}

			const lt: Lieutenant = {
				name,
				role,
				vmId,
				isLocal: false,
				status: "idle",
				lastOutput: "",
				outputHistory: [],
				taskCount: 0,
				createdAt: new Date().toISOString(),
				lastActivityAt: new Date().toISOString(),
			};

			// Register handle BEFORE installing event handler — installEventHandler
			// looks up the handle from rpcHandles, so it must be present first.
			lieutenants.set(name, lt);
			rpcHandles.set(name, handle);

			// Install event handler (shared with reconnection path)
			installEventHandler(lt);

			// Set model if specified
			handle.send({
				type: "set_model",
				provider: resolveModelProvider(),
				modelId: resolvedModel,
			});
			await persist();
			if (ctx) updateWidget(ctx);

			// Direct registry write (standalone pi-v support)
			await registryPost({
				id: vmId,
				name: name,
				role: "lieutenant",
				address: `${vmId}.vm.vers.sh`,
				registeredBy: "vers-lieutenant",
				metadata: {
					agentId: name,
					role: lt.role,
					commitId: resolvedCommit.commitId,
					createdAt: lt.createdAt,
				},
			});

			// Emit lifecycle event (agent-services hooks into this)
			pi.events.emit("vers:lt_created", {
				vmId,
				name,
				role: "lieutenant",
				address: `${vmId}.vm.vers.sh`,
				ltRole: lt.role,
				commitId: resolvedCommit.commitId,
				createdAt: lt.createdAt,
			});

			return {
				content: [{
					type: "text",
					text: [
						`Lieutenant "${name}" is ready.`,
						`  VM: ${vmId}`,
						`  Role: ${role}`,
						`  Status: idle — waiting for first task`,
					].join("\n"),
				}],
				details: { name, vmId, role },
			};
		},
	});

	// --- vers_lt_send ---
	pi.registerTool({
		name: "vers_lt_send",
		label: "Send to Lieutenant",
		description: [
			"Send a message to a lieutenant. Behavior depends on mode:",
			"  'prompt' (default when idle) — start a new task",
			"  'steer' — interrupt current work and redirect",
			"  'followUp' — queue message for after current task finishes",
		].join("\n"),
		parameters: Type.Object({
			name: Type.String({ description: "Lieutenant name" }),
			message: Type.String({ description: "The message to send" }),
			mode: Type.Optional(Type.Union([
				Type.Literal("prompt"),
				Type.Literal("steer"),
				Type.Literal("followUp"),
			], { description: "Message mode: 'prompt' (default), 'steer' (interrupt), 'followUp' (queue). If lieutenant is working and mode is 'prompt', it auto-selects 'followUp'." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { name, message, mode } = params as {
				name: string; message: string; mode?: "prompt" | "steer" | "followUp";
			};

			const lt = lieutenants.get(name);
			if (!lt) throw new Error(`Lieutenant '${name}' not found. Available: ${Array.from(lieutenants.keys()).join(", ") || "none"}`);
			if (lt.status === "paused") throw new Error(`Lieutenant '${name}' is paused. Resume it first with vers_lt_resume.`);

			const handle = rpcHandles.get(name);
			if (!handle) throw new Error(`No RPC handle for '${name}'`);

			let actualMode = mode || "prompt";
			let modeNote = "";

			// Auto-select mode based on lieutenant state
			if (lt.status === "working" && actualMode === "prompt") {
				// Lieutenant is busy — queue as follow-up rather than error
				actualMode = "followUp";
				modeNote = " (auto-queued as follow-up since lieutenant is working)";
			}

			// Send via RPC
			if (actualMode === "prompt") {
				lt.taskCount++;
				lt.lastOutput = "";
				handle.send({ type: "prompt", message });
			} else if (actualMode === "steer") {
				handle.send({ type: "steer", message });
			} else if (actualMode === "followUp") {
				handle.send({ type: "follow_up", message });
			}

			lt.lastActivityAt = new Date().toISOString();
			await persist();
			if (ctx) updateWidget(ctx);

			return {
				content: [{
					type: "text",
					text: `Sent to ${name} (${actualMode})${modeNote}: "${message.slice(0, 120)}${message.length > 120 ? "..." : ""}"`,
				}],
			};
		},
	});

	// --- vers_lt_read ---
	pi.registerTool({
		name: "vers_lt_read",
		label: "Read Lieutenant Output",
		description: "Read the latest output from a lieutenant. Shows current response if working, or last completed response if idle.",
		parameters: Type.Object({
			name: Type.String({ description: "Lieutenant name" }),
			tail: Type.Optional(Type.Number({ description: "Characters from end (default: all)" })),
			history: Type.Optional(Type.Number({ description: "Number of previous responses to include (default: 0, max: 20)" })),
		}),
		async execute(_id, params) {
			const { name, tail, history } = params as { name: string; tail?: number; history?: number };

			const lt = lieutenants.get(name);
			if (!lt) throw new Error(`Lieutenant '${name}' not found. Available: ${Array.from(lieutenants.keys()).join(", ") || "none"}`);

			let output = lt.lastOutput || "(no output yet)";
			if (tail && output.length > tail) {
				output = "..." + output.slice(-tail);
			}

			const parts: string[] = [];

			// Include history if requested
			if (history && history > 0) {
				const count = Math.min(history, lt.outputHistory.length);
				const start = lt.outputHistory.length - count;
				for (let i = start; i < lt.outputHistory.length; i++) {
					parts.push(`=== Response ${i + 1} ===\n${lt.outputHistory[i]}\n`);
				}
				parts.push(`=== Current (${lt.status}) ===\n${output}`);
			} else {
				parts.push(`[${name}] (${lt.status}, ${lt.taskCount} tasks):\n\n${output}`);
			}

			return {
				content: [{ type: "text", text: parts.join("\n") }],
				details: {
					name,
					status: lt.status,
					taskCount: lt.taskCount,
					outputLength: lt.lastOutput.length,
					historyCount: lt.outputHistory.length,
				},
			};
		},
	});

	// --- vers_lt_status ---
	pi.registerTool({
		name: "vers_lt_status",
		label: "Lieutenant Status",
		description: "Overview of all lieutenants: status, role, task count, last activity.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			if (ctx) updateWidget(ctx);

			if (lieutenants.size === 0) {
				return { content: [{ type: "text", text: "No lieutenants active." }] };
			}

			const lines: string[] = [];
			for (const [name, lt] of lieutenants) {
				const icon = lt.status === "working" ? "⟳" :
					lt.status === "idle" ? "●" :
					lt.status === "paused" ? "⏸" :
					lt.status === "error" ? "✗" : "○";
				const location = lt.isLocal ? "local" : `VM: ${lt.vmId.slice(0, 12)}`;
				lines.push([
					`${icon} ${name} [${lt.status}]`,
					`  Role: ${lt.role}`,
					`  ${location}`,
					`  Tasks: ${lt.taskCount}`,
					`  Last active: ${lt.lastActivityAt}`,
					`  Output: ${lt.lastOutput.length} chars${lt.status === "working" ? " (streaming...)" : ""}`,
				].join("\n"));
			}

			return {
				content: [{ type: "text", text: lines.join("\n\n") }],
				details: {
					lieutenants: Array.from(lieutenants.values()).map(lt => ({
						name: lt.name, vmId: lt.vmId, isLocal: lt.isLocal,
						status: lt.status, taskCount: lt.taskCount, role: lt.role,
					})),
				},
			};
		},
	});

	// --- vers_lt_pause ---
	pi.registerTool({
		name: "vers_lt_pause",
		label: "Pause Lieutenant",
		description: [
			"Pause a lieutenant's VM via Vers. Preserves full state (memory + disk).",
			"The lieutenant can be resumed later exactly where it left off.",
			"Use this to save resources when a lieutenant isn't actively needed.",
		].join(" "),
		parameters: Type.Object({
			name: Type.String({ description: "Lieutenant name" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { name } = params as { name: string };

			const lt = lieutenants.get(name);
			if (!lt) throw new Error(`Lieutenant '${name}' not found.`);
			if (lt.isLocal) throw new Error(`Lieutenant '${name}' is a local process — pause/resume requires a Vers VM.`);
			if (lt.status === "paused") return { content: [{ type: "text", text: `${name} is already paused.` }] };

			if (lt.status === "working") {
				throw new Error(`Lieutenant '${name}' is currently working. Send a steer to stop it first, or wait for it to finish.`);
			}

			// Disconnect tail before pausing
			const handle = rpcHandles.get(name);
			if (handle) {
				// Kill the tail SSH — we'll reconnect on resume
				// Don't kill the RPC daemon — it's preserved in VM memory
			}

			// Pause VM via Vers API
			await versApi("PATCH", `/vm/${encodeURIComponent(lt.vmId)}/state`, { state: "Paused" });
			lt.status = "paused";
			lt.lastActivityAt = new Date().toISOString();
			await persist();

			if (ctx) updateWidget(ctx);

			return {
				content: [{
					type: "text",
					text: `Lieutenant "${name}" paused. VM state preserved. Use vers_lt_resume to wake it.`,
				}],
			};
		},
	});

	// --- vers_lt_resume ---
	pi.registerTool({
		name: "vers_lt_resume",
		label: "Resume Lieutenant",
		description: "Resume a paused lieutenant. VM resumes from exact state including pi session.",
		parameters: Type.Object({
			name: Type.String({ description: "Lieutenant name" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { name } = params as { name: string };

			const lt = lieutenants.get(name);
			if (!lt) throw new Error(`Lieutenant '${name}' not found.`);
			if (lt.isLocal) throw new Error(`Lieutenant '${name}' is a local process — pause/resume requires a Vers VM.`);
			if (lt.status !== "paused") {
				return { content: [{ type: "text", text: `${name} is not paused (status: ${lt.status}).` }] };
			}

			// Resume VM
			await versApi("PATCH", `/vm/${encodeURIComponent(lt.vmId)}/state`, { state: "Running" });

			// Wait for SSH to come back
			const keyPath = await ensureKeyFile(lt.vmId);
			let ready = false;
			for (let i = 0; i < 15; i++) {
				try {
					const check = await sshExec(keyPath, lt.vmId, "tmux has-session -t pi-rpc 2>/dev/null && echo ok");
					if (check.stdout.includes("ok")) { ready = true; break; }
				} catch { /* not ready */ }
				await new Promise(r => setTimeout(r, 2000));
			}

			if (!ready) {
				lt.status = "error";
				await persist();
				if (ctx) updateWidget(ctx);
				throw new Error(`Lieutenant "${name}" VM resumed but pi session not found. The tmux session may have been lost.`);
			}

			// Reconnect tail -f
			const handle = rpcHandles.get(name);
			if (handle) {
				handle.reconnectTail();
			}

			lt.status = "idle";
			lt.lastActivityAt = new Date().toISOString();
			await persist();

			if (ctx) updateWidget(ctx);

			return {
				content: [{
					type: "text",
					text: `Lieutenant "${name}" resumed. Pi session intact. Ready for tasks.`,
				}],
			};
		},
	});

	// --- vers_lt_destroy ---
	pi.registerTool({
		name: "vers_lt_destroy",
		label: "Destroy Lieutenant",
		description: "Tear down a lieutenant — kills pi, deletes VM. Pass name='*' to destroy all.",
		parameters: Type.Object({
			name: Type.String({ description: "Lieutenant name, or '*' for all" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { name } = params as { name: string };

			const targets = name === "*"
				? Array.from(lieutenants.keys())
				: lieutenants.has(name) ? [name] : [];

			if (targets.length === 0) {
				throw new Error(name === "*" ? "No lieutenants to destroy." : `Lieutenant '${name}' not found.`);
			}

			const results: string[] = [];

			for (const n of targets) {
				const lt = lieutenants.get(n)!;

				// Kill RPC handle
				const handle = rpcHandles.get(n);
				if (handle) {
					try { await handle.kill(); } catch { /* ignore */ }
					rpcHandles.delete(n);
				}

				if (lt.isLocal) {
					// Local lieutenant — just kill the process (already done above)
					results.push(`${n}: destroyed (local, ${lt.taskCount} tasks completed)`);
				} else {
					// Remote lieutenant — deregister and delete VM
					await registryDelete(lt.vmId);
					pi.events.emit("vers:lt_destroyed", { vmId: lt.vmId, name: n });

					// If paused, resume first so we can delete
					if (lt.status === "paused") {
						try {
							await versApi("PATCH", `/vm/${encodeURIComponent(lt.vmId)}/state`, { state: "Running" });
						} catch { /* ignore — delete might work anyway */ }
					}

					// Delete VM
					try {
						await versApi("DELETE", `/vm/${encodeURIComponent(lt.vmId)}`);
						results.push(`${n}: destroyed (VM ${lt.vmId.slice(0, 12)}, ${lt.taskCount} tasks completed)`);
					} catch (err) {
						results.push(`${n}: failed to delete VM — ${err instanceof Error ? err.message : String(err)}`);
					}

					keyCache.delete(lt.vmId);
				}

				lieutenants.delete(n);
			}

			await persist();
			if (ctx) updateWidget(ctx);

			return {
				content: [{ type: "text", text: results.join("\n") }],
			};
		},
	});

	// --- vers_lt_discover ---
	pi.registerTool({
		name: "vers_lt_discover",
		label: "Discover Lieutenants",
		description: "Discover running lieutenants from the registry and reconnect to them. Use after session restart to recover lieutenant state.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const results = await discoverFromRegistry();
			if (ctx) updateWidget(ctx);
			if (results.length === 0) {
				return { content: [{ type: "text", text: "No lieutenants found in registry." }] };
			}
			return {
				content: [{ type: "text", text: `Discovery results:\n${results.join("\n")}` }],
				details: { discovered: results.length },
			};
		},
	});

	/**
	 * Discover and reconnect lieutenants from the registry.
	 * Returns an array of result strings describing what happened for each entry.
	 * Safe to call when registry is unavailable — returns empty array.
	 */
	async function discoverFromRegistry(): Promise<string[]> {
		const entries = await registryList();
		const ltEntries = entries.filter((e: any) => e.registeredBy === "vers-lieutenant" && e.role === "lieutenant");

		if (ltEntries.length === 0) return [];

		const results: string[] = [];
		for (const entry of ltEntries) {
			const name = entry.metadata?.agentId || entry.name;

			// Skip if already tracked locally
			if (lieutenants.has(name)) {
				results.push(`${name}: already connected`);
				continue;
			}

			try {
				// Check VM status first
				let vmState: string;
				try {
					const info = await versApi<{ state: string }>("GET", `/vm/${encodeURIComponent(entry.id)}/status`);
					vmState = info.state;
				} catch {
					results.push(`${name}: VM ${entry.id.slice(0, 12)} not found, skipping`);
					continue;
				}

				const lt: Lieutenant = {
					name,
					role: entry.metadata?.role || "recovered lieutenant",
					vmId: entry.id,
					isLocal: false,
					status: "idle",
					lastOutput: "",
					outputHistory: [],
					taskCount: 0,
					createdAt: entry.metadata?.createdAt || new Date().toISOString(),
					lastActivityAt: new Date().toISOString(),
				};

				if (vmState === "Paused" || vmState === "paused") {
					lt.status = "paused";
					lieutenants.set(name, lt);
					results.push(`${name}: reconnected (paused, VM ${entry.id.slice(0, 12)})`);
					continue;
				}

				if (vmState !== "Running" && vmState !== "running") {
					results.push(`${name}: VM ${entry.id.slice(0, 12)} in unexpected state "${vmState}", skipping`);
					continue;
				}

				// VM is running — check tmux session and reconnect
				const keyPath = await ensureKeyFile(entry.id);
				const check = await sshExec(keyPath, entry.id, "tmux has-session -t pi-rpc 2>/dev/null && echo alive || echo dead");

				if (!check.stdout.includes("alive")) {
					results.push(`${name}: VM ${entry.id.slice(0, 12)} — pi-rpc not running, skipping`);
					continue;
				}

				// Reconnect RPC
				const handle = await reconnectRpcAgent(entry.id);
				lieutenants.set(name, lt);
				rpcHandles.set(name, handle);
				installEventHandler(lt);
				results.push(`${name}: reconnected to VM ${entry.id.slice(0, 12)}`);
			} catch (err) {
				results.push(`${name}: reconnect failed — ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		if (results.length > 0) {
			await persist();
		}

		return results;
	}

	// Auto-discover from registry on session start
	pi.on("session_start", async (_event, ctx) => {
		if (ctx) updateWidget(ctx);

		// Auto-discover lieutenants from registry (best-effort, silent)
		if (process.env.VERS_INFRA_URL) {
			try {
				const results = await discoverFromRegistry();
				if (results.length > 0) {
					console.error(`[vers-lt] Registry discovery: ${results.join("; ")}`);
					if (ctx) updateWidget(ctx);
				}
			} catch { /* silent */ }
		}
	});

	// Cleanup on session shutdown
	pi.on("session_shutdown", async () => {
		// Persist final state so next session can reconnect
		await persist();

		// Disconnect local SSH tails — but don't kill remote pi daemons.
		// The VMs and pi sessions survive the meta session closing.
		for (const [name, handle] of rpcHandles) {
			try {
				// Only kill the local tail process, not the remote tmux sessions
				// We can't call handle.kill() because that kills the remote daemon too
				// Instead, just let the process cleanup happen naturally
			} catch { /* ignore */ }
		}
		rpcHandles.clear();
	});
}
