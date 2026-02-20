/**
 * Swarm Manager
 *
 * Orchestrates a swarm of pi coding agents running on Vers VMs.
 * Each agent runs pi in RPC mode inside a branched VM.
 * No framework dependencies — used by both pi extensions and MCP server.
 */

import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VersClient, loadVersKeyFromDisk } from "./vers-client.js";

// =============================================================================
// Types
// =============================================================================

export interface SwarmAgent {
	id: string;
	vmId: string;
	label: string;
	status: "starting" | "idle" | "working" | "done" | "error";
	task?: string;
	lastOutput: string;
	events: string[];
}

export interface SpawnOptions {
	commitId: string;
	count: number;
	labels?: string[];
	anthropicApiKey: string;
	model?: string;
}

export interface SpawnResult {
	agents: Array<{ id: string; vmId: string; status: string }>;
	messages: string[];
}

export interface WaitResult {
	elapsed: number;
	timedOut: boolean;
	agents: Array<{ id: string; status: string; output: string }>;
}

// =============================================================================
// RPC Internals
// =============================================================================

const RPC_DIR = "/tmp/pi-rpc";
const RPC_IN = `${RPC_DIR}/in`;
const RPC_OUT = `${RPC_DIR}/out`;
const RPC_ERR = `${RPC_DIR}/err`;

interface RpcHandle {
	send: (cmd: object) => void;
	onEvent: (handler: (event: any) => void) => void;
	kill: () => Promise<void>;
	vmId: string;
}

interface StartRpcOptions {
	anthropicApiKey: string;
	versApiKey?: string;
	versBaseUrl?: string;
}

/** SSH helpers — minimal, just what swarm needs */

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
		const child = spawn("ssh", [...args, command], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
		child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
		child.on("error", reject);
		child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 0 }));
	});
}

async function startRpcAgent(keyPath: string, vmId: string, opts: StartRpcOptions): Promise<RpcHandle> {
	const envExports = [
		`export ANTHROPIC_API_KEY='${opts.anthropicApiKey}'`,
		opts.versApiKey ? `export VERS_API_KEY='${opts.versApiKey}'` : "",
		opts.versBaseUrl ? `export VERS_BASE_URL='${opts.versBaseUrl}'` : "",
	].filter(Boolean).join("; ");

	const startScript = `
		set -e
		mkdir -p ${RPC_DIR}
		rm -f ${RPC_IN} ${RPC_OUT} ${RPC_ERR}
		mkfifo ${RPC_IN}
		touch ${RPC_OUT} ${RPC_ERR}
		tmux new-session -d -s pi-keeper "sleep infinity > ${RPC_IN}"
		tmux new-session -d -s pi-rpc "${envExports}; cd /root/workspace; pi --mode rpc --no-session < ${RPC_IN} >> ${RPC_OUT} 2>> ${RPC_ERR}"
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

		tailChild.stderr!.on("data", (d: Buffer) => {
			const msg = d.toString().trim();
			if (msg) console.error(`[vers-swarm] tail stderr (${vmId.slice(0, 12)}): ${msg}`);
		});

		tailChild.on("close", (code) => {
			if (killed) return;
			console.error(`[vers-swarm] tail on ${vmId.slice(0, 12)} exited (code ${code}), reconnecting in 3s...`);
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
			console.error(`[vers-swarm] send failed (${vmId.slice(0, 12)}): ${err.message}`);
		});
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

	return { send, onEvent: (handler) => { eventHandler = handler; }, kill, vmId };
}

// =============================================================================
// Swarm Manager
// =============================================================================

export class SwarmManager {
	private agents = new Map<string, SwarmAgent>();
	private rpcHandles = new Map<string, RpcHandle>();
	private client: VersClient;

	constructor(client: VersClient) {
		this.client = client;
	}

	/** Get a snapshot of all agents */
	getAgents(): SwarmAgent[] {
		return Array.from(this.agents.values());
	}

	/** Get a specific agent by ID */
	getAgent(agentId: string): SwarmAgent | undefined {
		return this.agents.get(agentId);
	}

	/** Get agent IDs */
	getAgentIds(): string[] {
		return Array.from(this.agents.keys());
	}

	/** Summary string for display */
	agentSummary(): string {
		if (this.agents.size === 0) return "No agents in swarm.";
		const lines = [];
		for (const [id, a] of this.agents) {
			const task = a.task ? ` — ${a.task.slice(0, 60)}` : "";
			lines.push(`  ${id} [${a.status}] (${a.vmId.slice(0, 12)})${task}`);
		}
		return `Swarm (${this.agents.size} agents):\n${lines.join("\n")}`;
	}

	/** Spawn N agents from a golden commit */
	async spawn(opts: SpawnOptions): Promise<SpawnResult> {
		const versApiKey = loadVersKeyFromDisk() || process.env.VERS_API_KEY || "";
		const versBaseUrl = process.env.VERS_BASE_URL || "https://api.vers.sh/api/v1";

		let rootVmId = "";
		const messages: string[] = [];

		for (let i = 0; i < opts.count; i++) {
			const label = opts.labels?.[i] || `agent-${i + 1}`;

			// Restore a new VM from the golden commit
			const vm = await this.client.restoreFromCommit(opts.commitId);
			const vmId = vm.vm_id;
			if (i === 0) rootVmId = vmId;

			// Wait for boot
			let retries = 30;
			while (retries > 0) {
				try {
					const keyPath = await this.client.ensureKeyFile(vmId);
					const check = await sshExec(keyPath, vmId, "echo ready");
					if (check.stdout.trim() === "ready") break;
				} catch { /* not ready yet */ }
				await new Promise(r => setTimeout(r, 2000));
				retries--;
			}
			if (retries === 0) {
				messages.push(`${label}: FAILED to boot VM ${vmId}`);
				continue;
			}

			// Inject identity
			const keyPath = await this.client.ensureKeyFile(vmId);
			const identity = JSON.stringify({
				vmId,
				agentId: label,
				rootVmId,
				parentVmId: "local",
				depth: 1,
				maxDepth: 50,
				maxVms: 20,
				createdAt: new Date().toISOString(),
			});
			await sshExec(keyPath, vmId, `cat > /root/.swarm/identity.json << 'IDENTITY_EOF'\n${identity}\nIDENTITY_EOF`);

			if (i === 0) {
				await sshExec(keyPath, vmId, `mkdir -p /root/.swarm/status && echo '{"vms":[]}' > /root/.swarm/registry.json`);
			}

			// Start RPC agent
			const handle = await startRpcAgent(keyPath, vmId, {
				anthropicApiKey: opts.anthropicApiKey,
				versApiKey,
				versBaseUrl,
			});

			const agent: SwarmAgent = {
				id: label,
				vmId,
				label,
				status: "idle",
				lastOutput: "",
				events: [],
			};

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
				messages.push(`${label}: VM ${vmId.slice(0, 12)} booted but pi RPC failed to start`);
				await handle.kill();
				continue;
			}

			// Install event handler
			handle.onEvent((event) => {
				agent.events.push(JSON.stringify(event));
				if (agent.events.length > 200) agent.events.shift();

				if (event.type === "agent_start") {
					agent.status = "working";
				} else if (event.type === "agent_end") {
					agent.status = "done";
				} else if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
					agent.lastOutput += event.assistantMessageEvent.delta;
				}
			});

			// Set model if specified
			if (opts.model) {
				handle.send({ type: "set_model", provider: "anthropic", modelId: opts.model });
			}

			this.agents.set(label, agent);
			this.rpcHandles.set(label, handle);
			messages.push(`${label}: VM ${vmId.slice(0, 12)} — ready`);
		}

		return {
			agents: Array.from(this.agents.values()).map(a => ({ id: a.id, vmId: a.vmId, status: a.status })),
			messages,
		};
	}

	/** Send a task to a specific agent */
	sendTask(agentId: string, task: string): void {
		const agent = this.agents.get(agentId);
		if (!agent) throw new Error(`Agent '${agentId}' not found. Available: ${this.getAgentIds().join(", ")}`);

		const handle = this.rpcHandles.get(agentId);
		if (!handle) throw new Error(`No RPC handle for agent '${agentId}'`);

		agent.task = task;
		agent.status = "working";
		agent.lastOutput = "";

		handle.send({ type: "prompt", message: task });
	}

	/** Wait for agents to finish */
	async wait(agentIds?: string[], timeoutSeconds = 300, signal?: AbortSignal): Promise<WaitResult> {
		const timeout = timeoutSeconds * 1000;
		const startTime = Date.now();

		const targetIds = agentIds || this.getAgentIds();
		const waiting = targetIds.filter(id => {
			const a = this.agents.get(id);
			return a && (a.status === "working" || a.status === "idle");
		});

		if (waiting.length > 0) {
			await new Promise<void>((resolve) => {
				const check = () => {
					if (signal?.aborted) { resolve(); return; }

					const allDone = waiting.every(id => {
						const a = this.agents.get(id);
						return !a || a.status === "done" || a.status === "error";
					});

					if (allDone || Date.now() - startTime > timeout) {
						resolve();
						return;
					}

					setTimeout(check, 2000);
				};
				check();
			});
		}

		const elapsed = Math.round((Date.now() - startTime) / 1000);
		const timedOut = waiting.some(id => {
			const a = this.agents.get(id);
			return a && a.status === "working";
		});

		const agents = targetIds.map(id => {
			const a = this.agents.get(id);
			return {
				id,
				status: a?.status || "unknown",
				output: a?.lastOutput || "(no output)",
			};
		});

		return { elapsed, timedOut, agents };
	}

	/** Tear down all agents and delete VMs */
	async teardown(): Promise<string[]> {
		const results: string[] = [];

		for (const [id, agent] of this.agents) {
			const handle = this.rpcHandles.get(id);
			if (handle) {
				try { await handle.kill(); } catch { /* ignore */ }
				this.rpcHandles.delete(id);
			}

			try {
				await this.client.delete(agent.vmId);
				results.push(`${id}: VM ${agent.vmId.slice(0, 12)} deleted`);
			} catch (err) {
				results.push(`${id}: failed to delete VM — ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		this.agents.clear();
		this.client.clearKeyCache();
		return results;
	}

	/** Kill all RPC handles (for graceful shutdown without deleting VMs) */
	async shutdown(): Promise<void> {
		for (const handle of this.rpcHandles.values()) {
			try { await handle.kill(); } catch { /* ignore */ }
		}
		this.rpcHandles.clear();
	}
}
