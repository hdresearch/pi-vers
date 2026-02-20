# Clawdbot Extensions

Clawdbot-compatible versions of the Vers tools.

## Installation

### Plugin (native tools)

Copy `extensions/vers-vm/` to `~/.clawdbot/extensions/vers-vm/` and enable in config:

```json
{
  "plugins": {
    "entries": {
      "vers-vm": { "enabled": true }
    }
  }
}
```

Then restart the gateway.

### Skills (instruction-based)

Copy `skills/vers-vm/` and `skills/vers-swarm/` to your workspace's `skills/` directory.

## What's Included

### Extensions (native tools)

| Extension | Tools |
|-----------|-------|
| `vers-vm` | `vers_vms`, `vers_vm_create`, `vers_vm_delete`, `vers_vm_branch`, `vers_vm_commit`, `vers_vm_restore`, `vers_vm_state`, `vers_vm_ssh_key` |

### Skills (instructions)

| Skill | Description |
|-------|-------------|
| `vers-vm` | API reference and workflows for Vers VM management |
| `vers-swarm` | Agent swarm orchestration patterns across branched VMs |

## Requirements

- `VERS_API_KEY` environment variable set
- Clawdbot 2026.1.x or later
