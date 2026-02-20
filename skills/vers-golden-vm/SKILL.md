---
name: vers-golden-vm
description: Bootstrap a Vers VM into a golden image with pi, Node.js, dev tools, and swarm extensions installed. Creates a committed snapshot that can be branched for self-organizing agent swarms.
---

# Vers Golden VM

Bootstrap a Vers VM into a reusable golden image for pi agent swarms. The golden image includes Node.js, pi, GitHub CLI, dev tools, and any pi packages you configure.

## Prerequisites

- Vers extension loaded with valid API key
- An API key for your chosen LLM provider (Anthropic, Zai, Google, OpenAI, or Azure)
- A GitHub token if cloning private repos

## Steps

### 1. Create a VM (4GB+ disk)

```
vers_vm_create with vcpu_count=2, mem_size_mib=2048, fs_size_mib=4096, wait_boot=true
```

Default 1GB disk is too small — pi + packages + node need ~1.3GB.

### 2. Bootstrap

Set the VM as active with `vers_vm_use`, then run the bootstrap script:

```bash
export GITHUB_TOKEN="<token>"
bash /path/to/scripts/bootstrap.sh
```

The script installs system packages, Node.js, pi, GitHub CLI, clones your configured pi packages, and registers them via `pi install`. Edit the `PACKAGES` array in the script to add your own repos.

### 3. Verify settings.json

**Critical check.** Pi reads packages from `~/.pi/agent/settings.json`, NOT from `~/.pi/packages.json`.

```bash
cat /root/.pi/agent/settings.json
# Should show: { "packages": ["git/github.com/org/your-package", ...] }
```

If `settings.json` doesn't exist or is empty, agents will only have `read/bash/edit/write` — no `vers_*`, `board_*`, `feed_*`, etc. tools. Run `pi install <path>` to fix.

### 4. Clean stale state

The bootstrap script handles this, but verify:

```bash
tmux ls  # should error "no server running"
ls /tmp/pi-rpc/  # should be empty
```

Stale tmux sessions or pi-rpc fifos from a previous pi run cause golden images to fail when branched.

### 5. Bake infra env vars into the image

If you have an infra VM running agent-services, bake the connection details into `/etc/environment` so all processes (including pi) inherit them — `.bashrc` only works for interactive shells:

```bash
cat >> /etc/environment << EOF
VERS_INFRA_URL=https://<infra_vm_id>.vm.vers.sh:3000
VERS_AUTH_TOKEN=<auth_token>
EOF
```

Replace with actual values. This ensures spawned agents can use board/feed/log/registry tools immediately.

### 6. Commit the golden image

Switch back to local (`vers_vm_local`) and commit:

```
vers_vm_commit with the VM ID
```

Save the returned commit_id — this is your golden image.

### 6. Update references

Update `VERS_GOLDEN_COMMIT_ID` in `~/.zshrc` (or wherever it's set). Note: running pi sessions won't pick up env var changes — they need a full restart.

## What the Golden Image Contains

- **OS**: Ubuntu 24.04
- **Runtime**: Node.js 22 LTS, npm
- **Agent**: pi coding agent (latest)
- **Tools**: git, ripgrep, fd, jq, tree, python3, build-essential, tmux, gh CLI
- **Pi packages**: whatever you configure in the `PACKAGES` array, registered via `pi install` → `settings.json`
- **Git config**: GIT_EDITOR=true, core.editor=true, merge.commit=no-edit

## Common Pitfalls

### packages.json vs settings.json
`~/.pi/packages.json` is a **legacy file that pi does not read**. Pi reads package registrations from `~/.pi/agent/settings.json`. Always use `pi install <path>` to register packages — never write packages.json manually.

### Re-committing used VMs
Golden images committed from VMs that previously ran pi (e.g., from an LT session) have stale tmux sessions and pi-rpc fifos baked in. These cause `vers_lt_create` to fail on the branched VMs. Always build golden images from **fresh VMs** using the bootstrap script.

### Disk size
Default VM disk is 1GB. Golden images need at least 4GB (`fs_size_mib=4096`). After bootstrap, disk usage is ~1.3GB.
