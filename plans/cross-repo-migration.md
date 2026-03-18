# Plan: Vers-Fleets Cross-Repo Migration

Last updated: 2026-03-17

## Purpose

This plan replaces the earlier Claude draft with a migration plan that matches the corrected `reef` implementation on branch `codex/correct-reef-migration` and the actual product brief for `vers-fleets`.

The goal is not "move code until it compiles." The goal is a single install/bootstrap story where:

- `reef` owns persistent orchestration state and module distribution.
- `pi-vers` remains the VM/SSH/shell-auth substrate.
- `punkin-pi` remains the packaged pi fork with harness engineering work.
- the eventual `vers-fleets` install path can compose all three without duplicate state or broken agent contracts.

## Repo Roles

| Repo | Role in v1 | Notes |
|------|------------|-------|
| `reef` | orchestration kernel, lieutenant service, live VM registry, lineage tree, bootloader, persisted reef-side config | source of truth for long-lived orchestration state |
| `pi-vers` | Vers API access, SSH/session plumbing, shell-auth, swarm/VM helper extensions, docs for extension-side responsibilities | remains the substrate below reef |
| `punkin-pi` | packaged pi fork with harness work | must be part of the final install story even if no code moves now |

## Non-Negotiable Architecture Decisions

### 1. Reef is the source of truth for orchestration state

Reef owns:

- lieutenant records
- remote lieutenant lifecycle coordination
- live registry entries
- VM lineage / VM DNA
- reef-side config persistence
- module selection for bootstrapped VMs

Pi-vers does not remain a second source of truth for lieutenant metadata.

### 2. Registry and VM tree are different systems

They must not be collapsed into one ambiguous table.

- `registry` tracks live/discoverable VM state: address, role, liveness, paused/running/stopped.
- `vm-tree` tracks durable lineage and reef DNA: parent, category, organs, capabilities.

The corrected reef branch keeps both, but they must be wired from the same server-side lifecycle events.

### 3. Lieutenant compatibility must be preserved

Existing agent flows already know `vers_lt_*`.

V1 must keep:

- `vers_lt_create`
- `vers_lt_send`
- `vers_lt_read`
- `vers_lt_status`
- `vers_lt_pause`
- `vers_lt_resume`
- `vers_lt_destroy`
- `vers_lt_discover`

Reef-native aliases like `reef_lt_*` are fine, but they are additive, not replacements.

### 4. Remote lieutenant is the default

Omitting `local` must mean "remote lieutenant backed by a Vers VM."

That implies:

- `commitId` is required for remote create
- `local: true` is explicit
- remote create must actually provision a VM, wait for SSH, start pi RPC, and attach a live handle

### 5. Root lineage must be bootstrapped, not implied

If reef emits child VM lineage with `parentVmId`, the parent node must already exist in `vm-tree`.

The corrected reef branch now bootstraps the current reef infra VM into `vm-tree` from `VERS_VM_ID` during service init. Future work must preserve this behavior.

### 6. Bootloader module selection must match reef's loader

Reef discovers services from `SERVICES_DIR`. Any selective boot story must build a real service directory or equivalent, not rely on imaginary `.disabled` markers.

## What Claude Got Right

- Moving lieutenant orchestration into a reef service module is correct.
- Promoting registry concerns into reef is correct.
- Treating VM DNA and lineage as reef-owned state is correct.
- Keeping Vers API, SSH, and shell-auth in `pi-vers` is correct.
- Treating agent VMs as reef-first boot targets is correct.

## What Claude Got Wrong

The earlier draft and branch work had several category errors:

- `punkin-pi` was treated as out of scope even though the final install story depends on it.
- the lieutenant migration was framed as a service rewrite, but the implementation initially dropped remote parity entirely
- tool renames broke compatibility by replacing `vers_lt_*` with `reef_lt_*`
- registry wiring was client-side only and did not reflect reef's server event bus
- registry and vm-tree were left as competing sources of truth instead of coordinated systems
- bootloader design assumed service-disable semantics that reef does not implement
- `vers-config` was described as durable/encrypted while implemented as process memory

## Corrected Reef Status

As of branch `codex/correct-reef-migration`, reef has the following meaningful corrections:

- lieutenant create/send/read/destroy works for local lieutenants with deterministic tests
- remote lieutenant lifecycle code is restored: create VM, wait for SSH, start/reconnect pi RPC, pause/resume/destroy
- server-side `lieutenant:*` events now populate `registry`
- `vm-tree` now bootstraps the current reef infra node from `VERS_VM_ID`
- idle lieutenant reads fall back to the last completed response
- both `reef_lt_*` and legacy `vers_lt_*` tools are registered
- reef-side config overrides persist to disk instead of process memory
- bootloader module selection uses `SERVICES_DIR` with an active-services directory

Validated locally on 2026-03-17:

- `bun test tests/lieutenant.test.ts` passes
- `bun run lint` passes for code; Biome only reports a schema-version info message

Known repo-wide non-migration failures still exist in `reef`:

- `services/installer/installer.test.ts`
- `examples/services/updater/updater.test.ts`

Those failures are pre-existing relative to this migration line and should be treated separately unless they begin to overlap the install story.

## Migration Workstreams

### Workstream A: Reef parity and hardening

Status: in progress on `reef/codex/correct-reef-migration`

Required outcomes:

- lieutenant local and remote flows verified
- registry and vm-tree fed by the same server-side lifecycle events
- root infra node bootstrapped
- config persistence honest and durable
- bootloader aligned with actual reef service loading
- targeted tests for the corrected behavior

### Workstream B: Pi-vers handoff and deprecation

Status: pending on `pi-vers/codex/correct-cross-repo-plan`

Required outcomes:

- docs clearly state which responsibilities move to reef
- lieutenant docs point to reef as the orchestration owner
- extension-side docs describe `pi-vers` as substrate, not orchestration source of truth
- future deprecation stubs preserve agent understanding and avoid silent breakage

### Workstream C: Punkin-pi packaging contract

Status: not started

Required outcomes:

- define exactly what `punkin-pi` contributes to the final install
- document how reef/pi-vers expect to find or invoke the packaged pi runtime
- avoid hidden assumptions about binary names, session state paths, or auth bootstrap

### Workstream D: Vers-fleets unified install

Status: design only

Required outcomes:

- one installer/bootstrap entrypoint
- shell-auth/bootstrap flow for Vers before reef creates any remote lieutenant
- parent infra reef bootstrapped first
- initial topology created deterministically:
  - parent infra reef node
  - lieutenant child
  - three initial swarm/agent VM children
- optional pi-vers on short-lived workers

## Required V1 Behavior

### Parent bootstrap

When a user starts `vers-fleets`:

1. complete Vers shell-auth/login
2. ensure org + API key exist
3. bootstrap the parent reef node
4. persist the root infra VM in `vm-tree`
5. create one lieutenant
6. create three initial swarm/agent VMs attached to that lieutenant

### VM categories

V1 categories:

- `infra_vm`
- `lieutenant`
- `swarm_vm`
- `agent_vm`

`parentVmId` is optional at the DB level, but required whenever lineage is known.

### VM DNA

Every tracked VM must carry:

- `organs`: reef modules/services loaded on that VM
- `capabilities`: extensions/features available on that VM

This must be queryable by humans and agents.

### Snapshot policy

The lineage DB must be snapshotted hourly.

Implementation rule:

- checkpoint WAL before copying
- retain a bounded history
- do not depend on the server already listening to register the snapshot job

## Risk Register

| Risk | Why it matters | Required mitigation |
|------|----------------|--------------------|
| two sources of truth for VM state | guarantees divergence and broken recovery | keep `registry` live-only and `vm-tree` lineage-only |
| breaking `vers_lt_*` | existing agents lose control paths immediately | preserve aliases until a full documented deprecation |
| remote lieutenant parity gaps | creates VMs that reef cannot drive | require end-to-end create/pause/resume/destroy behavior before merge |
| missing root bootstrap | child lineage inserts fail or silently drop | bootstrap current reef infra node at service init |
| fake config persistence | restart loses critical auth/config state | persist reef overrides to disk or a real store |
| bootloader/service mismatch | child VMs boot with the wrong module set | use `SERVICES_DIR`-based selection only |
| installer story ignores `punkin-pi` | final "single install" is incomplete | include packaging contract in the design before public rollout |

## Agent Instructions

Future agents working this migration should follow these rules:

1. Work only on new branches. Do not push more commits onto Claude's original branches.
2. Treat Claude's branches as review baselines, not trusted foundations.
3. Do not remove `vers_lt_*` names until a documented deprecation phase exists.
4. Do not add a second orchestration store in `pi-vers`.
5. When touching reef lineage, verify both `registry` and `vm-tree` behavior.
6. Prefer targeted deterministic tests over broad claims.
7. Any remote-flow change must be reviewed against actual `pi-vers` behavior, not just type signatures.
8. Do not mark `punkin-pi` as out of scope for the final install story.

## Immediate Next Steps

1. Finish reef validation and decide whether to absorb the unrelated installer/updater failures on the same branch or track them separately.
2. Update `pi-vers` docs and prompts to reflect reef as the orchestration owner.
3. Write the cross-repo agent runbook for the final `vers-fleets` bootstrap path.
4. Only then start the unified installer/binary work.
