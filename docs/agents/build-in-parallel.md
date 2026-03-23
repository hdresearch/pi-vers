# I need to build multiple things in parallel

## Steps

1. Spawn workers from a golden image:
```
vers_swarm_spawn --commitId <golden_commit_id> --count 3 --labels '["server","client","landing"]' --llmProxyKey <sk-vers-key>
```

2. Task each worker. Include the full spec in every task — workers can't read each other's files:
```
vers_swarm_task --agentId server --task "Build server.js. SPEC: <paste full spec here>"
vers_swarm_task --agentId client --task "Build game.js. SPEC: <paste full spec here>"
vers_swarm_task --agentId landing --task "Build index.html. SPEC: <paste full spec here>"
```

3. Wait for all to finish:
```
vers_swarm_wait
```

4. Collect files from each worker VM:
```
vers_vm_use --vmId <server_vm_id>
read --path /root/workspace/server.js
vers_vm_local

vers_vm_use --vmId <client_vm_id>
read --path /root/workspace/game.js
vers_vm_local
```

5. Assemble files locally, fix mismatches, verify.

6. Clean up:
```
vers_swarm_teardown
```

## If workers produce incompatible code

They will. Common mismatches:
- Server sends `segments`, client reads `snake`
- CSS uses `.card`, HTML uses `.landing-card`
- Server sends `[x, y]`, client expects `{x, y}`

Fix: read all files, find the mismatches, patch them. This is expected — the spec reduces drift but doesn't eliminate it.

## If you don't have a golden image commit ID

Create one. See: [I need to create a golden VM image](create-golden-image.md)

## If a worker fails to start

Check `vers_swarm_status`. If an agent shows "error", read its output with `vers_swarm_read --agentId <id>`. Common cause: the golden image is stale or the `LLM_PROXY_KEY` is invalid.

## How many workers?

3 is the sweet spot. More workers = more integration mismatches. Only go beyond 3 if components are truly independent.
