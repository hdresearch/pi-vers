# Reef Session Prompt
> Copy everything below this line into a Claude Code session for hdresearch/reef

---

You are working on hdresearch/reef, an agent server/kernel framework (v0.3.0, Bun + Hono + TypeScript). This is part of a coordinated cross-repo migration with hdresearch/pi-vers (being handled in a separate session on PR #60).

## Architecture Context

Three repos form the Vers agent platform:

- **reef** (this repo): Agent server — spawns per-task `pi --mode rpc` processes, hosts auto-discovered service modules, manages a ConversationTree. Has core services (cron, docs, installer, store, UI, services manager) and example services (registry, board, feed, journal, log, etc.).
- **pi-vers** (separate session): Pi extension package — VM APIs, SSH, swarm orchestration, lieutenants, background processes. Being consolidated in a separate PR.
- **punkin-pi** (private): Fork of pi-mono with harness work. Not in scope.

## Target Architecture

```
roof reef (SQLite VM tree, module distribution)
 └── lieutenants (1:many, snapshot to create)
      └── swarm workers / agent VMs (fleets)
           └── each bootstrapped with reef (bootloader) + selective modules + optional pi-vers
```

- Reef owns: lieutenants, VM registry, vers configs, SQLite VM lineage tree, module distribution
- Pi-vers owns: VM APIs (vers-vm.ts), SSH (vers-vm-copy.ts), shell/auth flows, swarm orchestration
- Reef acts as bootloader on every agent VM, selectively loading modules and optionally pi-vers
- Agent VMs can promote to lieutenants
- All VMs tracked in SQLite with "DNA" (modules=organs, extensions=capabilities)

## What Needs to Happen in Reef (3 phases, in order)

### Phase 1: Move Lieutenants into Reef as a Service Module

Pi-vers currently has `extensions/vers-lieutenant.ts` (~1400 lines) implementing persistent agent sessions on VMs. It provides 8 tools: `vers_lt_create`, `vers_lt_send`, `vers_lt_read`, `vers_lt_status`, `vers_lt_pause`, `vers_lt_resume`, `vers_lt_destroy`, `vers_lt_discover`.

The lieutenant extension today:
- Spawns persistent agent sessions on VMs via SSH + `pi --mode rpc`
- Tracks state in `~/.pi/lieutenants.json`
- Integrates with vers-agent-services registry for cross-session discovery
- Supports pause/resume/multi-turn conversation
- Supports hierarchical orchestration (lieutenants can spawn sub-lieutenants/swarms)

**Task**: Create `services/lieutenant/index.ts` as a reef ServiceModule that:
- Adapts the lieutenant concept to reef's service module interface (see existing services like `services/cron/` or `services/store/` for the pattern)
- Uses reef's per-task pi process spawning where applicable
- Stores state in reef's store service or the new SQLite DB (Phase 3)
- Exposes HTTP routes for lieutenant management
- Provides agent tools via the service module tool interface
- Ports the 8 tools listed above

Reference the pi-vers source for behavior. You can fetch it from GitHub:
- Lieutenant extension: https://github.com/hdresearch/pi-vers/blob/main/extensions/vers-lieutenant.ts
- Lieutenant docs: https://github.com/hdresearch/pi-vers/blob/main/docs/lieutenant.md
- Agent guide: https://github.com/hdresearch/pi-vers/blob/main/docs/agents/manage-lieutenants.md

### Phase 2: Promote VM Registry to Core + SQLite Backing

Reef already has `examples/services/registry/index.ts` with REST endpoints for VM registration, role filtering, heartbeat, and health discovery.

**Task**:
1. Move `examples/services/registry/` → `services/registry/`
2. Replace in-memory storage with SQLite
3. Add VM lineage tracking (parent-child relationships)
4. Add reef config tracking per VM (the "DNA" concept)

### Phase 3: Build SQLite VM Tree

**Task**: Create `services/vm-tree/index.ts` (or extend registry) with this schema:

```sql
CREATE TABLE vms (
  vm_id        TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  parent_vm_id TEXT REFERENCES vms(vm_id),
  category     TEXT NOT NULL CHECK(category IN ('lieutenant', 'swarm_vm', 'agent_vm', 'infra_vm')),
  reef_config  TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_vms_parent ON vms(parent_vm_id);
CREATE INDEX idx_vms_category ON vms(category);
```

`reef_config` is JSON representing VM DNA:
```json
{
  "organs": ["lieutenant", "registry", "cron", "store"],
  "capabilities": ["vers-vm", "vers-vm-copy", "vers-swarm", "ssh"]
}
```

Features needed:
- Full lineage tree queries (ancestors, descendants, subtrees)
- Category-based filtering
- Config diff between VMs
- Dashboard view: which modules/extensions are on which VM, where in the tree
- Hourly snapshots via reef's cron service: copy `data/vms.sqlite` → `data/snapshots/vms-{timestamp}.sqlite`, retain last 24
- SQLite should be part of the public starter image
- A normal person should be able to see which modules (plugins) and extensions are available on which VM and where that VM is on the lineage tree

### Phase 4 (after Phases 1-3): Vers Configs into Reef

Move config resolution from pi-vers into reef:

| Config | From (pi-vers) | To (reef) |
|--------|----------------|-----------|
| `VERS_API_KEY` resolution | `~/.vers/keys.json`, `~/.vers/config.json` | Reef store service |
| `VERS_INFRA_URL` / `VERS_AUTH_TOKEN` | `~/.vers/agent-services.json` | Reef core auth (src/core/auth.ts already has bearer auth) |
| Lieutenant state | `~/.pi/lieutenants.json` | Reef SQLite or store |

SSH-specific config (keys, control sockets) stays in pi-vers.

### Phase 5 (stretch): Reef as Bootloader

When a lieutenant spins up agent VMs, it bootstraps reef onto the VM first. The boot flow:

1. Create VM via Vers API (pi-vers handles this)
2. SCP `scripts/boot.sh` to VM and run it
3. Install reef with selected modules based on VM DNA config
4. Optionally install pi-vers (skip for short-lived haiku sessions)
5. Register VM in roof reef's SQLite tree
6. Start reef via systemd (`scripts/reef.service` already exists)

Agent VM polymorphism:

| VM Type | Reef | Modules | Pi-vers | Use Case |
|---------|------|---------|---------|----------|
| Full agent VM | Yes | All core + lieutenant | Yes | Long-lived, can promote to lieutenant |
| Swarm worker | Yes | Minimal (store, cron) | Yes | Fleet task execution |
| Lightweight worker | Yes | Minimal | No | Short-lived haiku sessions (5 min) |
| Infra VM | Yes | Core + specific service | No | Gitea, MinIO, persistent services |

## Coordination with pi-vers session

The pi-vers session (PR #60 on branch `claude/consolidate-open-prs-T7xZk`) is:
1. Consolidating open PRs (#20, #26, #52, #59) into a single release
2. After that, will deprecate `vers-lieutenant.ts` with a stub pointing to reef
3. Will update pi-vers docs to reference reef for lieutenant/registry functionality
4. Will keep: `vers-vm.ts`, `vers-vm-copy.ts`, `vers-swarm.ts`, SSH, background-process, plan-mode, thorium-orchestrator

The two sessions don't need to be in lockstep — reef can build the new services independently, and pi-vers will deprecate its copies once reef's are ready.

## Important Notes

- Follow reef's existing patterns: look at `services/cron/index.ts`, `services/store/index.ts` for the ServiceModule interface
- Reef uses Bun, not Node
- Reef has biome linting with a pre-commit hook — run `bunx biome check` before committing
- The ConversationTree in `src/tree.ts` uses hot/cold tiered storage (1500 node hot limit) — lieutenant state should be aware of this
- `src/core/discover.ts` auto-discovers service modules and topo-sorts by dependencies
- `src/core/extension.ts` composes pi extensions from service module tool definitions
