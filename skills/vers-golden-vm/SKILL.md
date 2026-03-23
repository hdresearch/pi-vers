---
name: vers-golden-vm
description: Bootstrap a Vers VM into a golden image with punkin-pi, Node.js, dev tools, and swarm extensions installed. Creates a committed snapshot that can be branched for self-organizing agent swarms.
---

# Vers Golden VM

Bootstrap a Vers VM into a reusable golden image for punkin-pi agent swarms. The golden image includes Node.js, punkin-pi (built from source at the `w/router` release tag), GitHub CLI, dev tools, and any punkin packages you configure.

## Prerequisites

- Vers extension loaded with valid API key
- An exchanged `LLM_PROXY_KEY` (`sk-vers-*`) for punkin agents
- A GitHub token if cloning private repos

## Steps

### 1. Create a VM (4GB+ disk)

```
vers_vm_create with vcpu_count=2, mem_size_mib=2048, fs_size_mib=4096, wait_boot=true
```

Default 1GB disk is too small — punkin-pi source + build + packages + node need ~1.5GB.

### 2. Bootstrap

Set the VM as active with `vers_vm_use`, then run the bootstrap script:

```bash
export GITHUB_TOKEN="<token>"
# Optional: override defaults
export PUNKIN_TAG="w/router"
export GIT_AUTHOR_NAME="reef-agent"
export GIT_AUTHOR_EMAIL="reef-agent@users.noreply.github.com"
bash /path/to/scripts/bootstrap.sh
```

The script:
1. Installs system packages, Node.js, GitHub CLI
2. Clones punkin-pi and builds from source at the specified tag
3. Symlinks `/usr/local/bin/punkin` to the built CLI
4. Clones and registers configured packages via `punkin install`

Edit the `PACKAGES` array in the script to add your own repos.

### 3. Verify settings.toml

**Critical check.** Punkin reads packages from `~/.punkin/agent/settings.toml`.

```bash
cat /root/.punkin/agent/settings.toml
# Should show: packages = [ "/opt/pi-vers", "/opt/vers-agent-services" ]
```

If `settings.toml` doesn't exist or is empty, agents will only have `read/bash/edit/write` — no `vers_*`, `board_*`, `feed_*`, etc. tools. Run `punkin install <path>` to fix.

### 4. Clean stale state

The bootstrap script handles this, but verify:

```bash
tmux ls  # should error "no server running"
ls /tmp/pi-rpc/  # should be empty
```

Stale tmux sessions or pi-rpc fifos from a previous punkin run cause golden images to fail when branched.

### 5. Bake infra env vars into the image

If you have an infra VM running agent-services, bake the connection details into `/etc/environment` so all processes (including punkin) inherit them. Include `LLM_PROXY_KEY` too if you want restored agents to inherit it automatically. `.bashrc` only works for interactive shells:

```bash
cat >> /etc/environment << EOF
VERS_INFRA_URL=https://<infra_vm_id>.vm.vers.sh:3000
VERS_AUTH_TOKEN=<auth_token>
LLM_PROXY_KEY=<sk-vers-key>
EOF
```

Replace with actual values. This ensures spawned agents can use board/feed/log/registry tools immediately.

### 6. Commit the golden image

Switch back to local (`vers_vm_local`) and commit:

```
vers_vm_commit with the VM ID
```

Save the returned commit_id — this is your golden image.

### 7. Update references

Update `VERS_GOLDEN_COMMIT_ID` in `~/.zshrc` (or wherever it's set). Note: running punkin sessions won't pick up env var changes — they need a full restart.

## What the Golden Image Contains

- **OS**: Ubuntu 24.04
- **Runtime**: Node.js 22 LTS, npm
- **Agent**: punkin-pi (built from source at the `w/router` release tag)
- **Tools**: git, ripgrep, fd, jq, tree, python3, build-essential, tmux, gh CLI
- **Packages**: whatever you configure in the `PACKAGES` array, registered via `punkin install` → `settings.toml`
- **Git config**: reef-agent identity, GIT_EDITOR=true, core.editor=true, merge.commit=no-edit

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GITHUB_TOKEN` | (empty) | GitHub PAT for cloning private repos |
| `PUNKIN_TAG` | `w/router` | Release tag to build punkin-pi from |
| `GIT_AUTHOR_NAME` | `reef-agent` | Git commit author name |
| `GIT_AUTHOR_EMAIL` | `reef-agent@users.noreply.github.com` | Git commit author email |

## Common Pitfalls

### settings.toml location
Punkin reads package registrations from `~/.punkin/agent/settings.toml`. Always use `punkin install <path>` to register packages.

### Re-committing used VMs
Golden images committed from VMs that previously ran punkin (e.g., from a lieutenant session) have stale tmux sessions and pi-rpc fifos baked in. These cause swarm spawns to fail on the branched VMs. Always build golden images from **fresh VMs** using the bootstrap script.

### Disk size
Default VM disk is 1GB. Golden images need at least 4GB (`fs_size_mib=4096`). After bootstrap, disk usage is ~1.5GB.

### punkin vs pi
The old bootstrap used `npm install -g @mariozechner/pi-coding-agent` (the `pi` binary). The new bootstrap builds `punkin-pi` from source. If your swarm coordinator runs `punkin`, the golden image must also have `punkin` — otherwise the spawner will fail with `punkin: command not found`.
