# Vers-Fleets Agent Runbook

Last updated: 2026-03-17

This runbook is for agents working across `reef`, `pi-vers`, and `punkin-pi` toward the single-install `vers-fleets` setup.

## Mission

Deliver one coherent bootstrap story, not three loosely related repos.

The install path must produce:

- a parent infra reef
- a lieutenant managed by reef
- an initial swarm of three child agent/swarm VMs
- lineage and DNA visible in reef
- `pi-vers` available where needed
- `punkin-pi` accounted for in packaging/runtime assumptions

## Branch Rules

Create new branches from the existing comparison baselines:

- `reef` from `claude/migrate-lieutenants-service-kuEjD`
- `pi-vers` from `claude/consolidate-open-prs-T7xZk`

Do not edit those Claude branches directly.

## Sequence

### Step 1: Reef must be real before docs move

Required reef checks:

- lieutenant service works locally
- remote lieutenant path is implemented, not stubbed
- registry receives server-side lifecycle events
- vm-tree accepts child lineage because the root infra node exists
- tool compatibility includes `vers_lt_*`

### Step 2: Pi-vers must be reframed, not duplicated

Required `pi-vers` changes:

- docs stop describing `pi-vers` as the orchestration owner for lieutenants
- docs explicitly state that reef owns long-lived lieutenant state
- `pi-vers` remains responsible for Vers API, SSH, shell-auth, and substrate helpers

### Step 3: Punkin-pi contract must be written down

Before unified install work:

- define the executable/runtime assumption
- define how reef child VMs invoke pi
- define where harness-specific behavior matters

### Step 4: Unified install

The future `vers-fleets` installer must:

1. run Vers shell-auth
2. ensure org + API key
3. bootstrap parent reef
4. register root infra node
5. create lieutenant
6. create three initial child VMs
7. optionally omit `pi-vers` from short-lived child VMs

## Checks Agents Must Perform

- compare behavior against existing `pi-vers` docs and extension code, not just new reef code
- test the HTTP routes that real agents will call
- verify state after restart or rehydrate paths where applicable
- never accept "scaffolding exists" as proof of migration completeness

## Known Correctness Traps

- renaming `vers_lt_*` to `reef_lt_*` without aliases
- emitting server events that nobody subscribes to
- writing lineage for child VMs before a parent infra node exists
- claiming persistence or encryption without implementing it
- designing bootloader behavior that reef service discovery cannot honor
- pretending `punkin-pi` is someone else's problem
