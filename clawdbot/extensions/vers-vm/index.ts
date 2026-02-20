/**
 * Vers VM Extension for Clawdbot
 * 
 * Provides tools for managing Vers VMs (vers.sh)
 */

const DEFAULT_BASE_URL = "https://api.vers.sh/api/v1";

export default function versVmPlugin(api: any) {
  const logger = api.logger || console;

  function getBaseUrl(): string {
    const cfg = api.getConfig?.()?.plugins?.entries?.["vers-vm"]?.config;
    return cfg?.baseUrl || process.env.VERS_BASE_URL || DEFAULT_BASE_URL;
  }

  function getApiKey(): string {
    return process.env.VERS_API_KEY || "";
  }

  async function versApi<T>(method: string, path: string, body?: unknown): Promise<T> {
    const baseUrl = getBaseUrl();
    const apiKey = getApiKey();
    
    if (!apiKey) {
      throw new Error("VERS_API_KEY environment variable not set");
    }

    const url = `${baseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Vers API ${method} ${path} failed (${res.status}): ${text}`);
    }

    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      return res.json() as Promise<T>;
    }
    return undefined as T;
  }

  // =========================================================================
  // Tools
  // =========================================================================

  api.registerTool({
    name: "vers_vms",
    description: "List all Vers VMs. Returns VM IDs, states (running/paused/booting), and creation times.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute() {
      const vms = await versApi<any[]>("GET", "/vms");
      const summary = vms.map((v: any) => `${v.vm_id.slice(0, 12)} [${v.state}] created ${v.created_at}`).join("\n");
      return {
        content: [{ type: "text", text: vms.length === 0 ? "No VMs found." : `${vms.length} VM(s):\n${summary}` }],
      };
    },
  });

  api.registerTool({
    name: "vers_vm_create",
    description: "Create a new root Firecracker VM on the Vers platform. Returns the new VM ID.",
    parameters: {
      type: "object",
      properties: {
        vcpu_count: { type: "number", description: "Number of vCPUs (default: 1)" },
        mem_size_mib: { type: "number", description: "RAM in MiB (default: 512)" },
        fs_size_mib: { type: "number", description: "Disk size in MiB (default: 512)" },
        wait_boot: { type: "boolean", description: "Wait for VM to finish booting (default: false)" },
      },
      required: [],
    },
    async execute(_id: string, params: any) {
      const { vcpu_count, mem_size_mib, fs_size_mib, wait_boot } = params;
      const vmConfig: Record<string, number> = {};
      if (vcpu_count !== undefined) vmConfig.vcpu_count = vcpu_count;
      if (mem_size_mib !== undefined) vmConfig.mem_size_mib = mem_size_mib;
      if (fs_size_mib !== undefined) vmConfig.fs_size_mib = fs_size_mib;
      
      const q = wait_boot ? "?wait_boot=true" : "";
      const result = await versApi<{ vm_id: string }>("POST", `/vm/new_root${q}`, { vm_config: vmConfig });
      
      return {
        content: [{ type: "text", text: `VM created: ${result.vm_id}` }],
      };
    },
  });

  api.registerTool({
    name: "vers_vm_delete",
    description: "Delete a Vers VM by ID. This is irreversible.",
    parameters: {
      type: "object",
      properties: {
        vm_id: { type: "string", description: "VM ID to delete" },
      },
      required: ["vm_id"],
    },
    async execute(_id: string, params: any) {
      const { vm_id } = params;
      await versApi<any>("DELETE", `/vm/${encodeURIComponent(vm_id)}`);
      return {
        content: [{ type: "text", text: `VM ${vm_id} deleted.` }],
      };
    },
  });

  api.registerTool({
    name: "vers_vm_branch",
    description: "Branch (clone) a VM. Creates a new VM with identical state. Like git branch for VMs.",
    parameters: {
      type: "object",
      properties: {
        vm_id: { type: "string", description: "VM ID to branch from" },
      },
      required: ["vm_id"],
    },
    async execute(_id: string, params: any) {
      const { vm_id } = params;
      const result = await versApi<{ vm_id: string }>("POST", `/vm/${encodeURIComponent(vm_id)}/branch`);
      return {
        content: [{ type: "text", text: `Branched VM ${vm_id.slice(0, 12)} → ${result.vm_id}` }],
      };
    },
  });

  api.registerTool({
    name: "vers_vm_commit",
    description: "Commit (snapshot) a VM's current state. Returns a commit ID that can be used to restore later.",
    parameters: {
      type: "object",
      properties: {
        vm_id: { type: "string", description: "VM ID to commit" },
        keep_paused: { type: "boolean", description: "Keep VM paused after commit (default: false)" },
      },
      required: ["vm_id"],
    },
    async execute(_id: string, params: any) {
      const { vm_id, keep_paused } = params;
      const q = keep_paused ? "?keep_paused=true" : "";
      const result = await versApi<{ commit_id: string }>("POST", `/vm/${encodeURIComponent(vm_id)}/commit${q}`);
      return {
        content: [{ type: "text", text: `VM ${vm_id.slice(0, 12)} committed: ${result.commit_id}` }],
      };
    },
  });

  api.registerTool({
    name: "vers_vm_restore",
    description: "Restore a new VM from a previously created commit. Creates a new VM in the exact state of the commit.",
    parameters: {
      type: "object",
      properties: {
        commit_id: { type: "string", description: "Commit ID to restore from" },
      },
      required: ["commit_id"],
    },
    async execute(_id: string, params: any) {
      const { commit_id } = params;
      const result = await versApi<{ vm_id: string }>("POST", "/vm/from_commit", { commit_id });
      return {
        content: [{ type: "text", text: `Restored from commit ${commit_id.slice(0, 12)} → VM ${result.vm_id}` }],
      };
    },
  });

  api.registerTool({
    name: "vers_vm_state",
    description: "Pause or resume a Vers VM. Paused VMs preserve memory state but don't consume compute.",
    parameters: {
      type: "object",
      properties: {
        vm_id: { type: "string", description: "VM ID to update" },
        state: { type: "string", enum: ["Paused", "Running"], description: "Target state" },
      },
      required: ["vm_id", "state"],
    },
    async execute(_id: string, params: any) {
      const { vm_id, state } = params;
      await versApi<void>("PATCH", `/vm/${encodeURIComponent(vm_id)}/state`, { state });
      return {
        content: [{ type: "text", text: `VM ${vm_id.slice(0, 12)} state set to ${state}.` }],
      };
    },
  });

  api.registerTool({
    name: "vers_vm_ssh_key",
    description: "Get SSH credentials for a VM. Returns connection instructions for SSH-over-TLS.",
    parameters: {
      type: "object",
      properties: {
        vm_id: { type: "string", description: "VM ID to get SSH key for" },
      },
      required: ["vm_id"],
    },
    async execute(_id: string, params: any) {
      const { vm_id } = params;
      const result = await versApi<{ ssh_private_key: string; ssh_port: number }>("GET", `/vm/${encodeURIComponent(vm_id)}/ssh_key`);
      
      const keyPreview = result.ssh_private_key.split("\n").slice(0, 2).join("\n");
      const instructions = `SSH Connection for VM ${vm_id.slice(0, 12)}:

1. Save the key to a file and chmod 600
2. Connect via SSH-over-TLS:
   ssh -i <keyfile> -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \\
     -o ProxyCommand="openssl s_client -connect %h:443 -servername %h -quiet 2>/dev/null" \\
     root@${vm_id}.vm.vers.sh

Key preview:
${keyPreview}
[... key truncated ...]`;

      return {
        content: [{ type: "text", text: instructions }],
      };
    },
  });

  api.registerTool({
    name: "vers_vm_branch_commit",
    description: "Create a new VM by branching directly from a commit ID (instead of a running VM).",
    parameters: {
      type: "object",
      properties: {
        commit_id: { type: "string", description: "Commit ID to branch from" },
      },
      required: ["commit_id"],
    },
    async execute(_id: string, params: any) {
      const { commit_id } = params;
      const result = await versApi<{ vm_id: string }>("POST", `/vm/branch/by_commit/${encodeURIComponent(commit_id)}`);
      return {
        content: [{ type: "text", text: `Branched from commit ${commit_id.slice(0, 12)} → VM ${result.vm_id}` }],
      };
    },
  });

  if (logger.info) logger.info("Vers VM plugin loaded");
}
