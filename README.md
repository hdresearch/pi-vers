# pi-vers

`pi-vers` is the Vers extension layer used by Reef-managed agent VMs.

`punkin-pi` is the harness. `pi-vers` is loaded into that harness to provide Vers-specific capabilities: VM create/restore, SSH-backed remote tool execution, lieutenant RPC startup, swarm worker startup, and related golden-image/runtime helpers.

## Current Role In The Stack

- `vers-fleets` bootstraps the root Reef VM only
- `reef` owns the runtime control plane
- `pi-vers` provides the Vers-facing extensions Reef-managed agents use
- `punkin-pi` `w/router` is the harness used on root and child agent VMs

That means `pi-vers` should remain the home for Vers-related extension behavior such as:

- Vers API interactions
- shell-auth and API-key handling
- SSH transport into VMs
- remote `pi`/`punkin` agent startup
- lieutenant RPC transport
- swarm worker runtime/orchestration
- shared runtime helpers used by Reef and child agents

Reef loads and consumes these capabilities. It should not duplicate them.

## What Reef Uses From pi-vers

At runtime, Reef relies on `pi-vers` extensions for:

- creating/restoring child agent VMs from the golden image
- starting remote lieutenant agents over RPC
- starting worker agents over RPC
- setting/persisting child runtime env like:
  - `VERS_VM_ID`
  - `VERS_INFRA_URL`
  - `PI_VERS_HOME`
  - `SERVICES_DIR`
  - child role metadata

## Extensions

The package currently exports these Punkin/Pi extensions:

- `vers-vm`
- `vers-vm-copy`
- `vers-lieutenant`
- `vers-swarm`
- `background-process`
- `plan-mode`

It also ships shared core utilities used by the MCP server and related callers.

## Golden Image Expectations

Child VMs restored from the golden image are expected to have:

- `punkin-pi` `w/router`
- `pi` symlinked to `punkin`
- local `pi-vers`
- Reef client extension installed separately
- persisted env that points back to the root Reef
- no local child Reef server

`pi-vers` startup helpers now persist `VERS_VM_ID` after restore, before agent startup, so self-aware child tools work both in the immediate session and in later shells.

## Swarms

Swarm worker runtime still lives here today.

That includes:

- restoring worker VMs from the golden image
- syncing child runtime context when needed
- starting workers in RPC mode
- lieutenant/worker back-and-forth during task execution

There is an open product question about whether swarm orchestration should eventually move into Reef. For now, the runtime implementation remains in `pi-vers`.

## Compatibility

The current system still needs compatibility with legacy Pi packages that import:

- `@mariozechner/pi-tui`
- `@mariozechner/pi-coding-agent`
- `@mariozechner/pi-ai`
- `@mariozechner/pi-agent-core`

Reef golden-image creation now installs VM-local alias links for these so restored child VMs can load older packages under `punkin`.

## Install / Build

The package name in `package.json` is still `@hdresearch/pi-v` for compatibility, even though the repo and current architecture refer to this project as `pi-vers`.

```bash
npm install
npm run build
```

## Notes

- `pi-vers` is an extension repo, not the harness and not the root control plane.
- Root-only concerns like global registry, global vm-tree, global commits, and lieutenant lifecycle ownership belong in Reef.
- Child-agent communication paths should remain compatible with lieutenant `<->` worker back-and-forth even as Reef control-plane boundaries get tighter.
