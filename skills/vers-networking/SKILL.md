---
name: vers-networking
description: How Vers VM networking works — public URLs, port routing, TLS proxy, IPv6, and running services on VMs.
---

# Vers VM Networking

Every Vers VM gets a public URL and can serve traffic on any port. This is how you expose services, APIs, and web interfaces running on VMs.

## Public URLs

Every VM is reachable at:

```
https://{vmId}.vm.vers.sh:{port}
```

For example:
```
https://45a68069-defc-4233-9865-6298d87053af.vm.vers.sh:3000/health
```

The Vers proxy terminates TLS and routes traffic to the specified port on the VM. This works for **any protocol over TCP** — HTTP, WebSocket, gRPC, etc.

## Key Facts

- **All ports are routable.** Specify the port in the URL. There is no need for SSH tunnels or port forwarding.
- **TLS is handled by the proxy.** Clients connect via `https://`, the proxy terminates TLS and forwards to the VM. Your service does NOT need to handle TLS.
- **IPv6 required.** Services on the VM **must bind to IPv6** (e.g., `::` or `::1`) for the proxy to reach them. Binding to `0.0.0.0` (IPv4 only) will not work through the proxy.
- **No firewall.** All ports are open by default. There is no allowlist or port mapping configuration needed.

## Running a Service on a VM

### Bind to IPv6

Most frameworks default to IPv4 (`0.0.0.0`). You must configure them to listen on `::` (all interfaces, IPv6 + IPv4 dual-stack).

**Node.js (Hono + @hono/node-server):**
```typescript
import { serve } from "@hono/node-server";
serve({ fetch: app.fetch, port: 3000, hostname: "::" });
```

**Node.js (native http):**
```typescript
server.listen(3000, "::");
```

**Python:**
```python
# Flask
app.run(host="::", port=3000)

# uvicorn
uvicorn.run(app, host="::", port=3000)
```

### Verify Accessibility

From any machine (local, another VM, CI):
```bash
curl https://{vmId}.vm.vers.sh:{port}/health
```

If you get a connection timeout, check:
1. Is the service running? (`ss -tlnp` on the VM)
2. Is it bound to IPv6? (`ss -tlnp | grep {port}` should show `:::port`)
3. Is the VM running? (`vers_vms` to check state)

## Common Patterns

### Expose an API

Start your service on the VM, bound to `::`, on any port:
```bash
PORT=3000 node dist/server.js
```

Clients use:
```
https://{vmId}.vm.vers.sh:3000
```

### VM-to-VM Communication

VMs reach each other the same way — via the public URL. There is no private network between VMs. All traffic goes through the TLS proxy.

```bash
# From one VM, call another VM's API
curl https://{otherVmId}.vm.vers.sh:3000/api/data
```

### WebSocket

Connect via `wss://`:
```javascript
const ws = new WebSocket("wss://{vmId}.vm.vers.sh:8080");
```

### Service Discovery

Use a service registry to track which VMs are running which services:
```bash
# Register
curl -X POST https://{infraVmId}.vm.vers.sh:3000/registry/vms \
  -H 'Content-Type: application/json' \
  -d '{"id": "{vmId}", "name": "my-service", "role": "worker", "address": "{vmId}.vm.vers.sh", "services": [{"name": "api", "port": 3000}]}'

# Discover
curl https://{infraVmId}.vm.vers.sh:3000/registry/discover/worker
```

## Cross-VM SSH

Any Vers VM can SSH directly into any other Vers VM using the TLS proxy. This works out of the box — golden image SSH keys are pre-installed on all VMs, so no key exchange or setup is needed.

### SSH Command

```bash
ssh -o StrictHostKeyChecking=no \
    -o ProxyCommand="openssl s_client -connect %h:443 -servername %h -quiet 2>/dev/null" \
    root@{vmId}.vm.vers.sh
```

The `ProxyCommand` tunnels the SSH connection through the Vers TLS proxy on port 443, just like HTTPS traffic. The `-o StrictHostKeyChecking=no` flag avoids host key prompts when connecting to new VMs.

### Use Cases

- **Deploying code to another VM.** A lieutenant can push built artifacts, sync files, or run deploy scripts on an infrastructure VM.
- **Inspecting another lieutenant's VM.** SSH in to check logs, debug a running service, or verify system state.
- **Cross-VM file transfer.** Use `scp` or `rsync` (with the same proxy command) to move files between VMs.

### Example: Deploying to an Infrastructure VM

A lieutenant building code on its own VM can deploy to a separate infra VM:

```bash
INFRA_VM="45a68069-defc-4233-9865-6298d87053af"
SSH_OPTS='-o StrictHostKeyChecking=no -o ProxyCommand="openssl s_client -connect %h:443 -servername %h -quiet 2>/dev/null"'

# Copy built artifacts to the infra VM
scp $SSH_OPTS -r ./dist root@${INFRA_VM}.vm.vers.sh:/root/workspace/my-service/dist

# Restart the service remotely
ssh $SSH_OPTS root@${INFRA_VM}.vm.vers.sh "cd /root/workspace/my-service && npm start"
```

### Example: Cross-VM File Transfer with rsync

```bash
REMOTE_VM="7b2c1f3e-aaaa-4000-bbbb-123456789abc"
SSH_CMD='ssh -o StrictHostKeyChecking=no -o ProxyCommand="openssl s_client -connect %h:443 -servername %h -quiet 2>/dev/null"'

rsync -avz -e "$SSH_CMD" ./logs/ root@${REMOTE_VM}.vm.vers.sh:/root/workspace/collected-logs/
```

### Notes

- **Golden image keys.** All VMs created from the same golden image share SSH keys, so cross-VM SSH works without any configuration.
- **No private network.** SSH traffic goes through the public TLS proxy, just like HTTP. There is no direct VM-to-VM link.
- **Root access.** VMs use the `root` user by default.

## Security

**All ports are public by default.** There is no firewall. Any service you start is reachable by anyone on the internet. Always protect services with authentication.

For your coordination services, set `VERS_AUTH_TOKEN` env var. All endpoints except `/health` will require `Authorization: Bearer <token>`. Pass the same token to worker VMs so they can authenticate.

```bash
# Start with auth
VERS_AUTH_TOKEN=$(openssl rand -hex 32) PORT=3000 node dist/server.js

# Authenticated request
curl -H "Authorization: Bearer $TOKEN" https://{vmId}.vm.vers.sh:3000/board/tasks
```

## Common Mistakes

1. **Binding to `0.0.0.0` instead of `::`** — The proxy routes via IPv6. IPv4-only services won't be reachable through the public URL (but will work locally on the VM).
2. **Assuming SSH-only access** — VMs are not behind a bastion. The TLS proxy routes any TCP traffic, not just SSH.
3. **Using SSH tunnels for HTTP** — Unnecessary. Just hit the public URL directly.
4. **Forgetting the port in the URL** — Unlike traditional hosting, there's no default port 80/443 mapping. Specify the port your service runs on.
