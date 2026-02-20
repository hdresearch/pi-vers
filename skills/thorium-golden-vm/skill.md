# Thorium Golden VM Skill

## Purpose

Bootstrap a Vers VM into a reusable golden image for Thorium agents. This golden image contains all language toolchains, verification tools, and configurations needed to run Thorium's multi-agent code generation and verification pipeline.

## What This Skill Does

Creates a VM with:
- **6 Language Ecosystems**: C/C++, C#, Java, Rust, Python, JavaScript/TypeScript
- **Build Tools**: gcc, clang, cmake, .NET CLI, Maven, Cargo, pip, npm
- **Formatters**: clang-format, dotnet format, google-java-format, rustfmt, black, prettier
- **Linters**: clang-tidy, Roslyn, Checkstyle, clippy, ruff, eslint
- **Test Frameworks**: GoogleTest, xUnit, JUnit 5, cargo test, pytest, jest
- **Fuzzers**: libFuzzer, SharpFuzz, Jazzer, cargo-fuzz, hypothesis, jsfuzz
- **Static Analyzers**: cppcheck, scan-build, SpotBugs, Infer, pyright, semgrep
- **Policy Tools**: gitleaks, trivy, shellcheck
- **Base Tools**: git, curl, wget, jq, tree, ripgrep, fd-find

## Prerequisites

- Vers API key configured (`VERS_API_KEY` environment variable or `~/.vers/keys.json`)
- pi installed with Pi-V extensions
- Sufficient Vers VM quota (recommended: 8GB RAM, 32GB disk)

## Steps to Execute

### 1. Create Base VM

```bash
# Create a VM with sufficient resources
vers_vm_create --vcpu_count 4 --mem_size_mib 8192 --fs_size_mib 32768 --wait_boot true
```

Note the VM ID returned. Set it as active:

```bash
vers_vm_use --vm_id <VM_ID>
```

### 2. Run Bootstrap Script

The bootstrap script will install all toolchains. Run it in the VM:

```bash
# Upload bootstrap script to VM
# (Assuming VM is active, tools will route through SSH)
bash /path/to/pi-v/skills/thorium-golden-vm/scripts/bootstrap.sh
```

This will take 15-30 minutes depending on network speed and VM performance.

### 3. Verify Installation

Run the verification script to ensure all tools are installed correctly:

```bash
bash /path/to/pi-v/skills/thorium-golden-vm/scripts/verify.sh
```

If any tools are missing, the script will report errors.

### 4. Configure Thorium Directory

Create the Thorium configuration directory structure:

```bash
mkdir -p /root/.thorium
cat > /root/.thorium/config.json <<'EOF'
{
  "version": "0.1.0",
  "languages": ["c", "csharp", "java", "rust", "python", "js"],
  "goldenImage": true,
  "createdAt": "$(date -Iseconds)"
}
EOF

mkdir -p /root/.thorium/templates
mkdir -p /root/.thorium/workspace
```

### 5. Commit to Golden Image

```bash
vers_vm_commit --keep_paused false
```

Note the commit ID returned. This is your golden image commit ID.

### 6. Store Commit ID

Save the commit ID for future use. You can store it in:
- Thorium's `config/vm_config.yml` under `golden_image.commit_id`
- Environment variable: `THORIUM_GOLDEN_COMMIT_ID`
- Local file: `~/.thorium/golden-commit-id`

### 7. Test Golden Image

Restore a new VM from the golden image to verify it works:

```bash
vers_vm_restore --commit_id <COMMIT_ID> --wait_boot true
vers_vm_use --vm_id <NEW_VM_ID>

# Test a language toolchain
python3 --version
rustc --version
node --version
```

### 8. Cleanup

Delete the test VM:

```bash
vers_vm_delete --vm_id <NEW_VM_ID>
vers_vm_local
```

## Maintenance

Golden images should be refreshed periodically (recommended: monthly) to get:
- Security updates
- New tool versions
- Bug fixes

To refresh:
1. Restore from existing golden image
2. Run system updates: `apt update && apt upgrade -y`
3. Update language toolchains (see bootstrap.sh)
4. Commit new golden image
5. Update Thorium config with new commit ID

## Troubleshooting

**Problem**: Bootstrap script fails with "E: Unable to locate package"
- **Solution**: VM may not have network connectivity. Check Vers VM networking.

**Problem**: Language toolchain installation fails
- **Solution**: Check individual installation logs in `/tmp/thorium-bootstrap-*.log`

**Problem**: Verification script reports missing tools
- **Solution**: Re-run bootstrap script or install missing tools manually

**Problem**: Commit fails with "VM is not paused"
- **Solution**: Pause the VM first: `vers_vm_state --vm_id <VM_ID> --state Paused`

## Golden Image Size

Expected disk usage:
- Base Ubuntu: ~2GB
- All language toolchains: ~8-12GB
- Total: ~10-14GB

Ensure VM has at least 32GB disk to allow workspace for code generation.

## Quick Start Command

For automated golden image creation:

```bash
# Single command to create, bootstrap, and commit
make vm-golden-image  # (From Thorium repository with Pi-V integration)
```

This will execute all steps automatically and save the commit ID.
