#!/usr/bin/env node
/**
 * Vers MCP Server
 *
 * Exposes Vers VM management and swarm orchestration as MCP tools.
 * Designed for Claude Code and other MCP-compatible clients.
 *
 * Usage:
 *   npx @hdresearch/vers-mcp
 *   claude mcp add vers -- npx @hdresearch/vers-mcp
 *
 * Environment:
 *   VERS_API_KEY     — Vers API key (or ~/.vers/keys.json)
 *   ANTHROPIC_API_KEY — Required for swarm agents
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { VersClient, shellEscape, type VmConfig } from "../core/vers-client.js";
import { SwarmManager } from "../core/swarm.js";
import { writeState, clearState } from "./state.js";

// =============================================================================
// State
// =============================================================================

const client = new VersClient();
const swarm = new SwarmManager(client);
let activeVmId: string | undefined;

// =============================================================================
// Helpers
// =============================================================================

function text(s: string) {
	return { content: [{ type: "text" as const, text: s }] };
}

function errorText(s: string) {
	return { content: [{ type: "text" as const, text: s }], isError: true };
}

// =============================================================================
// Server
// =============================================================================

const server = new McpServer({
	name: "vers",
	version: "0.1.0",
});

// =============================================================================
// VM Management Tools
// =============================================================================

server.tool(
	"vers_vms",
	"List all Vers VMs. Returns VM IDs, states, and creation times.",
	{},
	async () => {
		const vms = await client.list();
		const active = activeVmId ? ` (active: ${activeVmId.slice(0, 12)})` : "";
		return text(`${vms.length} VM(s)${active}\n\n${JSON.stringify(vms, null, 2)}`);
	},
);

server.tool(
	"vers_vm_create",
	"Create a new root Firecracker VM on the Vers platform. Optionally configure CPU, memory, and disk size.",
	{
		vcpu_count: z.number().optional().describe("Number of vCPUs"),
		mem_size_mib: z.number().optional().describe("RAM in MiB"),
		fs_size_mib: z.number().optional().describe("Disk size in MiB"),
		wait_boot: z.boolean().optional().describe("Wait for VM to finish booting (default: false)"),
	},
	async ({ vcpu_count, mem_size_mib, fs_size_mib, wait_boot }) => {
		const cfg: VmConfig = {};
		if (vcpu_count !== undefined) cfg.vcpu_count = vcpu_count;
		if (mem_size_mib !== undefined) cfg.mem_size_mib = mem_size_mib;
		if (fs_size_mib !== undefined) cfg.fs_size_mib = fs_size_mib;
		const result = await client.createRoot(cfg, wait_boot);
		return text(`VM created: ${result.vm_id}`);
	},
);

server.tool(
	"vers_vm_delete",
	"Delete a Vers VM by ID.",
	{ vmId: z.string().describe("VM ID to delete") },
	async ({ vmId }) => {
		if (activeVmId === vmId) activeVmId = undefined;
		const result = await client.delete(vmId);
		return text(`VM ${result.vm_id} deleted.`);
	},
);

server.tool(
	"vers_vm_branch",
	"Clone a VM by branching it. Creates a new VM with the same state. Like git branching for VMs.",
	{ vmId: z.string().describe("VM ID to branch from") },
	async ({ vmId }) => {
		const result = await client.branch(vmId);
		return text(`Branched VM ${vmId} -> ${result.vm_id}`);
	},
);

server.tool(
	"vers_vm_commit",
	"Snapshot a VM to a commit. The commit ID can be used later to restore or branch from this state.",
	{
		vmId: z.string().describe("VM ID to commit"),
		keep_paused: z.boolean().optional().describe("Keep VM paused after commit (default: false)"),
	},
	async ({ vmId, keep_paused }) => {
		const result = await client.commit(vmId, keep_paused);
		return text(`VM ${vmId} committed: ${result.commit_id}`);
	},
);

server.tool(
	"vers_vm_restore",
	"Restore a new VM from a previously created commit.",
	{ commitId: z.string().describe("Commit ID to restore from") },
	async ({ commitId }) => {
		const result = await client.restoreFromCommit(commitId);
		return text(`Restored from commit ${commitId} -> VM ${result.vm_id}`);
	},
);

server.tool(
	"vers_vm_state",
	"Pause or resume a Vers VM.",
	{
		vmId: z.string().describe("VM ID to update"),
		state: z.enum(["Paused", "Running"]).describe("Target state"),
	},
	async ({ vmId, state }) => {
		await client.updateState(vmId, state);
		return text(`VM ${vmId} state set to ${state}.`);
	},
);

// =============================================================================
// Active VM — set/clear which VM remote tools execute on
// =============================================================================

server.tool(
	"vers_vm_use",
	"Set the active VM. After calling this, vers_bash/vers_read/vers_edit/vers_write execute on this VM via SSH.",
	{ vmId: z.string().describe("VM ID to use as the active execution target") },
	async ({ vmId }) => {
		const result = await client.exec(vmId, "echo ok");
		if (result.stdout.trim() !== "ok") {
			return errorText(`Cannot reach VM ${vmId}: ${result.stderr}`);
		}
		activeVmId = vmId;
		await writeState({ activeVmId: vmId, updatedAt: new Date().toISOString() });
		return text(`Active VM set to ${vmId}. Use vers_bash/vers_read/vers_edit/vers_write to execute on it.`);
	},
);

server.tool(
	"vers_vm_local",
	"Clear the active VM. vers_bash/vers_read/vers_edit/vers_write will error until a VM is set.",
	{},
	async () => {
		const prev = activeVmId;
		activeVmId = undefined;
		await clearState();
		return text(prev ? `Cleared active VM (was ${prev}).` : "Already in local mode.");
	},
);

// =============================================================================
// Remote Execution Tools (require active VM)
// =============================================================================

function requireActiveVm(): string {
	if (!activeVmId) {
		throw new Error("No active VM. Call vers_vm_use first to set one.");
	}
	return activeVmId;
}

server.tool(
	"vers_bash",
	"Execute a bash command on the active Vers VM via SSH. Call vers_vm_use first to set the target VM.",
	{
		command: z.string().describe("Bash command to execute"),
		timeout: z.number().optional().describe("Timeout in seconds (default: 120). Pass 0 for no timeout."),
	},
	async ({ command, timeout }) => {
		const vmId = requireActiveVm();
		const timeoutMs = timeout !== undefined ? (timeout > 0 ? timeout * 1000 : 300000) : 120000;

		const result = await client.exec(vmId, command, timeoutMs);
		const output = (result.stdout + result.stderr).trim() || "(no output)";

		if (result.exitCode !== 0) {
			return errorText(`${output}\n\nCommand exited with code ${result.exitCode}`);
		}
		return text(output);
	},
);

server.tool(
	"vers_read",
	"Read a file from the active Vers VM via SSH. Supports offset/limit for large files. Call vers_vm_use first.",
	{
		path: z.string().describe("Path to the file to read"),
		offset: z.number().optional().describe("Line number to start reading from (1-indexed)"),
		limit: z.number().optional().describe("Maximum number of lines to read"),
	},
	async ({ path, offset, limit }) => {
		const vmId = requireActiveVm();

		let cmd: string;
		if (offset && limit) {
			cmd = `sed -n '${offset},${offset + limit - 1}p' ${shellEscape(path)}`;
		} else if (offset) {
			cmd = `tail -n +${offset} ${shellEscape(path)}`;
		} else if (limit) {
			cmd = `head -n ${limit} ${shellEscape(path)}`;
		} else {
			cmd = `cat ${shellEscape(path)}`;
		}

		const wcResult = await client.exec(vmId, `wc -l < ${shellEscape(path)}`);
		const totalLines = parseInt(wcResult.stdout.trim()) || 0;

		const result = await client.exec(vmId, cmd);
		if (result.exitCode !== 0) {
			return errorText(result.stderr || `Failed to read ${path}`);
		}

		let output = result.stdout;
		const outputLines = output.split("\n").length;

		if (output.length > 50000) {
			output = output.slice(0, 50000) + "\n\n[Output truncated at 50KB. Use offset/limit for large files.]";
		}

		const startLine = offset || 1;
		const endLine = startLine + outputLines - 1;
		if (endLine < totalLines) {
			output += `\n\n[Showing lines ${startLine}-${endLine} of ${totalLines}. Use offset=${endLine + 1} to continue.]`;
		}

		return text(output);
	},
);

server.tool(
	"vers_edit",
	"Edit a file on the active Vers VM by replacing exact text. The oldText must match exactly. Call vers_vm_use first.",
	{
		path: z.string().describe("Path to the file to edit"),
		oldText: z.string().describe("Exact text to find and replace"),
		newText: z.string().describe("New text to replace with"),
	},
	async ({ path, oldText, newText }) => {
		const vmId = requireActiveVm();

		const readResult = await client.exec(vmId, `cat ${shellEscape(path)}`);
		if (readResult.exitCode !== 0) {
			return errorText(readResult.stderr || `File not found: ${path}`);
		}

		const content = readResult.stdout;
		const index = content.indexOf(oldText);
		if (index === -1) {
			return errorText(`Could not find the exact text in ${path}. Must match exactly including whitespace.`);
		}
		if (content.indexOf(oldText, index + 1) !== -1) {
			return errorText(`Found multiple occurrences in ${path}. Provide more context to make it unique.`);
		}

		const newContent = content.substring(0, index) + newText + content.substring(index + oldText.length);
		const marker = `VERS_EOF_${Date.now()}`;
		const writeCmd = `cat > ${shellEscape(path)} << '${marker}'\n${newContent}\n${marker}`;
		const writeResult = await client.exec(vmId, writeCmd);
		if (writeResult.exitCode !== 0) {
			return errorText(writeResult.stderr || `Failed to write ${path}`);
		}

		return text(`Successfully replaced text in ${path}.`);
	},
);

server.tool(
	"vers_write",
	"Write content to a file on the active Vers VM. Creates parent directories automatically. Call vers_vm_use first.",
	{
		path: z.string().describe("Path to the file to write"),
		content: z.string().describe("Content to write to the file"),
	},
	async ({ path, content }) => {
		const vmId = requireActiveVm();

		const dir = path.replace(/\/[^/]*$/, "");
		if (dir && dir !== path) {
			await client.exec(vmId, `mkdir -p ${shellEscape(dir)}`);
		}

		const marker = `VERS_EOF_${Date.now()}`;
		const writeCmd = `cat > ${shellEscape(path)} << '${marker}'\n${content}\n${marker}`;
		const result = await client.exec(vmId, writeCmd);
		if (result.exitCode !== 0) {
			return errorText(result.stderr || `Failed to write ${path}`);
		}

		return text(`Successfully wrote ${content.length} bytes to ${path}`);
	},
);

// =============================================================================
// Swarm Tools
// =============================================================================

server.tool(
	"vers_swarm_spawn",
	"Branch N VMs from a golden commit and start pi coding agents on each. Each agent runs pi in RPC mode, ready to receive tasks.",
	{
		commitId: z.string().describe("Golden image commit ID to branch from"),
		count: z.number().describe("Number of agents to spawn"),
		labels: z.array(z.string()).optional().describe("Labels for each agent"),
		anthropicApiKey: z.string().describe("Anthropic API key for the agents to use"),
		model: z.string().optional().describe("Model ID for agents (default: claude-sonnet-4-20250514)"),
	},
	async ({ commitId, count, labels, anthropicApiKey, model }) => {
		const result = await swarm.spawn({ commitId, count, labels, anthropicApiKey, model });
		return text(`Spawned ${count} agent(s):\n${result.messages.join("\n")}\n\n${swarm.agentSummary()}`);
	},
);

server.tool(
	"vers_swarm_task",
	"Send a task (prompt) to a specific swarm agent. The agent will begin working on it autonomously.",
	{
		agentId: z.string().describe("Agent label/ID to send task to"),
		task: z.string().describe("The task prompt to send"),
	},
	async ({ agentId, task }) => {
		swarm.sendTask(agentId, task);
		return text(`Task sent to ${agentId}: "${task.slice(0, 100)}${task.length > 100 ? "..." : ""}"`);
	},
);

server.tool(
	"vers_swarm_wait",
	"Block until all agents (or specified agents) finish. Returns each agent's full text output.",
	{
		agentIds: z.array(z.string()).optional().describe("Specific agent IDs to wait for (default: all)"),
		timeoutSeconds: z.number().optional().describe("Max seconds to wait (default: 300)"),
	},
	async ({ agentIds, timeoutSeconds }) => {
		const result = await swarm.wait(agentIds, timeoutSeconds);
		const output = result.agents.map(a => `=== ${a.id} [${a.status}] ===\n${a.output}\n`).join("\n");
		return text(`${result.timedOut ? "TIMED OUT after" : "All agents finished in"} ${result.elapsed}s\n\n${output}`);
	},
);

server.tool(
	"vers_swarm_status",
	"Check the status of all agents in the swarm.",
	{},
	async () => {
		return text(swarm.agentSummary());
	},
);

server.tool(
	"vers_swarm_read",
	"Read the latest text output from a specific swarm agent.",
	{
		agentId: z.string().describe("Agent label/ID to read from"),
		tail: z.number().optional().describe("Number of characters from the end to return (default: all)"),
	},
	async ({ agentId, tail }) => {
		const agent = swarm.getAgent(agentId);
		if (!agent) return errorText(`Agent '${agentId}' not found. Available: ${swarm.getAgentIds().join(", ")}`);

		let output = agent.lastOutput || "(no output yet)";
		if (tail && output.length > tail) {
			output = "..." + output.slice(-tail);
		}
		return text(`[${agentId}] (${agent.status}):\n\n${output}`);
	},
);

server.tool(
	"vers_swarm_teardown",
	"Stop all swarm agents and delete their VMs.",
	{},
	async () => {
		const results = await swarm.teardown();
		return text(`Swarm torn down:\n${results.join("\n")}`);
	},
);

// =============================================================================
// Start
// =============================================================================

async function main() {
	// Clean slate on startup
	await clearState();

	// Clean up on exit
	process.on("SIGINT", async () => { await clearState(); process.exit(0); });
	process.on("SIGTERM", async () => { await clearState(); process.exit(0); });

	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error("Vers MCP server running on stdio");
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
