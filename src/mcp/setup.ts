#!/usr/bin/env node
/**
 * Setup helper for Claude Code integration.
 * Prints the hooks configuration to add to .claude/settings.json.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const hookScript = resolve(__dirname, "../../hooks/redirect-to-vm.sh");

const config = {
	hooks: {
		PreToolUse: [
			{
				matcher: "Bash|Read|Edit|Write",
				hooks: [
					{
						type: "command",
						command: hookScript,
					},
				],
			},
		],
	},
};

console.log(`
Vers MCP — Claude Code Setup
=============================

1. Add the MCP server:

   claude mcp add vers -- npx @hdresearch/vers-mcp

2. Add this to your .claude/settings.json (merge with existing hooks):

${JSON.stringify(config, null, 2)}

This hook auto-denies Bash/Read/Edit/Write when a Vers VM is active,
nudging Claude to use vers_bash/vers_read/vers_edit/vers_write instead.

Requires: jq (brew install jq)
`);
