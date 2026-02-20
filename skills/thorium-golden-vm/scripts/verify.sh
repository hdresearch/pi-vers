#!/usr/bin/env bash
#
# Thorium Golden VM Verification Script
#
# Verifies that all required language toolchains and verification tools
# are properly installed and functional.
#

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS=0
FAIL=0

check_command() {
    local cmd=$1
    local name=${2:-$cmd}

    if command -v "$cmd" >/dev/null 2>&1; then
        echo -e "${GREEN}✓${NC} $name"
        ((PASS++))
        return 0
    else
        echo -e "${RED}✗${NC} $name (not found)"
        ((FAIL++))
        return 1
    fi
}

check_version() {
    local cmd=$1
    local name=$2
    local version_flag=${3:---version}

    if command -v "$cmd" >/dev/null 2>&1; then
        local version
        version=$($cmd $version_flag 2>&1 | head -1)
        echo -e "${GREEN}✓${NC} $name: $version"
        ((PASS++))
        return 0
    else
        echo -e "${RED}✗${NC} $name (not found)"
        ((FAIL++))
        return 1
    fi
}

check_file() {
    local file=$1
    local name=$2

    if [ -f "$file" ]; then
        echo -e "${GREEN}✓${NC} $name"
        ((PASS++))
        return 0
    else
        echo -e "${RED}✗${NC} $name (not found)"
        ((FAIL++))
        return 1
    fi
}

echo "=========================================="
echo "Thorium Golden VM Verification"
echo "=========================================="
echo ""

# =============================================================================
# Base Tools
# =============================================================================

echo "Base Tools:"
check_command git
check_command curl
check_command wget
check_command jq
check_command tree
check_command rg "ripgrep"
check_command fdfind "fd-find"
check_command shellcheck
echo ""

# =============================================================================
# C/C++ Toolchain
# =============================================================================

echo "C/C++ Toolchain:"
check_version gcc "gcc" --version
check_version g++ "g++" --version
check_version clang "clang" --version
check_version clang-format "clang-format" --version
check_version clang-tidy "clang-tidy" --version
check_version cmake "cmake" --version
check_command ninja
check_version cppcheck "cppcheck" --version

# Check for GoogleTest libraries
if [ -f /usr/lib/libgtest.a ] || [ -f /usr/lib/x86_64-linux-gnu/libgtest.a ]; then
    echo -e "${GREEN}✓${NC} GoogleTest libraries"
    ((PASS++))
else
    echo -e "${YELLOW}⚠${NC} GoogleTest libraries (not found, but may be in source form)"
fi
echo ""

# =============================================================================
# C#/.NET Toolchain
# =============================================================================

echo "C#/.NET Toolchain:"
check_version dotnet ".NET SDK" --version

# Check dotnet can build
if dotnet --list-sdks | grep -q "8.0"; then
    echo -e "${GREEN}✓${NC} .NET SDK 8.0"
    ((PASS++))
else
    echo -e "${RED}✗${NC} .NET SDK 8.0 (not found)"
    ((FAIL++))
fi
echo ""

# =============================================================================
# Java Toolchain
# =============================================================================

echo "Java Toolchain:"
check_version java "Java Runtime" -version
check_version javac "Java Compiler" -version
check_version mvn "Maven" --version
check_file /opt/java-tools/checkstyle.jar "Checkstyle"
check_file /opt/java-tools/google-java-format.jar "google-java-format"
check_command spotbugs "SpotBugs"
echo ""

# =============================================================================
# Rust Toolchain
# =============================================================================

echo "Rust Toolchain:"

# Source Rust environment if not already in PATH
if ! command -v rustc >/dev/null 2>&1; then
    if [ -f "$HOME/.cargo/env" ]; then
        source "$HOME/.cargo/env"
    fi
fi

check_version rustc "rustc" --version
check_version cargo "cargo" --version
check_command rustfmt
check_command clippy-driver "clippy"
check_command cargo-audit "cargo-audit"
check_command cargo-fuzz "cargo-fuzz"
check_command cargo-deny "cargo-deny"
echo ""

# =============================================================================
# Python Toolchain
# =============================================================================

echo "Python Toolchain:"
check_version python3 "Python" --version
check_version pip3 "pip" --version
check_command mypy
check_command pyright
check_command black
check_command ruff
check_command pytest
check_command bandit
check_command safety
echo ""

# =============================================================================
# JavaScript/TypeScript Toolchain
# =============================================================================

echo "JavaScript/TypeScript Toolchain:"
check_version node "Node.js" --version
check_version npm "npm" --version
check_command tsc "TypeScript"
check_command prettier
check_command eslint
check_command jest
check_command semgrep
echo ""

# =============================================================================
# Security Tools
# =============================================================================

echo "Security Tools:"
check_version gitleaks "gitleaks" version
check_version trivy "trivy" --version
echo ""

# =============================================================================
# Thorium Directory Structure
# =============================================================================

echo "Thorium Configuration:"
if [ -d /root/.thorium ]; then
    echo -e "${GREEN}✓${NC} /root/.thorium directory exists"
    ((PASS++))

    if [ -f /root/.thorium/config.json ]; then
        echo -e "${GREEN}✓${NC} /root/.thorium/config.json exists"
        ((PASS++))
    else
        echo -e "${RED}✗${NC} /root/.thorium/config.json missing"
        ((FAIL++))
    fi
else
    echo -e "${RED}✗${NC} /root/.thorium directory missing"
    ((FAIL++))
fi
echo ""

# =============================================================================
# Summary
# =============================================================================

echo "=========================================="
echo "Verification Summary"
echo "=========================================="
echo -e "Passed: ${GREEN}$PASS${NC}"
echo -e "Failed: ${RED}$FAIL${NC}"
echo ""

if [ $FAIL -eq 0 ]; then
    echo -e "${GREEN}All checks passed!${NC} Golden VM is ready."
    echo ""
    echo "Next steps:"
    echo "  1. Commit this VM: vers_vm_commit"
    echo "  2. Save the commit ID for Thorium"
    echo "  3. Test by restoring a new VM from the commit"
    exit 0
else
    echo -e "${RED}Some checks failed.${NC} Please review the output above."
    echo ""
    echo "Common fixes:"
    echo "  - Re-run bootstrap.sh if tools are missing"
    echo "  - Check network connectivity if downloads failed"
    echo "  - Ensure sufficient disk space (df -h)"
    exit 1
fi
