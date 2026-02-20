# I need to manage persistent agent sessions

Lieutenants are long-lived pi agents on Vers VMs. They accumulate context across tasks, support mid-task steering, and survive session restarts.

## Create a lieutenant
```
vers_lt_create --name infra --role "Manage infrastructure and deployment" --commitId <golden_commit_id> --anthropicApiKey <key>
```
Returns when pi-rpc is ready. The `role` becomes the lieutenant's system prompt context.

## Send a task
```
vers_lt_send --name infra --message "Set up the PostgreSQL schema for user auth"
```
Default mode is `prompt` — starts a new task.

## Steer (interrupt and redirect)
```
vers_lt_send --name infra --message "Stop — use raw SQL, not Prisma" --mode steer
```
Interrupts current work. The lieutenant sees everything it did plus your correction.

## Follow up (queue next task)
```
vers_lt_send --name infra --message "Now add the API routes" --mode followUp
```
Queues for after the current task finishes. Sending a `prompt` while working auto-converts to `followUp`.

## Read output
```
vers_lt_read --name infra
```
Returns current response (if working) or last completed response (if idle). Use `--tail 2000` for just the end, `--history 3` to include previous responses.

## Pause and resume
```
vers_lt_pause --name infra
vers_lt_resume --name infra
```
Pausing freezes the VM — full state preserved, no compute cost. You cannot pause a `working` lieutenant — wait or steer it to stop first.

## Destroy
```
vers_lt_destroy --name infra
```
Kills pi, deletes the VM. Pass `--name '*'` to destroy all.

## Check status
```
vers_lt_status
```
Shows all lieutenants: status, role, VM ID, task count, last activity.

## Steer vs followUp vs prompt

- **prompt**: start a new task (idle only — auto-converts to followUp if working)
- **steer**: interrupt now and redirect (use when working)
- **followUp**: queue for after current task finishes

All three preserve full conversation history.

## If a lieutenant won't resume

`vers_lt_resume` checks for the `pi-rpc` tmux session. If it's gone, the lieutenant errors. Destroy and recreate.

## If output seems stale

The tail stream auto-reconnects within 3 seconds after network blips. If the lieutenant is paused, you get whatever was captured before the pause.

## Golden image requirements

The golden image needs pi and Node.js. Creation syncs your local `~/.pi/agent/` config (skills, settings.json, extensions) to the VM.

## Session restarts

State persists to `~/.pi/lieutenants.json`. On session start, the extension reconnects to surviving VMs automatically. Use `vers_lt_discover` to recover from the registry.
