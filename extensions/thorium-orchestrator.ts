/**
 * Thorium Orchestrator Extension
 *
 * Integrates the Thorium multi-agent framework with Vers VM orchestration.
 * Provides lifecycle management for Thorium agents (Bob, Mary, Peter, Steve)
 * running in isolated VMs, with support for event-driven coordination,
 * parallel verification swarms, and bi-directional communication via
 * the ThoriumBridge (file-based JSON-RPC protocol).
 *
 * When the ThoriumBridge is connected, events flow between this extension
 * and Thorium's Eagle DSL layer. When not connected, the extension falls
 * back to direct SSH-based agent management.
 *
 * Tools:
 *   thorium_agent_spawn          - Spawn a Thorium agent in a VM
 *   thorium_agent_task           - Send an event/task to an agent
 *   thorium_agent_status         - Check status of agents
 *   thorium_agent_read           - Read agent output
 *   thorium_agent_teardown       - Shutdown and cleanup agents
 *   thorium_verification_swarm   - Spawn parallel verification swarm
 *   thorium_verification_wait    - Wait for verification results
 *   thorium_orchestrator_init    - Initialize the ThoriumBridge
 *   thorium_orchestrator_status  - Bridge, agent, and swarm status overview
 *   thorium_event_publish        - Publish an event to Thorium via bridge
 *   thorium_event_subscribe      - Subscribe to Thorium events
 *   thorium_hook_invoke          - Invoke a Thorium hook
 *   thorium_memory_read          - Read from Thorium shared memory
 *   thorium_memory_write         - Write to Thorium shared memory
 *   thorium_consensus_propose    - Propose a consensus ballot
 *   thorium_consensus_vote       - Cast a vote on a ballot
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn, exec } from "node:child_process";
import {
	writeFile,
	mkdir,
	readdir,
	stat,
	access,
	readFile,
	appendFile,
	unlink,
	watch,
} from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { constants } from "node:fs";

const execAsync = promisify(exec);

// =============================================================================
// Types
// =============================================================================

type AgentType = "bob" | "mary" | "peter" | "steve";
type AgentStatus = "starting" | "idle" | "working" | "done" | "error";

const AGENT_ROLE_MAP: Record<AgentType, string> = {
	bob: "generator",
	mary: "verifier",
	peter: "monitor",
	steve: "ambassador",
};

/** Default VM resource allocations per agent type. */
const AGENT_VM_DEFAULTS: Record<AgentType, { vcpu: number; memory: number }> = {
	bob: { vcpu: 2, memory: 4096 },
	mary: { vcpu: 2, memory: 4096 },
	peter: { vcpu: 1, memory: 2048 },
	steve: { vcpu: 1, memory: 2048 },
};

interface ThoriumAgent {
	id: string;
	type: AgentType;
	thoriumRole: string;
	vmId: string;
	status: AgentStatus;
	language?: string;
	workspace: string;
	isLieutenant: boolean;
	lastEvent?: string;
	lastOutput: string;
	events: string[];
	createdAt: number;
}

interface VerificationStage {
	name: string;
	agentId: string;
	status: "pending" | "running" | "passed" | "failed";
	output: string;
}

interface VerificationSwarm {
	id: string;
	language: string;
	workspace: string;
	stages: VerificationStage[];
	status: "running" | "completed" | "failed";
	createdAt: number;
}

// =============================================================================
// ThoriumBridge Types
// =============================================================================

interface ThoriumEvent {
	id: string;
	name: string;
	payload: unknown;
	source: string;
	timestamp: string;
}

interface BridgeMessage {
	id: string;
	operation: string;
	payload: unknown;
	timestamp: string;
}

interface BridgeResponse {
	id: string;
	success: boolean;
	result?: unknown;
	error?: string;
	timestamp: string;
}

interface BridgeOptions {
	thoriumRoot: string;
	pollIntervalMs?: number;
	requestTimeoutMs?: number;
}

// =============================================================================
// ThoriumBridge — file-based JSON-RPC for Eagle DSL communication
// =============================================================================

class ThoriumBridge {
	private requestDir: string = "";
	private responseDir: string = "";
	private eventsFile: string = "";
	private eventHandlers: Map<string, ((event: ThoriumEvent) => void)[]> = new Map();
	private pendingRequests: Map<string, {
		resolve: (value: unknown) => void;
		reject: (reason: Error) => void;
		timeout: ReturnType<typeof setTimeout>;
	}> = new Map();
	private connected: boolean = false;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private eventPollTimer: ReturnType<typeof setInterval> | null = null;
	private lastEventOffset: number = 0;
	private thoriumRoot: string = "";
	private pollIntervalMs: number = 500;
	private requestTimeoutMs: number = 30000;
	private connectedAt: number = 0;

	/**
	 * Connect to a Thorium project by setting up the bridge directories
	 * and starting the polling loops.
	 */
	async connect(options: BridgeOptions): Promise<void> {
		if (this.connected) {
			throw new Error("ThoriumBridge is already connected. Disconnect first.");
		}

		this.thoriumRoot = options.thoriumRoot;
		this.pollIntervalMs = options.pollIntervalMs ?? 500;
		this.requestTimeoutMs = options.requestTimeoutMs ?? 30000;

		const bridgeDir = join(this.thoriumRoot, "workspace", ".thorium-bridge");
		this.requestDir = join(bridgeDir, "requests");
		this.responseDir = join(bridgeDir, "responses");
		this.eventsFile = join(bridgeDir, "events.jsonl");

		// Create bridge directories
		await mkdir(this.requestDir, { recursive: true });
		await mkdir(this.responseDir, { recursive: true });

		// Ensure events file exists
		try {
			await access(this.eventsFile, constants.F_OK);
		} catch {
			await writeFile(this.eventsFile, "");
		}

		// Determine initial event offset (skip existing events)
		try {
			const existing = await readFile(this.eventsFile, "utf-8");
			const lines = existing.split("\n").filter((l) => l.trim());
			this.lastEventOffset = lines.length;
		} catch {
			this.lastEventOffset = 0;
		}

		// Start polling for responses
		this.pollTimer = setInterval(() => {
			this.pollResponses().catch((err) => {
				console.error(
					`[thorium-bridge] response poll error: ${err instanceof Error ? err.message : String(err)}`
				);
			});
		}, this.pollIntervalMs);
		if (this.pollTimer.unref) this.pollTimer.unref();

		// Start polling for events
		this.eventPollTimer = setInterval(() => {
			this.pollEvents().catch((err) => {
				console.error(
					`[thorium-bridge] event poll error: ${err instanceof Error ? err.message : String(err)}`
				);
			});
		}, this.pollIntervalMs);
		if (this.eventPollTimer.unref) this.eventPollTimer.unref();

		this.connected = true;
		this.connectedAt = Date.now();
	}

	/**
	 * Disconnect the bridge, cancel timers, reject pending requests.
	 */
	async disconnect(): Promise<void> {
		if (!this.connected) return;

		this.connected = false;

		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
		if (this.eventPollTimer) {
			clearInterval(this.eventPollTimer);
			this.eventPollTimer = null;
		}

		// Reject all pending requests
		for (const [id, pending] of this.pendingRequests) {
			clearTimeout(pending.timeout);
			pending.reject(new Error("ThoriumBridge disconnected"));
		}
		this.pendingRequests.clear();
		this.eventHandlers.clear();
		this.lastEventOffset = 0;
		this.connectedAt = 0;
	}

	/**
	 * Send a request to Thorium via the bridge and wait for a response.
	 */
	async sendRequest(operation: string, payload: unknown): Promise<unknown> {
		if (!this.connected) {
			throw new Error("ThoriumBridge is not connected");
		}

		const id = `req-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

		const message: BridgeMessage = {
			id,
			operation,
			payload,
			timestamp: new Date().toISOString(),
		};

		// Write request file
		const requestPath = join(this.requestDir, `${id}.json`);
		await writeFile(requestPath, JSON.stringify(message, null, 2));

		// Wait for response
		return new Promise<unknown>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Request ${id} timed out after ${this.requestTimeoutMs}ms`));
			}, this.requestTimeoutMs);

			this.pendingRequests.set(id, { resolve, reject, timeout });
		});
	}

	/**
	 * Publish an event to Thorium by appending to the events file.
	 */
	async publishEvent(eventName: string, payload: unknown): Promise<void> {
		if (!this.connected) {
			throw new Error("ThoriumBridge is not connected");
		}

		const event: ThoriumEvent = {
			id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
			name: eventName,
			payload,
			source: "pi-vers",
			timestamp: new Date().toISOString(),
		};

		await appendFile(this.eventsFile, JSON.stringify(event) + "\n");
	}

	/**
	 * Register a handler for events matching a pattern.
	 * Pattern supports prefix matching: "agent.*" matches "agent.started", etc.
	 */
	onEvent(pattern: string, handler: (event: ThoriumEvent) => void): void {
		const handlers = this.eventHandlers.get(pattern) || [];
		handlers.push(handler);
		this.eventHandlers.set(pattern, handlers);
	}

	/**
	 * Remove a previously registered event handler.
	 */
	offEvent(pattern: string, handler: (event: ThoriumEvent) => void): void {
		const handlers = this.eventHandlers.get(pattern);
		if (!handlers) return;
		const idx = handlers.indexOf(handler);
		if (idx >= 0) handlers.splice(idx, 1);
		if (handlers.length === 0) this.eventHandlers.delete(pattern);
	}

	/**
	 * Check if the bridge is connected.
	 */
	isConnected(): boolean {
		return this.connected;
	}

	/**
	 * Return the uptime in seconds since connection, or 0 if not connected.
	 */
	uptimeSeconds(): number {
		if (!this.connected || this.connectedAt === 0) return 0;
		return Math.floor((Date.now() - this.connectedAt) / 1000);
	}

	/**
	 * Return the thorium root path, or empty string if not connected.
	 */
	getThoriumRoot(): string {
		return this.thoriumRoot;
	}

	// -------------------------------------------------------------------------
	// Internal polling
	// -------------------------------------------------------------------------

	private async pollResponses(): Promise<void> {
		if (!this.connected) return;

		let entries: string[];
		try {
			entries = await readdir(this.responseDir);
		} catch {
			return;
		}

		for (const entry of entries) {
			if (!entry.endsWith(".json")) continue;

			const responsePath = join(this.responseDir, entry);
			try {
				const content = await readFile(responsePath, "utf-8");
				const response = JSON.parse(content) as BridgeResponse;

				const pending = this.pendingRequests.get(response.id);
				if (pending) {
					clearTimeout(pending.timeout);
					this.pendingRequests.delete(response.id);
					if (response.success) {
						pending.resolve(response.result);
					} else {
						pending.reject(new Error(response.error || "Unknown bridge error"));
					}
				}

				// Remove processed response file
				await unlink(responsePath).catch(() => {});
			} catch (err) {
				// Malformed response file — skip it
				console.error(
					`[thorium-bridge] bad response file ${entry}: ${err instanceof Error ? err.message : String(err)}`
				);
			}
		}
	}

	private async pollEvents(): Promise<void> {
		if (!this.connected) return;

		let content: string;
		try {
			content = await readFile(this.eventsFile, "utf-8");
		} catch {
			return;
		}

		const lines = content.split("\n").filter((l) => l.trim());
		if (lines.length <= this.lastEventOffset) return;

		// Process new lines only
		const newLines = lines.slice(this.lastEventOffset);
		this.lastEventOffset = lines.length;

		for (const line of newLines) {
			try {
				const event = JSON.parse(line) as ThoriumEvent;

				// Skip events we published ourselves
				if (event.source === "pi-vers") continue;

				this.dispatchEvent(event);
			} catch {
				// Malformed event line — skip
			}
		}
	}

	private dispatchEvent(event: ThoriumEvent): void {
		for (const [pattern, handlers] of this.eventHandlers) {
			if (this.matchesPattern(pattern, event.name)) {
				for (const handler of handlers) {
					try {
						handler(event);
					} catch (err) {
						console.error(
							`[thorium-bridge] event handler error for "${pattern}": ${err instanceof Error ? err.message : String(err)}`
						);
					}
				}
			}
		}
	}

	private matchesPattern(pattern: string, eventName: string): boolean {
		if (pattern === "*") return true;
		if (pattern === eventName) return true;

		// Wildcard suffix: "agent.*" matches "agent.started", "agent.stopped"
		if (pattern.endsWith(".*")) {
			const prefix = pattern.slice(0, -2);
			return eventName.startsWith(prefix + ".") || eventName === prefix;
		}

		// Wildcard prefix: "*.failed" matches "verification.failed", "build.failed"
		if (pattern.startsWith("*.")) {
			const suffix = pattern.slice(2);
			return eventName.endsWith("." + suffix) || eventName === suffix;
		}

		return false;
	}
}

// =============================================================================
// State Management
// =============================================================================

const agents = new Map<string, ThoriumAgent>();
const swarms = new Map<string, VerificationSwarm>();
const bridge = new ThoriumBridge();
const extensionStartedAt = Date.now();

/** Active event subscriptions — maps pattern to subscription ID for tracking. */
const activeSubscriptions = new Map<string, string>();

function generateId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// =============================================================================
// Vers API Client (reused from vers-vm)
// =============================================================================

function loadApiKey(): string {
	try {
		const homedir = process.env.HOME || process.env.USERPROFILE || "";
		const data = require("fs").readFileSync(join(homedir, ".vers", "keys.json"), "utf-8");
		return JSON.parse(data)?.keys?.VERS_API_KEY || "";
	} catch {
		return process.env.VERS_API_KEY || "";
	}
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
interface NewVmResponse { vm_id: string }

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

async function sshExec(vmId: string, command: string): Promise<string> {
	const keyPath = await ensureKeyFile(vmId);
	const args = [...sshArgs(keyPath, vmId), command];
	const { stdout, stderr } = await execAsync(`ssh ${args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`);
	return stdout + stderr;
}

async function waitForVmBoot(vmId: string, maxAttempts = 60): Promise<void> {
	for (let i = 0; i < maxAttempts; i++) {
		try {
			await sshExec(vmId, "echo ready");
			return;
		} catch (err) {
			if (i === maxAttempts - 1) throw new Error(`VM ${vmId} failed to boot after ${maxAttempts} attempts`);
			await new Promise(resolve => setTimeout(resolve, 2000));
		}
	}
}

// =============================================================================
// Lieutenant integration helpers
// =============================================================================

/**
 * Start a persistent agent session via tmux on a VM.
 * Used when isLieutenant is true — the agent runs in a tmux session
 * that survives SSH disconnects, allowing long-lived operation.
 */
async function startLieutenantSession(vmId: string, agentId: string, agentType: AgentType): Promise<void> {
	const RPC_DIR = "/tmp/thorium-lt";
	const sessionName = `thorium-${agentType}`;

	const startScript = `
		set -e
		mkdir -p ${RPC_DIR}
		rm -f ${RPC_DIR}/in ${RPC_DIR}/out ${RPC_DIR}/err
		mkfifo ${RPC_DIR}/in
		touch ${RPC_DIR}/out ${RPC_DIR}/err

		# Keep FIFO open so the agent never sees EOF
		tmux new-session -d -s ${sessionName}-keeper "sleep infinity > ${RPC_DIR}/in"

		# Start agent processing loop in tmux
		tmux new-session -d -s ${sessionName} "cd /root/workspace && cat ${RPC_DIR}/in | while IFS= read -r line; do echo \\$line >> ${RPC_DIR}/out; done 2>> ${RPC_DIR}/err"

		sleep 1
		tmux has-session -t ${sessionName} 2>/dev/null && echo "lt_started" || echo "lt_failed"
	`;

	const result = await sshExec(vmId, startScript);
	if (!result.includes("lt_started")) {
		throw new Error(`Failed to start lieutenant session for ${agentType} on ${vmId}: ${result}`);
	}
}

/**
 * Send a command to a lieutenant's tmux session via the FIFO.
 */
async function sendToLieutenant(vmId: string, agentType: AgentType, data: string): Promise<void> {
	const RPC_DIR = "/tmp/thorium-lt";
	await sshExec(vmId, `echo '${data.replace(/'/g, "'\\''")}' > ${RPC_DIR}/in`);
}

/**
 * Read the latest output from a lieutenant session.
 */
async function readLieutenantOutput(vmId: string, agentType: AgentType, tail?: number): Promise<string> {
	const RPC_DIR = "/tmp/thorium-lt";
	if (tail) {
		return await sshExec(vmId, `tail -c ${tail} ${RPC_DIR}/out 2>/dev/null || echo ''`);
	}
	return await sshExec(vmId, `cat ${RPC_DIR}/out 2>/dev/null || echo ''`);
}

/**
 * Tear down a lieutenant's tmux sessions.
 */
async function teardownLieutenantSession(vmId: string, agentType: AgentType): Promise<void> {
	const sessionName = `thorium-${agentType}`;
	await sshExec(vmId, `
		tmux kill-session -t ${sessionName} 2>/dev/null || true
		tmux kill-session -t ${sessionName}-keeper 2>/dev/null || true
		rm -rf /tmp/thorium-lt
	`);
}

// =============================================================================
// Agent Management
// =============================================================================

async function spawnAgent(
	type: AgentType,
	commitId: string,
	workspace: string,
	language?: string,
	vcpu?: number,
	memory?: number,
	isLieutenant?: boolean
): Promise<ThoriumAgent> {
	const defaults = AGENT_VM_DEFAULTS[type];

	// Create VM from golden image
	const restoreBody = {
		commit_id: commitId,
		vcpu_count: vcpu || defaults.vcpu,
		mem_size_mib: memory || defaults.memory,
	};

	const vmResponse = await versApi<NewVmResponse>("POST", "/vm/restore", restoreBody);
	const vmId = vmResponse.vm_id;

	// Wait for boot
	await waitForVmBoot(vmId);

	// Create agent record
	const agentId = generateId(type);
	const thoriumRole = AGENT_ROLE_MAP[type];
	const agent: ThoriumAgent = {
		id: agentId,
		type,
		thoriumRole,
		vmId,
		status: "starting",
		language,
		workspace,
		isLieutenant: isLieutenant || false,
		lastOutput: "",
		events: [],
		createdAt: Date.now(),
	};
	agents.set(agentId, agent);

	// Initialize agent configuration in VM
	const config = {
		agentId,
		agentType: type,
		thoriumRole,
		language: language || "unknown",
		workspace: "/workspace",
		thoriumVersion: "0.2.0",
		isLieutenant: isLieutenant || false,
	};

	await sshExec(vmId, "mkdir -p /root/.thorium");
	await sshExec(vmId, `cat > /root/.thorium/config.json <<'EOF'\n${JSON.stringify(config, null, 2)}\nEOF`);
	await sshExec(vmId, `cat > /root/.thorium/events.jsonl <<'EOF'\nEOF`);

	// If lieutenant mode, start a persistent tmux session
	if (isLieutenant) {
		await startLieutenantSession(vmId, agentId, type);
	}

	// Update status
	agent.status = "idle";
	agents.set(agentId, agent);

	// Publish bridge event if connected
	if (bridge.isConnected()) {
		try {
			await bridge.publishEvent("agent.started", {
				agentId,
				agentType: type,
				thoriumRole,
				vmId,
				language,
				isLieutenant: isLieutenant || false,
			});
		} catch (err) {
			console.error(
				`[thorium] bridge event publish failed: ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}

	return agent;
}

async function sendTaskToAgent(agentId: string, event: string, payload: Record<string, unknown>): Promise<void> {
	const agent = agents.get(agentId);
	if (!agent) throw new Error(`Agent ${agentId} not found`);

	// Update agent status
	agent.status = "working";
	agent.lastEvent = event;
	agent.events.push(event);
	agents.set(agentId, agent);

	// Write event to VM's event log
	const eventData = {
		type: event,
		timestamp: new Date().toISOString(),
		payload,
	};

	if (agent.isLieutenant) {
		// Send to lieutenant's FIFO
		await sendToLieutenant(agent.vmId, agent.type, JSON.stringify(eventData));
	} else {
		// Write to event log for fire-and-forget agents
		await sshExec(agent.vmId, `echo '${JSON.stringify(eventData)}' >> /root/.thorium/events.jsonl`);
	}

	// Publish bridge event if connected
	if (bridge.isConnected()) {
		try {
			await bridge.publishEvent("task.dispatched", {
				agentId,
				agentType: agent.type,
				thoriumRole: agent.thoriumRole,
				event,
				payload,
			});
		} catch (err) {
			console.error(
				`[thorium] bridge event publish failed: ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}
}

// =============================================================================
// Verification Swarm — parallel spawning
// =============================================================================

async function spawnVerificationSwarm(
	language: string,
	workspace: string,
	stages: string[],
	commitId: string
): Promise<string> {
	const swarmId = generateId("swarm");

	const swarm: VerificationSwarm = {
		id: swarmId,
		language,
		workspace,
		stages: stages.map(name => ({
			name,
			agentId: "",
			status: "pending",
			output: "",
		})),
		status: "running",
		createdAt: Date.now(),
	};
	swarms.set(swarmId, swarm);

	// Publish swarm.started event if bridge is connected
	if (bridge.isConnected()) {
		try {
			await bridge.publishEvent("swarm.started", {
				swarmId,
				language,
				stages,
				stageCount: stages.length,
			});
		} catch (err) {
			console.error(
				`[thorium] bridge event publish failed: ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}

	// Spawn all verification agents in parallel using Promise.allSettled
	const spawnPromises = swarm.stages.map(async (stage) => {
		try {
			const agent = await spawnAgent("mary", commitId, workspace, language, 2, 2048);
			stage.agentId = agent.id;
			stage.status = "running";

			// Send verification task to agent
			await sendTaskToAgent(agent.id, "verification.stage", {
				stage: stage.name,
				language,
				workspace: "/workspace",
			});

			return { stage: stage.name, success: true, agentId: agent.id };
		} catch (err) {
			stage.status = "failed";
			stage.output = err instanceof Error ? err.message : String(err);
			return { stage: stage.name, success: false, error: stage.output };
		}
	});

	const results = await Promise.allSettled(spawnPromises);

	// Log any unexpected rejections (should not happen since we catch inside)
	for (const result of results) {
		if (result.status === "rejected") {
			console.error(`[thorium] unexpected swarm spawn rejection: ${result.reason}`);
		}
	}

	swarms.set(swarmId, swarm);
	return swarmId;
}

async function waitForVerification(swarmId: string, timeout: number): Promise<Record<string, { pass: boolean; output: string }>> {
	const swarm = swarms.get(swarmId);
	if (!swarm) throw new Error(`Swarm ${swarmId} not found`);

	const startTime = Date.now();
	const results: Record<string, { pass: boolean; output: string }> = {};

	// Poll for completion
	while (Date.now() - startTime < timeout * 1000) {
		let allComplete = true;

		for (const stage of swarm.stages) {
			if (stage.status === "running") {
				allComplete = false;

				// Check agent status
				const agent = agents.get(stage.agentId);
				if (agent && (agent.status === "done" || agent.status === "error")) {
					stage.status = agent.status === "done" ? "passed" : "failed";
					stage.output = agent.lastOutput;

					// Publish per-stage result to bridge
					if (bridge.isConnected()) {
						try {
							await bridge.publishEvent(
								stage.status === "passed" ? "verification.passed" : "verification.failed",
								{
									swarmId,
									stage: stage.name,
									agentId: stage.agentId,
									output: stage.output.slice(0, 500),
								}
							);
						} catch {
							// Best effort
						}
					}
				}
			}

			results[stage.name] = {
				pass: stage.status === "passed",
				output: stage.output,
			};
		}

		if (allComplete) {
			swarm.status = swarm.stages.every(s => s.status === "passed") ? "completed" : "failed";
			swarms.set(swarmId, swarm);

			// Publish swarm completion to bridge
			if (bridge.isConnected()) {
				try {
					await bridge.publishEvent("swarm.completed", {
						swarmId,
						status: swarm.status,
						results,
					});
				} catch {
					// Best effort
				}
			}

			return results;
		}

		await new Promise(resolve => setTimeout(resolve, 1000));
	}

	throw new Error(`Verification timed out after ${timeout}s`);
}

// =============================================================================
// Bridge helper functions for memory and consensus tools
// =============================================================================

async function bridgeMemoryRead(scope: string, key: string): Promise<unknown> {
	if (!bridge.isConnected()) {
		throw new Error("ThoriumBridge is not connected. Use thorium_orchestrator_init first.");
	}
	return await bridge.sendRequest("memory.read", { scope, key });
}

async function bridgeMemoryWrite(scope: string, key: string, value: unknown): Promise<unknown> {
	if (!bridge.isConnected()) {
		throw new Error("ThoriumBridge is not connected. Use thorium_orchestrator_init first.");
	}
	return await bridge.sendRequest("memory.write", { scope, key, value });
}

async function bridgeHookInvoke(hookName: string, args: Record<string, unknown>): Promise<unknown> {
	if (!bridge.isConnected()) {
		throw new Error("ThoriumBridge is not connected. Use thorium_orchestrator_init first.");
	}
	return await bridge.sendRequest("hook.invoke", { hookName, args });
}

async function bridgeConsensusPropose(
	ballotType: string,
	description: string,
	proposer: string
): Promise<unknown> {
	if (!bridge.isConnected()) {
		throw new Error("ThoriumBridge is not connected. Use thorium_orchestrator_init first.");
	}
	return await bridge.sendRequest("consensus.propose", {
		ballotType,
		description,
		proposer,
	});
}

async function bridgeConsensusVote(
	ballotId: string,
	voter: string,
	vote: string
): Promise<unknown> {
	if (!bridge.isConnected()) {
		throw new Error("ThoriumBridge is not connected. Use thorium_orchestrator_init first.");
	}
	return await bridge.sendRequest("consensus.vote", {
		ballotId,
		voter,
		vote,
	});
}

// =============================================================================
// Extension Registration
// =============================================================================

export default function thoriumOrchestratorExtension(pi: ExtensionAPI) {
	// =========================================================================
	// Tool: thorium_agent_spawn
	// =========================================================================

	pi.registerTool({
		name: "thorium_agent_spawn",
		label: "Spawn Thorium Agent",
		description:
			"Spawn a Thorium agent in an isolated Vers VM. Supports Bob (generator), Mary (verifier), " +
			"Peter (monitor), and Steve (ambassador). Set isLieutenant=true for a persistent tmux-based " +
			"session that survives SSH disconnects.",
		parameters: Type.Object({
			agent: Type.Union(
				[
					Type.Literal("bob"),
					Type.Literal("mary"),
					Type.Literal("peter"),
					Type.Literal("steve"),
				],
				{ description: "Agent type to spawn" }
			),
			commitId: Type.String({
				description: "Golden image commit ID",
			}),
			workspace: Type.String({
				description: "Workspace directory path (will be mounted in VM)",
			}),
			language: Type.Optional(
				Type.String({
					description: "Target language (for language-specific optimization)",
				})
			),
			vcpu: Type.Optional(
				Type.Number({
					description: "Number of vCPUs (default: auto per agent type)",
				})
			),
			memory: Type.Optional(
				Type.Number({
					description: "Memory size in MiB (default: auto per agent type)",
				})
			),
			isLieutenant: Type.Optional(
				Type.Boolean({
					description: "Use lieutenant pattern (persistent tmux session) instead of fire-and-forget (default: false)",
				})
			),
		}),
		async execute(_id, params) {
			try {
				const { agent: agentType, commitId, workspace, language, vcpu, memory, isLieutenant } =
					params as {
						agent: AgentType;
						commitId: string;
						workspace: string;
						language?: string;
						vcpu?: number;
						memory?: number;
						isLieutenant?: boolean;
					};

				const agent = await spawnAgent(
					agentType,
					commitId,
					workspace,
					language,
					vcpu,
					memory,
					isLieutenant
				);

				return {
					content: [
						{
							type: "text" as const,
							text: `Agent ${agent.type} (${agent.thoriumRole}) spawned in VM ${agent.vmId}${agent.isLieutenant ? " [lieutenant]" : ""}`,
						},
					],
					details: {
						success: true,
						agentId: agent.id,
						vmId: agent.vmId,
						type: agent.type,
						thoriumRole: agent.thoriumRole,
						status: agent.status,
						isLieutenant: agent.isLieutenant,
					},
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to spawn agent: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: {
						success: false,
						error: err instanceof Error ? err.message : String(err),
					},
				};
			}
		},
	});

	// =========================================================================
	// Tool: thorium_agent_task
	// =========================================================================

	pi.registerTool({
		name: "thorium_agent_task",
		label: "Send Task to Agent",
		description:
			"Send an event or task to a Thorium agent. The event is logged to the agent's event " +
			"journal on the VM. For lieutenant agents, the event is sent via the persistent FIFO.",
		parameters: Type.Object({
			agentId: Type.String({
				description: "Agent ID",
			}),
			event: Type.String({
				description: "Event type (e.g., 'spec.ready', 'code.ready', 'verification.stage')",
			}),
			payload: Type.Record(Type.String(), Type.Any(), {
				description: "Event payload data",
			}),
		}),
		async execute(_id, params) {
			try {
				const { agentId, event, payload } = params as {
					agentId: string;
					event: string;
					payload: Record<string, unknown>;
				};

				await sendTaskToAgent(agentId, event, payload);
				const agent = agents.get(agentId);

				return {
					content: [
						{
							type: "text" as const,
							text: `Event "${event}" sent to agent ${agentId} (${agent?.type}/${agent?.thoriumRole})`,
						},
					],
					details: {
						success: true,
						agentId,
						status: agent?.status,
						event,
					},
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to send task: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: {
						success: false,
						error: err instanceof Error ? err.message : String(err),
					},
				};
			}
		},
	});

	// =========================================================================
	// Tool: thorium_agent_status
	// =========================================================================

	pi.registerTool({
		name: "thorium_agent_status",
		label: "Agent Status",
		description:
			"Check the status of a specific Thorium agent or list all agents. " +
			"Returns agent type, Thorium role, VM ID, status, and event history.",
		parameters: Type.Object({
			agentId: Type.Optional(
				Type.String({
					description: "Agent ID (omit to list all agents)",
				})
			),
		}),
		async execute(_id, params) {
			try {
				const { agentId } = params as { agentId?: string };

				if (agentId) {
					const agent = agents.get(agentId);
					if (!agent) {
						return {
							content: [{ type: "text" as const, text: `Agent ${agentId} not found` }],
							details: { success: false, error: `Agent ${agentId} not found` },
						};
					}

					const info = {
						id: agent.id,
						type: agent.type,
						thoriumRole: agent.thoriumRole,
						vmId: agent.vmId,
						status: agent.status,
						language: agent.language,
						isLieutenant: agent.isLieutenant,
						lastEvent: agent.lastEvent,
						eventsProcessed: agent.events.length,
						uptime: Math.floor((Date.now() - agent.createdAt) / 1000),
					};

					const lines = [
						`Agent ${info.id}`,
						`  Type:       ${info.type} (${info.thoriumRole})`,
						`  VM:         ${info.vmId.slice(0, 12)}`,
						`  Status:     ${info.status}`,
						`  Language:   ${info.language || "n/a"}`,
						`  Lieutenant: ${info.isLieutenant}`,
						`  Events:     ${info.eventsProcessed} (last: ${info.lastEvent || "none"})`,
						`  Uptime:     ${info.uptime}s`,
					];

					return {
						content: [{ type: "text" as const, text: lines.join("\n") }],
						details: { success: true, agent: info },
					};
				} else {
					const allAgents = Array.from(agents.values()).map((agent) => ({
						id: agent.id,
						type: agent.type,
						thoriumRole: agent.thoriumRole,
						vmId: agent.vmId,
						status: agent.status,
						language: agent.language,
						isLieutenant: agent.isLieutenant,
						lastEvent: agent.lastEvent,
						eventsProcessed: agent.events.length,
						uptime: Math.floor((Date.now() - agent.createdAt) / 1000),
					}));

					if (allAgents.length === 0) {
						return {
							content: [{ type: "text" as const, text: "No agents running." }],
							details: { success: true, agents: [], count: 0 },
						};
					}

					const lines = [`${allAgents.length} agent(s):`];
					for (const a of allAgents) {
						const lt = a.isLieutenant ? " [lt]" : "";
						lines.push(
							`  ${a.id} — ${a.type}/${a.thoriumRole} [${a.status}]${lt} (${a.vmId.slice(0, 12)})`
						);
					}

					return {
						content: [{ type: "text" as const, text: lines.join("\n") }],
						details: { success: true, agents: allAgents, count: allAgents.length },
					};
				}
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Status check failed: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: {
						success: false,
						error: err instanceof Error ? err.message : String(err),
					},
				};
			}
		},
	});

	// =========================================================================
	// Tool: thorium_agent_read
	// =========================================================================

	pi.registerTool({
		name: "thorium_agent_read",
		label: "Read Agent Output",
		description:
			"Read output from a Thorium agent. For lieutenant agents, reads from the " +
			"persistent session output. For fire-and-forget agents, reads the output log.",
		parameters: Type.Object({
			agentId: Type.String({
				description: "Agent ID",
			}),
			tail: Type.Optional(
				Type.Number({
					description: "Number of characters from end of output (default: all)",
				})
			),
		}),
		async execute(_id, params) {
			try {
				const { agentId, tail } = params as { agentId: string; tail?: number };

				const agent = agents.get(agentId);
				if (!agent) {
					return {
						content: [{ type: "text" as const, text: `Agent ${agentId} not found` }],
						details: { success: false, error: `Agent ${agentId} not found` },
					};
				}

				let output: string;
				if (agent.isLieutenant) {
					output = await readLieutenantOutput(agent.vmId, agent.type, tail);
				} else {
					output = await sshExec(agent.vmId, "cat /root/.thorium/output.log 2>/dev/null || echo ''");
				}

				agent.lastOutput = output;
				agents.set(agentId, agent);

				const displayOutput =
					tail && output.length > tail ? output.slice(-tail) : output;

				return {
					content: [{ type: "text" as const, text: displayOutput || "(no output)" }],
					details: {
						success: true,
						agentId: agent.id,
						totalLength: output.length,
					},
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Read failed: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: {
						success: false,
						error: err instanceof Error ? err.message : String(err),
					},
				};
			}
		},
	});

	// =========================================================================
	// Tool: thorium_agent_teardown
	// =========================================================================

	pi.registerTool({
		name: "thorium_agent_teardown",
		label: "Teardown Agent",
		description:
			"Shutdown and cleanup Thorium agents. Tears down lieutenant sessions, " +
			"deletes VMs, and publishes shutdown events to the bridge.",
		parameters: Type.Object({
			agentId: Type.Optional(
				Type.String({
					description: "Agent ID (omit to teardown all agents)",
				})
			),
		}),
		async execute(_id, params) {
			try {
				const { agentId } = params as { agentId?: string };
				const toDelete: string[] = [];

				if (agentId) {
					const agent = agents.get(agentId);
					if (!agent) {
						return {
							content: [{ type: "text" as const, text: `Agent ${agentId} not found` }],
							details: { success: false, error: `Agent ${agentId} not found` },
						};
					}
					toDelete.push(agentId);
				} else {
					toDelete.push(...agents.keys());
				}

				const deleted: string[] = [];
				const errors: string[] = [];

				for (const id of toDelete) {
					const agent = agents.get(id);
					if (!agent) continue;

					try {
						// Teardown lieutenant session if applicable
						if (agent.isLieutenant) {
							try {
								await teardownLieutenantSession(agent.vmId, agent.type);
							} catch {
								// Best effort — VM might already be gone
							}
						}

						// Delete VM
						await versApi("DELETE", `/vm/${encodeURIComponent(agent.vmId)}`);

						// Publish shutdown event
						if (bridge.isConnected()) {
							try {
								await bridge.publishEvent("agent.stopped", {
									agentId: id,
									agentType: agent.type,
									thoriumRole: agent.thoriumRole,
									vmId: agent.vmId,
								});
							} catch {
								// Best effort
							}
						}

						agents.delete(id);
						deleted.push(id);
					} catch (err) {
						errors.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
					}
				}

				const text = errors.length > 0
					? `Deleted ${deleted.length} agent(s) with ${errors.length} error(s):\n${errors.join("\n")}`
					: `Deleted ${deleted.length} agent(s)`;

				return {
					content: [{ type: "text" as const, text }],
					details: {
						success: errors.length === 0,
						deleted,
						errors: errors.length > 0 ? errors : undefined,
					},
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Teardown failed: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: {
						success: false,
						error: err instanceof Error ? err.message : String(err),
					},
				};
			}
		},
	});

	// =========================================================================
	// Tool: thorium_verification_swarm
	// =========================================================================

	pi.registerTool({
		name: "thorium_verification_swarm",
		label: "Spawn Verification Swarm",
		description:
			"Spawn a parallel verification swarm. Each verification stage runs in its own " +
			"VM simultaneously (using Promise.allSettled), following the Thorium verification " +
			"pipeline order: Build > Format > Lint > Test > Fuzz > Integration > Static > Policy.",
		parameters: Type.Object({
			language: Type.String({
				description: "Programming language",
			}),
			workspace: Type.String({
				description: "Workspace directory path",
			}),
			stages: Type.Array(Type.String(), {
				description: "Verification stages (e.g., ['build', 'format', 'lint', 'test'])",
			}),
			commitId: Type.String({
				description: "Golden image commit ID",
			}),
		}),
		async execute(_id, params) {
			try {
				const { language, workspace, stages, commitId } = params as {
					language: string;
					workspace: string;
					stages: string[];
					commitId: string;
				};

				const swarmId = await spawnVerificationSwarm(
					language,
					workspace,
					stages,
					commitId
				);

				const swarm = swarms.get(swarmId);
				const stageStatus = swarm
					? swarm.stages.map((s) => `  ${s.name}: ${s.status}`).join("\n")
					: "";

				return {
					content: [
						{
							type: "text" as const,
							text: `Verification swarm spawned with ${stages.length} parallel stage(s)\n${stageStatus}`,
						},
					],
					details: {
						success: true,
						swarmId,
						stages: stages,
					},
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Swarm spawn failed: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: {
						success: false,
						error: err instanceof Error ? err.message : String(err),
					},
				};
			}
		},
	});

	// =========================================================================
	// Tool: thorium_verification_wait
	// =========================================================================

	pi.registerTool({
		name: "thorium_verification_wait",
		label: "Wait for Verification",
		description:
			"Wait for a verification swarm to complete. Polls agent statuses and returns " +
			"per-stage pass/fail results. Publishes verification events to the bridge.",
		parameters: Type.Object({
			swarmId: Type.String({
				description: "Verification swarm ID",
			}),
			timeout: Type.Optional(
				Type.Number({
					description: "Timeout in seconds (default: 300)",
				})
			),
		}),
		async execute(_id, params) {
			try {
				const { swarmId, timeout } = params as { swarmId: string; timeout?: number };

				const results = await waitForVerification(swarmId, timeout || 300);
				const allPassed = Object.values(results).every((r) => r.pass);
				const swarm = swarms.get(swarmId);

				const lines = [
					allPassed
						? "All verification stages passed"
						: "Some verification stages failed",
				];
				for (const [name, result] of Object.entries(results)) {
					const icon = result.pass ? "PASS" : "FAIL";
					lines.push(`  ${icon} ${name}`);
				}

				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
					details: {
						success: true,
						swarmId,
						status: swarm?.status,
						allPassed,
						results,
					},
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Wait failed: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: {
						success: false,
						error: err instanceof Error ? err.message : String(err),
					},
				};
			}
		},
	});

	// =========================================================================
	// Tool: thorium_orchestrator_init
	// =========================================================================

	pi.registerTool({
		name: "thorium_orchestrator_init",
		label: "Initialize Thorium Bridge",
		description:
			"Initialize the ThoriumBridge for bi-directional communication with Thorium's " +
			"Eagle DSL layer. Creates bridge directories under workspace/.thorium-bridge/ " +
			"and starts polling for events and responses.",
		parameters: Type.Object({
			thoriumRoot: Type.String({
				description: "Path to the Thorium project root directory",
			}),
			pollIntervalMs: Type.Optional(
				Type.Number({
					description: "Poll interval in milliseconds (default: 500)",
				})
			),
			requestTimeoutMs: Type.Optional(
				Type.Number({
					description: "Request timeout in milliseconds (default: 30000)",
				})
			),
		}),
		async execute(_id, params) {
			try {
				const { thoriumRoot, pollIntervalMs, requestTimeoutMs } = params as {
					thoriumRoot: string;
					pollIntervalMs?: number;
					requestTimeoutMs?: number;
				};

				// Validate thorium root exists
				try {
					await access(thoriumRoot, constants.F_OK);
				} catch {
					return {
						content: [
							{
								type: "text" as const,
								text: `Thorium root not found: ${thoriumRoot}`,
							},
						],
						details: { success: false, error: `Path not found: ${thoriumRoot}` },
					};
				}

				// Disconnect if already connected (reconnect scenario)
				if (bridge.isConnected()) {
					await bridge.disconnect();
				}

				await bridge.connect({
					thoriumRoot,
					pollIntervalMs,
					requestTimeoutMs,
				});

				// Publish initialization event
				await bridge.publishEvent("orchestrator.initialized", {
					thoriumRoot,
					pollIntervalMs: pollIntervalMs ?? 500,
					requestTimeoutMs: requestTimeoutMs ?? 30000,
					agentCount: agents.size,
					swarmCount: swarms.size,
				});

				const bridgeDir = join(thoriumRoot, "workspace", ".thorium-bridge");

				return {
					content: [
						{
							type: "text" as const,
							text: [
								`ThoriumBridge connected to ${thoriumRoot}`,
								`  Requests:  ${join(bridgeDir, "requests/")}`,
								`  Responses: ${join(bridgeDir, "responses/")}`,
								`  Events:    ${join(bridgeDir, "events.jsonl")}`,
								`  Polling:   ${pollIntervalMs ?? 500}ms`,
								`  Timeout:   ${requestTimeoutMs ?? 30000}ms`,
							].join("\n"),
						},
					],
					details: {
						success: true,
						thoriumRoot,
						bridgeDir,
						connected: true,
					},
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Bridge init failed: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: {
						success: false,
						error: err instanceof Error ? err.message : String(err),
					},
				};
			}
		},
	});

	// =========================================================================
	// Tool: thorium_orchestrator_status
	// =========================================================================

	pi.registerTool({
		name: "thorium_orchestrator_status",
		label: "Orchestrator Status",
		description:
			"Returns comprehensive status: bridge connection state, all agents, " +
			"all swarms, active subscriptions, and uptime.",
		parameters: Type.Object({}),
		async execute() {
			try {
				const agentList = Array.from(agents.values()).map((a) => ({
					id: a.id,
					type: a.type,
					thoriumRole: a.thoriumRole,
					status: a.status,
					vmId: a.vmId.slice(0, 12),
					isLieutenant: a.isLieutenant,
					uptime: Math.floor((Date.now() - a.createdAt) / 1000),
				}));

				const swarmList = Array.from(swarms.values()).map((s) => ({
					id: s.id,
					language: s.language,
					status: s.status,
					stages: s.stages.length,
					passed: s.stages.filter((st) => st.status === "passed").length,
					failed: s.stages.filter((st) => st.status === "failed").length,
					running: s.stages.filter((st) => st.status === "running").length,
				}));

				const subscriptionList = Array.from(activeSubscriptions.entries()).map(
					([pattern, id]) => ({ pattern, subscriptionId: id })
				);

				const bridgeStatus = {
					connected: bridge.isConnected(),
					thoriumRoot: bridge.getThoriumRoot() || null,
					uptimeSeconds: bridge.uptimeSeconds(),
				};

				const extensionUptime = Math.floor((Date.now() - extensionStartedAt) / 1000);

				const lines = [
					`Thorium Orchestrator Status`,
					``,
					`Bridge: ${bridgeStatus.connected ? "CONNECTED" : "DISCONNECTED"}${
						bridgeStatus.connected ? ` (${bridgeStatus.uptimeSeconds}s uptime)` : ""
					}`,
					bridgeStatus.thoriumRoot ? `  Root: ${bridgeStatus.thoriumRoot}` : "",
					``,
					`Agents: ${agentList.length}`,
				];

				for (const a of agentList) {
					const lt = a.isLieutenant ? " [lt]" : "";
					lines.push(`  ${a.id} — ${a.type}/${a.thoriumRole} [${a.status}]${lt} (${a.vmId})`);
				}

				lines.push(``, `Swarms: ${swarmList.length}`);
				for (const s of swarmList) {
					lines.push(
						`  ${s.id} — ${s.language} [${s.status}] (${s.passed}/${s.stages} passed, ${s.failed} failed, ${s.running} running)`
					);
				}

				if (subscriptionList.length > 0) {
					lines.push(``, `Subscriptions: ${subscriptionList.length}`);
					for (const sub of subscriptionList) {
						lines.push(`  ${sub.pattern} (${sub.subscriptionId})`);
					}
				}

				lines.push(``, `Extension uptime: ${extensionUptime}s`);

				return {
					content: [{ type: "text" as const, text: lines.filter(Boolean).join("\n") }],
					details: {
						success: true,
						bridge: bridgeStatus,
						agents: agentList,
						swarms: swarmList,
						subscriptions: subscriptionList,
						extensionUptime,
					},
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Status failed: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: {
						success: false,
						error: err instanceof Error ? err.message : String(err),
					},
				};
			}
		},
	});

	// =========================================================================
	// Tool: thorium_event_publish
	// =========================================================================

	pi.registerTool({
		name: "thorium_event_publish",
		label: "Publish Thorium Event",
		description:
			"Publish an event to Thorium via the bridge. The event is appended to the " +
			"shared events.jsonl file, where Thorium's Eagle DSL layer can read it. " +
			"Requires the bridge to be connected (thorium_orchestrator_init).",
		parameters: Type.Object({
			eventName: Type.String({
				description: "Event name (e.g., 'code.ready', 'verification.passed')",
			}),
			payload: Type.Record(Type.String(), Type.Any(), {
				description: "Event payload data",
			}),
		}),
		async execute(_id, params) {
			try {
				const { eventName, payload } = params as {
					eventName: string;
					payload: Record<string, unknown>;
				};

				if (!bridge.isConnected()) {
					return {
						content: [
							{
								type: "text" as const,
								text: "ThoriumBridge is not connected. Use thorium_orchestrator_init first.",
							},
						],
						details: { success: false, error: "Bridge not connected" },
					};
				}

				await bridge.publishEvent(eventName, payload);

				return {
					content: [
						{
							type: "text" as const,
							text: `Event "${eventName}" published to Thorium bridge`,
						},
					],
					details: {
						success: true,
						eventName,
						payload,
					},
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Publish failed: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: {
						success: false,
						error: err instanceof Error ? err.message : String(err),
					},
				};
			}
		},
	});

	// =========================================================================
	// Tool: thorium_event_subscribe
	// =========================================================================

	pi.registerTool({
		name: "thorium_event_subscribe",
		label: "Subscribe to Thorium Events",
		description:
			"Subscribe to Thorium events matching a pattern. Supports exact names " +
			"(e.g., 'agent.started'), prefix wildcards ('agent.*'), suffix wildcards " +
			"('*.failed'), and catch-all ('*'). Events are logged and can be read " +
			"via thorium_agent_status. Requires bridge connection.",
		parameters: Type.Object({
			eventPattern: Type.String({
				description: "Event pattern to subscribe to (e.g., 'agent.*', 'verification.failed', '*')",
			}),
		}),
		async execute(_id, params) {
			try {
				const { eventPattern } = params as { eventPattern: string };

				if (!bridge.isConnected()) {
					return {
						content: [
							{
								type: "text" as const,
								text: "ThoriumBridge is not connected. Use thorium_orchestrator_init first.",
							},
						],
						details: { success: false, error: "Bridge not connected" },
					};
				}

				if (activeSubscriptions.has(eventPattern)) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Already subscribed to "${eventPattern}" (id: ${activeSubscriptions.get(eventPattern)})`,
							},
						],
						details: {
							success: true,
							alreadySubscribed: true,
							eventPattern,
							subscriptionId: activeSubscriptions.get(eventPattern),
						},
					};
				}

				const subscriptionId = generateId("sub");

				// Register the event handler
				bridge.onEvent(eventPattern, (event: ThoriumEvent) => {
					console.error(
						`[thorium] event [${subscriptionId}] ${event.name}: ${JSON.stringify(event.payload).slice(0, 200)}`
					);

					// Also emit on the pi extension event bus for cross-extension coordination
					try {
						pi.events.emit("thorium:event", {
							subscriptionId,
							pattern: eventPattern,
							event,
						});
					} catch {
						// Best effort
					}
				});

				activeSubscriptions.set(eventPattern, subscriptionId);

				return {
					content: [
						{
							type: "text" as const,
							text: `Subscribed to "${eventPattern}" (id: ${subscriptionId})`,
						},
					],
					details: {
						success: true,
						eventPattern,
						subscriptionId,
					},
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Subscribe failed: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: {
						success: false,
						error: err instanceof Error ? err.message : String(err),
					},
				};
			}
		},
	});

	// =========================================================================
	// Tool: thorium_hook_invoke
	// =========================================================================

	pi.registerTool({
		name: "thorium_hook_invoke",
		label: "Invoke Thorium Hook",
		description:
			"Invoke a Thorium hook via the bridge. Hooks are extension points in the " +
			"Thorium DSL that allow custom processing at defined lifecycle stages " +
			"(e.g., pre-generate, post-verify, on-failure). Requires bridge connection.",
		parameters: Type.Object({
			hookName: Type.String({
				description: "Hook name (e.g., 'pre-generate', 'post-verify', 'on-failure')",
			}),
			args: Type.Optional(
				Type.Record(Type.String(), Type.Any(), {
					description: "Arguments to pass to the hook (default: empty)",
				})
			),
		}),
		async execute(_id, params) {
			try {
				const { hookName, args } = params as {
					hookName: string;
					args?: Record<string, unknown>;
				};

				const result = await bridgeHookInvoke(hookName, args || {});

				return {
					content: [
						{
							type: "text" as const,
							text: `Hook "${hookName}" invoked successfully`,
						},
					],
					details: {
						success: true,
						hookName,
						result,
					},
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Hook invocation failed: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: {
						success: false,
						error: err instanceof Error ? err.message : String(err),
					},
				};
			}
		},
	});

	// =========================================================================
	// Tool: thorium_memory_read
	// =========================================================================

	pi.registerTool({
		name: "thorium_memory_read",
		label: "Read Thorium Memory",
		description:
			"Read a value from Thorium's shared memory via the bridge. Memory is organized " +
			"by scope (e.g., 'global', 'agent:bob', 'session') and key. Requires bridge connection.",
		parameters: Type.Object({
			scope: Type.String({
				description: "Memory scope (e.g., 'global', 'agent:bob', 'session')",
			}),
			key: Type.String({
				description: "Memory key to read",
			}),
		}),
		async execute(_id, params) {
			try {
				const { scope, key } = params as { scope: string; key: string };

				const result = await bridgeMemoryRead(scope, key);

				const display =
					result === undefined
						? `(no value at ${scope}/${key})`
						: typeof result === "string"
							? result
							: JSON.stringify(result, null, 2);

				return {
					content: [{ type: "text" as const, text: display }],
					details: {
						success: true,
						scope,
						key,
						value: result,
					},
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Memory read failed: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: {
						success: false,
						error: err instanceof Error ? err.message : String(err),
					},
				};
			}
		},
	});

	// =========================================================================
	// Tool: thorium_memory_write
	// =========================================================================

	pi.registerTool({
		name: "thorium_memory_write",
		label: "Write Thorium Memory",
		description:
			"Write a value to Thorium's shared memory via the bridge. Memory is organized " +
			"by scope and key, and is persisted by Thorium's SQLite backend. " +
			"Requires bridge connection.",
		parameters: Type.Object({
			scope: Type.String({
				description: "Memory scope (e.g., 'global', 'agent:bob', 'session')",
			}),
			key: Type.String({
				description: "Memory key to write",
			}),
			value: Type.Any({
				description: "Value to write (string, number, object, etc.)",
			}),
		}),
		async execute(_id, params) {
			try {
				const { scope, key, value } = params as {
					scope: string;
					key: string;
					value: unknown;
				};

				const result = await bridgeMemoryWrite(scope, key, value);

				return {
					content: [
						{
							type: "text" as const,
							text: `Wrote to ${scope}/${key}`,
						},
					],
					details: {
						success: true,
						scope,
						key,
						value,
						result,
					},
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Memory write failed: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: {
						success: false,
						error: err instanceof Error ? err.message : String(err),
					},
				};
			}
		},
	});

	// =========================================================================
	// Tool: thorium_consensus_propose
	// =========================================================================

	pi.registerTool({
		name: "thorium_consensus_propose",
		label: "Propose Consensus Ballot",
		description:
			"Propose a consensus ballot via the Thorium bridge. Used for multi-agent " +
			"decision-making (e.g., code acceptance, design choice). Agents can then " +
			"vote on the ballot using thorium_consensus_vote. Requires bridge connection.",
		parameters: Type.Object({
			ballotType: Type.String({
				description: "Type of ballot (e.g., 'code-acceptance', 'design-choice', 'security-review')",
			}),
			description: Type.String({
				description: "Description of what is being decided",
			}),
			proposer: Type.String({
				description: "Agent ID or name of the proposer",
			}),
		}),
		async execute(_id, params) {
			try {
				const { ballotType, description, proposer } = params as {
					ballotType: string;
					description: string;
					proposer: string;
				};

				const result = await bridgeConsensusPropose(ballotType, description, proposer);

				// Publish event for other agents to discover the ballot
				if (bridge.isConnected()) {
					try {
						await bridge.publishEvent("consensus.ballot.created", {
							ballotType,
							description,
							proposer,
							result,
						});
					} catch {
						// Best effort
					}
				}

				return {
					content: [
						{
							type: "text" as const,
							text: `Ballot proposed: ${ballotType} by ${proposer}`,
						},
					],
					details: {
						success: true,
						ballotType,
						description,
						proposer,
						result,
					},
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Propose failed: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: {
						success: false,
						error: err instanceof Error ? err.message : String(err),
					},
				};
			}
		},
	});

	// =========================================================================
	// Tool: thorium_consensus_vote
	// =========================================================================

	pi.registerTool({
		name: "thorium_consensus_vote",
		label: "Cast Consensus Vote",
		description:
			"Cast a vote on an existing consensus ballot. Valid votes depend on the " +
			"ballot type but typically include 'approve', 'reject', 'abstain'. " +
			"Requires bridge connection.",
		parameters: Type.Object({
			ballotId: Type.String({
				description: "Ballot ID to vote on",
			}),
			voter: Type.String({
				description: "Agent ID or name of the voter",
			}),
			vote: Type.String({
				description: "Vote value (e.g., 'approve', 'reject', 'abstain')",
			}),
		}),
		async execute(_id, params) {
			try {
				const { ballotId, voter, vote } = params as {
					ballotId: string;
					voter: string;
					vote: string;
				};

				const result = await bridgeConsensusVote(ballotId, voter, vote);

				// Publish vote event
				if (bridge.isConnected()) {
					try {
						await bridge.publishEvent("consensus.vote.cast", {
							ballotId,
							voter,
							vote,
							result,
						});
					} catch {
						// Best effort
					}
				}

				return {
					content: [
						{
							type: "text" as const,
							text: `Vote cast: ${voter} voted "${vote}" on ballot ${ballotId}`,
						},
					],
					details: {
						success: true,
						ballotId,
						voter,
						vote,
						result,
					},
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Vote failed: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: {
						success: false,
						error: err instanceof Error ? err.message : String(err),
					},
				};
			}
		},
	});

	// =========================================================================
	// Extension lifecycle — cleanup on shutdown
	// =========================================================================

	pi.on("session_shutdown", async () => {
		// Disconnect bridge
		if (bridge.isConnected()) {
			try {
				await bridge.publishEvent("orchestrator.shutdown", {
					agentCount: agents.size,
					swarmCount: swarms.size,
				});
			} catch {
				// Best effort
			}
			await bridge.disconnect();
		}

		// Note: we do NOT auto-teardown agents on shutdown — VMs persist
		// and can be reconnected in a future session. Use thorium_agent_teardown
		// for explicit cleanup.
	});
}
