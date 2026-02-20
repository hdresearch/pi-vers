/**
 * Vers API Client
 *
 * Pure TypeScript client for the Vers platform (vers.sh).
 * Handles API calls, SSH key management, and remote command execution.
 * No framework dependencies — used by both pi extensions and MCP server.
 */

import { execFile, spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// =============================================================================
// Types
// =============================================================================

export interface Vm {
	vm_id: string;
	owner_id: string;
	state: "booting" | "running" | "paused";
	created_at: string;
}

export interface NewVmResponse {
	vm_id: string;
}

export interface VmDeleteResponse {
	vm_id: string;
}

export interface VmCommitResponse {
	commit_id: string;
}

export interface VmSSHKeyResponse {
	ssh_port: number;
	ssh_private_key: string;
}

export interface VmConfig {
	vcpu_count?: number | null;
	mem_size_mib?: number | null;
	fs_size_mib?: number | null;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface VersClientOptions {
	apiKey?: string;
	baseURL?: string;
}

// =============================================================================
// Helpers
// =============================================================================

const DEFAULT_BASE_URL = "https://api.vers.sh/api/v1";

/** Try to read VERS_API_KEY from ~/.vers/keys.json */
export function loadVersKeyFromDisk(): string {
	try {
		const homedir = process.env.HOME || process.env.USERPROFILE || "";
		const keysPath = join(homedir, ".vers", "keys.json");
		const data = require("fs").readFileSync(keysPath, "utf-8");
		const parsed = JSON.parse(data);
		return parsed?.keys?.VERS_API_KEY || "";
	} catch {
		return "";
	}
}

export function shellEscape(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

// =============================================================================
// Client
// =============================================================================

export class VersClient {
	private explicitApiKey: string | undefined;
	private baseURL: string;
	private sshKeyCache = new Map<string, VmSSHKeyResponse>();
	private keyPathCache = new Map<string, string>();

	constructor(opts: VersClientOptions = {}) {
		this.explicitApiKey = opts.apiKey || undefined;
		this.baseURL = (opts.baseURL || process.env.VERS_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
	}

	/** Resolve the API key fresh each time — picks up keys added after session start */
	private resolveApiKey(): string {
		return this.explicitApiKey || process.env.VERS_API_KEY || loadVersKeyFromDisk() || "";
	}

	private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const url = `${this.baseURL}${path}`;
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		const apiKey = this.resolveApiKey();
		if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

		const res = await fetch(url, {
			method,
			headers,
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});

		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`Vers API ${method} ${path} failed (${res.status}): ${text}`);
		}

		const ct = res.headers.get("content-type") || "";
		if (ct.includes("application/json")) return res.json() as Promise<T>;
		return undefined as T;
	}

	// =========================================================================
	// VM API
	// =========================================================================

	async list(): Promise<Vm[]> {
		return this.request<Vm[]>("GET", "/vms");
	}

	async createRoot(vmConfig: VmConfig, waitBoot?: boolean): Promise<NewVmResponse> {
		const q = waitBoot ? "?wait_boot=true" : "";
		return this.request<NewVmResponse>("POST", `/vm/new_root${q}`, { vm_config: vmConfig });
	}

	async delete(vmId: string): Promise<VmDeleteResponse> {
		return this.request<VmDeleteResponse>("DELETE", `/vm/${encodeURIComponent(vmId)}`);
	}

	async branch(vmId: string): Promise<NewVmResponse> {
		return this.request<NewVmResponse>("POST", `/vm/${encodeURIComponent(vmId)}/branch`);
	}

	async commit(vmId: string, keepPaused?: boolean): Promise<VmCommitResponse> {
		const q = keepPaused ? "?keep_paused=true" : "";
		return this.request<VmCommitResponse>("POST", `/vm/${encodeURIComponent(vmId)}/commit${q}`);
	}

	async restoreFromCommit(commitId: string): Promise<NewVmResponse> {
		return this.request<NewVmResponse>("POST", "/vm/from_commit", { commit_id: commitId });
	}

	async updateState(vmId: string, state: "Paused" | "Running"): Promise<void> {
		await this.request<void>("PATCH", `/vm/${encodeURIComponent(vmId)}/state`, { state });
	}

	async getSSHKey(vmId: string): Promise<VmSSHKeyResponse> {
		const cached = this.sshKeyCache.get(vmId);
		if (cached) return cached;
		const key = await this.request<VmSSHKeyResponse>("GET", `/vm/${encodeURIComponent(vmId)}/ssh_key`);
		this.sshKeyCache.set(vmId, key);
		return key;
	}

	// =========================================================================
	// SSH
	// =========================================================================

	/** Get or create a persistent key file for a VM */
	async ensureKeyFile(vmId: string): Promise<string> {
		const existing = this.keyPathCache.get(vmId);
		if (existing) return existing;

		const keyInfo = await this.getSSHKey(vmId);
		const keyDir = join(tmpdir(), "vers-ssh-keys");
		await mkdir(keyDir, { recursive: true });
		const keyPath = join(keyDir, `vers-${vmId.slice(0, 12)}.pem`);
		await writeFile(keyPath, keyInfo.ssh_private_key, { mode: 0o600 });
		this.keyPathCache.set(vmId, keyPath);
		return keyPath;
	}

	/** Base SSH args for a VM (SSH-over-TLS via openssl ProxyCommand) */
	async sshArgs(vmId: string): Promise<string[]> {
		const keyPath = await this.ensureKeyFile(vmId);
		const hostname = `${vmId}.vm.vers.sh`;
		return [
			"-i", keyPath,
			"-o", "StrictHostKeyChecking=no",
			"-o", "UserKnownHostsFile=/dev/null",
			"-o", "LogLevel=ERROR",
			"-o", "ConnectTimeout=30",
			"-o", `ProxyCommand=openssl s_client -connect %h:443 -servername %h -quiet 2>/dev/null`,
			`root@${hostname}`,
		];
	}

	/** Execute a command on a VM via SSH, return stdout/stderr/exitCode */
	async exec(vmId: string, command: string, timeoutMs = 300000): Promise<ExecResult> {
		const args = await this.sshArgs(vmId);
		return new Promise((resolve, reject) => {
			execFile("ssh", [...args, command], { maxBuffer: 10 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
				if (err && typeof (err as any).code === "string" && (err as any).code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
					if (!(err as any).killed && (err as any).signal == null && stdout === "" && stderr === "") {
						reject(new Error(`SSH failed: ${err.message}`));
						return;
					}
				}
				const exitCode = (err as any)?.status ?? (err ? 1 : 0);
				resolve({ stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "", exitCode });
			});
		});
	}

	/** Execute a command with streaming output via spawn */
	execStreaming(vmId: string, command: string, opts: {
		onData: (data: Buffer) => void;
		signal?: AbortSignal;
		timeout?: number;
	}): Promise<{ exitCode: number | null }> {
		return new Promise(async (resolve, reject) => {
			try {
				const args = await this.sshArgs(vmId);
				const child = spawn("ssh", [...args, command], {
					stdio: ["ignore", "pipe", "pipe"],
				});

				let timedOut = false;
				let timeoutHandle: NodeJS.Timeout | undefined;
				if (opts.timeout && opts.timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						child.kill("SIGTERM");
					}, opts.timeout * 1000);
				}

				if (child.stdout) child.stdout.on("data", opts.onData);
				if (child.stderr) child.stderr.on("data", opts.onData);

				const onAbort = () => child.kill("SIGTERM");
				if (opts.signal) {
					if (opts.signal.aborted) { onAbort(); }
					else { opts.signal.addEventListener("abort", onAbort, { once: true }); }
				}

				child.on("error", (err) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
					reject(err);
				});

				child.on("close", (code) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
					if (opts.signal?.aborted) { reject(new Error("aborted")); return; }
					if (timedOut) { reject(new Error(`timeout:${opts.timeout}`)); return; }
					resolve({ exitCode: code });
				});
			} catch (err) {
				reject(err);
			}
		});
	}

	/** Clear SSH key caches (useful for teardown) */
	clearKeyCache(): void {
		this.sshKeyCache.clear();
		this.keyPathCache.clear();
	}
}
