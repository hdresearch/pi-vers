#!/usr/bin/env bash
#
# Thorium Golden VM Bootstrap Script
#
# Installs all language toolchains and verification tools needed for Thorium
# multi-agent code generation and verification pipeline.
#
# Languages: C/C++, C#, Java, Rust, Python, JavaScript/TypeScript
#

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${BLUE}[INFO]${NC} $*"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $*"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $*"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $*"
}

# =============================================================================
# System Preparation
# =============================================================================

log_info "Starting Thorium Golden VM bootstrap..."
log_info "This will take 15-30 minutes depending on network speed."

log_info "Updating system packages..."
apt update -qq
apt upgrade -y -qq

log_info "Installing base development tools..."
apt install -y -qq \
    build-essential \
    git \
    curl \
    wget \
    ca-certificates \
    gnupg \
    lsb-release \
    software-properties-common \
    pkg-config \
    libssl-dev \
    unzip \
    zip \
    jq \
    tree \
    ripgrep \
    fd-find \
    shellcheck \
    || { log_error "Failed to install base tools"; exit 1; }

log_success "Base tools installed"

# =============================================================================
# C/C++ Toolchain
# =============================================================================

log_info "Installing C/C++ toolchain..."

apt install -y -qq \
    gcc \
    g++ \
    clang \
    clang-format \
    clang-tidy \
    cmake \
    ninja-build \
    libgtest-dev \
    libgmock-dev \
    cppcheck \
    || { log_error "Failed to install C/C++ tools"; exit 1; }

# Build GoogleTest libraries
log_info "Building GoogleTest..."
cd /usr/src/gtest
cmake . -DCMAKE_BUILD_TYPE=Release
make -j$(nproc)
cp lib/*.a /usr/lib/ 2>/dev/null || true
cd /usr/src/googletest
cmake . -DCMAKE_BUILD_TYPE=Release
make -j$(nproc)
cp lib/*.a /usr/lib/ 2>/dev/null || true

log_success "C/C++ toolchain installed"

# =============================================================================
# C# / .NET Toolchain
# =============================================================================

log_info "Installing .NET SDK..."

wget https://dot.net/v1/dotnet-install.sh -O /tmp/dotnet-install.sh
chmod +x /tmp/dotnet-install.sh
/tmp/dotnet-install.sh --channel 8.0 --install-dir /usr/share/dotnet
ln -sf /usr/share/dotnet/dotnet /usr/bin/dotnet

# Verify .NET installation
if ! dotnet --version >/dev/null 2>&1; then
    log_error ".NET installation failed"
    exit 1
fi

log_success ".NET SDK installed: $(dotnet --version)"

# =============================================================================
# Java Toolchain
# =============================================================================

log_info "Installing Java toolchain..."

apt install -y -qq openjdk-21-jdk maven || { log_error "Failed to install Java"; exit 1; }

# Install additional Java tools
log_info "Installing Java verification tools..."
mkdir -p /opt/java-tools

# Checkstyle
wget -q https://github.com/checkstyle/checkstyle/releases/download/checkstyle-10.12.5/checkstyle-10.12.5-all.jar \
    -O /opt/java-tools/checkstyle.jar

# SpotBugs
wget -q https://github.com/spotbugs/spotbugs/releases/download/4.8.1/spotbugs-4.8.1.tgz \
    -O /tmp/spotbugs.tgz
tar -xzf /tmp/spotbugs.tgz -C /opt/java-tools/
ln -sf /opt/java-tools/spotbugs-4.8.1/bin/spotbugs /usr/local/bin/spotbugs

# google-java-format
wget -q https://github.com/google/google-java-format/releases/download/v1.18.1/google-java-format-1.18.1-all-deps.jar \
    -O /opt/java-tools/google-java-format.jar

echo '#!/bin/bash
java -jar /opt/java-tools/google-java-format.jar "$@"' > /usr/local/bin/google-java-format
chmod +x /usr/local/bin/google-java-format

log_success "Java toolchain installed: $(java -version 2>&1 | head -1)"

# =============================================================================
# Rust Toolchain
# =============================================================================

log_info "Installing Rust toolchain..."

curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable

# Source Rust environment
export PATH="/root/.cargo/bin:$PATH"
source "$HOME/.cargo/env"

# Install Rust tools
rustup component add rustfmt clippy

# Install cargo-fuzz, cargo-audit, cargo-deny
cargo install cargo-fuzz cargo-audit cargo-deny --quiet || log_warn "Some Rust tools failed to install"

log_success "Rust toolchain installed: $(rustc --version)"

# =============================================================================
# Python Toolchain
# =============================================================================

log_info "Installing Python toolchain..."

apt install -y -qq \
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    || { log_error "Failed to install Python"; exit 1; }

# Upgrade pip
python3 -m pip install --upgrade pip

# Install Python tools
pip3 install --quiet \
    mypy \
    pyright \
    black \
    ruff \
    pytest \
    pytest-cov \
    hypothesis \
    bandit \
    safety \
    || log_warn "Some Python tools failed to install"

log_success "Python toolchain installed: $(python3 --version)"

# =============================================================================
# JavaScript/TypeScript Toolchain
# =============================================================================

log_info "Installing Node.js and npm..."

# Install Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y -qq nodejs

# Verify Node installation
if ! node --version >/dev/null 2>&1; then
    log_error "Node.js installation failed"
    exit 1
fi

log_info "Installing JavaScript/TypeScript tools..."
npm install -g --quiet \
    typescript \
    prettier \
    eslint \
    jest \
    semgrep \
    || log_warn "Some JavaScript tools failed to install"

log_success "Node.js toolchain installed: $(node --version)"

# =============================================================================
# Policy and Security Tools
# =============================================================================

log_info "Installing security and policy tools..."

# gitleaks
wget -q https://github.com/gitleaks/gitleaks/releases/download/v8.18.1/gitleaks_8.18.1_linux_x64.tar.gz \
    -O /tmp/gitleaks.tar.gz
tar -xzf /tmp/gitleaks.tar.gz -C /usr/local/bin/ gitleaks
chmod +x /usr/local/bin/gitleaks

# trivy
wget -qO - https://aquasecurity.github.io/trivy-repo/deb/public.key | apt-key add -
echo "deb https://aquasecurity.github.io/trivy-repo/deb $(lsb_release -sc) main" | tee -a /etc/apt/sources.list.d/trivy.list
apt update -qq
apt install -y -qq trivy

log_success "Security tools installed"

# =============================================================================
# Thorium Directory Structure
# =============================================================================

log_info "Creating Thorium directory structure..."

mkdir -p /root/.thorium/{config,templates,workspace,logs}

cat > /root/.thorium/config.json <<'EOF'
{
  "version": "0.1.0",
  "goldenImage": true,
  "languages": {
    "c": {
      "compiler": "gcc",
      "version": "$(gcc --version | head -1)"
    },
    "csharp": {
      "runtime": "dotnet",
      "version": "$(dotnet --version)"
    },
    "java": {
      "compiler": "javac",
      "version": "$(javac -version 2>&1)"
    },
    "rust": {
      "compiler": "rustc",
      "version": "$(rustc --version)"
    },
    "python": {
      "interpreter": "python3",
      "version": "$(python3 --version)"
    },
    "js": {
      "runtime": "node",
      "version": "$(node --version)"
    }
  },
  "createdAt": "$(date -Iseconds)",
  "hostname": "$(hostname)"
}
EOF

log_success "Thorium directory structure created"

# =============================================================================
# Cleanup
# =============================================================================

log_info "Cleaning up..."

apt autoremove -y -qq
apt clean
rm -rf /tmp/* /var/tmp/*

# =============================================================================
# Final Summary
# =============================================================================

log_success "Thorium Golden VM bootstrap complete!"
echo ""
echo "=========================================="
echo "Installed Toolchains:"
echo "=========================================="
echo "C/C++:       $(gcc --version | head -1)"
echo "C#/.NET:     $(dotnet --version)"
echo "Java:        $(java -version 2>&1 | head -1)"
echo "Rust:        $(rustc --version)"
echo "Python:      $(python3 --version)"
echo "Node.js:     $(node --version)"
echo ""
echo "Verification Tools:"
echo "  - clang-format, clang-tidy, cppcheck"
echo "  - dotnet format"
echo "  - checkstyle, spotbugs, google-java-format"
echo "  - rustfmt, clippy, cargo-audit"
echo "  - mypy, pyright, black, ruff, bandit"
echo "  - prettier, eslint, semgrep"
echo ""
echo "Security Tools:"
echo "  - gitleaks, trivy, shellcheck"
echo ""
echo "Next steps:"
echo "1. Run verify.sh to check all installations"
echo "2. Commit this VM to create golden image"
echo "3. Save the commit ID for Thorium configuration"
echo "=========================================="
