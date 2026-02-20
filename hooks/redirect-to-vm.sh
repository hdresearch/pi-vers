#!/bin/bash
# redirect-to-vm.sh
#
# Claude Code PreToolUse hook that denies Bash/Read/Edit/Write when a Vers VM
# is active, nudging Claude to use vers_bash/vers_read/vers_edit/vers_write instead.
#
# Reads VM state from the MCP server's state file.
# Install: add to .claude/settings.json (see README)

STATE_FILE="${TMPDIR:-/tmp}/vers-mcp/state.json"

# No state file = no active VM = allow everything
if [ ! -f "$STATE_FILE" ]; then
  exit 0
fi

# Read the active VM ID
ACTIVE_VM=$(jq -r '.activeVmId // empty' "$STATE_FILE" 2>/dev/null)

# No active VM = allow everything
if [ -z "$ACTIVE_VM" ]; then
  exit 0
fi

# A VM is active — read which tool is being called
INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name')

# Map built-in tool names to their vers_* equivalents
case "$TOOL_NAME" in
  Bash)  VERS_TOOL="vers_bash" ;;
  Read)  VERS_TOOL="vers_read" ;;
  Edit)  VERS_TOOL="vers_edit" ;;
  Write) VERS_TOOL="vers_write" ;;
  *)     exit 0 ;;  # Not a redirectable tool, allow it
esac

VM_SHORT="${ACTIVE_VM:0:12}"

# Deny and tell Claude which tool to use instead
jq -n \
  --arg tool "$VERS_TOOL" \
  --arg vm "$VM_SHORT" \
  '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: ("Vers VM " + $vm + " is active. Use " + $tool + " instead to execute on the VM.")
    }
  }'
