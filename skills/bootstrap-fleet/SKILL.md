---
name: bootstrap-fleet
description: Bootstrap a self-improving agent fleet on Vers from scratch. Walks through deploying agent-services, building a golden image, testing the loop, and running first tasks. Use when onboarding someone new to the Vers agent fleet workflow.
---

# Bootstrap Fleet

Guide a user from zero infrastructure to a working self-improving agent fleet on Vers. This skill encodes the full bootstrap sequence and the hard-won lessons from operating fleets in production.

## Prerequisites

Before starting, verify these are in place:

- [ ] `ANTHROPIC_API_KEY` is set
- [ ] `VERS_API_KEY` is set (get yours from `https://vers.sh/orgs/<org>/settings/api-keys`)
- [ ] pi-v package is installed (`pi install https://github.com/hdresearch/pi-v`)
- [ ] vers-agent-services package is installed (`pi install https://github.com/hdresearch/vers-agent-services`)
- [ ] Or run `curl -fsSL https://raw.githubusercontent.com/hdresearch/pi-v/main/install.sh | bash` to install both at once

```bash
# Quick check — should show vers_vm_create, vers_swarm_spawn, etc.
echo "ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:+set}" 
echo "VERS_API_KEY: ${VERS_API_KEY:+set}"
```

If pi-v is not installed, install it first. If API keys are missing, ask the user to set them before proceeding.

## Overview

The bootstrap has 4 phases. Each phase builds on the last. Don't skip ahead.

| Phase | What | Time | Result |
|-------|------|------|--------|
| 1 | Deploy agent-services to an infra VM | ~15 min | Shared coordination layer (board, feed, log, registry) |
| 2 | Build a golden image | ~20 min | Reusable VM snapshot with pi + all tools pre-installed |
| 3 | Test the loop | ~10 min | Verify an agent can spawn, use tools, and coordinate |
| 4 | Ignition | ongoing | Real work via the fleet |

> **⚠️ IMPORTANT**: Run Phases 1–3 continuously without stopping to ask the user. The only point where user input is needed is Phase 4 (choosing what work to do). Every step in Phases 1–3 is fully automatable — env vars get written to shell config AND exported in the current session, golden image gets built and tested, loop gets verified. Keep moving until the fleet is ready.

---

## Phase 1: Deploy Agent-Services

### 1a. Create the infra VM

```
vers_vm_create with mem_size_mib=4096, fs_size_mib=8192, vcpu_count=2, wait_boot=true
```

Save the VM ID — this is your **infra VM**. All agents will talk to it.

### 1b. Set up the server

```
vers_vm_use <infra_vm_id>
```

Then run on the VM:

```bash
# Install Node.js
export DEBIAN_FRONTEND=noninteractive
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - > /dev/null 2>&1
apt-get install -y -qq nodejs git > /dev/null 2>&1

# Clone and build
cd /root
git clone https://github.com/hdresearch/vers-agent-services.git
cd vers-agent-services
npm install
npm run build

# Generate auth token
export VERS_AUTH_TOKEN=$(openssl rand -hex 32)
echo "Auth token: $VERS_AUTH_TOKEN"

# Start in background
export PORT=3000
nohup npm start > /tmp/agent-services.log 2>&1 &

# Verify
sleep 3
curl -s http://localhost:3000/health
```

### 1c. Record the connection details

Switch back to local:
```
vers_vm_local
```

Write the agent-services config file so the extension picks it up automatically — no env vars or shell restart needed:

```bash
mkdir -p ~/.vers
cat > ~/.vers/agent-services.json << EOF
{
  "url": "https://<infra_vm_id>.vm.vers.sh:3000",
  "token": "<the token from above>"
}
EOF
echo "Wrote ~/.vers/agent-services.json"
```

Replace `<infra_vm_id>` and `<the token from above>` with the actual values.

After writing this file, the agent-services extension will find it on next `/reload` or pi restart — no shell config editing needed.

Also export env vars in the current pi process so they're live immediately without even a reload:

```bash
export VERS_INFRA_URL=https://<infra_vm_id>.vm.vers.sh:3000
export VERS_AUTH_TOKEN=<the token from above>
echo "VERS_INFRA_URL=$VERS_INFRA_URL"
echo "VERS_AUTH_TOKEN=${VERS_AUTH_TOKEN:+set}"
```

### 1d. Snapshot immediately

**Critical** — snapshot the infra VM before anything else. If the VM dies, you lose all state.

```
vers_vm_commit <infra_vm_id>
```

Save the commit ID. This is your infra recovery point.

### 1e. Verify coordination tools work

Test the tools (env vars are already live from the export in 1c):

```
board_create_task with title="Bootstrap complete", description="Infra VM deployed and snapshotted", tags=["bootstrap"]
board_list_tasks
log_append with text="Fleet bootstrap started. Infra VM deployed."
feed_publish with type="custom", summary="Infra VM online", agent="orchestrator"
```

All four should succeed. If any fail, check `VERS_INFRA_URL` and `VERS_AUTH_TOKEN`.

### 1f. Generate a dashboard login link

Agent-services ships with a web dashboard for viewing the board, feed, and log. It requires a magic link to log in. Generate one by SSH-ing into the infra VM:

```
vers_vm_use <infra_vm_id>
```

```bash
curl -s -X POST http://localhost:3000/auth/magic-link \
  -H "Authorization: Bearer <auth_token>" \
  -H "Content-Type: application/json"
```

This returns a URL like `https://localhost:3000/ui/login?token=...`. Replace `localhost` with the infra VM host:

```
https://<infra_vm_id>.vm.vers.sh:3000/ui/login?token=<token>
```

Share the link with the user — it expires in 5 minutes and sets a session cookie for the dashboard. Don't wait for confirmation, keep moving to Phase 2. Switch back to local after:

```
vers_vm_local
```

---

## Phase 2: Build the Golden Image

Use the `vers-golden-vm` skill for the detailed steps. The high-level flow:

### 2a. Create a fresh VM

```
vers_vm_create with mem_size_mib=4096, fs_size_mib=8192, wait_boot=true
```

### 2b. Bootstrap it

Set the VM as active with `vers_vm_use`, then run the bootstrap script from the vers-golden-vm skill (`scripts/bootstrap.sh`). After bootstrapping:

1. Copy extensions into the VM (vers-vm.ts, vers-swarm.ts)
2. Copy AGENTS.md context
3. Set up swarm directories

### 2c. Install both packages on the golden image

This is the step most people miss. The golden image needs BOTH packages:

```bash
# On the VM — install.sh handles both, or do it manually:
pi install https://github.com/hdresearch/pi-v
pi install https://github.com/hdresearch/vers-agent-services
```

### 2d. Set environment defaults

```bash
# On the VM — these will be inherited by all agents spawned from this image
echo 'export GIT_EDITOR=true' >> /root/.bashrc
```

Also bake the infra connection into `/etc/environment` so spawned agents can use coordination tools immediately:

```bash
cat >> /etc/environment << EOF
VERS_INFRA_URL=https://<infra_vm_id>.vm.vers.sh:3000
VERS_AUTH_TOKEN=<auth_token>
EOF
```

> **⚠️ CRITICAL**: Use `/etc/environment`, NOT `.bashrc` for these. Pi agents don't run in interactive shells, so `.bashrc` is never sourced. `/etc/environment` is read by all processes.

> **⚠️ CRITICAL LESSON**: Use `pi install`, not manual file copying. `pi install` writes to `~/.pi/agent/settings.json` which pi actually reads. Manually copying files creates `~/.pi/packages.json` which pi ignores. This bug results in agents having only 4 base tools instead of 35+. Always verify after building:
>
> ```bash
> cat /root/.pi/agent/settings.json
> # Should show both packages in the "packages" array
> ```

### 2e. Commit the golden image

```
vers_vm_local
vers_vm_commit <golden_vm_id>
```

Save the commit ID. This is your **golden image**.

### 2f. Verify tool count

Spawn a test agent from the golden image and verify it has the full toolset:

```
vers_swarm_spawn with commitId=<golden_commit_id>, count=1, labels=["test-golden"], anthropicApiKey=<key>
vers_swarm_task with agentId="test-golden", task="List all your available tools. Count them. If you have fewer than 30 tools, something is wrong — report that."
vers_swarm_wait
vers_swarm_read with agentId="test-golden"
vers_swarm_teardown
```

If the agent reports fewer than 30 tools, the golden image is broken. Rebuild it.

---

## Phase 3: Test the Loop

This is the moment of truth. Spawn an agent that can:
1. Boot from the golden image ✓
2. Access all tools ✓  
3. Use the shared board ✓

```
vers_swarm_spawn with commitId=<golden_commit_id>, count=1, labels=["test-loop"], anthropicApiKey=<key>
```

Send it a task that exercises the coordination layer:

```
vers_swarm_task with agentId="test-loop", task="You are a test agent verifying the fleet is working. Do these things in order: 1) Use board_create_task to create a task titled 'Loop test' with description 'Created by test-loop agent to verify fleet coordination'. 2) Use feed_publish to publish an event with type='custom', summary='Test agent online and working'. 3) Use log_append to write 'Test agent successfully used all coordination tools.' Report back what happened."
```

Wait and read:
```
vers_swarm_wait
vers_swarm_read with agentId="test-loop"
```

**If the agent created a board task, published a feed event, and wrote a log entry — the loop is live.**

Clean up:
```
vers_swarm_teardown
```

Print a summary table of all asset IDs (infra VM, infra commit, golden image commit, golden VM) then proceed directly to Phase 4.

---

## Phase 4: Ignition — First Real Tasks

Now point the fleet at real work. Suggest these in order:

### Task 1: Orient

> "Read the board, the work log, and the feed. Summarize what exists. Create 3-5 board tasks for things worth working on."

This establishes the read-first habit.

### Task 2: Build something real

Help the user pick a concrete task, then:

```
vers_swarm_spawn with commitId=<golden_commit_id>, count=1, labels=["worker-1"], anthropicApiKey=<key>
vers_swarm_task with agentId="worker-1", task="<the actual task with a clear deliverable>"
```

Good first tasks have **clear deliverables**: "Build X", "Fix Y", "Write tests for Z", "Analyze codebase and write a report."

Bad first tasks are open-ended: "Investigate everything about X" (agent reads forever, writes never).

### Task 3: Run parallel work

Once comfortable with single agents, try parallelism:

```
vers_swarm_spawn with commitId=<golden_commit_id>, count=3, labels=["worker-a", "worker-b", "worker-c"], anthropicApiKey=<key>
```

Send each a different task. Monitor via `vers_swarm_status`. Collect results via `vers_swarm_wait`.

---

## Troubleshooting

### Agent has only 4 tools

The golden image used manual file copying instead of `pi install`. Rebuild it. See the critical lesson in Phase 2d.

### Agent can't reach infra URL

The `VERS_INFRA_URL` and `VERS_AUTH_TOKEN` env vars need to be set on the agent's VM, not just locally.

> **⚠️ CRITICAL**: Use `/etc/environment`, NOT `.bashrc`. Pi agents don't run in interactive shells, so `.bashrc` is never sourced. `/etc/environment` is read by all processes via PAM.

Bake them into the golden image:
```bash
cat >> /etc/environment << EOF
VERS_INFRA_URL=https://<infra_vm_id>.vm.vers.sh:3000
VERS_AUTH_TOKEN=<token>
EOF
```

Then recommit the golden image. If the infra VM changes, you'll need to rebuild.

### Infra VM died / state lost

Restore from the infra snapshot:
```
vers_vm_restore <infra_commit_id>
```

You'll lose data since the last snapshot. Lesson: snapshot the infra VM regularly, and always before deploys.

### Agent reads forever, produces nothing

Never give open-ended "investigate X" tasks. Always include a deliverable:
- ❌ "Investigate the auth system"
- ✅ "Investigate the auth system and write a report with findings and 3 recommended improvements"

If an agent is stuck, use `vers_swarm_read` to check progress. You can send a follow-up message via `vers_swarm_task` to steer it.

### VM creation fails

Check for orphan VMs consuming capacity:
```
vers_vms
```

Delete any VMs you're not using:
```
vers_vm_delete <vm_id>
```

---

## Maintaining the Fleet

### Daily habits

1. **Start every session** by reading the board, log, and feed
2. **Snapshot the infra VM** before any maintenance
3. **Log continuously** — if it's not in the log, it didn't happen
4. **Update the board** — tasks should flow through open → in_progress → done

### Weekly habits

1. **Backup data** — export board/log/feed/journal from the infra VM
2. **Review the golden image** — does it need updates (new tools, new packages)?
3. **Groom the board** — close stale tasks, update priorities

### Signs the loop is working

- ✅ Agents are creating tasks, not just completing them
- ✅ Agents are improving agent infrastructure (skills, tools, conventions)
- ✅ Velocity is increasing without you working harder
- ✅ Recovery from failures is getting faster

### Signs the loop is NOT working

- ❌ You're doing work yourself instead of delegating
- ❌ The board is empty or stale
- ❌ The work log has gaps
- ❌ Every agent spawn requires manual intervention
