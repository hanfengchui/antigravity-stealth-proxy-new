#!/usr/bin/env bash
#
# Antigravity Stealth Proxy — One-Click Installer
# Supported: Debian 11+, Ubuntu 20.04+
# Repository: https://github.com/hanfengchui/antigravity-stealth-proxy-new.git
#
# Usage:
#   curl -sSL <url>/install.sh | bash          # Fresh install
#   bash install.sh                             # Local run
#   bash install.sh --uninstall                 # Remove everything
#
set -euo pipefail

# ─────────────────────────── Constants ────────────────────────────

readonly REPO_URL="https://github.com/hanfengchui/antigravity-stealth-proxy-new.git"
readonly INSTALL_DIR="/opt/antigravity-proxy"
readonly SERVICE_NAME="antigravity-proxy"
readonly SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
readonly NGINX_CONF="/etc/nginx/sites-available/${SERVICE_NAME}"
readonly NGINX_LINK="/etc/nginx/sites-enabled/${SERVICE_NAME}"
readonly CONFIG_FILE="${INSTALL_DIR}/config.json"
readonly MIN_NODE_MAJOR=18
readonly DESIRED_NODE_MAJOR=22
readonly SCRIPT_VERSION="1.0.0"

# ─────────────────────────── Colors ───────────────────────────────

if [[ -t 1 ]]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  BLUE='\033[0;34m'
  CYAN='\033[0;36m'
  BOLD='\033[1m'
  DIM='\033[2m'
  RESET='\033[0m'
else
  RED='' GREEN='' YELLOW='' BLUE='' CYAN='' BOLD='' DIM='' RESET=''
fi

# ─────────────────────────── Helpers ──────────────────────────────

info()    { echo -e "${BLUE}[INFO]${RESET}  $*"; }
ok()      { echo -e "${GREEN}[  OK]${RESET}  $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
fail()    { echo -e "${RED}[FAIL]${RESET}  $*" >&2; }
step()    { echo -e "\n${BOLD}${CYAN}▸ $*${RESET}"; }
divider() { echo -e "${DIM}────────────────────────────────────────────────────${RESET}"; }

die() {
  fail "$@"
  exit 1
}

confirm() {
  local prompt="${1:-Continue?}"
  local default="${2:-y}"
  local yn
  if [[ "${default}" == "y" ]]; then
    read -rp "$(echo -e "${YELLOW}${prompt} [Y/n]:${RESET} ")" yn
    yn="${yn:-y}"
  else
    read -rp "$(echo -e "${YELLOW}${prompt} [y/N]:${RESET} ")" yn
    yn="${yn:-n}"
  fi
  [[ "${yn}" =~ ^[Yy] ]]
}

spinner() {
  local pid=$1
  local msg="${2:-Working}"
  local chars='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
  local i=0
  while kill -0 "${pid}" 2>/dev/null; do
    echo -ne "\r${CYAN}  ${chars:i++%${#chars}:1}${RESET} ${msg}..."
    sleep 0.1
  done
  echo -ne "\r"
}

run_quiet() {
  local msg="$1"
  shift
  local logfile
  logfile=$(mktemp)
  if "$@" > "${logfile}" 2>&1; then
    ok "${msg}"
    rm -f "${logfile}"
    return 0
  else
    local rc=$?
    fail "${msg}"
    echo -e "${DIM}$(tail -20 "${logfile}")${RESET}"
    rm -f "${logfile}"
    return "${rc}"
  fi
}

# ─────────────────────────── Pre-flight ───────────────────────────

banner() {
  echo ""
  echo -e "${BOLD}${CYAN}"
  echo "  ╔══════════════════════════════════════════════╗"
  echo "  ║    Antigravity Stealth Proxy  Installer      ║"
  echo "  ║    v${SCRIPT_VERSION}                                    ║"
  echo "  ╚══════════════════════════════════════════════╝"
  echo -e "${RESET}"
}

check_os() {
  step "Checking operating system"

  if [[ ! -f /etc/os-release ]]; then
    die "Cannot detect OS. /etc/os-release not found."
  fi

  # shellcheck disable=SC1091
  source /etc/os-release

  case "${ID}" in
    debian|ubuntu) ;;
    *)
      die "Unsupported OS: ${ID}. This installer supports Debian and Ubuntu only."
      ;;
  esac

  ok "Detected ${PRETTY_NAME}"
}

check_root() {
  step "Checking privileges"

  if [[ "${EUID}" -ne 0 ]]; then
    die "This script must be run as root. Try: sudo bash install.sh"
  fi

  ok "Running as root"
}

check_arch() {
  local arch
  arch=$(uname -m)
  case "${arch}" in
    x86_64|aarch64|arm64) ;;
    *)
      warn "Untested architecture: ${arch}. Proceeding anyway."
      ;;
  esac
}

# ─────────────────────────── Uninstall ────────────────────────────

do_uninstall() {
  banner
  step "Uninstalling Antigravity Stealth Proxy"

  if ! confirm "This will remove the service, Nginx config, and project files. Continue?" "n"; then
    info "Aborted."
    exit 0
  fi

  # Stop and disable service
  if systemctl is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
    info "Stopping service..."
    systemctl stop "${SERVICE_NAME}" || true
  fi
  if systemctl is-enabled --quiet "${SERVICE_NAME}" 2>/dev/null; then
    systemctl disable "${SERVICE_NAME}" || true
  fi
  if [[ -f "${SERVICE_FILE}" ]]; then
    rm -f "${SERVICE_FILE}"
    systemctl daemon-reload
    ok "Removed systemd service"
  fi

  # Remove Nginx config
  if [[ -f "${NGINX_CONF}" ]] || [[ -L "${NGINX_LINK}" ]]; then
    rm -f "${NGINX_LINK}" "${NGINX_CONF}"
    if command -v nginx &>/dev/null && nginx -t &>/dev/null; then
      systemctl reload nginx || true
    fi
    ok "Removed Nginx configuration"
  fi

  # Remove project directory
  if [[ -d "${INSTALL_DIR}" ]]; then
    if confirm "Remove project directory ${INSTALL_DIR} (including config.json with account data)?" "n"; then
      rm -rf "${INSTALL_DIR}"
      ok "Removed ${INSTALL_DIR}"
    else
      warn "Kept ${INSTALL_DIR}"
    fi
  fi

  echo ""
  ok "Uninstall complete."
  exit 0
}

# ─────────────────────────── Node.js ──────────────────────────────

detect_node() {
  if command -v node &>/dev/null; then
    local ver
    ver=$(node -v | sed 's/^v//')
    local major
    major=$(echo "${ver}" | cut -d. -f1)
    echo "${major}"
  else
    echo "0"
  fi
}

install_node() {
  step "Setting up Node.js"

  local current_major
  current_major=$(detect_node)

  if [[ "${current_major}" -ge "${MIN_NODE_MAJOR}" ]]; then
    ok "Node.js v$(node -v | sed 's/^v//') detected (>= ${MIN_NODE_MAJOR} required)"
    return 0
  fi

  if [[ "${current_major}" -gt 0 ]]; then
    warn "Node.js v$(node -v | sed 's/^v//') is too old (need >= ${MIN_NODE_MAJOR})"
  else
    info "Node.js not found"
  fi

  info "Installing Node.js ${DESIRED_NODE_MAJOR}.x LTS via NodeSource..."

  # Install prerequisites
  run_quiet "Installing prerequisites" \
    apt-get update -qq

  run_quiet "Installing curl and ca-certificates" \
    apt-get install -y -qq curl ca-certificates gnupg

  # NodeSource setup
  local keyring_dir="/etc/apt/keyrings"
  mkdir -p "${keyring_dir}"

  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o "${keyring_dir}/nodesource.gpg" 2>/dev/null

  echo "deb [signed-by=${keyring_dir}/nodesource.gpg] https://deb.nodesource.com/node_${DESIRED_NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list

  run_quiet "Updating package lists" \
    apt-get update -qq

  run_quiet "Installing Node.js ${DESIRED_NODE_MAJOR}.x" \
    apt-get install -y -qq nodejs

  # Verify
  local new_major
  new_major=$(detect_node)
  if [[ "${new_major}" -lt "${MIN_NODE_MAJOR}" ]]; then
    die "Node.js installation failed. Got major version ${new_major}."
  fi

  ok "Node.js $(node -v) installed successfully"
}

# ─────────────────────────── Git / Project ────────────────────────

install_git() {
  if command -v git &>/dev/null; then
    return 0
  fi
  run_quiet "Installing git" \
    apt-get install -y -qq git
}

deploy_project() {
  step "Deploying project"

  install_git

  local is_upgrade=false

  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    is_upgrade=true
    info "Existing installation detected at ${INSTALL_DIR}"

    if confirm "Update to latest version?" "y"; then
      info "Pulling latest changes..."

      # Stash any local changes to config
      local stashed=false
      if cd "${INSTALL_DIR}" && git diff --quiet config.json 2>/dev/null; then
        : # config.json unchanged
      elif [[ -f "${INSTALL_DIR}/config.json" ]]; then
        cp "${INSTALL_DIR}/config.json" "${INSTALL_DIR}/config.json.bak"
        info "Backed up config.json → config.json.bak"
      fi

      cd "${INSTALL_DIR}"
      run_quiet "Fetching updates" git fetch origin
      run_quiet "Resetting to latest" git reset --hard origin/main || \
        run_quiet "Resetting to latest (master)" git reset --hard origin/master || true

      # Restore config backup if it existed
      if [[ -f "${INSTALL_DIR}/config.json.bak" ]]; then
        cp "${INSTALL_DIR}/config.json.bak" "${INSTALL_DIR}/config.json"
        ok "Restored config.json from backup"
      fi

      ok "Updated to latest version"
    else
      info "Skipping update, using existing code"
    fi
  else
    info "Cloning repository..."
    run_quiet "Cloning to ${INSTALL_DIR}" \
      git clone "${REPO_URL}" "${INSTALL_DIR}"
    ok "Project cloned to ${INSTALL_DIR}"
  fi

  IS_UPGRADE="${is_upgrade}"
}

install_deps() {
  step "Installing dependencies"

  cd "${INSTALL_DIR}"

  # Install build tools for native modules (better-sqlite3)
  if ! command -v make &>/dev/null || ! command -v g++ &>/dev/null; then
    run_quiet "Installing build essentials (for native modules)" \
      apt-get install -y -qq build-essential python3
  fi

  run_quiet "Running npm install --production" \
    npm install --production

  ok "Dependencies installed"
}

# ─────────────────────────── Configuration ────────────────────────

generate_password() {
  openssl rand -base64 18 | tr -d '/+=' | head -c 24
}

generate_api_key() {
  echo "sk-$(openssl rand -hex 24)"
}

run_config_wizard() {
  step "Configuration"

  # If config.json exists and this is an upgrade, skip wizard
  if [[ -f "${CONFIG_FILE}" ]] && [[ "${IS_UPGRADE:-false}" == "true" ]]; then
    ok "Existing config.json found — keeping current configuration"
    # Read port from existing config for later use
    LISTEN_PORT=$(python3 -c "
import json, sys
try:
    cfg = json.load(open('${CONFIG_FILE}'))
    print(cfg.get('port', 8080))
except:
    print(8080)
" 2>/dev/null || echo "8080")
    return 0
  fi

  divider
  echo -e "${BOLD}Interactive Configuration${RESET}"
  echo -e "${DIM}Press Enter to accept defaults shown in [brackets]${RESET}"
  divider

  # Admin password
  local default_password
  default_password=$(generate_password)
  echo ""
  read -rp "$(echo -e "${CYAN}Admin panel password${RESET} [${DIM}${default_password}${RESET}]: ")" ADMIN_PASSWORD
  ADMIN_PASSWORD="${ADMIN_PASSWORD:-${default_password}}"

  # Listen port
  echo ""
  read -rp "$(echo -e "${CYAN}Listen port${RESET} [${DIM}8080${RESET}]: ")" LISTEN_PORT
  LISTEN_PORT="${LISTEN_PORT:-8080}"

  # Validate port is a number
  if ! [[ "${LISTEN_PORT}" =~ ^[0-9]+$ ]] || [[ "${LISTEN_PORT}" -lt 1 ]] || [[ "${LISTEN_PORT}" -gt 65535 ]]; then
    warn "Invalid port '${LISTEN_PORT}', defaulting to 8080"
    LISTEN_PORT=8080
  fi

  # Generate initial API key
  local default_key
  default_key=$(generate_api_key)

  # Write config.json
  local config_content
  config_content=$(cat <<CFGEOF
{
  "port": ${LISTEN_PORT},
  "host": "0.0.0.0",
  "adminPassword": "${ADMIN_PASSWORD}",
  "apiKeys": {
    "default": "${default_key}"
  },
  "accounts": [],
  "userBindings": {},
  "pacer": {
    "maxRequestsPerMinute": 5,
    "burstSize": 3,
    "jitterMinMs": 1000,
    "jitterMaxMs": 4000,
    "dailyLimitPerAccount": 500
  },
  "session": {
    "minLifetimeMs": 7200000,
    "maxLifetimeMs": 21600000,
    "restartDelayMs": 10000
  },
  "retry": {
    "maxRetries": 2,
    "waitBeforeSwitch": 60000,
    "maxWaitMs": 120000
  },
  "heartbeat": {
    "enabled": true,
    "intervalMs": 1800000
  }
}
CFGEOF
)

  echo "${config_content}" > "${CONFIG_FILE}"
  chmod 600 "${CONFIG_FILE}"
  ok "Configuration saved to ${CONFIG_FILE}"

  echo ""
  echo -e "  ${DIM}Admin password:${RESET} ${BOLD}${ADMIN_PASSWORD}${RESET}"
  echo -e "  ${DIM}API key:${RESET}        ${BOLD}${default_key}${RESET}"
  echo -e "  ${DIM}Port:${RESET}           ${BOLD}${LISTEN_PORT}${RESET}"

  # Store for summary
  GENERATED_API_KEY="${default_key}"
}

# ─────────────────────────── Nginx + SSL ──────────────────────────

setup_nginx() {
  step "Nginx reverse proxy (optional)"

  if ! confirm "Configure Nginx reverse proxy with SSL?" "n"; then
    NGINX_CONFIGURED=false
    return 0
  fi

  echo ""
  read -rp "$(echo -e "${CYAN}Domain name${RESET} (e.g. proxy.example.com): ")" DOMAIN_NAME

  if [[ -z "${DOMAIN_NAME}" ]]; then
    warn "No domain provided, skipping Nginx setup"
    NGINX_CONFIGURED=false
    return 0
  fi

  # Install Nginx
  if ! command -v nginx &>/dev/null; then
    run_quiet "Installing Nginx" \
      apt-get install -y -qq nginx
  fi

  # Create server block
  cat > "${NGINX_CONF}" <<NGINXEOF
# Antigravity Stealth Proxy — managed by install.sh
upstream antigravity_backend {
    server 127.0.0.1:${LISTEN_PORT};
    keepalive 64;
}

server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN_NAME};

    # ACME challenge for Certbot
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${DOMAIN_NAME};

    # SSL certs will be managed by Certbot
    ssl_certificate     /etc/letsencrypt/live/${DOMAIN_NAME}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN_NAME}/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    # Security headers
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # Request size (for large prompts)
    client_max_body_size 50m;

    # Proxy timeouts (streaming can be long)
    proxy_connect_timeout 60s;
    proxy_send_timeout    300s;
    proxy_read_timeout    300s;

    location / {
        proxy_pass http://antigravity_backend;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";

        # SSE / streaming support
        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding on;
    }
}
NGINXEOF

  # Enable site
  ln -sf "${NGINX_CONF}" "${NGINX_LINK}"

  # Remove default site if it conflicts
  if [[ -L /etc/nginx/sites-enabled/default ]]; then
    rm -f /etc/nginx/sites-enabled/default
  fi

  # Test Nginx config (ignore SSL cert errors since we haven't obtained them yet)
  # First, create a temp config without SSL for initial validation
  ok "Nginx server block created for ${DOMAIN_NAME}"

  # Install Certbot
  if ! command -v certbot &>/dev/null; then
    run_quiet "Installing Certbot" \
      apt-get install -y -qq certbot python3-certbot-nginx
  fi

  # Obtain certificate
  info "Requesting SSL certificate from Let's Encrypt..."
  echo ""

  if certbot --nginx -d "${DOMAIN_NAME}" --non-interactive --agree-tos \
    --register-unsafely-without-email --redirect 2>&1; then
    ok "SSL certificate obtained for ${DOMAIN_NAME}"
  else
    warn "Certbot failed. You can retry manually:"
    echo -e "  ${DIM}certbot --nginx -d ${DOMAIN_NAME}${RESET}"
  fi

  # Reload Nginx
  if nginx -t &>/dev/null; then
    systemctl reload nginx
    ok "Nginx reloaded"
  else
    warn "Nginx config test failed. Check: nginx -t"
  fi

  NGINX_CONFIGURED=true
}

# ─────────────────────────── Systemd ──────────────────────────────

setup_systemd() {
  step "Setting up systemd service"

  local node_path
  node_path=$(command -v node)

  cat > "${SERVICE_FILE}" <<SVCEOF
[Unit]
Description=Antigravity Stealth Proxy
After=network.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=root
WorkingDirectory=${INSTALL_DIR}
ExecStart=${node_path} src/index.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${INSTALL_DIR}
PrivateTmp=true

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

[Install]
WantedBy=multi-user.target
SVCEOF

  systemctl daemon-reload

  # Enable service
  systemctl enable "${SERVICE_NAME}" --quiet

  # Start or restart
  if systemctl is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
    info "Service already running, restarting..."
    systemctl restart "${SERVICE_NAME}"
  else
    systemctl start "${SERVICE_NAME}"
  fi

  # Wait a moment and verify
  sleep 2

  if systemctl is-active --quiet "${SERVICE_NAME}"; then
    ok "Service ${SERVICE_NAME} is running"
  else
    fail "Service failed to start. Check logs:"
    echo -e "  ${DIM}journalctl -u ${SERVICE_NAME} -n 30 --no-pager${RESET}"
    return 1
  fi
}

# ─────────────────────────── Firewall ─────────────────────────────

configure_firewall() {
  # Only configure if ufw is installed
  if ! command -v ufw &>/dev/null; then
    return 0
  fi

  if ! ufw status 2>/dev/null | grep -q "Status: active"; then
    return 0
  fi

  step "Configuring firewall"

  if [[ "${NGINX_CONFIGURED:-false}" == "true" ]]; then
    ufw allow 80/tcp  &>/dev/null || true
    ufw allow 443/tcp &>/dev/null || true
    ok "Opened ports 80, 443 (Nginx)"
  else
    ufw allow "${LISTEN_PORT}/tcp" &>/dev/null || true
    ok "Opened port ${LISTEN_PORT}"
  fi
}

# ─────────────────────────── Summary ──────────────────────────────

print_summary() {
  local server_ip
  server_ip=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "YOUR_SERVER_IP")

  echo ""
  divider
  echo -e "${BOLD}${GREEN}"
  echo "  Installation Complete!"
  echo -e "${RESET}"
  divider

  # Access URL
  echo ""
  echo -e "  ${BOLD}Access URLs${RESET}"
  if [[ "${NGINX_CONFIGURED:-false}" == "true" ]] && [[ -n "${DOMAIN_NAME:-}" ]]; then
    echo -e "  WebUI:     ${CYAN}https://${DOMAIN_NAME}${RESET}"
    echo -e "  API:       ${CYAN}https://${DOMAIN_NAME}/v1/messages${RESET}"
    echo -e "  Health:    ${CYAN}https://${DOMAIN_NAME}/health${RESET}"
  else
    echo -e "  WebUI:     ${CYAN}http://${server_ip}:${LISTEN_PORT}${RESET}"
    echo -e "  API:       ${CYAN}http://${server_ip}:${LISTEN_PORT}/v1/messages${RESET}"
    echo -e "  Health:    ${CYAN}http://${server_ip}:${LISTEN_PORT}/health${RESET}"
  fi

  # API key (only for fresh installs)
  if [[ -n "${GENERATED_API_KEY:-}" ]]; then
    echo ""
    echo -e "  ${BOLD}API Key${RESET}"
    echo -e "  ${CYAN}${GENERATED_API_KEY}${RESET}"
  fi

  # Admin password (only for fresh installs)
  if [[ -n "${ADMIN_PASSWORD:-}" ]] && [[ "${IS_UPGRADE:-false}" != "true" ]]; then
    echo ""
    echo -e "  ${BOLD}Admin Password${RESET}"
    echo -e "  ${CYAN}${ADMIN_PASSWORD}${RESET}"
  fi

  # Next steps
  echo ""
  divider
  echo -e "  ${BOLD}Next Steps${RESET}"
  echo ""
  echo -e "  ${YELLOW}1.${RESET} Open the WebUI and add your Google account(s)"
  echo -e "     via the OAuth flow on the Accounts page."
  echo ""
  echo -e "  ${YELLOW}2.${RESET} Configure Claude Code CLI:"
  echo ""
  if [[ "${NGINX_CONFIGURED:-false}" == "true" ]] && [[ -n "${DOMAIN_NAME:-}" ]]; then
    echo -e "     ${DIM}export ANTHROPIC_BASE_URL=https://${DOMAIN_NAME}${RESET}"
  else
    echo -e "     ${DIM}export ANTHROPIC_BASE_URL=http://${server_ip}:${LISTEN_PORT}${RESET}"
  fi
  echo -e "     ${DIM}export ANTHROPIC_AUTH_TOKEN=${GENERATED_API_KEY:-sk-your-api-key}${RESET}"
  echo -e "     ${DIM}export ANTHROPIC_MODEL=claude-sonnet-4-6-thinking${RESET}"

  # Service management
  echo ""
  divider
  echo -e "  ${BOLD}Service Management${RESET}"
  echo ""
  echo -e "  ${DIM}systemctl status  ${SERVICE_NAME}${RESET}   # Check status"
  echo -e "  ${DIM}systemctl restart ${SERVICE_NAME}${RESET}   # Restart"
  echo -e "  ${DIM}systemctl stop    ${SERVICE_NAME}${RESET}   # Stop"
  echo -e "  ${DIM}journalctl -u ${SERVICE_NAME} -f${RESET}    # Stream logs"
  echo ""
  divider
  echo ""
}

# ─────────────────────────── Main ─────────────────────────────────

main() {
  # Handle --uninstall flag
  if [[ "${1:-}" == "--uninstall" ]] || [[ "${1:-}" == "uninstall" ]]; then
    check_root
    do_uninstall
  fi

  banner
  check_os
  check_root
  check_arch

  # Detect existing installation
  IS_UPGRADE=false
  NGINX_CONFIGURED=false
  LISTEN_PORT=8080
  GENERATED_API_KEY=""
  ADMIN_PASSWORD=""

  if [[ -d "${INSTALL_DIR}/.git" ]] && [[ -f "${SERVICE_FILE}" ]]; then
    echo ""
    info "Existing installation detected at ${INSTALL_DIR}"
    if ! confirm "Upgrade existing installation?" "y"; then
      info "Aborted."
      exit 0
    fi
  fi

  install_node
  deploy_project
  install_deps
  run_config_wizard
  setup_nginx
  setup_systemd
  configure_firewall
  print_summary
}

main "$@"
