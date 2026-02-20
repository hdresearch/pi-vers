---
name: vers-swarm
description: Orchestrate agent swarms across Vers VMs - spawn parallel agents on branched VMs for distributed work, parallel exploration, or multi-path problem solving. Use when you need to run multiple agents simultaneously on isolated environments.
---

# Vers Swarm Orchestration

Spawn and coordinate multiple agents across branched Vers VMs. Each agent runs in an isolated environment branched from a common state.

## Prerequisites

- `VERS_API_KEY` environment variable
- A committed VM state (commit_id) to branch from
- For Clawdbot swarms: use `sessions_spawn` for each VM

## Concept

```
        [Golden Commit]
              │
    ┌─────────┼─────────┐
    ▼         ▼         ▼
 [VM-A]    [VM-B]    [VM-C]
 Agent1    Agent2    Agent3
   │         │         │
   ▼         ▼         ▼
 Result1   Result2   Result3
```

All agents start from identical state, explore independently, report back.

## Workflow

### 1. Prepare Golden State

Create and configure a VM with all needed tools:

```bash
# Create VM
VM_ID=$(curl -s -X POST -H "Authorization: Bearer $VERS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"vm_config": {"vcpu_count": 2, "mem_size_mib": 2048, "fs_size_mib": 2048}}' \
  "https://api.vers.sh/api/v1/vm/new_root?wait_boot=true" | jq -r .vm_id)

# SSH in and install tools (Node, Python, git, etc.)
# ... setup commands ...

# Commit as golden image
COMMIT_ID=$(curl -s -X POST -H "Authorization: Bearer $VERS_API_KEY" \
  https://api.vers.sh/api/v1/vm/$VM_ID/commit | jq -r .commit_id)

echo "Golden commit: $COMMIT_ID"
```

### 2. Spawn Swarm

Branch N VMs from the golden commit:

```bash
# Branch from commit (repeat for each agent)
NEW_VM=$(curl -s -X POST -H "Authorization: Bearer $VERS_API_KEY" \
  https://api.vers.sh/api/v1/vm/branch/by_commit/$COMMIT_ID | jq -r .vm_id)
```

### 3. Dispatch Tasks

For Clawdbot, use `sessions_spawn` to create sub-agents that SSH into each VM:

```
For each VM:
  1. Get SSH credentials
  2. Spawn sub-agent with task
  3. Sub-agent SSHs to VM, executes task
  4. Report results back
```

### 4. Collect Results

Wait for all agents to complete, gather outputs.

### 5. Teardown

Delete all swarm VMs when done:

```bash
curl -s -X DELETE -H "Authorization: Bearer $VERS_API_KEY" \
  https://api.vers.sh/api/v1/vm/$VM_ID
```

## Use Cases

### Parallel Code Exploration
- Branch 3 VMs
- Agent A: Try approach with library X
- Agent B: Try approach with library Y  
- Agent C: Try from-scratch implementation
- Compare results, pick winner

### Distributed Testing
- Branch per test suite
- Run tests in parallel
- Aggregate results

### Safe Experimentation
- Branch before risky changes
- If it breaks, the original is untouched
- If it works, commit the new state

## Coordination Patterns

### Fan-Out / Fan-In
1. Coordinator commits baseline
2. Fan-out: spawn N workers from commit
3. Workers execute independently
4. Fan-in: collect results, synthesize

### Checkpoint & Retry
1. Commit before each major step
2. If step fails, restore and retry with different approach
3. Build up chain of successful commits

## Tips

- Keep golden images minimal but complete
- Commit often — checkpoints are cheap
- Label your commits (store commit_id → description mapping)
- Clean up VMs when done to avoid costs
- VMs branch instantly — the copy-on-write is fast
