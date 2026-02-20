---
name: vers-vm
description: Manage Vers VMs (vers.sh) - create, branch, commit, restore, pause/resume Firecracker VMs. Use when working with Vers platform, VM orchestration, or when you need isolated execution environments.
---

# Vers VM Management

Vers provides Firecracker VMs that can be branched like git. Use for isolated environments, parallel exploration, or safe experimentation.

## Prerequisites

- `VERS_API_KEY` environment variable set
- API endpoint: `https://api.vers.sh/api/v1`

## Quick Reference

### List VMs
```bash
curl -s -H "Authorization: Bearer $VERS_API_KEY" \
  https://api.vers.sh/api/v1/vms | jq .
```

### Create VM
```bash
curl -s -X POST -H "Authorization: Bearer $VERS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"vm_config": {"vcpu_count": 1, "mem_size_mib": 512, "fs_size_mib": 512}}' \
  https://api.vers.sh/api/v1/vm/new_root | jq .
```

Add `?wait_boot=true` to wait for VM to be ready.

### Branch VM (clone current state)
```bash
curl -s -X POST -H "Authorization: Bearer $VERS_API_KEY" \
  https://api.vers.sh/api/v1/vm/{vm_id}/branch | jq .
```

### Commit VM (snapshot)
```bash
curl -s -X POST -H "Authorization: Bearer $VERS_API_KEY" \
  https://api.vers.sh/api/v1/vm/{vm_id}/commit | jq .
```
Returns `commit_id` for later restore.

### Restore from Commit
```bash
curl -s -X POST -H "Authorization: Bearer $VERS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"commit_id": "COMMIT_ID"}' \
  https://api.vers.sh/api/v1/vm/from_commit | jq .
```

### Pause/Resume VM
```bash
# Pause
curl -s -X PATCH -H "Authorization: Bearer $VERS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"state": "Paused"}' \
  https://api.vers.sh/api/v1/vm/{vm_id}/state

# Resume
curl -s -X PATCH -H "Authorization: Bearer $VERS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"state": "Running"}' \
  https://api.vers.sh/api/v1/vm/{vm_id}/state
```

### Delete VM
```bash
curl -s -X DELETE -H "Authorization: Bearer $VERS_API_KEY" \
  https://api.vers.sh/api/v1/vm/{vm_id}
```

### Get SSH Credentials
```bash
curl -s -H "Authorization: Bearer $VERS_API_KEY" \
  https://api.vers.sh/api/v1/vm/{vm_id}/ssh_key | jq .
```
Returns `ssh_private_key` and `ssh_port` (443).

## SSH Connection

Vers uses SSH-over-TLS on port 443:

```bash
# Save the key
curl -s -H "Authorization: Bearer $VERS_API_KEY" \
  https://api.vers.sh/api/v1/vm/{vm_id}/ssh_key | jq -r .ssh_private_key > /tmp/vers-key.pem
chmod 600 /tmp/vers-key.pem

# Connect via SSH-over-TLS
ssh -i /tmp/vers-key.pem \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  -o ProxyCommand="openssl s_client -connect %h:443 -servername %h -quiet 2>/dev/null" \
  root@{vm_id}.vm.vers.sh
```

## Common Workflows

### Exploration Branch
1. Create root VM or use existing
2. Do initial setup (install tools, configure)
3. Commit as baseline: `commit` → save commit_id
4. Branch for exploration
5. If exploration fails, restore from commit
6. If exploration succeeds, commit new state

### Parallel Testing
1. Commit current VM state
2. Branch N times from commit
3. Run different tests on each branch
4. Compare results
5. Keep successful branch, delete others

## VM States

- `booting` — VM is starting up
- `running` — VM is active and accessible
- `paused` — VM is suspended (no compute cost, state preserved)

## Tips

- Branch is faster than creating from scratch — use commits as checkpoints
- Paused VMs preserve memory state exactly
- SSH keys are per-VM and cached by the API
- VMs have private IPv6 addresses within Vers network
