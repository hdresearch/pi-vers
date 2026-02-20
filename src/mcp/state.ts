/**
 * Shared state file for coordinating between MCP server and hooks.
 *
 * The MCP server writes VM state to a file. Hook scripts read it to
 * decide whether to deny built-in tools in favor of vers_* tools.
 */

import { writeFile, readFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const STATE_DIR = join(tmpdir(), "vers-mcp");
const STATE_FILE = join(STATE_DIR, "state.json");

export interface VersState {
	activeVmId: string | null;
	updatedAt: string;
}

export async function writeState(state: VersState): Promise<void> {
	await mkdir(STATE_DIR, { recursive: true });
	await writeFile(STATE_FILE, JSON.stringify(state), "utf-8");
}

export async function readState(): Promise<VersState | null> {
	try {
		const data = await readFile(STATE_FILE, "utf-8");
		return JSON.parse(data);
	} catch {
		return null;
	}
}

export async function clearState(): Promise<void> {
	try {
		await unlink(STATE_FILE);
	} catch { /* ignore */ }
}

export { STATE_FILE };
