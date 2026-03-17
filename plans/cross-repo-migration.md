# Plan: Cross-Repo Architecture Migration

## Context

Three repos in hdresearch form the Vers agent platform:

| Repo | Role | State |
|------|------|-------|
| **reef** | Agent server/kernel — spawns pi processes, hosts service modules, manages conversation tree | v0.3.0, active, 85 commits |
| **pi-vers** | Pi extension package — VM APIs, SSH, swarm, lieutenants, agent-services integration | v0.2.0, 8 open PRs |
| **punkin-pi** | Fork of pi-mono with harness engineering work | Private, not in scope for this plan |

### Target Architecture (from engineering notes)

```
roof reef (SQLite VM tree, module distribution)
 └── lieutenants (1:many, snapshot to create)
      └── swarm workers / agent VMs (fleets)
           └── each bootstrapped with reef (bootloader) + selective modules + optional pi-vers
```

- Reef owns: lieutenants, VM registry, vers configs, SQLite VM lineage tree, module distribution
- Pi-vers owns: VM APIs (`vers-vm.ts`), SSH (`vers-vm-copy.ts`), shell/auth flows (e.g. GitHub connections), swarm orchestration
- Reef acts as bootloader on every agent VM, selectively loading modules and optionally pi-vers
- Agent VMs can promote to lieutenants; all VMs tracked in SQLite with "DNA" (modules=organs, extensions=capabilities)

---

## Phase 0: Stabilize pi-vers (THIS REPO — IN PROGRESS)

Consolidate open PRs before migrating anything out. See `plans/consolidate-prs.md`.

**Deliverable**: Single merged PR with PRs #20, #26, #52, #59 (and optionally non-PR branches).

---

## Phase 1: Move Lieutenants to Reef

### What moves

| From (pi-vers) | To (reef) | Notes |
|-----------------|-----------|-------|
| `extensions/vers-lieutenant.ts` (~1400 lines) | `services/lieutenant/index.ts` | Rewrite as reef service module |
| `docs/lieutenant.md` | `docs/lieutenant.md` or inline in service | Reference docs |
| `docs/agents/manage-lieutenants.md` | Reef skill or service docs | Agent-facing guide |
| `docs/humans/guide-persistent-agent-sessions.md` | Reef docs | Human-facing guide |
| Lieutenant state (`~/.pi/lieutenants.json`) | Reef store service or SQLite | Persistent state |

### How it changes

Pi-vers lieutenant is currently a pi extension that:
- Spawns persistent agent sessions on VMs via SSH + `pi --mode rpc`
- Tracks state in `~/.pi/lieutenants.json`
- Integrates with vers-agent-services registry for discovery
- Supports pause/resume/multi-turn conversation

In reef, this becomes a **service module** that:
- Uses reef's existing per-task pi process spawning (`src/reef.ts`)
- Stores state in reef's store service or SQLite
- Exposes HTTP routes for lieutenant management (`/lieutenant/create`, `/lieutenant/send`, etc.)
- Provides agent tools via the service module tool interface
- Integrates with the new SQLite VM tree for lineage tracking

### Migration strategy

1. Write `services/lieutenant/index.ts` in reef, adapting the pi-vers extension to reef's `ServiceModule` interface
2. Port the 7 tools: `vers_lt_create`, `vers_lt_send`, `vers_lt_read`, `vers_lt_status`, `vers_lt_pause`, `vers_lt_resume`, `vers_lt_destroy`, `vers_lt_discover`
3. Wire lieutenant state into reef's store or the new SQLite DB
4. Deprecate `extensions/vers-lieutenant.ts` in pi-vers (keep as stub pointing to reef)
5. Update pi-vers docs to reference reef for lieutenant functionality

---

## Phase 2: Promote VM Registry to Reef Core

### What moves

| From | To (reef) | Notes |
|------|-----------|-------|
| `vers-agent-services` registry (external repo) | `services/registry/index.ts` (promote from examples) | Already exists as reef example |
| Pi-vers registry integration (`VERS_INFRA_URL/registry/vms`) | Reef-native registry | Change endpoint consumers |

### How it changes

Reef already has `examples/services/registry/index.ts` with:
- REST endpoints for registration, filtering by role, heartbeat, health discovery

Promotion to core means:
1. Move from `examples/services/registry/` to `services/registry/`
2. Back with SQLite instead of in-memory storage
3. Add VM lineage tracking (parent-child relationships)
4. Add reef config tracking per VM (the "DNA" concept)

---

## Phase 3: Build SQLite VM Tree

### New component in reef

**Location**: `services/vm-tree/index.ts` (or extend registry)

**Schema**:
```sql
CREATE TABLE vms (
  vm_id        TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  parent_vm_id TEXT REFERENCES vms(vm_id),
  category     TEXT NOT NULL CHECK(category IN ('lieutenant', 'swarm_vm', 'agent_vm', 'infra_vm')),
  reef_config  TEXT NOT NULL DEFAULT '{}',  -- JSON: { organs: [...], capabilities: [...] }
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_vms_parent ON vms(parent_vm_id);
CREATE INDEX idx_vms_category ON vms(category);
```

**reef_config** JSON structure (VM DNA):
```json
{
  "organs": ["lieutenant", "registry", "cron", "store"],
  "capabilities": ["vers-vm", "vers-vm-copy", "vers-swarm", "ssh"]
}
```

**Features**:
- Full lineage tree queries (ancestors, descendants, subtrees)
- Category-based filtering
- Config diff between VMs
- Dashboard view: which modules/extensions are on which VM, where in the tree
- Hourly snapshots via reef's cron service (`services/cron/`)
- Part of public starter image

### Snapshot strategy
- Cron job: `0 * * * *` (every hour)
- Copy `data/vms.sqlite` → `data/snapshots/vms-{timestamp}.sqlite`
- Retain last 24 snapshots (1 day rolling window)

---

## Phase 4: Vers Configs into Reef

### What moves

| Config | From | To |
|--------|------|----|
| `VERS_API_KEY` resolution | Pi-vers (`~/.vers/keys.json`, `~/.vers/config.json`) | Reef store service |
| `VERS_INFRA_URL` / `VERS_AUTH_TOKEN` | Pi-vers (`~/.vers/agent-services.json`) | Reef core auth (`src/core/auth.ts` already has bearer auth) |
| Lieutenant state | Pi-vers (`~/.pi/lieutenants.json`) | Reef SQLite or store |
| SSH key cache | Pi-vers (`/tmp/vers-ssh-keys/`) | Stays in pi-vers (SSH is pi-vers domain) |

### How it changes

Reef becomes the source of truth for:
- API credentials (stored in reef's store with TTL)
- Auth tokens (already has `VERS_AUTH_TOKEN` bearer auth)
- VM configurations (SQLite)
- Module/extension manifests

Pi-vers retains SSH-specific config (keys, control sockets) since SSH remains pi-vers's domain.

---

## Phase 5: Reef as Bootloader

### Bootstrap flow for agent VMs

When a lieutenant spins up an agent VM:

1. **Create VM** via Vers API (pi-vers `vers_vm_create`)
2. **Bootstrap reef** onto the VM:
   - SCP `boot.sh` (reef already has `scripts/boot.sh`)
   - Install reef with selected modules based on VM DNA config
   - Optionally install pi-vers (skip for short-lived haiku sessions)
3. **Register VM** in roof reef's SQLite tree with:
   - `parent_vm_id` = lieutenant's VM
   - `category` = `swarm_vm` or `agent_vm`
   - `reef_config` = selected organs + capabilities
4. **Start reef** on the VM (systemd, reef already has `scripts/reef.service`)

### Agent VM polymorphism

| VM Type | Reef | Modules | Pi-vers | Use Case |
|---------|------|---------|---------|----------|
| Full agent VM | Yes | All core + lieutenant | Yes | Long-lived, can promote to lieutenant |
| Swarm worker | Yes | Minimal (store, cron) | Yes | Fleet task execution |
| Lightweight worker | Yes | Minimal | No | Short-lived haiku sessions (5 min) |
| Infra VM | Yes | Core + specific service | No | Gitea, MinIO, persistent services |

---

## Phase 6: Stretch — Hierarchical Reef Network

Every agent VM runs its own reef instance. The "roof" reef manages the tree:

```
roof reef (SQLite master, full tree view)
 ├── lieutenant A reef (subset of tree)
 │    ├── swarm-vm-1 reef (leaf)
 │    └── swarm-vm-2 reef (leaf, promoted to lieutenant)
 │         └── sub-swarm-vm reef (leaf)
 └── lieutenant B reef
      └── swarm-vm-3 reef (no pi-vers, lightweight)
```

- Roof reef SQLite is the single source of truth
- Agent VM reefs report up via heartbeat/registry
- Plugin configs can cascade: roof reef sets defaults, lieutenant reef overrides, agent VM reef overrides further
- Dashboard on any reef shows its subtree

---

## Dependency Order

```
Phase 0 (pi-vers PR consolidation)  ← in progress
    │
    ▼
Phase 1 (lieutenants → reef)
    │
    ├──► Phase 2 (registry → reef core)  ← can parallel with Phase 1
    │
    ▼
Phase 3 (SQLite VM tree)  ← depends on registry being in reef
    │
    ▼
Phase 4 (configs → reef)  ← depends on store/SQLite being ready
    │
    ▼
Phase 5 (reef bootloader)  ← depends on everything above
    │
    ▼
Phase 6 (hierarchical reef network)  ← stretch goal
```

## Repo Ownership After Migration

| Component | Repo | Status |
|-----------|------|--------|
| VM lifecycle (create, branch, commit, restore) | pi-vers | Stays |
| SSH tool routing + ControlMaster | pi-vers | Stays |
| File copy (SCP) | pi-vers | Stays |
| Swarm orchestration | pi-vers | Stays |
| Shell/auth flows (GitHub connections) | pi-vers | Stays |
| Lieutenants | reef | Moves from pi-vers |
| VM registry | reef | Promoted from example |
| SQLite VM tree | reef | New |
| Vers configs (API keys, auth tokens) | reef | Moves from pi-vers |
| Service modules (cron, store, docs, UI) | reef | Stays |
| Agent VM bootstrap | reef | New (boot.sh exists) |
| Harness engineering | punkin-pi | Stays (private) |
