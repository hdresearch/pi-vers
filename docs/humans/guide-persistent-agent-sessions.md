# Persistent Agent Sessions with Lieutenants

> Spawn a long-lived coding agent, send it a sequence of tasks, and watch it build on its own context. No re-explaining what it already did. One agent, many tasks, growing memory.

## What You'll Have at the End

- A persistent "lieutenant" agent running on a Vers VM
- Three tasks completed in sequence, each building on the last
- An understanding of when lieutenants beat swarm workers (and when they don't)

## Before You Start

```bash
npm install -g @mariozechner/pi-coding-agent
pi install git@github.com:hdresearch/pi-v.git
```

You need: a [Vers](https://vers.sh) account (`VERS_API_KEY` env var) and an Anthropic API key.

You also need a golden image commit ID. If you don't have one, see `docs/agents/create-golden-image.md`.

## The Scenario

You're setting up a Node.js API server. There are three steps, and each depends on the last:

1. Create the Express server with health check and config
2. Add PostgreSQL connection pooling using that config
3. Add user CRUD routes that use the database pool

A swarm can't do this — step 3 needs to see the pool from step 2, which needs the config from step 1. A single prompt could do it, but you want to review each step before moving on. That's what lieutenants are for.

## Step 1: Create the Lieutenant

```
vers_lt_create --name api --role "Build and maintain the Node.js API server" --commitId <golden_commit_id> --anthropicApiKey <your_key>
```

This restores a VM from your golden image, writes a system prompt from your `role` description, boots pi in RPC mode, and waits until it's ready. The lieutenant is now `idle`, waiting for its first task.

> Unlike swarm workers (`vers_swarm_spawn`), a lieutenant has a name and identity. It knows it's called "api" and that its job is the API server. That role string becomes part of its system prompt.

## Step 2: First Task — Scaffold the Server

```
vers_lt_send --name api --message "Create a Node.js Express API server in /root/workspace/api.

- src/index.ts — Express app, listen on PORT from env (default 3000)
- src/config.ts — load DATABASE_URL, PORT, NODE_ENV from env with defaults
- src/routes/health.ts — GET /health returns { status: 'ok', uptime: process.uptime() }
- package.json with express, typescript, tsx
- tsconfig.json

Run npm install and verify it compiles with npx tsc --noEmit."
```

The default mode is `prompt` — it starts working immediately. Check on it:

```
vers_lt_read --name api
```

You'll see output streaming in: creating files, running npm install, fixing type errors. When it's done, its status flips to `idle` and you get the complete response.

## Step 3: Second Task — Add the Database Layer

The lieutenant already knows about `config.ts` and the Express app. You don't need to describe them again:

```
vers_lt_send --name api --message "Add PostgreSQL connection pooling to the API.

- src/db.ts — create a pg Pool using DATABASE_URL from the config you already made
- Add a GET /health/db route that runs SELECT 1 and reports the pool status
- Export the pool so routes can import it
- Add pg to package.json and install"
```

The lieutenant imports from `./config` because it remembers writing that file. It adds the health route next to the one it already created. No spec duplication, no integration mismatches.

## Step 4: Third Task — Add User Routes

```
vers_lt_send --name api --message "Add user CRUD routes.

- src/routes/users.ts — GET/POST/PUT/DELETE /users, using the pg pool from db.ts
- Add a migration file: src/migrations/001-users.sql (id, email, name, created_at)
- Wire the routes into the Express app
- Add basic input validation (email format, required fields)"
```

Three tasks, one agent. The user routes import the pool from step 2. The migration matches the schema the routes expect. Everything is consistent because one agent wrote all of it.

Want to see how the work evolved? Read the history:

```
vers_lt_read --name api --history 3
```

This returns the last 3 completed responses in order — you can see the full arc of what the lieutenant built.

## Steering Mid-Task

Sometimes you'll check on the lieutenant while it's working and realize it's heading the wrong way:

```
vers_lt_read --name api
```

You see it's adding Prisma. You wanted raw SQL:

```
vers_lt_send --name api --message "Stop adding Prisma. Use raw pg queries — keep this dependency-light." --mode steer
```

The `steer` mode interrupts the current work. The lieutenant sees the correction in context, acknowledges it, and changes direction. It doesn't start over — it adjusts from where it is.

If you don't want to interrupt but do want to queue a follow-on:

```
vers_lt_send --name api --message "After this, add request logging middleware" --mode followUp
```

The `followUp` queues your message for after the current task finishes. If you forget to set the mode, sending a `prompt` while the lieutenant is working auto-converts to `followUp` — it won't clobber work in progress.

## Pausing Between Sessions

Done for today but want to continue tomorrow:

```
vers_lt_pause --name api
```

The VM freezes. No compute costs. Full state preserved — memory, disk, pi conversation history, everything. When you're ready:

```
vers_lt_resume --name api
```

Pi picks up where it left off. You can immediately send the next task.

> You can't pause a `working` lieutenant. Wait for it to finish, or steer it to stop first.

## Reading Files from the Lieutenant's VM

The lieutenant works on its own VM. To inspect or collect files:

```
vers_vm_use --vmId <lt_vm_id>
read --path /root/workspace/api/src/index.ts
bash --command "cd /root/workspace/api && npx tsc --noEmit"
vers_vm_local
```

Find the VM ID from `vers_lt_status`.

## Session Restarts

If your coordinator session drops, lieutenants survive. Their VMs keep running, pi keeps its tmux session. On the next session start, the extension loads `~/.pi/lieutenants.json` and reconnects automatically — running lieutenants get their tail re-attached, paused ones reconnect as paused, dead VMs get cleaned up.

## Clean Up

Destroy one:

```
vers_lt_destroy --name api
```

Destroy all:

```
vers_lt_destroy --name '*'
```

This kills pi and deletes each VM individually. Unlike `vers_swarm_teardown`, it only touches lieutenants — your swarm workers and infra VMs are unaffected.

## What Just Happened

You ran three dependent tasks through a single persistent agent:

1. **Task 1**: The lieutenant scaffolded the Express server and config module
2. **Task 2**: It added database pooling, importing directly from the config it wrote in task 1
3. **Task 3**: It added user routes using the pool from task 2, with a migration matching the route schema

The key mechanic: pi's RPC mode maintains conversation history across prompts. When you send a second `vers_lt_send`, the new message enters the same conversation. The lieutenant sees everything it said and did before. That's why it can import `./config` without being told about it — it wrote that file two tasks ago.

The lieutenant extension adds persistence on top: state saves to disk, VMs survive session restarts, pause/resume lets you freeze an agent mid-project and thaw it days later.

## When to Use Lieutenants

**Use lieutenants when:**
- Tasks are sequential and each builds on the last
- You want to review and steer between steps
- The domain needs accumulated context
- Work spans multiple sessions — pause overnight, resume tomorrow

**Use swarm workers when:**
- Tasks are independent and parallelizable
- Components have a clear upfront spec
- Speed matters more than coherence

**The heuristic:** If you can write all the specs upfront, use a swarm. If you need to see step N before deciding step N+1, use a lieutenant.

## Lieutenants + Swarms Together

The patterns compose. A common setup:

- **lt-backend**: persistent lieutenant building the API, task by task
- **lt-frontend**: persistent lieutenant building the UI, task by task
- **Swarm burst**: when lt-backend finishes the schema, it spawns 3 workers to build independent API modules in parallel, collects results back onto its own VM

Lieutenants have full access to pi tools — including `vers_swarm_spawn`. A lieutenant can be both a persistent session holder and a swarm coordinator.

## Next Steps

- For golden image creation: `docs/agents/create-golden-image.md`
- For parallel builds: `docs/agents/build-in-parallel.md`
- For the full swarm guide: `docs/humans/guide-self-organizing-agent-swarms.md`
- For tool reference: `extensions/vers-lieutenant.ts`
