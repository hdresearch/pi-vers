/**
 * Vers shell-auth helper.
 *
 * Extracted from the installer flow so other repos can reuse the exact same
 * Vers login/bootstrap semantics without re-implementing them.
 */

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadVersKeyFromDisk } from "./vers-client.js";

export interface ShellAuthMatch {
	email: string;
	is_active?: boolean;
	public_key_verified?: boolean;
}

export interface VerifyPublicKeyResponse {
	verified?: boolean;
	count?: number;
	matches?: ShellAuthMatch[];
}

export interface VerifyKeyResponse {
	verified?: boolean;
}

export interface ApiKeyResponse {
	api_key?: string;
	error?: string;
}

export interface EnsureVersApiKeyOptions {
	apiKey?: string;
	email?: string;
	baseUrl?: string;
	label?: string;
	forceShellAuth?: boolean;
	pollIntervalMs?: number;
	maxPollAttempts?: number;
	fetchImpl?: typeof fetch;
	prompt?: (question: string) => Promise<string>;
}

export interface EnsureVersApiKeyResult {
	apiKey: string;
	source: "existing" | "shell-auth";
	email?: string;
}

const DEFAULT_BASE_URL = "https://vers.sh";

function execFileAsync(command: string, args: string[], options: Record<string, unknown> = {}) {
	return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
		execFile(command, args, options as any, (error, stdout, stderr) => {
			if (error) {
				reject(
					Object.assign(error, {
						stdout: stdout?.toString() ?? "",
						stderr: stderr?.toString() ?? "",
					}),
				);
				return;
			}
			resolve({
				stdout: stdout?.toString() ?? "",
				stderr: stderr?.toString() ?? "",
			});
		});
	});
}

function writeJson(file: string, value: unknown): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function findExistingPublicKey(): string | null {
	const home = homedir();
	const files = ["id_ed25519.pub", "id_ecdsa.pub", "id_rsa.pub"].map((name) => join(home, ".ssh", name));
	for (const file of files) {
		try {
			const value = readFileSync(file, "utf8").trim();
			if (value) return value;
		} catch {
			// Keep searching.
		}
	}
	return null;
}

async function ensureSshPublicKey(): Promise<string> {
	const existing = findExistingPublicKey();
	if (existing) return existing;

	const privateKeyPath = join(homedir(), ".ssh", "id_ed25519");
	mkdirSync(dirname(privateKeyPath), { recursive: true });
	await execFileAsync("ssh-keygen", ["-t", "ed25519", "-f", privateKeyPath, "-N", "", "-q"]);
	return readFileSync(`${privateKeyPath}.pub`, "utf8").trim();
}

function defaultPrompt(question: string): Promise<string> {
	return new Promise((resolve, reject) => {
		process.stdout.write(question);
		process.stdin.resume();
		process.stdin.setEncoding("utf8");
		process.stdin.once("data", (chunk) => {
			process.stdin.pause();
			resolve(String(chunk).trim());
		});
		process.stdin.once("error", reject);
	});
}

async function post<T>(fetchImpl: typeof fetch, baseUrl: string, path: string, body: Record<string, unknown>): Promise<T> {
	const response = await fetchImpl(`${baseUrl}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const text = await response.text();
	const payload = text ? JSON.parse(text) : {};
	if (!response.ok) {
		const detail = typeof payload === "object" && payload !== null && "error" in payload ? (payload as any).error : text;
		throw new Error(detail || `Shell auth request failed (${response.status})`);
	}
	return payload as T;
}

export async function ensureVersApiKey(options: EnsureVersApiKeyOptions = {}): Promise<EnsureVersApiKeyResult> {
	const forceShellAuth = options.forceShellAuth === true;
	const existingKey = forceShellAuth ? "" : options.apiKey || process.env.VERS_API_KEY || loadVersKeyFromDisk();
	if (existingKey) {
		return {
			apiKey: existingKey,
			source: "existing",
		};
	}

	const fetchImpl = options.fetchImpl || fetch;
	const prompt = options.prompt || defaultPrompt;
	const baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
	const sshPublicKey = await ensureSshPublicKey();

	const verified = await post<VerifyPublicKeyResponse>(fetchImpl, baseUrl, "/api/shell-auth/verify-public-key", {
		ssh_public_key: sshPublicKey,
	}).catch(() => ({ verified: false, count: 0, matches: [] }));

	let email = options.email || "";
	if (verified.verified && (verified.count || 0) > 0) {
		const active = verified.matches?.find((match) => match.is_active && match.public_key_verified) || verified.matches?.[0];
		email = active?.email || email;
	}

	if (!email) {
		email = (await prompt("Enter your Vers account email: ")).trim();
		if (!email) throw new Error("Email is required to complete Vers shell auth");
	}

	if (!verified.verified || (verified.count || 0) === 0) {
		await post(fetchImpl, baseUrl, "/api/shell-auth", {
			email,
			ssh_public_key: sshPublicKey,
		});

		const maxPollAttempts = options.maxPollAttempts ?? 100;
		const pollIntervalMs = options.pollIntervalMs ?? 3000;
		let confirmed = false;

		for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
			const poll = await post<VerifyKeyResponse>(fetchImpl, baseUrl, "/api/shell-auth/verify-key", {
				email,
				ssh_public_key: sshPublicKey,
			}).catch(() => ({ verified: false }));

			if (poll.verified) {
				confirmed = true;
				break;
			}

			await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
		}

		if (!confirmed) {
			throw new Error("Vers email verification timed out");
		}
	}

	const apiKeyResponse = await post<ApiKeyResponse>(fetchImpl, baseUrl, "/api/shell-auth/api-keys", {
		email,
		ssh_public_key: sshPublicKey,
		label: options.label || "pi-vers",
	});

	if (!apiKeyResponse.api_key) {
		throw new Error(apiKeyResponse.error || "Vers shell auth did not return an API key");
	}

	const apiKey = apiKeyResponse.api_key;
	const home = homedir();
	writeJson(join(home, ".vers", "keys.json"), { keys: { VERS_API_KEY: apiKey } });
	writeJson(join(home, ".vers", "config.json"), { api_key: apiKey, versApiKey: apiKey });

	return {
		apiKey,
		email,
		source: "shell-auth",
	};
}
