#!/bin/bash
# Bootstrap a Vers VM into a golden image for punkin-pi agent swarms.
# Run as root on a fresh 4GB+ Vers VM.
#
# Requires: GITHUB_TOKEN env var for cloning private repos.
#
# Builds punkin-pi from source at the w/router release tag instead of installing the old
# @mariozechner/pi-coding-agent npm package. This ensures agents run the
# same harness as the reef coordinator.
#
# Uses `punkin install` to register packages in ~/.punkin/agent/settings.toml.
#
# Customize the PACKAGES array below for your own punkin packages.
set -euo pipefail

GITHUB_TOKEN="${GITHUB_TOKEN:-}"
PUNKIN_TAG="${PUNKIN_TAG:-w/router}"
GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-reef-agent}"
GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-reef-agent@users.noreply.github.com}"

echo "=== Vers Golden VM Bootstrap (punkin-pi) ==="

# --- System packages ---
echo "[1/8] Installing system packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  git curl wget build-essential \
  ripgrep fd-find jq tree \
  python3 python3-pip \
  openssh-client \
  ca-certificates gnupg \
  tmux \
  > /dev/null 2>&1

ln -sf "$(which fdfind)" /usr/local/bin/fd 2>/dev/null || true

# --- Node.js 22 LTS ---
echo "[2/8] Installing Node.js..."
if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - > /dev/null 2>&1
  apt-get install -y -qq nodejs > /dev/null 2>&1
fi
echo "  node $(node --version), npm $(npm --version)"

# --- punkin-pi coding agent (built from source) ---
echo "[3/8] Building punkin-pi from source (tag: $PUNKIN_TAG)..."
PUNKIN_DIR="/opt/punkin-pi"
if [ ! -d "$PUNKIN_DIR" ]; then
  git clone https://github.com/hdresearch/punkin-pi.git "$PUNKIN_DIR" > /dev/null 2>&1
fi
cd "$PUNKIN_DIR"
git fetch --tags --force > /dev/null 2>&1
if ! git rev-parse --verify -q "refs/tags/$PUNKIN_TAG" > /dev/null; then
  echo "  ERROR: punkin-pi release tag '$PUNKIN_TAG' was not found."
  exit 1
fi
git -c advice.detachedHead=false checkout --detach "refs/tags/$PUNKIN_TAG" > /dev/null 2>&1
echo "  Checked out release $PUNKIN_TAG ($(git rev-parse --short HEAD))"

echo "  Installing dependencies..."
npm install > /dev/null 2>&1

echo "  Building..."
npm run build > /dev/null 2>&1

# Symlink the CLI binary
chmod +x "$PUNKIN_DIR/packages/coding-agent/dist/cli.js"
ln -sf "$PUNKIN_DIR/packages/coding-agent/dist/cli.js" /usr/local/bin/punkin
ln -sf /usr/local/bin/punkin /usr/local/bin/pi
echo "  punkin $(punkin --version 2>/dev/null || echo 'installed')"
echo "  pi symlinked to punkin"

cd /root

# --- GitHub CLI ---
echo "[4/8] Installing GitHub CLI..."
if ! command -v gh &>/dev/null; then
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null
  apt-get update -qq > /dev/null 2>&1
  apt-get install -y -qq gh > /dev/null 2>&1
fi
echo "  gh $(gh --version | head -1)"

# --- Git config ---
echo "[5/8] Configuring git..."
git config --global user.name "$GIT_AUTHOR_NAME"
git config --global user.email "$GIT_AUTHOR_EMAIL"
git config --global init.defaultBranch main
git config --global core.editor "true"
export GIT_EDITOR=true
echo 'export GIT_EDITOR=true' >> /root/.bashrc
git config --global merge.commit no-edit

# Configure git credential helper for GitHub token
if [ -n "$GITHUB_TOKEN" ]; then
  echo "  Configuring GitHub token..."
  git config --global url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"
fi

# --- Directories ---
echo "[6/8] Setting up directories..."
mkdir -p /root/workspace
mkdir -p /root/.punkin/agent
mkdir -p /tmp/pi-rpc

# --- Clone and install punkin packages ---
echo "[7/8] Installing punkin packages..."

# Default packages: pi-v (VM/swarm tools) and vers-agent-services (coordination tools).
# Add your own as "url|dir" pairs. Private repos require GITHUB_TOKEN.
PACKAGES=(
  "https://github.com/hdresearch/pi-v.git|/opt/pi-vers"
  "https://github.com/hdresearch/vers-agent-services.git|/opt/vers-agent-services"
)

for entry in "${PACKAGES[@]}"; do
  url="${entry%%|*}"
  dir="${entry##*|}"
  name="$(basename "$dir")"
  if [ ! -d "$dir" ]; then
    mkdir -p "$(dirname "$dir")"
    git clone "$url" "$dir" > /dev/null 2>&1
  fi
  echo "  $name cloned"
done

# *** KEY: use `punkin install` to register packages in settings.toml ***
# `punkin install` creates ~/.punkin/agent/settings.toml which punkin reads.
echo "  Running punkin install..."
for entry in "${PACKAGES[@]}"; do
  dir="${entry##*|}"
  name="$(basename "$dir")"
  punkin install "$dir" 2>/dev/null || echo "  WARN: punkin install $name failed"
done

# Verify settings.toml was created
if [ -f /root/.punkin/agent/settings.toml ]; then
  echo "  settings.toml created ✓"
  cat /root/.punkin/agent/settings.toml
else
  echo "  ERROR: settings.toml not created! Extensions will NOT load."
  echo "  This means agents will only have read/bash/edit/write — no vers_*, board_*, etc."
  exit 1
fi

# --- Cleanup ---
echo "[8/8] Cleaning up..."
apt-get clean
rm -rf /var/lib/apt/lists/*
rm -f /root/.bash_history

# Remove any stale tmux/pi-rpc state (critical for golden images)
tmux kill-server 2>/dev/null || true
rm -rf /tmp/pi-rpc/*

echo ""
echo "=== Bootstrap complete ==="
echo "  Node:     $(node --version)"
echo "  npm:      $(npm --version)"
echo "  punkin:   $(punkin --version 2>/dev/null || echo 'built from source')"
echo "  gh:       $(gh --version | head -1)"
echo "  git:      $(git --version)"
echo "  git user: $(git config --global user.name) <$(git config --global user.email)>"
echo ""
echo "Ready to commit as golden image."
