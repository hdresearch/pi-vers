#!/usr/bin/env bash
set -euo pipefail

REPO="https://github.com/hdresearch/pi-v"
PI_PKG="@mariozechner/pi-coding-agent"
VERS_API="https://vers.sh"

info()  { printf "\033[1;34m==>\033[0m %s\n" "$*"; }
warn()  { printf "\033[1;33m==>\033[0m %s\n" "$*"; }
error() { printf "\033[1;31m==>\033[0m %s\n" "$*"; exit 1; }
ok()    { printf "\033[1;32m==>\033[0m %s\n" "$*"; }

# Detect shell config file
detect_shell_rc() {
  # Detect the user's actual shell, not the shell running this script
  local user_shell="${SHELL:-/bin/bash}"
  case "$user_shell" in
    */fish)
      echo "$HOME/.config/fish/config.fish"
      ;;
    */zsh)
      echo "$HOME/.zshrc"
      ;;
    *)
      echo "$HOME/.bashrc"
      ;;
  esac
}

# Append an export to shell config (idempotent, shell-aware)
persist_env() {
  local var_name="$1" var_value="$2" shell_rc="$3"

  # Ensure parent directory exists (for fish)
  mkdir -p "$(dirname "$shell_rc")"

  case "$shell_rc" in
    *.fish)
      # Fish syntax: set -gx VAR value
      if ! grep -q "set -gx ${var_name} " "$shell_rc" 2>/dev/null; then
        echo "set -gx ${var_name} ${var_value}" >> "$shell_rc"
      else
        sed -i.bak "s|^set -gx ${var_name} .*|set -gx ${var_name} ${var_value}|" "$shell_rc"
        rm -f "${shell_rc}.bak"
      fi
      ;;
    *)
      # Bash/zsh syntax: export VAR=value
      if ! grep -q "^export ${var_name}=" "$shell_rc" 2>/dev/null; then
        echo "export ${var_name}=${var_value}" >> "$shell_rc"
      else
        sed -i.bak "s|^export ${var_name}=.*|export ${var_name}=${var_value}|" "$shell_rc"
        rm -f "${shell_rc}.bak"
      fi
      ;;
  esac

  export "${var_name}=${var_value}"
}

# Find the user's SSH public key
find_ssh_public_key() {
  for key_file in "$HOME/.ssh/id_ed25519.pub" "$HOME/.ssh/id_ecdsa.pub" "$HOME/.ssh/id_rsa.pub"; do
    if [ -f "$key_file" ]; then
      cat "$key_file"
      return 0
    fi
  done
  return 1
}

# -----------------------------------------------------------
# 1. Check for Node.js
# -----------------------------------------------------------
if ! command -v node &>/dev/null; then
  error "Node.js is required but not installed. Install it from https://nodejs.org or via nvm."
fi

NODE_MAJOR=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 20 ]; then
  error "Node.js >= 20 is required (found v$(node --version)). Please upgrade."
fi

# -----------------------------------------------------------
# 2. Check for pi / install if missing
# -----------------------------------------------------------
if command -v pi &>/dev/null; then
  info "pi is already installed ($(pi --version 2>/dev/null || echo 'unknown version'))"
else
  info "Installing pi ($PI_PKG)..."
  npm install -g "$PI_PKG"
  if ! command -v pi &>/dev/null; then
    error "pi installed but not found on PATH. Make sure your npm global bin is in PATH."
  fi
  info "pi installed ($(pi --version 2>/dev/null))"
fi

# -----------------------------------------------------------
# 3. Install pi-v and agent-services packages
# -----------------------------------------------------------
info "Installing pi-v package from $REPO..."
pi install "$REPO"

AGENT_SERVICES_REPO="https://github.com/hdresearch/vers-agent-services"
info "Installing agent-services package from $AGENT_SERVICES_REPO..."
pi install "$AGENT_SERVICES_REPO"

# -----------------------------------------------------------
# 4. Vers account setup
# -----------------------------------------------------------
SHELL_RC=$(detect_shell_rc)

if [ -n "${VERS_API_KEY:-}" ]; then
  ok "VERS_API_KEY is already set"
elif [ -f "$HOME/.vers/keys.json" ]; then
  ok "Vers keys found at ~/.vers/keys.json"
else
  info "No Vers API key found. Let's set one up."
  printf "\n"

  # Find SSH public key
  SSH_PUB_KEY=$(find_ssh_public_key 2>/dev/null || true)
  if [ -z "$SSH_PUB_KEY" ]; then
    info "No SSH key found. Generating one..."
    ssh-keygen -t ed25519 -f "$HOME/.ssh/id_ed25519" -N "" -q
    SSH_PUB_KEY=$(cat "$HOME/.ssh/id_ed25519.pub")
    ok "SSH key generated"
  fi

  # Check if this key is already registered
  VERIFY_RESPONSE=$(curl -sf -X POST "${VERS_API}/api/shell-auth/verify-public-key" \
    -H "Content-Type: application/json" \
    -d "{\"ssh_public_key\": \"${SSH_PUB_KEY}\"}" 2>/dev/null || echo '{"verified":false}')

  ALREADY_VERIFIED=$(echo "$VERIFY_RESPONSE" | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    console.log(d.verified && d.count > 0 ? 'true' : 'false');
  " 2>/dev/null || echo "false")

  if [ "$ALREADY_VERIFIED" = "true" ]; then
    # Key is already registered — extract email and get an API key
    EMAIL=$(echo "$VERIFY_RESPONSE" | node -e "
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      const m = d.matches.find(m => m.is_active && m.public_key_verified) || d.matches[0];
      console.log(m.email);
    " 2>/dev/null)
    ok "SSH key already registered to ${EMAIL}"
  else
    # New user — collect email and register
    printf "  Enter your email: "
    read -r EMAIL < /dev/tty || EMAIL=""
    if [ -z "$EMAIL" ]; then
      error "Email is required to create a Vers account."
    fi

    info "Sending verification email to ${EMAIL}..."
    REGISTER_RESPONSE=$(curl -sf -X POST "${VERS_API}/api/shell-auth" \
      -H "Content-Type: application/json" \
      -d "{\"email\": \"${EMAIL}\", \"ssh_public_key\": \"${SSH_PUB_KEY}\"}" 2>/dev/null || echo '{"error":"request failed"}')

    REG_ERROR=$(echo "$REGISTER_RESPONSE" | node -e "
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      console.log(d.error || '');
    " 2>/dev/null || echo "")

    if [ -n "$REG_ERROR" ]; then
      error "Registration failed: ${REG_ERROR}"
    fi

    printf "\n"
    ok "Verification email sent!"
    info "Check your inbox and click the link. Waiting..."
    printf "\n"

    # Poll for verification (up to 5 minutes)
    VERIFIED=false
    for i in $(seq 1 100); do
      POLL_RESPONSE=$(curl -sf -X POST "${VERS_API}/api/shell-auth/verify-key" \
        -H "Content-Type: application/json" \
        -d "{\"email\": \"${EMAIL}\", \"ssh_public_key\": \"${SSH_PUB_KEY}\"}" 2>/dev/null || echo '{"verified":false}')

      IS_VERIFIED=$(echo "$POLL_RESPONSE" | node -e "
        const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
        console.log(d.verified ? 'true' : 'false');
      " 2>/dev/null || echo "false")

      if [ "$IS_VERIFIED" = "true" ]; then
        VERIFIED=true
        break
      fi

      # Print a dot every 3 seconds to show we're waiting
      printf "."
      sleep 3
    done

    printf "\n"

    if [ "$VERIFIED" != "true" ]; then
      error "Verification timed out. Run this script again after clicking the email link."
    fi

    ok "Email verified!"
  fi

  # Create an API key
  info "Creating API key..."
  API_KEY_RESPONSE=$(curl -sf -X POST "${VERS_API}/api/shell-auth/api-keys" \
    -H "Content-Type: application/json" \
    -d "{\"email\": \"${EMAIL}\", \"ssh_public_key\": \"${SSH_PUB_KEY}\", \"label\": \"pi-v-install\"}" 2>/dev/null || echo '{"error":"request failed"}')

  API_KEY=$(echo "$API_KEY_RESPONSE" | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    if (d.api_key) console.log(d.api_key);
    else if (d.error) { console.error(d.error); process.exit(1); }
    else { console.error('unexpected response'); process.exit(1); }
  " 2>/dev/null)

  if [ -z "$API_KEY" ]; then
    error "Failed to create API key. Response: ${API_KEY_RESPONSE}"
  fi

  # Persist the key
  persist_env "VERS_API_KEY" "$API_KEY" "$SHELL_RC"

  # Write to ~/.vers/ in all formats tools might read
  mkdir -p "$HOME/.vers"

  # ~/.vers/keys.json — the format pi-v extensions read (loadVersKeyFromDisk)
  cat > "$HOME/.vers/keys.json" << KEYSEOF
{
  "keys": {
    "VERS_API_KEY": "${API_KEY}"
  }
}
KEYSEOF

  # ~/.vers/config.json — the format vers CLI reads
  if [ -f "$HOME/.vers/config.json" ]; then
    node -e "
      const fs = require('fs');
      const c = JSON.parse(fs.readFileSync('$HOME/.vers/config.json','utf8'));
      c.api_key = '$API_KEY';
      c.versApiKey = '$API_KEY';
      fs.writeFileSync('$HOME/.vers/config.json', JSON.stringify(c, null, 2));
    " 2>/dev/null
  else
    echo "{\"api_key\": \"${API_KEY}\", \"versApiKey\": \"${API_KEY}\"}" > "$HOME/.vers/config.json"
  fi

  ok "VERS_API_KEY saved to ${SHELL_RC}, ~/.vers/keys.json, and ~/.vers/config.json"
fi

# -----------------------------------------------------------
# 5. Check for Anthropic API key
# -----------------------------------------------------------
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  ok "ANTHROPIC_API_KEY is already set"
else
  printf "\n"
  warn "ANTHROPIC_API_KEY is not set."
  printf "  Required for spawning swarm agents.\n"
  printf "  Enter your Anthropic API key (or press Enter to skip): "
  read -r ANTHROPIC_KEY < /dev/tty || ANTHROPIC_KEY=""
  if [ -n "$ANTHROPIC_KEY" ]; then
    persist_env "ANTHROPIC_API_KEY" "$ANTHROPIC_KEY" "$SHELL_RC"
    ok "ANTHROPIC_API_KEY saved to ${SHELL_RC}"
  else
    warn "Skipped. Add it later: export ANTHROPIC_API_KEY=your-key-here"
  fi
fi

# -----------------------------------------------------------
# Done
# -----------------------------------------------------------
printf "\n"
ok "Setup complete!"
printf "\n  Packages installed:\n"
printf "    pi-v                — VM management, swarm orchestration, background processes\n"
printf "    vers-agent-services — Shared board, feed, log, registry, usage tracking\n"
printf "\n  VM & Swarm tools:\n"
printf "    vers_vm_create, vers_vm_use, vers_vm_commit, vers_swarm_spawn, ...\n"
printf "\n  Coordination tools (requires an infra VM running agent-services):\n"
printf "    board_create_task, feed_publish, log_append, registry_discover, ...\n"
printf "\n  To get started, run pi and say:\n"
printf "    \"bootstrap Vers agents\"\n\n"
