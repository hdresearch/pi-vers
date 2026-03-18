# Reef Session Prompt
> Copy everything below this line into a coding session for `reef`

---

You are working on `reef` as part of the `vers-fleets` migration.

## Read This First

Do not treat the earlier Claude migration branch as correct. Use it as a diff baseline only.

The corrected implementation branch is:

- `reef`: `codex/correct-reef-migration`

The paired planning branch in `pi-vers` is:

- `pi-vers`: `codex/correct-cross-repo-plan`

## System Boundaries

`reef` owns:

- lieutenant orchestration
- live registry service
- VM lineage / VM DNA
- reef-side config persistence
- bootloader and module distribution

`pi-vers` owns:

- Vers API calls
- SSH/session plumbing
- shell-auth and related connection flows
- swarm helpers that still belong at the extension layer

`punkin-pi` is not optional in the final install story. Do not design a solution that pretends it does not exist.

## Critical Rules

1. Preserve compatibility for `vers_lt_*` tools.
2. Remote lieutenant is the default; `local: true` is explicit.
3. Do not create duplicate state systems for VM lineage.
4. `registry` and `vm-tree` are separate but coordinated.
5. Bootloader logic must follow reef's actual service discovery model.
6. Any parent-child lineage path must ensure the parent infra node exists first.

## What The Corrected Reef Branch Already Fixes

- local lieutenant create/send/read/destroy is covered by tests
- remote lieutenant lifecycle code is restored
- registry now listens to server-side `lieutenant:*` events
- `vm-tree` bootstraps the current reef infra node from `VERS_VM_ID`
- idle lieutenant reads return the last completed output
- reef registers both `reef_lt_*` and `vers_lt_*`
- config overrides persist to disk

## What Still Needs Careful Review

- repo-wide installer test failures
- repo-wide updater test failures
- whether to keep `vm-tree` and `registry` as separate services or converge APIs later without collapsing their responsibilities
- the final boot/install story that must include `punkin-pi`

## Required Validation

Before claiming reef work is done:

1. run targeted lieutenant tests
2. run lint
3. verify registry/vm-tree event wiring
4. identify any remaining repo-wide failures and separate migration-related from unrelated baseline failures

## Preferred Work Order

1. finish lieutenant parity
2. finish registry/vm-tree/root bootstrap
3. finish config/bootloader truthfulness
4. only then work on the broader install/bootstrap path
