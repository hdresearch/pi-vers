#!/bin/bash
# Bootstrap a Vers VM into a golden image for pi agent swarms.
# Run as root on a fresh 4GB+ Vers VM.
#
# Requires: GITHUB_TOKEN env var for cloning private repos.
#
# IMPORTANT: This script uses `pi install` to register packages.
# Do NOT manually write ~/.pi/packages.json — pi doesn't read it.
# Pi reads packages from ~/.pi/agent/settings.json, which `pi install` creates.
#
# Customize the PACKAGES array below for your own pi packages.
set -euo pipefail

GITHUB_TOKEN="${GITHUB_TOKEN:-}"

echo "=== Vers Golden VM Bootstrap ==="

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

# --- Pi coding agent ---
echo "[3/8] Installing pi coding agent..."
npm install -g @mariozechner/pi-coding-agent > /dev/null 2>&1
echo "  pi $(pi --version)"

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
git config --global user.name "pi-agent"
git config --global user.email "tynan.daly@hdr.is"
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
mkdir -p /root/.pi/agent/extensions
mkdir -p /root/.pi/agent/context
mkdir -p /root/.pi/agent/skills
mkdir -p /tmp/pi-rpc

# --- Clone and install pi packages ---
echo "[7/8] Installing pi packages..."

# Default packages: pi-v (VM/swarm tools) and vers-agent-services (coordination tools).
# Add your own as "url|dir" pairs. Private repos require GITHUB_TOKEN.
PACKAGES=(
  "https://github.com/hdresearch/pi-v.git|/root/.pi/agent/git/github.com/hdresearch/pi-v"
  "https://github.com/hdresearch/vers-agent-services.git|/root/.pi/agent/git/github.com/hdresearch/vers-agent-services"
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

# *** KEY: use `pi install` to register packages in settings.json ***
# Do NOT write packages.json manually — pi ignores that file.
# `pi install` creates ~/.pi/agent/settings.json which pi actually reads.
echo "  Running pi install..."
for entry in "${PACKAGES[@]}"; do
  dir="${entry##*|}"
  name="$(basename "$dir")"
  pi install "$dir" 2>/dev/null || echo "  WARN: pi install $name failed"
done

# Verify settings.json was created
if [ -f /root/.pi/agent/settings.json ]; then
  echo "  settings.json created ✓"
  cat /root/.pi/agent/settings.json | jq -r '.packages[]' 2>/dev/null | while read pkg; do
    echo "    - $pkg"
  done
else
  echo "  ERROR: settings.json not created! Extensions will NOT load."
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
echo "  pi:       $(pi --version)"
echo "  gh:       $(gh --version | head -1)"
echo "  git:      $(git --version)"
echo "  Packages: $(cat /root/.pi/agent/settings.json | jq '.packages | length') installed"
echo ""
echo "Ready to commit as golden image."
