# I need to create a golden VM image

A golden image is a snapshotted VM with Node.js, `punkin-pi` `w/router`, and Vers tools pre-installed. Branch from it to get instant ready-to-code VMs.

## Steps

1. Create a fresh VM:
```
vers_vm_create --mem_size_mib 4096 --fs_size_mib 8192 --wait_boot true
```

2. Connect to it:
```
vers_vm_use --vmId <vmId>
```

3. Copy the shared bootstrap script from this repo into the VM:
```
vers_vm_copy --localPath <path-to-pi-vers>/skills/vers-golden-vm/scripts/bootstrap.sh --remotePath /root/bootstrap-golden-vm.sh --direction to_vm
```

4. Run the bootstrap:
```bash
export GITHUB_TOKEN="<token>"
export PUNKIN_TAG="w/router"
bash /root/bootstrap-golden-vm.sh
```

The script installs Node.js, builds `punkin-pi` from the `w/router` release tag, creates both `punkin` and `pi` binaries, clones the default Vers packages, and registers them through `punkin install`.

5. Verify the registered packages:
```bash
cat /root/.punkin/agent/settings.toml
# Should contain /opt/pi-vers and /opt/vers-agent-services
```

6. Snapshot it:
```
vers_vm_local
vers_vm_commit --vmId <vmId>
```

7. Save the returned `commit_id`. This is your golden image. Use it with `vers_swarm_spawn` or `vers_vm_restore`.

## If you need to update the golden image

Restore from the old commit, make changes, and commit again. You get a new commit ID.

## If the VM runs out of disk

Increase `fs_size_mib` when creating. 8192 (8GB) is enough for most setups. Use 16384 for projects with large dependencies.
