/**
 * Thorium Orchestrator Extension
 *
 * Integrates Thorium multi-agent framework with Vers VM orchestration.
 * Provides lifecycle management for Thorium agents (Bob, Mary, Peter) running
 * in isolated VMs, with support for event-driven coordination and parallel verification.
 *
 * Tools:
 *   thorium_agent_spawn       - Spawn a Thorium agent in a VM
 *   thorium_agent_task        - Send an event/task to an agent
 *   thorium_agent_status      - Check status of agents
 *   thorium_agent_read        - Read agent output
 *   thorium_agent_teardown    - Shutdown and cleanup agents
 *   thorium_verification_swarm - Spawn parallel verification swarm
 *   thorium_verification_wait  - Wait for verification results
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn, exec } from "node:child_process";
import { writeFile, mkdir, readdir, stat, access, readFile, appendFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// =============================================================================
// Types
// =============================================================================

type AgentType = "bob" | "mary" | "peter";
type AgentStatus = "starting" | "idle" | "working" | "done" | "error";

interface ThoriumAgent {
	id: string;
	type: AgentType;
	vmId: string;
	status: AgentStatus;
	language?: string;
	workspace: string;
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
// State Management
// =============================================================================

const agents = new Map<string, ThoriumAgent>();
const swarms = new Map<string, VerificationSwarm>();

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
// Agent Management
// =============================================================================

async function spawnAgent(
	type: AgentType,
	commitId: string,
	workspace: string,
	language?: string,
	vcpu?: number,
	memory?: number
): Promise<ThoriumAgent> {
	// Create VM from golden image
	const restoreBody = {
		commit_id: commitId,
		vcpu_count: vcpu || (type === "bob" ? 2 : type === "mary" ? 2 : 1),
		mem_size_mib: memory || (type === "bob" ? 4096 : type === "mary" ? 4096 : 2048),
	};

	const vmResponse = await versApi<NewVmResponse>("POST", "/vm/restore", restoreBody);
	const vmId = vmResponse.vm_id;

	// Wait for boot
	await waitForVmBoot(vmId);

	// Create agent record
	const agentId = generateId(type);
	const agent: ThoriumAgent = {
		id: agentId,
		type,
		vmId,
		status: "starting",
		language,
		workspace,
		lastOutput: "",
		events: [],
		createdAt: Date.now(),
	};
	agents.set(agentId, agent);

	// Initialize agent configuration in VM
	const config = {
		agentId,
		agentType: type,
		language: language || "unknown",
		workspace: "/workspace",
		thoriumVersion: "0.1.0",
	};

	await sshExec(vmId, "mkdir -p /root/.thorium");
	await sshExec(vmId, `cat > /root/.thorium/config.json <<'EOF'\n${JSON.stringify(config, null, 2)}\nEOF`);
	await sshExec(vmId, `cat > /root/.thorium/events.jsonl <<'EOF'\nEOF`);

	// Update status
	agent.status = "idle";
	agents.set(agentId, agent);

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

	await sshExec(agent.vmId, `echo '${JSON.stringify(eventData)}' >> /root/.thorium/events.jsonl`);

	// Trigger agent processing (would normally be done by agent daemon in VM)
	// For now, we just log the event - actual processing would be done by pi agent in VM
}

// =============================================================================
// Verification Swarm
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

	// Spawn VM for each stage
	for (const stage of swarm.stages) {
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
		} catch (err) {
			stage.status = "failed";
			stage.output = err instanceof Error ? err.message : String(err);
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
			return results;
		}

		await new Promise(resolve => setTimeout(resolve, 1000));
	}

	throw new Error(`Verification timed out after ${timeout}s`);
}

// =============================================================================
// Extension Registration
// =============================================================================

export async function register(api: ExtensionAPI): Promise<void> {
	// thorium_agent_spawn
	api.registerTool(
		"thorium_agent_spawn",
		Type.Object({
			agent: Type.Union([Type.Literal("bob"), Type.Literal("mary"), Type.Literal("peter")], {
				description: "Agent type to spawn",
			}),
			commitId: Type.String({
				description: "Golden image commit ID",
			}),
			workspace: Type.String({
				description: "Workspace directory path (will be mounted in VM)",
			}),
			language: Type.Optional(Type.String({
				description: "Target language (for language-specific optimization)",
			})),
			vcpu: Type.Optional(Type.Number({
				description: "Number of vCPUs",
			})),
			memory: Type.Optional(Type.Number({
				description: "Memory size in MiB",
			})),
		}),
		async (args) => {
			try {
				const agent = await spawnAgent(
					args.agent,
					args.commitId,
					args.workspace,
					args.language,
					args.vcpu,
					args.memory
				);

				return {
					success: true,
					agentId: agent.id,
					vmId: agent.vmId,
					status: agent.status,
					message: `Agent ${agent.type} spawned in VM ${agent.vmId}`,
				};
			} catch (err) {
				return {
					success: false,
					error: err instanceof Error ? err.message : String(err),
				};
			}
		}
	);

	// thorium_agent_task
	api.registerTool(
		"thorium_agent_task",
		Type.Object({
			agentId: Type.String({
				description: "Agent ID",
			}),
			event: Type.String({
				description: "Event type (e.g., 'spec.ready', 'code.ready')",
			}),
			payload: Type.Record(Type.String(), Type.Any(), {
				description: "Event payload data",
			}),
		}),
		async (args) => {
			try {
				await sendTaskToAgent(args.agentId, args.event, args.payload);
				const agent = agents.get(args.agentId);

				return {
					success: true,
					agentId: args.agentId,
					status: agent?.status,
					message: `Event ${args.event} sent to agent ${args.agentId}`,
				};
			} catch (err) {
				return {
					success: false,
					error: err instanceof Error ? err.message : String(err),
				};
			}
		}
	);

	// thorium_agent_status
	api.registerTool(
		"thorium_agent_status",
		Type.Object({
			agentId: Type.Optional(Type.String({
				description: "Agent ID (omit to list all agents)",
			})),
		}),
		async (args) => {
			try {
				if (args.agentId) {
					const agent = agents.get(args.agentId);
					if (!agent) {
						return {
							success: false,
							error: `Agent ${args.agentId} not found`,
						};
					}

					return {
						success: true,
						agent: {
							id: agent.id,
							type: agent.type,
							vmId: agent.vmId,
							status: agent.status,
							language: agent.language,
							lastEvent: agent.lastEvent,
							eventsProcessed: agent.events.length,
							uptime: Math.floor((Date.now() - agent.createdAt) / 1000),
						},
					};
				} else {
					const allAgents = Array.from(agents.values()).map(agent => ({
						id: agent.id,
						type: agent.type,
						vmId: agent.vmId,
						status: agent.status,
						language: agent.language,
						lastEvent: agent.lastEvent,
						eventsProcessed: agent.events.length,
						uptime: Math.floor((Date.now() - agent.createdAt) / 1000),
					}));

					return {
						success: true,
						agents: allAgents,
						count: allAgents.length,
					};
				}
			} catch (err) {
				return {
					success: false,
					error: err instanceof Error ? err.message : String(err),
				};
			}
		}
	);

	// thorium_agent_read
	api.registerTool(
		"thorium_agent_read",
		Type.Object({
			agentId: Type.String({
				description: "Agent ID",
			}),
			tail: Type.Optional(Type.Number({
				description: "Number of characters from end of output",
			})),
		}),
		async (args) => {
			try {
				const agent = agents.get(args.agentId);
				if (!agent) {
					return {
						success: false,
						error: `Agent ${args.agentId} not found`,
					};
				}

				// Read output from VM
				const output = await sshExec(agent.vmId, "cat /root/.thorium/output.log 2>/dev/null || echo ''");
				agent.lastOutput = output;
				agents.set(args.agentId, agent);

				const displayOutput = args.tail && output.length > args.tail
					? output.slice(-args.tail)
					: output;

				return {
					success: true,
					agentId: agent.id,
					output: displayOutput,
					totalLength: output.length,
				};
			} catch (err) {
				return {
					success: false,
					error: err instanceof Error ? err.message : String(err),
				};
			}
		}
	);

	// thorium_agent_teardown
	api.registerTool(
		"thorium_agent_teardown",
		Type.Object({
			agentId: Type.Optional(Type.String({
				description: "Agent ID (omit to teardown all agents)",
			})),
		}),
		async (args) => {
			try {
				const toDelete: string[] = [];

				if (args.agentId) {
					const agent = agents.get(args.agentId);
					if (!agent) {
						return {
							success: false,
							error: `Agent ${args.agentId} not found`,
						};
					}
					toDelete.push(args.agentId);
				} else {
					toDelete.push(...agents.keys());
				}

				const deleted: string[] = [];
				const errors: string[] = [];

				for (const agentId of toDelete) {
					const agent = agents.get(agentId);
					if (!agent) continue;

					try {
						// Delete VM
						await versApi("DELETE", `/vm/${encodeURIComponent(agent.vmId)}`);
						agents.delete(agentId);
						deleted.push(agentId);
					} catch (err) {
						errors.push(`${agentId}: ${err instanceof Error ? err.message : String(err)}`);
					}
				}

				return {
					success: errors.length === 0,
					deleted,
					errors: errors.length > 0 ? errors : undefined,
					message: `Deleted ${deleted.length} agent(s)`,
				};
			} catch (err) {
				return {
					success: false,
					error: err instanceof Error ? err.message : String(err),
				};
			}
		}
	);

	// thorium_verification_swarm
	api.registerTool(
		"thorium_verification_swarm",
		Type.Object({
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
		async (args) => {
			try {
				const swarmId = await spawnVerificationSwarm(
					args.language,
					args.workspace,
					args.stages,
					args.commitId
				);

				return {
					success: true,
					swarmId,
					stages: args.stages,
					message: `Verification swarm spawned with ${args.stages.length} stage(s)`,
				};
			} catch (err) {
				return {
					success: false,
					error: err instanceof Error ? err.message : String(err),
				};
			}
		}
	);

	// thorium_verification_wait
	api.registerTool(
		"thorium_verification_wait",
		Type.Object({
			swarmId: Type.String({
				description: "Verification swarm ID",
			}),
			timeout: Type.Optional(Type.Number({
				description: "Timeout in seconds (default: 300)",
			})),
		}),
		async (args) => {
			try {
				const results = await waitForVerification(args.swarmId, args.timeout || 300);

				const allPassed = Object.values(results).every(r => r.pass);
				const swarm = swarms.get(args.swarmId);

				return {
					success: true,
					swarmId: args.swarmId,
					status: swarm?.status,
					allPassed,
					results,
					message: allPassed ? "All verification stages passed" : "Some verification stages failed",
				};
			} catch (err) {
				return {
					success: false,
					error: err instanceof Error ? err.message : String(err),
				};
			}
		}
	);
}
