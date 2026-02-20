# Vers Lieutenant Extension

Persistent, conversational agent sessions running on Vers VMs.

## Table of Contents

- [Overview](#overview)
- [Tools Reference](#tools-reference)
- [Architecture](#architecture)
- [Lifecycle](#lifecycle)
- [Registry Integration](#registry-integration)
- [Reconnection](#reconnection)
- [Configuration](#configuration)
- [Common Patterns](#common-patterns)
- [Known Limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)

---

## Overview

A **lieutenant** is a persistent, long-lived pi agent session running on its own Vers VM. Unlike swarm workers—which are ephemeral, single-task, and fire-and-forget—lieutenants persist across tasks, accumulate context over time, and support multi-turn conversational interaction.

### Lieutenants vs. Swarm Workers

| Property | Lieutenant | Swarm Worker |
|---|---|---|
| **Lifetime** | Persistent — survives across tasks | Ephemeral — destroyed after task completes |
| **Context** | Accumulates across all tasks | Fresh context per task |
| **Interaction** | Conversational: prompt, steer, follow-up | Single-task: fire and forget |
| **State** | Pausable / resumable (VM snapshot) | No pause support |
| **Identity** | Named, role-based (`"infra"`, `"docs"`) | Anonymous worker ID |
| **Cost** | VM stays alive (pause to save resources) | VM deleted on completion |
| **Use case** | Ongoing domain expertise, multi-step workflows | Parallelizable independent tasks |

### When to Use Lieutenants

- **Domain specialization** — A lieutenant named `"infra"` that accumulates knowledge about your infrastructure across dozens of tasks.
- **Multi-step workflows** — Send task 1, read the result, send task 2 that builds on it—all with shared context.
- **Steering** — Redirect an agent mid-task when requirements change.
- **Hierarchical orchestration** — A coordinator spawns lieutenants, each of which may spawn its own sub-swarms.

---

## Tools Reference

### `vers_lt_create`

Spawn a new lieutenant on a fresh Vers VM.

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | ✓ | Short identifier for the lieutenant (e.g., `"infra"`, `"billing"`, `"docs"`) |
| `role` | string | ✓ | Role description — becomes the lieutenant's system prompt context |
| `commitId` | string | ✓ | Golden image commit ID to create the VM from |
| `anthropicApiKey` | string | ✓ | Anthropic API key for the lieutenant's pi session |
| `model` | string | | Model ID (default: `claude-sonnet-4-20250514`) |

**Returns:** Confirmation with VM ID, name, role, and status.

**Example:**
```
vers_lt_create(
  name: "infra",
  role: "Manage infrastructure: Terraform, Kubernetes, CI/CD pipelines. You have deep knowledge of our AWS setup.",
  commitId: "abc123def456",
  anthropicApiKey: "sk-ant-..."
)
```

**What happens under the hood:**
1. Creates a new Vers VM from the specified commit image.
2. Waits for SSH availability (up to 60s).
3. Writes a system prompt file to the VM embedding the lieutenant's name and role.
4. Starts a `pi --mode rpc` daemon inside a tmux session on the VM.
5. Verifies the RPC daemon is responsive via a `get_state` handshake (up to 45s).
6. Registers the lieutenant in the local state and (optionally) the external registry.

**Errors:**
- `"Lieutenant 'X' already exists"` — A lieutenant with that name is already tracked. Destroy it first or pick a different name.
- `"VM failed to boot within 60s"` — The Vers VM didn't become SSH-reachable. The VM is cleaned up automatically.
- `"Pi RPC failed to start"` — The pi daemon didn't respond to the startup handshake. VM is cleaned up automatically.

---

### `vers_lt_send`

Send a message to a lieutenant. The behavior depends on the mode and the lieutenant's current state.

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | ✓ | Lieutenant name |
| `message` | string | ✓ | The message to send |
| `mode` | string | | One of `"prompt"`, `"steer"`, `"followUp"`. Defaults to `"prompt"`. |

**Modes:**

| Mode | When to Use | Behavior |
|---|---|---|
| `prompt` | Lieutenant is idle | Starts a new task. Increments the task counter. |
| `steer` | Lieutenant is working | Interrupts current work and redirects the agent. |
| `followUp` | Lieutenant is working | Queues the message to be processed after the current task finishes. |

**Auto-mode selection:** If you send a `prompt` while the lieutenant is working, it automatically becomes a `followUp` (with a note in the response). This prevents accidental task collisions.

**Returns:** Confirmation of what was sent and in which mode.

**Example:**
```
vers_lt_send(name: "infra", message: "Set up a staging Kubernetes namespace with resource quotas")
vers_lt_send(name: "infra", message: "Actually, use 4Gi memory limit instead of 2Gi", mode: "steer")
vers_lt_send(name: "infra", message: "After that, also add a NetworkPolicy", mode: "followUp")
```

**Errors:**
- `"Lieutenant 'X' not found"` — No lieutenant with that name exists.
- `"Lieutenant 'X' is paused"` — Resume it first with `vers_lt_resume`.

---

### `vers_lt_read`

Read the latest output from a lieutenant.

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | ✓ | Lieutenant name |
| `tail` | number | | Only return the last N characters of output |
| `history` | number | | Include N previous completed responses (max 20) |

**Returns:** The lieutenant's current or last output, along with status metadata.

**Behavior by status:**
- **`working`** — Returns the in-progress streaming output (partial response).
- **`idle`** — Returns the last completed response.
- **`paused`** — Returns whatever was last captured before pause.

**Example:**
```
vers_lt_read(name: "infra")
vers_lt_read(name: "infra", tail: 500)
vers_lt_read(name: "infra", history: 3)  // Last 3 completed responses + current
```

**Details in response:**
- `name`, `status`, `taskCount` — Current lieutenant state.
- `outputLength` — Character count of the current output buffer.
- `historyCount` — How many completed responses are stored in the rolling buffer.

---

### `vers_lt_status`

Overview of all tracked lieutenants.

**Parameters:** None.

**Returns:** A formatted status report for every lieutenant, including:
- Status icon: `⟳` working, `●` idle, `⏸` paused, `✗` error, `○` starting
- Name, role, VM ID
- Task count and last activity timestamp
- Output buffer size

**Example output:**
```
⟳ infra [working]
  Role: Manage infrastructure: Terraform, Kubernetes, CI/CD
  VM: vm_abc123def456
  Tasks: 5
  Last active: 2026-02-10T20:00:00.000Z
  Output: 1842 chars (streaming...)

● docs [idle]
  Role: Write and maintain documentation
  VM: vm_789ghi012jkl
  Tasks: 2
  Last active: 2026-02-10T19:45:00.000Z
  Output: 3201 chars
```

Also updates the UI widget sidebar if available.

---

### `vers_lt_pause`

Pause a lieutenant's VM, preserving full state (memory + disk).

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | ✓ | Lieutenant name |

**What happens:**
1. Calls the Vers API to pause the VM (`PATCH /vm/:id/state → { state: "Paused" }`).
2. The VM's full memory and disk are snapshotted — the pi session, tmux, all processes are frozen in place.
3. The lieutenant's local status is set to `"paused"`.
4. State is persisted to `~/.pi/lieutenants.json`.

**Constraints:**
- Cannot pause a lieutenant that is currently `"working"`. Either steer it to finish or wait for it to become idle.
- Pausing is idempotent — pausing an already-paused lieutenant returns a no-op message.

**Use case:** Save Vers resources when a lieutenant isn't actively needed. Resume later with full context intact.

---

### `vers_lt_resume`

Resume a paused lieutenant.

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | ✓ | Lieutenant name |

**What happens:**
1. Calls the Vers API to resume the VM (`PATCH /vm/:id/state → { state: "Running" }`).
2. Waits for SSH to become available (up to 30s).
3. Verifies the tmux `pi-rpc` session is still alive on the VM.
4. Reconnects the local tail process to resume output streaming.
5. Sets status to `"idle"`.

**Errors:**
- `"pi session not found"` — The tmux session was lost during pause/resume. Status is set to `"error"`. You'll need to destroy and recreate the lieutenant.

---

### `vers_lt_destroy`

Tear down a lieutenant: kills the remote pi daemon, deletes the VM.

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | ✓ | Lieutenant name, or `"*"` to destroy all lieutenants |

**What happens (per lieutenant):**
1. Deregisters from the external registry (best-effort).
2. Kills the RPC handle (terminates local tail SSH, kills remote tmux sessions, removes FIFO files).
3. If the VM is paused, resumes it first (some Vers backends require running state for deletion).
4. Deletes the VM via the Vers API.
5. Removes the lieutenant from local tracking and persists state.

**Example:**
```
vers_lt_destroy(name: "infra")     // Destroy one
vers_lt_destroy(name: "*")         // Destroy all
```

---

### `vers_lt_discover`

Discover running lieutenants from the external registry and reconnect to them.

**Parameters:** None.

**Returns:** A list of discovery results per registry entry:
- `"X: reconnected to VM abc123"` — Successfully reconnected.
- `"X: already connected"` — Already tracked locally, skipped.
- `"X: VM not found, skipping"` — Registry entry is stale.
- `"X: pi-rpc not running, skipping"` — VM exists but the pi tmux session is gone.
- `"X: reconnect failed — ..."` — SSH or other error.

**Use case:** After a full session restart where `~/.pi/lieutenants.json` was lost, but lieutenants are still running on VMs and registered in the registry.

---

## Architecture

### High-Level Overview

```
┌─────────────────────────────────────┐
│  Coordinator (local pi session)     │
│                                     │
│  ┌───────────────────────────────┐  │
│  │  vers-lieutenant extension    │  │
│  │                               │  │
│  │  lieutenants: Map<name, LT>  │  │
│  │  rpcHandles: Map<name, RPC>  │  │
│  └──────┬────────────┬──────────┘  │
│         │            │              │
└─────────┼────────────┼──────────────┘
          │            │
     SSH (send)   SSH (tail -f)
          │            │
          ▼            ▼
┌──────────────────────────────────────┐
│  Vers VM (per lieutenant)            │
│                                      │
│  tmux "pi-keeper": sleep ∞ > FIFO   │
│  tmux "pi-rpc":    pi --mode rpc    │
│                     < FIFO >> out    │
│                                      │
│  /tmp/pi-rpc/                        │
│    in   (named pipe / FIFO)          │
│    out  (append-only output file)    │
│    err  (stderr log)                 │
└──────────────────────────────────────┘
```

### Communication Channel

The extension communicates with each lieutenant's pi daemon through an SSH-tunneled RPC channel:

**Input (sending commands):**
1. Commands are JSON-serialized and newline-terminated.
2. A new SSH connection is opened per command: `ssh ... "cat > /tmp/pi-rpc/in"`.
3. The JSON is written to stdin of the SSH process, which pipes it into the FIFO.
4. The pi daemon reads from the FIFO and processes the command.

**Output (reading responses):**
1. A persistent SSH connection runs `tail -f /tmp/pi-rpc/out` on the VM.
2. The pi daemon appends JSON-line events to the output file.
3. The local tail process streams these back, where they're parsed line-by-line.
4. Events are dispatched to the lieutenant's event handler.

**FIFO Keepalive:**
- A tmux session named `pi-keeper` runs `sleep infinity > /tmp/pi-rpc/in`.
- This keeps the FIFO's write end open so the pi daemon doesn't see EOF and exit when there are gaps between commands.

### SSH Tunneling

All SSH connections use the Vers SSH proxy:

```
ProxyCommand=openssl s_client -connect %h:443 -servername %h -quiet
```

This tunnels SSH over TLS to `<vmId>.vm.vers.sh:443`, avoiding firewall issues with non-standard ports.

Additional SSH options ensure reliability:
- `ConnectTimeout=30` — Fail fast on unreachable VMs.
- `ServerAliveInterval=15` / `ServerAliveCountMax=4` — Detect dead connections within ~60s.
- `StrictHostKeyChecking=no` — VMs are ephemeral; host keys change.

### RPC Events

The pi daemon emits JSON-line events on the output stream. Key event types:

| Event | Meaning |
|---|---|
| `agent_start` | Pi has begun processing a prompt |
| `agent_end` | Pi has finished processing |
| `message_update` (with `text_delta`) | Streaming token from the assistant |
| `response` (to `get_state`) | Acknowledgment used for startup handshake |

The extension uses these to track lieutenant status (`working` ↔ `idle`) and accumulate output text.

---

## Lifecycle

```
                    ┌──────────┐
          create    │ starting │
        ──────────► │          │
                    └────┬─────┘
                         │ RPC handshake OK
                         ▼
                    ┌──────────┐  prompt   ┌──────────┐
                    │   idle   │ ────────► │ working  │
                    │          │ ◄──────── │          │
                    └────┬─────┘ agent_end └──┬───────┘
                         │                    │
                   pause │              steer │ (redirect)
                         ▼                    │
                    ┌──────────┐              │
                    │  paused  │              │
                    │          │              │
                    └────┬─────┘              │
                         │                    │
                  resume │                    │
                         ▼                    │
                    ┌──────────┐              │
                    │   idle   │ ◄────────────┘
                    └────┬─────┘     (eventually)
                         │
                 destroy │
                         ▼
                    ┌──────────┐
                    │ (gone)   │
                    └──────────┘
```

### Stage Details

**Starting** — VM is being provisioned, SSH is being probed, pi daemon is launching. Takes 20–90 seconds typically. If anything fails, the VM is cleaned up and an error is thrown.

**Idle** — The lieutenant is ready and waiting for tasks. Its pi daemon is running but not processing a prompt. You can send prompts, pause, or destroy it.

**Working** — The lieutenant is actively processing a prompt. Output is streaming. You can steer (interrupt/redirect), send follow-ups (queued), or read partial output. You cannot pause while working.

**Paused** — The VM is suspended via Vers. All state (memory, disk, processes) is frozen. No SSH access is possible. Resume to return to idle. Costs no compute while paused.

**Error** — Something went wrong (e.g., tmux session lost after resume). The lieutenant is tracked but non-functional. Destroy and recreate.

---

## Registry Integration

The extension optionally integrates with an external VM registry for cross-session discovery.

### How It Works

**Registration:** When a lieutenant is created, it posts an entry to `$VERS_INFRA_URL/registry/vms`:

```json
{
  "id": "vm_abc123",
  "name": "infra",
  "role": "lieutenant",
  "address": "vm_abc123.vm.vers.sh",
  "registeredBy": "vers-lieutenant",
  "metadata": {
    "agentId": "infra",
    "role": "Manage infrastructure...",
    "commitId": "abc123def456",
    "createdAt": "2026-02-10T20:00:00.000Z"
  }
}
```

**Deregistration:** When a lieutenant is destroyed, its entry is deleted from the registry.

**Discovery:** `vers_lt_discover` queries the registry for entries where `registeredBy === "vers-lieutenant"` and `role === "lieutenant"`, then attempts to reconnect to each one.

### Requirements

Registry integration requires two environment variables:
- `VERS_INFRA_URL` — Base URL of the infrastructure service.
- `VERS_AUTH_TOKEN` — Bearer token for registry API authentication.

If either is missing, all registry operations silently no-op. The extension works fine without registry support—it just won't have cross-session discovery via the registry (local persistence via `lieutenants.json` still works).

---

## Reconnection

Lieutenants are designed to survive coordinator restarts. There are two reconnection mechanisms:

### 1. Local State File (`~/.pi/lieutenants.json`)

On every state mutation (create, send, pause, resume, destroy), the extension persists a snapshot:

```json
{
  "lieutenants": [
    {
      "name": "infra",
      "role": "Manage infrastructure...",
      "vmId": "vm_abc123",
      "status": "idle",
      "taskCount": 5,
      "createdAt": "2026-02-10T18:00:00.000Z",
      "lastActivityAt": "2026-02-10T20:00:00.000Z"
    }
  ],
  "savedAt": "2026-02-10T20:01:00.000Z"
}
```

**On extension load** (async, non-blocking):
1. Reads `~/.pi/lieutenants.json`.
2. For each saved lieutenant, checks VM status via the Vers API.
3. If the VM is running: SSHes in, verifies the tmux `pi-rpc` session exists, and reconnects the tail output stream.
4. If the VM is paused: Restores the lieutenant in `"paused"` status (no SSH needed).
5. If the VM is gone or in an unexpected state: Skips it with a log message.

**Important:** Reconnection skips old output. The tail starts with `-n 0` (new lines only), so you won't see a replay of previous work. The lieutenant's context is preserved on the VM—it just won't echo old output to the coordinator.

### 2. Registry Discovery (`vers_lt_discover`)

If `~/.pi/lieutenants.json` is lost (e.g., the coordinator's filesystem was wiped), but VMs are still running and registered:

1. Call `vers_lt_discover` (or it runs automatically on `session_start` if `VERS_INFRA_URL` is set).
2. The extension queries the registry, finds lieutenant entries, checks each VM, and reconnects.

### Session Shutdown Behavior

On `session_shutdown`, the extension:
- Persists final state to `~/.pi/lieutenants.json`.
- Disconnects local SSH tail processes.
- Does **not** kill the remote pi daemons or VMs — they continue running independently.

---

## Configuration

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✓ (at create time) | Passed as a parameter to `vers_lt_create`. Forwarded to the lieutenant's pi daemon. |
| `VERS_API_KEY` | ✓ | API key for Vers VM management. Also read from `~/.vers/keys.json`. |
| `VERS_BASE_URL` | | Override the Vers API base URL (default: `https://api.vers.sh/api/v1`). |
| `VERS_INFRA_URL` | | Infrastructure service URL for registry integration. If unset, registry is disabled. |
| `VERS_AUTH_TOKEN` | | Bearer token for the registry API. Required if `VERS_INFRA_URL` is set. |

### Environment Forwarding

When a lieutenant is created, the following environment variables from the coordinator are forwarded to the lieutenant's pi daemon:
- `ANTHROPIC_API_KEY` (from the `anthropicApiKey` parameter)
- `VERS_API_KEY`
- `VERS_BASE_URL`
- `VERS_INFRA_URL`
- `VERS_AUTH_TOKEN`
- `GIT_EDITOR=true` (hardcoded to prevent interactive editor prompts)

This means lieutenants can themselves use Vers tools—including spawning sub-swarms or even sub-lieutenants.

### State File

Lieutenant state is persisted at `~/.pi/lieutenants.json`. This file is automatically managed; you shouldn't need to edit it manually. Delete it to force a clean slate (existing VMs will still be running—use the registry or manual cleanup).

---

## Common Patterns

### Fire-and-Forget Task

Send a task and check back later:

```
vers_lt_send(name: "infra", message: "Audit all S3 buckets for public access and generate a report")
// ... do other work ...
vers_lt_read(name: "infra")
```

### Steering Mid-Task

Redirect a lieutenant while it's working:

```
vers_lt_send(name: "infra", message: "Migrate the database to the new schema")
// Realize you need to change approach:
vers_lt_send(name: "infra", message: "Stop — do a dry run first, don't apply changes yet", mode: "steer")
```

### Follow-Up Queuing

Queue work that builds on the current task:

```
vers_lt_send(name: "docs", message: "Write API docs for the /users endpoint")
vers_lt_send(name: "docs", message: "After that, also document the /billing endpoint", mode: "followUp")
```

The follow-up message will be delivered after the current task completes.

### Multi-Step Workflow with Context

Leverage the lieutenant's accumulated context:

```
vers_lt_send(name: "infra", message: "List all EKS clusters and their node counts")
// Wait for completion...
vers_lt_read(name: "infra")
// Lieutenant now knows the cluster topology
vers_lt_send(name: "infra", message: "Scale the production cluster to 5 nodes")
// It already knows which cluster is 'production' from the previous task
```

### Hierarchical Lieutenants

A lieutenant can spawn its own sub-lieutenants or sub-swarms since it has access to Vers tools and API keys:

```
vers_lt_create(name: "lead", role: "Technical lead. Coordinate sub-teams for large projects.", ...)
vers_lt_send(name: "lead", message: "Refactor the payment system. Spawn sub-lieutenants for frontend, backend, and testing.")
```

The `lead` lieutenant can then call `vers_lt_create` within its own session to spawn specialized sub-agents.

### Resource Management with Pause/Resume

Keep lieutenants around but save costs:

```
vers_lt_pause(name: "infra")     // Done for now, freeze state
// Hours or days later...
vers_lt_resume(name: "infra")    // Wake up with full context intact
vers_lt_send(name: "infra", message: "Continue where you left off — what's the status?")
```

---

## Known Limitations

### Output Reading After Pi Exit

If the pi daemon on the lieutenant's VM crashes or exits unexpectedly, the tail process will continue running but no new output will appear. The lieutenant will appear stuck in whatever its last status was. The `agent_end` event won't fire, so status may remain `"working"` indefinitely.

**Workaround:** Check for stale lieutenants by comparing `lastActivityAt` to current time. If a lieutenant has been `"working"` for an unusually long time, SSH in manually to check the tmux session.

### Idle Timeout

There is no built-in idle timeout. A lieutenant's VM will run (and cost money) indefinitely until you explicitly pause or destroy it. Plan your lieutenant lifecycle accordingly.

### Sequential SSH Probes on Reconnect

During reconnection (on extension load), each saved lieutenant is probed sequentially—SSH to check VM state, verify tmux, start tail. With many lieutenants, this can take significant time at startup. There is no parallel reconnection currently.

### Output History Limit

The rolling output history buffer holds at most 20 completed responses. Older responses are dropped. If you need to review earlier work, you'll need to SSH into the VM and check the raw output file at `/tmp/pi-rpc/out`.

### No Automatic Error Recovery

If a lieutenant enters the `"error"` state (e.g., tmux session lost after resume), it stays in error. There's no automatic retry or self-healing. You must destroy and recreate the lieutenant.

### Single Coordinator Assumption

The extension assumes a single coordinator is managing lieutenants at any time. If two coordinator sessions both load the same `lieutenants.json` and try to manage the same lieutenants simultaneously, behavior is undefined—output events may be split between sessions, state may diverge.

---

## Troubleshooting

### "Pi RPC failed to start on \<vmId\>"

**Cause:** The pi daemon didn't respond to the startup `get_state` handshake within 45 seconds.

**Possible reasons:**
- The `ANTHROPIC_API_KEY` is invalid or expired.
- The VM's pi installation is broken or missing.
- The golden image commit doesn't include pi.
- Network issues between the VM and Anthropic's API.

**Resolution:**
1. The VM is automatically cleaned up on this error.
2. Verify your API key is valid.
3. Verify the commit ID points to a working golden image with pi installed.
4. Try creating the lieutenant again.

### "Lieutenant 'X' not found"

**Cause:** No lieutenant with that name is currently tracked.

**Possible reasons:**
- The lieutenant was never created in this session.
- The coordinator restarted and reconnection failed silently.
- The lieutenant was destroyed.

**Resolution:**
1. Run `vers_lt_status` to see all tracked lieutenants.
2. Run `vers_lt_discover` to check the registry for orphaned lieutenants.
3. Check `~/.pi/lieutenants.json` for persisted state.

### "session not found" / Stale Tmux

**Cause:** The tmux `pi-rpc` session on the VM no longer exists.

**Possible reasons:**
- Pi crashed or exited.
- The VM was restarted outside of the lieutenant extension.
- OOM killer terminated the pi process.

**Resolution:**
1. SSH into the VM manually: `ssh -i <keyfile> root@<vmId>.vm.vers.sh`
2. Check tmux sessions: `tmux list-sessions`
3. Check logs: `cat /tmp/pi-rpc/err`
4. If unrecoverable, destroy and recreate: `vers_lt_destroy(name: "X")`

### Lieutenant Stuck in "working"

**Cause:** The `agent_end` event was never received.

**Possible reasons:**
- The tail SSH connection dropped and hasn't reconnected.
- Pi is genuinely still working (large task).
- Pi crashed mid-task (see "stale tmux" above).

**Resolution:**
1. Check `lastActivityAt` in `vers_lt_status`. If it's recent, pi may still be working.
2. Try `vers_lt_read` — if output is growing, it's still active.
3. SSH in and check: `tmux has-session -t pi-rpc && echo alive || echo dead`
4. If the tail connection dropped, the extension auto-reconnects after 3 seconds. Force a reconnect by calling `vers_lt_read`.

### Orphaned VMs

**Cause:** The coordinator crashed before persisting state, or `lieutenants.json` was deleted.

**Resolution:**
1. Run `vers_lt_discover` to find and reconnect via the registry.
2. If no registry: use the Vers dashboard or API to list VMs and manually identify lieutenant VMs.
3. Delete orphaned VMs via the Vers API: `DELETE /vm/<vmId>`.

### SSH Connection Failures

**Cause:** Can't establish SSH to the lieutenant's VM.

**Possible reasons:**
- VM is paused (no SSH while paused — resume first).
- VM was deleted externally.
- Network issues / Vers infrastructure problems.
- SSH key cache is stale (keys are cached in `/tmp/vers-ssh-keys/`).

**Resolution:**
1. Clear the key cache: `rm -rf /tmp/vers-ssh-keys/`
2. Check VM status via the Vers API.
3. If the VM is gone, destroy the lieutenant locally: `vers_lt_destroy(name: "X")`.
