#!/usr/bin/env bash
# Memgraph Setup Script for EC2
# Installs Docker (if needed), deploys Memgraph container, verifies connectivity.
# Idempotent — safe to re-run.
#
# Usage: bash setup-memgraph.sh
# Run on EC2 instance as ubuntu user (or with sudo access).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MEMGRAPH_DIR="${SCRIPT_DIR}"
SCRIPTS_DIR="$(dirname "${SCRIPT_DIR}")/scripts"

echo "=== Memgraph Setup for Futurator ==="
echo "Memgraph dir: ${MEMGRAPH_DIR}"
echo "Scripts dir:  ${SCRIPTS_DIR}"
echo ""

# ── Task 1: Install Docker ──────────────────────────────────────────

install_docker() {
  if command -v docker &>/dev/null; then
    echo "[OK] Docker already installed: $(docker --version)"
  else
    echo "[INSTALL] Installing Docker Engine..."
    sudo apt-get update -qq
    sudo apt-get install -y -qq ca-certificates curl
    sudo install -m 0755 -d /etc/apt/keyrings
    sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    sudo chmod a+r /etc/apt/keyrings/docker.asc

    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
      $(. /etc/os-release && echo "${VERSION_CODENAME}") stable" | \
      sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

    sudo apt-get update -qq
    sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
    echo "[OK] Docker installed: $(docker --version)"
  fi

  # Ensure docker-compose plugin is available
  if docker compose version &>/dev/null; then
    echo "[OK] Docker Compose available: $(docker compose version --short)"
  else
    echo "[ERROR] Docker Compose plugin not found"
    exit 1
  fi

  # Add ubuntu user to docker group (if not already)
  if groups ubuntu 2>/dev/null | grep -q docker; then
    echo "[OK] User 'ubuntu' is in docker group"
  else
    echo "[SETUP] Adding 'ubuntu' to docker group..."
    sudo usermod -aG docker ubuntu
    echo "[OK] Added. Note: you may need to log out and back in for group changes to take effect."
  fi

  # Enable Docker on boot
  sudo systemctl enable docker --quiet 2>/dev/null || true
  sudo systemctl start docker 2>/dev/null || true
  echo "[OK] Docker service enabled and running"
}

# ── Task 2 + 3: Deploy and start Memgraph ───────────────────────────

deploy_memgraph() {
  echo ""
  echo "=== Deploying Memgraph ==="

  cd "${MEMGRAPH_DIR}"

  # Check if container already running
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q futurator-memgraph; then
    echo "[OK] Memgraph container already running"
    docker ps --filter name=futurator-memgraph --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
  else
    echo "[DEPLOY] Starting Memgraph container..."
    docker compose up -d
    echo "[OK] Memgraph container started"

    # Wait for Memgraph to be ready
    echo "[WAIT] Waiting for Memgraph to accept connections..."
    for i in $(seq 1 30); do
      if docker exec futurator-memgraph mgconsole --command "RETURN 1;" &>/dev/null 2>&1; then
        echo "[OK] Memgraph is ready (attempt ${i})"
        break
      fi
      if [ "$i" -eq 30 ]; then
        echo "[WARN] Memgraph not responding after 30s — check logs: docker logs futurator-memgraph"
      fi
      sleep 1
    done
  fi

  # Verify port is listening
  if ss -tlnp 2>/dev/null | grep -q ":7687"; then
    echo "[OK] Port 7687 (Bolt) is listening"
  else
    echo "[WARN] Port 7687 not detected — Memgraph may still be starting"
  fi

  # Show container stats
  echo ""
  echo "Container details:"
  docker inspect futurator-memgraph --format \
    'Name: {{.Name}}
Image: {{.Config.Image}}
Status: {{.State.Status}}
RestartPolicy: {{.HostConfig.RestartPolicy.Name}}
MemoryLimit: {{.HostConfig.Memory}}
Ports: {{range $p, $conf := .NetworkSettings.Ports}}{{$p}} -> {{(index $conf 0).HostPort}} {{end}}' 2>/dev/null || true
}

# ── Task 4: Setup scripts directory ─────────────────────────────────

setup_scripts() {
  echo ""
  echo "=== Setting up scripts directory ==="

  mkdir -p "${SCRIPTS_DIR}"

  # Initialize package.json if not present
  if [ ! -f "${SCRIPTS_DIR}/package.json" ]; then
    echo "[SETUP] Initializing scripts package.json..."
    cd "${SCRIPTS_DIR}"
    cat > package.json << 'PKGJSON'
{
  "name": "futurator-scripts",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "Mycelium knowledge graph utility scripts",
  "scripts": {
    "test-memgraph": "node test-memgraph.mjs"
  },
  "dependencies": {
    "neo4j-driver": "^5.27.0"
  }
}
PKGJSON
    npm install --silent 2>/dev/null || npm install
    echo "[OK] Scripts package.json created and dependencies installed"
  else
    echo "[OK] Scripts package.json already exists"
    # Ensure neo4j-driver is installed
    cd "${SCRIPTS_DIR}"
    if [ ! -d "node_modules/neo4j-driver" ]; then
      npm install --silent 2>/dev/null || npm install
    fi
  fi

  # Copy test script if not present or update it
  if [ -f "${SCRIPT_DIR}/../scripts/test-memgraph.mjs" ]; then
    cp "${SCRIPT_DIR}/../scripts/test-memgraph.mjs" "${SCRIPTS_DIR}/test-memgraph.mjs"
    echo "[OK] test-memgraph.mjs deployed"
  else
    echo "[WARN] test-memgraph.mjs not found in repo scripts dir"
  fi
}

# ── Task 4 continued: Run connection test ────────────────────────────

run_test() {
  echo ""
  echo "=== Running Memgraph connection test ==="

  cd "${SCRIPTS_DIR}"
  if [ -f "test-memgraph.mjs" ]; then
    node test-memgraph.mjs
  else
    echo "[SKIP] test-memgraph.mjs not found"
  fi
}

# ── Task 5: Initialize schema (Story MY-1.2) ─────────────────────────

init_schema() {
  echo ""
  echo "=== Initializing Memgraph schema ==="

  cd "${SCRIPTS_DIR}"
  if [ -f "init-memgraph.mjs" ]; then
    node init-memgraph.mjs
  else
    echo "[SKIP] init-memgraph.mjs not found — run Story MY-1.2 first"
  fi
}

# ── Main ─────────────────────────────────────────────────────────────

install_docker
deploy_memgraph
setup_scripts
run_test
init_schema

echo ""
echo "=== Setup Complete ==="
echo "Memgraph Bolt endpoint: bolt://localhost:7687"
echo "Memgraph monitoring:    http://localhost:7444"
echo ""
echo "Next steps:"
echo "  - Run init-wiki.sh to set up wiki directory structure"
echo "  - Run graph-sync.mjs to sync knowledge to Memgraph"
