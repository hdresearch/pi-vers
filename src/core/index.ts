/**
 * Core exports — harness-agnostic Vers client and swarm manager.
 * Import these if you want to build your own integration.
 */
export { VersClient, loadVersKeyFromDisk, shellEscape } from "./vers-client.js";
export type { Vm, NewVmResponse, VmDeleteResponse, VmCommitResponse, VmSSHKeyResponse, VmConfig, ExecResult, VersClientOptions } from "./vers-client.js";

export { SwarmManager } from "./swarm.js";
export type { SwarmAgent, SpawnOptions, SpawnResult, WaitResult } from "./swarm.js";
