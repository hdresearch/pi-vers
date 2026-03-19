/**
 * Core exports — harness-agnostic Vers client and swarm manager.
 * Import these if you want to build your own integration.
 */
export { VersClient, loadVersKeyFromDisk, shellEscape } from "./vers-client.js";
export type {
	Vm,
	NewVmResponse,
	VmDeleteResponse,
	VmCommitResponse,
	VmSSHKeyResponse,
	VmConfig,
	ExecResult,
	UploadDirectoryOptions,
	VersClientOptions,
} from "./vers-client.js";
export { ensureVersApiKey } from "./shell-auth.js";
export type { EnsureVersApiKeyOptions, EnsureVersApiKeyResult } from "./shell-auth.js";
export { resolveAgentBinary } from "./agent-runtime.js";

export { SwarmManager } from "./swarm.js";
export type { SwarmAgent, SpawnOptions, SpawnResult, WaitResult } from "./swarm.js";
