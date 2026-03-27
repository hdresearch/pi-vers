/**
 * Background Process Extension
 *
 * Spawn long-lived background processes that persist across tool calls.
 * Tools: bg_start, bg_stop, bg_list, bg_logs
 */

import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

interface BgProcess {
	id: string;
	command: string;
	cwd: string;
	shell: string;
	proc: ChildProcess;
	stdout: string[];
	stderr: string[];
	startedAt: number;
	exitCode: number | null;
}

const MAX_LOG_LINES = 500;

function resolveShell(): string {
	const candidates = [process.env.SHELL, "/bin/bash", "/usr/bin/bash", "/bin/sh"].filter(Boolean) as string[];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return "sh";
}

export default function backgroundProcessExtension(pi: ExtensionAPI) {
	const processes = new Map<string, BgProcess>();

	function appendLog(lines: string[], data: string) {
		const newLines = data.split("\n");
		for (const line of newLines) {
			if (line.length > 0) {
				lines.push(line);
				if (lines.length > MAX_LOG_LINES) lines.shift();
			}
		}
	}

	pi.registerTool({
		name: "bg_start",
		label: "Start Background Process",
		description:
			"Start a long-lived background process (e.g. dev server). Returns an ID to manage it later. The process persists across tool calls.",
		parameters: Type.Object({
			id: Type.String({ description: "Unique name for this process (e.g. 'vite', 'server')" }),
			command: Type.String({ description: "Shell command to run" }),
			cwd: Type.Optional(Type.String({ description: "Working directory (default: current)" })),
			waitMs: Type.Optional(
				Type.Number({
					description: "Milliseconds to wait before returning, to capture initial output (default: 2000)",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { id, command, cwd, waitMs } = params as {
				id: string;
				command: string;
				cwd?: string;
				waitMs?: number;
			};

			// Kill existing process with same ID
			const existing = processes.get(id);
			if (existing && existing.exitCode === null) {
				existing.proc.kill("SIGTERM");
				processes.delete(id);
			}

			const workDir = cwd || ctx.cwd;
			if (!existsSync(workDir)) {
				return {
					content: [{ type: "text", text: `Working directory does not exist: ${workDir}` }],
					isError: true,
					details: { id, cwd: workDir },
				};
			}

			const shell = resolveShell();

			const proc = spawn(shell, ["-lc", command], {
				cwd: workDir,
				stdio: ["ignore", "pipe", "pipe"],
				detached: true,
			});

			const bg: BgProcess = {
				id,
				command,
				cwd: workDir,
				shell,
				proc,
				stdout: [],
				stderr: [],
				startedAt: Date.now(),
				exitCode: null,
			};

			proc.stdout?.on("data", (data: Buffer) => appendLog(bg.stdout, data.toString()));
			proc.stderr?.on("data", (data: Buffer) => appendLog(bg.stderr, data.toString()));
			proc.on("exit", (code) => {
				bg.exitCode = code;
			});
			proc.on("error", (err) => {
				bg.stderr.push(`[spawn error] ${err.message}`);
				bg.exitCode = -1;
			});

			processes.set(id, bg);
			proc.unref();

			// Wait for initial output
			const wait = waitMs ?? 2000;
			await new Promise((r) => setTimeout(r, wait));

			const alive = bg.exitCode === null;
			const initialOut = bg.stdout.slice(-20).join("\n");
			const initialErr = bg.stderr.slice(-20).join("\n");

			let text = `Process "${id}" ${alive ? "started (running)" : `exited (code: ${bg.exitCode})`}\n`;
			text += `PID: ${proc.pid}\n`;
			text += `Shell: ${shell}\n`;
			text += `Command: ${command}\n`;
			text += `CWD: ${workDir}\n`;
			if (initialOut) text += `\n--- stdout ---\n${initialOut}`;
			if (initialErr) text += `\n--- stderr ---\n${initialErr}`;

			return {
				content: [{ type: "text", text }],
				details: { id, pid: proc.pid, alive },
			};
		},
	});

	pi.registerTool({
		name: "bg_stop",
		label: "Stop Background Process",
		description: "Stop a running background process by ID.",
		parameters: Type.Object({
			id: Type.String({ description: "Process ID to stop" }),
			signal: Type.Optional(
				Type.String({ description: "Signal to send (default: SIGTERM). Use SIGKILL to force." }),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { id, signal } = params as { id: string; signal?: string };
			const bg = processes.get(id);
			if (!bg) {
				return {
					content: [{ type: "text", text: `No process found with ID "${id}"` }],
					isError: true,
					details: {},
				};
			}

			if (bg.exitCode !== null) {
				processes.delete(id);
				return {
					content: [{ type: "text", text: `Process "${id}" already exited (code: ${bg.exitCode})` }],
					details: { id, exitCode: bg.exitCode },
				};
			}

			const sig = (signal as NodeJS.Signals) || "SIGTERM";
			const pid = bg.proc.pid;
			if (pid) {
				try {
					process.kill(-pid, sig);
				} catch {
					bg.proc.kill(sig);
				}
			} else {
				bg.proc.kill(sig);
			}

			// Wait briefly for exit
			await new Promise((r) => setTimeout(r, 500));

			const exited = bg.exitCode !== null;
			if (!exited && sig !== "SIGKILL") {
				if (pid) {
					try {
						process.kill(-pid, "SIGKILL");
					} catch {
						bg.proc.kill("SIGKILL");
					}
				} else {
					bg.proc.kill("SIGKILL");
				}
				await new Promise((r) => setTimeout(r, 300));
			}

			processes.delete(id);
			return {
				content: [{ type: "text", text: `Process "${id}" stopped.` }],
				details: { id },
			};
		},
	});

	pi.registerTool({
		name: "bg_list",
		label: "List Background Processes",
		description: "List all background processes and their status.",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			if (processes.size === 0) {
				return {
					content: [{ type: "text", text: "No background processes." }],
					details: {},
				};
			}

			const lines: string[] = [];
			for (const [id, bg] of processes) {
				const alive = bg.exitCode === null;
				const uptime = alive ? `${Math.round((Date.now() - bg.startedAt) / 1000)}s` : "-";
				lines.push(
					`${id}: ${alive ? "RUNNING" : `EXITED(${bg.exitCode})`} | PID ${bg.proc.pid} | uptime ${uptime} | ${bg.command}`,
				);
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { count: processes.size },
			};
		},
	});

	pi.registerTool({
		name: "bg_logs",
		label: "Background Process Logs",
		description: "Get stdout/stderr logs from a background process.",
		parameters: Type.Object({
			id: Type.String({ description: "Process ID" }),
			last: Type.Optional(Type.Number({ description: "Number of recent lines (default: 50)" })),
			stream: Type.Optional(
				Type.String({ description: "'stdout', 'stderr', or 'both' (default: 'both')" }),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { id, last, stream } = params as { id: string; last?: number; stream?: string };
			const bg = processes.get(id);
			if (!bg) {
				return {
					content: [{ type: "text", text: `No process found with ID "${id}"` }],
					isError: true,
					details: {},
				};
			}

			const n = last ?? 50;
			const which = stream || "both";
			const parts: string[] = [];

			const alive = bg.exitCode === null;
			parts.push(`Process "${id}": ${alive ? "RUNNING" : `EXITED(${bg.exitCode})`}`);

			if (which === "stdout" || which === "both") {
				const lines = bg.stdout.slice(-n);
				parts.push(`\n--- stdout (last ${lines.length}) ---`);
				parts.push(lines.join("\n") || "(empty)");
			}

			if (which === "stderr" || which === "both") {
				const lines = bg.stderr.slice(-n);
				parts.push(`\n--- stderr (last ${lines.length}) ---`);
				parts.push(lines.join("\n") || "(empty)");
			}

			return {
				content: [{ type: "text", text: parts.join("\n") }],
				details: { id, alive: bg.exitCode === null },
			};
		},
	});

	// Clean up all processes on shutdown
	pi.on("session_shutdown", async () => {
		for (const [_id, bg] of processes) {
			if (bg.exitCode === null) {
				bg.proc.kill("SIGKILL");
			}
		}
		processes.clear();
	});
}
