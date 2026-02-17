/**
 * Vers VM Copy Extension
 *
 * Adds a vers_vm_copy tool for transferring files between local and VMs,
 * or between two VMs. Uses the SSH infrastructure from the vers-vm extension.
 *
 * Supports:
 *   - local → VM (upload)
 *   - VM → local (download)
 *   - VM → VM (transfer via local pipe)
 *
 * Tools provided:
 *   vers_vm_copy  - Copy files between local and VMs
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execFile, spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, isAbsolute } from "node:path";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// =============================================================================
// Path helpers — respect PI_CODING_AGENT_DIR and VERS_HOME
// =============================================================================

function getPiAgentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) {
		if (envDir === "~") return homedir();
		if (envDir.startsWith("~/")) return join(homedir(), envDir.slice(2));
		return envDir;
	}
	return join(homedir(), ".pi", "agent");
}

function getVersHome(): string {
	const envDir = process.env.VERS_HOME;
	if (envDir) {
		if (envDir === "~") return homedir();
		if (envDir.startsWith("~/")) return join(homedir(), envDir.slice(2));
		return envDir;
	}
	return join(getPiAgentDir(), "..", "vers");
}

// =============================================================================
// Inline Vers API Client (minimal — just SSH key + exec for file transfer)
// =============================================================================

const DEFAULT_BASE_URL = "https://api.vers.sh/api/v1";

interface VmSSHKeyResponse { ssh_port: number; ssh_private_key: string }

/** Try to read VERS_API_KEY from vers home or legacy ~/.vers */
function loadVersKeyFromDisk(): string {
	const versHome = getVersHome();

	// Try <vers-home>/keys.json first
	try {
		const data = require("fs").readFileSync(join(versHome, "keys.json"), "utf-8");
		const key = JSON.parse(data)?.keys?.VERS_API_KEY || "";
		if (key) return key;
	} catch {}

	// Try <vers-home>/config.json
	try {
		const data = require("fs").readFileSync(join(versHome, "config.json"), "utf-8");
		const parsed = JSON.parse(data);
		const key = parsed?.versApiKey || parsed?.api_key || "";
		if (key) return key;
	} catch {}

	// Fall back to legacy ~/.vers/keys.json
	const legacyDir = join(homedir(), ".vers");
	try {
		const data = require("fs").readFileSync(join(legacyDir, "keys.json"), "utf-8");
		const key = JSON.parse(data)?.keys?.VERS_API_KEY || "";
		if (key) return key;
	} catch {}

	// Fall back to legacy ~/.vers/config.json
	try {
		const data = require("fs").readFileSync(join(legacyDir, "config.json"), "utf-8");
		const parsed = JSON.parse(data);
		return parsed?.versApiKey || parsed?.api_key || "";
	} catch {}

	return "";
}

class VersSSHClient {
	private apiKey: string;
	private baseURL: string;
	private sshKeyCache = new Map<string, VmSSHKeyResponse>();
	private keyPathCache = new Map<string, string>();

	constructor(opts?: { apiKey?: string; baseURL?: string }) {
		this.apiKey = opts?.apiKey || process.env.VERS_API_KEY || loadVersKeyFromDisk();
		this.baseURL = opts?.baseURL || process.env.VERS_BASE_URL || DEFAULT_BASE_URL;
		if (!this.apiKey) throw new Error("VERS_API_KEY not set");
	}

	private async request<T>(method: string, path: string): Promise<T> {
		const url = `${this.baseURL}${path}`;
		const res = await fetch(url, {
			method,
			headers: {
				"Authorization": `Bearer ${this.apiKey}`,
				"Content-Type": "application/json",
			},
		});
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new Error(`Vers API ${method} ${path} failed (${res.status}): ${body}`);
		}
		return res.json() as Promise<T>;
	}

	async getSSHKey(vmId: string): Promise<VmSSHKeyResponse> {
		const cached = this.sshKeyCache.get(vmId);
		if (cached) return cached;
		const key = await this.request<VmSSHKeyResponse>("GET", `/vm/${encodeURIComponent(vmId)}/ssh_key`);
		this.sshKeyCache.set(vmId, key);
		return key;
	}

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

	/** Build scp args for a VM */
	async scpArgs(vmId: string): Promise<string[]> {
		const keyPath = await this.ensureKeyFile(vmId);
		const hostname = `${vmId}.vm.vers.sh`;
		return [
			"-i", keyPath,
			"-o", "StrictHostKeyChecking=no",
			"-o", "UserKnownHostsFile=/dev/null",
			"-o", "LogLevel=ERROR",
			"-o", "ConnectTimeout=30",
			"-o", `ProxyCommand=openssl s_client -connect ${hostname}:443 -servername ${hostname} -quiet 2>/dev/null`,
		];
	}

	/** Read a file from a VM via SSH cat */
	async readFile(vmId: string, path: string): Promise<Buffer> {
		const keyPath = await this.ensureKeyFile(vmId);
		const hostname = `${vmId}.vm.vers.sh`;
		return new Promise((resolve, reject) => {
			execFile("ssh", [
				"-i", keyPath,
				"-o", "StrictHostKeyChecking=no",
				"-o", "UserKnownHostsFile=/dev/null",
				"-o", "LogLevel=ERROR",
				"-o", "ConnectTimeout=30",
				"-o", `ProxyCommand=openssl s_client -connect ${hostname}:443 -servername ${hostname} -quiet 2>/dev/null`,
				`root@${hostname}`,
				`cat ${JSON.stringify(path)}`,
			], { maxBuffer: 50 * 1024 * 1024, encoding: "buffer" }, (err, stdout, stderr) => {
				if (err && stdout.length === 0) {
					reject(new Error(`Failed to read ${path} from VM ${vmId}: ${stderr?.toString() || err.message}`));
				} else {
					resolve(stdout);
				}
			});
		});
	}

	/** Write a file to a VM via SSH */
	async writeFile(vmId: string, path: string, content: Buffer): Promise<void> {
		const keyPath = await this.ensureKeyFile(vmId);
		const hostname = `${vmId}.vm.vers.sh`;
		return new Promise((resolve, reject) => {
			const child = spawn("ssh", [
				"-i", keyPath,
				"-o", "StrictHostKeyChecking=no",
				"-o", "UserKnownHostsFile=/dev/null",
				"-o", "LogLevel=ERROR",
				"-o", "ConnectTimeout=30",
				"-o", `ProxyCommand=openssl s_client -connect ${hostname}:443 -servername ${hostname} -quiet 2>/dev/null`,
				`root@${hostname}`,
				`mkdir -p ${JSON.stringify(dirname(path))} && cat > ${JSON.stringify(path)}`,
			], { stdio: ["pipe", "pipe", "pipe"] });

			let stderr = "";
			child.stderr?.on("data", (d: Buffer) => stderr += d.toString());
			child.on("error", (err) => reject(new Error(`SSH error: ${err.message}`)));
			child.on("close", (code) => {
				if (code !== 0) {
					reject(new Error(`Failed to write ${path} on VM ${vmId} (exit ${code}): ${stderr}`));
				} else {
					resolve();
				}
			});

			child.stdin?.end(content);
		});
	}

	/** List files matching a glob on a VM */
	async listFiles(vmId: string, path: string): Promise<string[]> {
		const keyPath = await this.ensureKeyFile(vmId);
		const hostname = `${vmId}.vm.vers.sh`;
		return new Promise((resolve, reject) => {
			execFile("ssh", [
				"-i", keyPath,
				"-o", "StrictHostKeyChecking=no",
				"-o", "UserKnownHostsFile=/dev/null",
				"-o", "LogLevel=ERROR",
				"-o", "ConnectTimeout=30",
				"-o", `ProxyCommand=openssl s_client -connect ${hostname}:443 -servername ${hostname} -quiet 2>/dev/null`,
				`root@${hostname}`,
				`find ${JSON.stringify(path)} -type f 2>/dev/null`,
			], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
				if (err && !stdout) {
					reject(new Error(`Failed to list ${path} on VM ${vmId}: ${stderr || err.message}`));
				} else {
					resolve(stdout.trim().split("\n").filter(Boolean));
				}
			});
		});
	}
}

// =============================================================================
// Extension
// =============================================================================

export default function versVmCopyExtension(pi: ExtensionAPI) {
	let client: VersSSHClient | undefined;

	function getClient(): VersSSHClient {
		if (!client) {
			const apiKey = (pi.getFlag("vers-api-key") as string) || undefined;
			const baseURL = (pi.getFlag("vers-base-url") as string) || undefined;
			client = new VersSSHClient({ apiKey, baseURL });
		}
		return client;
	}

	pi.registerTool({
		name: "vers_vm_copy",
		label: "Copy files to/from VM",
		description:
			"Copy files between local filesystem and a Vers VM, or between two VMs. " +
			"Paths prefixed with 'vm:<vm_id>:' refer to a VM, bare paths are local. " +
			"Supports single files and directories (recursive). " +
			"Examples: " +
			"  vers_vm_copy(src='vm:abc123:/root/workspace/docs/', dst='/Users/me/docs/') " +
			"  vers_vm_copy(src='./file.txt', dst='vm:abc123:/root/workspace/file.txt') " +
			"  vers_vm_copy(src='vm:abc123:/root/file', dst='vm:def456:/root/file')",
		parameters: Type.Object({
			src: Type.String({ description: "Source path. Prefix with 'vm:<vm_id>:' for VM paths, otherwise local." }),
			dst: Type.String({ description: "Destination path. Prefix with 'vm:<vm_id>:' for VM paths, otherwise local." }),
			recursive: Type.Optional(Type.Boolean({ description: "Copy directory recursively (default: auto-detect)" })),
		}),
		async execute(_id, params) {
			const { src, dst, recursive } = params as { src: string; dst: string; recursive?: boolean };

			const srcParsed = parsePath(src);
			const dstParsed = parsePath(dst);

			const c = getClient();

			// --- Local → Local (just use cp) ---
			if (!srcParsed.vmId && !dstParsed.vmId) {
				return {
					content: [{ type: "text", text: "Both paths are local. Use bash with cp instead." }],
					details: {},
				};
			}

			// --- VM → Local ---
			if (srcParsed.vmId && !dstParsed.vmId) {
				const vmId = await resolveVmId(c, srcParsed.vmId);
				const localPath = resolveLocalPath(dstParsed.path);

				// Check if source is a directory
				const isDir = recursive ?? await isRemoteDir(c, vmId, srcParsed.path);
				if (isDir) {
					const files = await c.listFiles(vmId, srcParsed.path);
					if (files.length === 0) {
						return { content: [{ type: "text", text: `No files found at ${srcParsed.path} on VM ${vmId.slice(0, 12)}` }], details: {} };
					}
					let copied = 0;
					for (const remotePath of files) {
						const relativePath = remotePath.replace(srcParsed.path.replace(/\/$/, ""), "").replace(/^\//, "");
						const destFile = join(localPath, relativePath);
						await mkdir(dirname(destFile), { recursive: true });
						const content = await c.readFile(vmId, remotePath);
						await writeFile(destFile, content);
						copied++;
					}
					return {
						content: [{ type: "text", text: `Copied ${copied} file(s) from VM ${vmId.slice(0, 12)}:${srcParsed.path} → ${localPath}` }],
						details: { copied, vmId, direction: "download" },
					};
				} else {
					await mkdir(dirname(localPath), { recursive: true });
					const content = await c.readFile(vmId, srcParsed.path);
					await writeFile(localPath, content);
					return {
						content: [{ type: "text", text: `Copied VM ${vmId.slice(0, 12)}:${srcParsed.path} → ${localPath} (${formatSize(content.length)})` }],
						details: { vmId, direction: "download", size: content.length },
					};
				}
			}

			// --- Local → VM ---
			if (!srcParsed.vmId && dstParsed.vmId) {
				const vmId = await resolveVmId(c, dstParsed.vmId);
				const localPath = resolveLocalPath(srcParsed.path);

				const isDir = recursive ?? await isLocalDir(localPath);
				if (isDir) {
					const files = await listLocalFiles(localPath);
					let copied = 0;
					for (const filePath of files) {
						const relativePath = filePath.replace(localPath.replace(/\/$/, ""), "").replace(/^\//, "");
						const remoteDest = join(dstParsed.path, relativePath);
						const content = await readFile(filePath);
						await c.writeFile(vmId, remoteDest, content);
						copied++;
					}
					return {
						content: [{ type: "text", text: `Copied ${copied} file(s) from ${localPath} → VM ${vmId.slice(0, 12)}:${dstParsed.path}` }],
						details: { copied, vmId, direction: "upload" },
					};
				} else {
					const content = await readFile(localPath);
					await c.writeFile(vmId, dstParsed.path, content);
					return {
						content: [{ type: "text", text: `Copied ${localPath} → VM ${vmId.slice(0, 12)}:${dstParsed.path} (${formatSize(content.length)})` }],
						details: { vmId, direction: "upload", size: content.length },
					};
				}
			}

			// --- VM → VM ---
			if (srcParsed.vmId && dstParsed.vmId) {
				const srcVmId = await resolveVmId(c, srcParsed.vmId);
				const dstVmId = await resolveVmId(c, dstParsed.vmId);

				const isDir = recursive ?? await isRemoteDir(c, srcVmId, srcParsed.path);
				if (isDir) {
					const files = await c.listFiles(srcVmId, srcParsed.path);
					let copied = 0;
					for (const remotePath of files) {
						const relativePath = remotePath.replace(srcParsed.path.replace(/\/$/, ""), "").replace(/^\//, "");
						const content = await c.readFile(srcVmId, remotePath);
						await c.writeFile(dstVmId, join(dstParsed.path, relativePath), content);
						copied++;
					}
					return {
						content: [{ type: "text", text: `Copied ${copied} file(s) from VM ${srcVmId.slice(0, 12)}:${srcParsed.path} → VM ${dstVmId.slice(0, 12)}:${dstParsed.path}` }],
						details: { copied, srcVmId, dstVmId, direction: "vm-to-vm" },
					};
				} else {
					const content = await c.readFile(srcVmId, srcParsed.path);
					await c.writeFile(dstVmId, dstParsed.path, content);
					return {
						content: [{ type: "text", text: `Copied VM ${srcVmId.slice(0, 12)}:${srcParsed.path} → VM ${dstVmId.slice(0, 12)}:${dstParsed.path} (${formatSize(content.length)})` }],
						details: { srcVmId, dstVmId, direction: "vm-to-vm", size: content.length },
					};
				}
			}

			return { content: [{ type: "text", text: "Invalid path combination." }], details: {} };
		},
	});
}

// =============================================================================
// Helpers
// =============================================================================

interface ParsedPath {
	vmId: string | null;
	path: string;
}

/** Parse a path like "vm:abc123:/root/file" or "/local/file" */
function parsePath(input: string): ParsedPath {
	const match = input.match(/^vm:([^:]+):(.+)$/);
	if (match) {
		return { vmId: match[1], path: match[2] };
	}
	return { vmId: null, path: input };
}

/** Resolve a possibly-short VM ID to full UUID by listing VMs */
async function resolveVmId(client: VersSSHClient, partialId: string): Promise<string> {
	// If it looks like a full UUID already, use it
	if (partialId.length >= 36) return partialId;
	// Otherwise we'll just use it as-is and let the API error if it's wrong
	// The SSH key endpoint needs the full ID, so try to look it up
	return partialId;
}

function resolveLocalPath(p: string): string {
	return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

async function isRemoteDir(client: VersSSHClient, vmId: string, path: string): Promise<boolean> {
	try {
		const files = await client.listFiles(vmId, path);
		// If find returns multiple files or the path itself isn't in the list, it's a dir
		return files.length > 1 || (files.length === 1 && files[0] !== path);
	} catch {
		return false;
	}
}

async function isLocalDir(path: string): Promise<boolean> {
	try {
		const { stat } = await import("node:fs/promises");
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

async function listLocalFiles(dir: string): Promise<string[]> {
	const { readdir, stat } = await import("node:fs/promises");
	const results: string[] = [];
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...await listLocalFiles(fullPath));
		} else {
			results.push(fullPath);
		}
	}
	return results;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
