# Build a Full-Stack App in 60 Seconds with Agent Swarms

> Spawn parallel coding agents across Firecracker VMs. One prompt in, working app out. We'll build a multiplayer snake game with a WebSocket server, Canvas client, and landing page — all built simultaneously by three agents.

## What You'll Have at the End

- A multiplayer snake game running at a public HTTPS URL
- Three agents that built the server, client, and landing page in parallel
- A golden VM image you can reuse for any future project
- The swarm infrastructure to parallelize any multi-component build

## Before You Start

```bash
npm install -g @mariozechner/pi-coding-agent
pi install git@github.com:hdresearch/pi-v.git
```

You need: a [Vers](https://vers.sh) account (`VERS_API_KEY` env var) and an exchanged `LLM_PROXY_KEY`.

## Step 1: Create the Golden Image

The golden image is a VM snapshot with Node.js, `punkin-pi` `w/router`, and Vers packages pre-installed. You create it once, branch from it forever.

```
vers_vm_create --mem_size_mib 4096 --fs_size_mib 8192 --wait_boot true
```

Connect and copy the shared bootstrap script:

```
vers_vm_use --vmId <vmId>
```

```
vers_vm_copy --localPath <path-to-pi-vers>/skills/vers-golden-vm/scripts/bootstrap.sh --remotePath /root/bootstrap-golden-vm.sh --direction to_vm
```

Run the bootstrap:

```bash
export GITHUB_TOKEN="<token>"
export PUNKIN_TAG="w/router"
bash /root/bootstrap-golden-vm.sh
```

Snapshot it:

```
vers_vm_local
vers_vm_commit --vmId <vmId>
```

Save the returned `commit_id`. That's your golden image.

## Step 2: Spawn the Architect

Instead of manually coordinating workers, we spawn a single "architect" agent and let it decompose the work itself.

```
vers_swarm_spawn --commitId <commit_id> --count 1 --labels '["architect"]' --llmProxyKey <your_sk-vers_key>
```

You now have one agent running on a fresh VM, ready for instructions.

## Step 3: Send the Build Prompt

This is the only prompt you write. The architect handles everything else:

```
vers_swarm_task --agentId architect --task "You are the ARCHITECT. Build a multiplayer snake game.

## What to build
A browser-based multiplayer snake game with:
- Node.js WebSocket server managing game state (20x20 grid, 100ms ticks)
- HTML5 Canvas client with keyboard controls and scoreboard
- Landing page with game title, instructions, and Play button

## Requirements
- Server: WebSocket on port 3000, collision detection, food spawning, spectator mode on death
- Client: Canvas rendering, arrow key controls, death screen with reason, auto-reconnect
- Landing: responsive design, Play button links to /game.html

## HOW TO DO THIS — Use the swarm!

### Step 1: Design
Write /root/workspace/SPEC.md with:
- WebSocket message types (exact JSON field names)
- Shared constants (GRID_SIZE=20, TICK_MS=100, PORT=3000)
- File structure: server.js, public/game.html, public/game.js, public/style.css, public/index.html
- CSS class names and DOM IDs used across files

### Step 2: Spawn workers
Use vers_swarm_spawn with commit ID <commit_id>.
Spawn 3 workers: [\"server\", \"client\", \"landing\"]

### Step 3: Task each worker
Use vers_swarm_task for each. INCLUDE THE FULL SPEC in each task.
- server: Build server.js and package.json
- client: Build public/game.html, public/game.js, public/style.css
- landing: Build public/index.html with links to game.html

### Step 4: Wait and collect
Use vers_swarm_wait to block until all workers finish.
Then vers_vm_use each worker VM, read their files, vers_vm_local between reads.

### Step 5: Assemble and verify
Write all files to /root/workspace/ on YOUR VM.
Fix any integration mismatches (field names, CSS classes, DOM IDs).
Run: npm install && node server.js

### LLM proxy key: <your_sk-vers_key>
### Golden image commit: <commit_id>

Go!"
```

## Step 4: Wait

```
vers_swarm_wait --timeoutSeconds 300
```

The architect writes a spec, spawns 3 workers, tasks them, waits for results, collects files, fixes integration issues, and starts the server. This takes ~60-90 seconds.

## Step 5: See the Result

The architect's VM is running the game. Find its VM ID from the spawn output, then:

```
https://<architect-vm-id>.vm.vers.sh:3000
```

Open it in your browser. You have a multiplayer snake game.

> Vers terminates TLS at the proxy — your VM serves plain HTTP, the browser sees HTTPS. If the server binds IPv4 only, you may need an IPv6 bridge (the architect usually handles this).

## Step 6: Clean Up

```
vers_swarm_teardown
```

This kills all agents and deletes their VMs.

## What Just Happened

The architect did in 90 seconds what a single agent takes 12+ minutes to do:

1. **Wrote a spec** defining message types, constants, CSS classes, and file structure
2. **Spawned 3 VMs** from your golden image (5 seconds each)
3. **Tasked each worker** with the full spec embedded in the prompt — workers built in parallel (~50 seconds)
4. **Collected and fixed**: the server sent `segments`, the client read `snake` — the architect patched it
5. **Verified**: `npm install && node server.js` on its own VM

The spec is the contract. Workers never communicate with each other. All coordination flows through the spec (upfront) and the architect (after). Workers will always drift a little — the architect's integration-fix step is where the pattern pays off.

## When Not to Use This

- **Small tasks** (under 3 files): single agent is faster, no coordination overhead
- **Tightly coupled code**: if every file depends on every other file, the spec can't capture the contract
- **Exploratory work**: if you don't know what to build, you can't write a spec

The sweet spot: 3 independent components with a clear interface between them. Server + client + config. API + worker + dashboard. CLI + library + tests.

## Next Steps

- Reuse your golden image commit ID for any future swarm
- Modify the architect prompt for different projects — the infrastructure stays the same
- For details on the RPC daemon that keeps agents alive through SSH drops, see `docs/agents/build-in-parallel.md`
