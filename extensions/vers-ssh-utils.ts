/**
 * Shared SSH utilities for Vers extensions -- Windows compatibility layer.
 *
 * On Linux/macOS, Vers SSH uses openssl s_client as a ProxyCommand to tunnel
 * SSH over TLS to {vmId}.vm.vers.sh:443. On Windows this does not work because:
 *
 *   1. openssl s_client has TLS compatibility issues with the Vers proxy on Windows.
 *   2. SSH ControlMaster requires Unix domain sockets, which fail on NTFS.
 *
 * The fix: on Windows, spin up a local Node.js TCP server that forwards to the
 * Vers TLS endpoint. SSH connects to 127.0.0.1:<port> instead of using
 * ProxyCommand. One proxy per VM, reused across connections.
 */

import { platform } from "node:os";

/** True when running on Windows (native or WSL host process) */
export const IS_WINDOWS = platform() === "win32";

/**
 * Local TCP-to-TLS proxy for Windows.
 *
 * Starts a localhost TCP server that forwards traffic to {vmId}.vm.vers.sh:443
 * via Node built-in TLS module. Returns the ephemeral port number.
 *
 * Proxies are cached per VM ID -- calling this twice for the same VM returns the
 * same port.
 *
 * Note: rejectUnauthorized: false is intentional -- TLS here is only a transport
 * wrapper to reach the Vers proxy. SSH key authentication inside the tunnel
 * provides the actual security. This matches the Linux behavior where
 * openssl s_client -quiet also skips certificate verification.
 */
const _winProxyPorts = new Map<string, number>();
export async function ensureWinProxy(vmId: string): Promise<number> {
	const existing = _winProxyPorts.get(vmId);
	if (existing) return existing;

	const tls = require("node:tls");
	const net = require("node:net");
	const hostname = vmId + ".vm.vers.sh";

	return new Promise<number>((resolve, reject) => {
		const server = net.createServer((client: any) => {
			const remote = tls.connect({
				host: hostname,
				port: 443,
				servername: hostname,
				// TLS is a transport wrapper only -- SSH key auth provides actual security.
				// Equivalent to the openssl s_client -quiet behavior on Linux.
				rejectUnauthorized: false,
			});
			remote.on("secureConnect", () => {
				client.pipe(remote);
				remote.pipe(client);
			});
			remote.on("error", () => client.destroy());
			client.on("error", () => remote.destroy());
			client.on("close", () => remote.destroy());
			remote.on("close", () => client.destroy());
		});
		server.listen(0, "127.0.0.1", () => {
			const port = server.address().port;
			_winProxyPorts.set(vmId, port);
			// Keep server alive for the lifetime of the process
			server.unref();
			resolve(port);
		});
		server.on("error", reject);
	});
}

/**
 * Build platform-appropriate SSH connection args for a Vers VM.
 *
 * On Linux/macOS: uses openssl s_client ProxyCommand (original behavior).
 * On Windows: uses local TCP-to-TLS proxy on an ephemeral port.
 *
 * Does NOT include ControlMaster/ControlPath args -- those are managed by the
 * caller (and skipped entirely on Windows).
 */
export async function platformSSHArgs(vmId: string): Promise<string[]> {
	if (IS_WINDOWS) {
		const localPort = await ensureWinProxy(vmId);
		return ["-p", String(localPort), "root@127.0.0.1"];
	} else {
		const hostname = vmId + ".vm.vers.sh";
		return [
			"-o", "ProxyCommand=openssl s_client -connect %h:443 -servername %h -quiet 2>/dev/null",
			"root@" + hostname,
		];
	}
}
