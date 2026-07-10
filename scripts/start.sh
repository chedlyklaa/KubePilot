#!/usr/bin/env bash
# =============================================================================
# start.sh — Start all KubePilot clusters and monitoring stack
#
# Starts three minikube profiles (minikube, cluster2, staging-cluster),
# installs Prometheus + Grafana on the main minikube cluster, and opens
# port-forwards for the dashboard .env to consume.
#
# Usage:
#   chmod +x scripts/start.sh
#   ./scripts/start.sh [--no-monitoring] [--no-test-pods] [--skip-existing]
#
# Options:
#   --no-monitoring   Skip Prometheus + Grafana installation
#   --no-test-pods    Skip deploying test workloads on minikube
#   --skip-existing   Skip clusters that are already Running (faster restarts)
# =============================================================================
set -euo pipefail

# ── Flags ────────────────────────────────────────────────────────────────────
INSTALL_MONITORING=true
DEPLOY_TEST_PODS=true
SKIP_EXISTING=false

for arg in "$@"; do
  case $arg in
    --no-monitoring)  INSTALL_MONITORING=false ;;
    --no-test-pods)   DEPLOY_TEST_PODS=false   ;;
    --skip-existing)  SKIP_EXISTING=true        ;;
  esac
done

# ── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GRN='\033[0;32m'; YLW='\033[1;33m'
BLU='\033[0;34m'; CYN='\033[0;36m'; DIM='\033[2m'; NC='\033[0m'
BOLD='\033[1m'

log()     { echo -e "${BLU}[start]${NC} $*"; }
ok()      { echo -e "${GRN}  ✓${NC}  $*"; }
warn()    { echo -e "${YLW}  ⚠${NC}  $*"; }
err()     { echo -e "${RED}  ✗${NC}  $*"; }
info()    { echo -e "${CYN}  ℹ${NC}  $*"; }
section() { echo -e "\n${BOLD}${BLU}━━━ $* ━━━${NC}"; }
sep()     { echo -e "${DIM}────────────────────────────────────────────────${NC}"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ── Prerequisites check ───────────────────────────────────────────────────────
section "Prerequisites"

check_cmd() {
  if command -v "$1" &>/dev/null; then
    ok "$1 $(${2:-$1 version --short 2>/dev/null | head -1} 2>/dev/null || echo 'found')"
  else
    err "$1 not found — please install it first"
    exit 1
  fi
}

check_cmd minikube "minikube version --short"
check_cmd kubectl   "kubectl version --client --short"
check_cmd helm      "helm version --short"

# ── Qdrant (vector store) ─────────────────────────────────────────────────────
# Started early and independently of the minikube/Helm steps below — it has no
# Kubernetes dependency, and we don't want a slow/failed cluster or Helm install
# (which can hit `set -e` and abort the script) to prevent Qdrant from starting.
section "Qdrant"

QDRANT_CONTAINER="qdrant"
QDRANT_PORT=6333
QDRANT_LOG="${ROOT_DIR}/.pf-logs/qdrant-start.log"
mkdir -p "${ROOT_DIR}/.pf-logs"

if ! command -v docker &>/dev/null; then
  warn "docker not found — skipping Qdrant startup (set QDRANT_URL to an external instance)"
elif ! docker info &>/dev/null; then
  err "Docker daemon not reachable — is Docker Desktop running?"
  warn "  Start Docker Desktop, then re-run this script (Qdrant startup skipped)"
else
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${QDRANT_CONTAINER}$"; then
    ok "Qdrant already running (container: ${QDRANT_CONTAINER})"
  elif docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q "^${QDRANT_CONTAINER}$"; then
    log "Starting existing Qdrant container (${QDRANT_CONTAINER})..."
    if docker start "${QDRANT_CONTAINER}" >"${QDRANT_LOG}" 2>&1; then
      ok "Qdrant container started"
    else
      err "Failed to start Qdrant container — see ${QDRANT_LOG}"
      tail -20 "${QDRANT_LOG}" || true
    fi
  else
    log "No existing '${QDRANT_CONTAINER}' container found — creating one (port ${QDRANT_PORT})..."
    if docker run -d \
      --name "${QDRANT_CONTAINER}" \
      -p "${QDRANT_PORT}:6333" \
      -p 6334:6334 \
      --restart unless-stopped \
      qdrant/qdrant:latest \
      >"${QDRANT_LOG}" 2>&1; then
      ok "Qdrant container created"
    else
      err "Failed to start Qdrant container — see ${QDRANT_LOG}"
      tail -20 "${QDRANT_LOG}" || true
    fi
  fi
fi

# ── Cluster definitions ───────────────────────────────────────────────────────
# Each entry: "profile|cpus|memory|disk"
CLUSTERS=(
  "minikube|4|4096|20g"
  "cluster2|2|2048|10g"
  "staging-cluster|2|2048|10g"
  "cluster3|2|2048|10g"
)

# ── Helper: start one minikube profile ────────────────────────────────────────
start_cluster() {
  local profile="$1" cpus="$2" memory="$3" disk="$4"

  local status
  status=$(minikube status --profile "${profile}" -o json 2>/dev/null \
           | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('Host',''))" 2>/dev/null \
           || echo "")

  if [[ "${status}" == "Running" ]]; then
    if [[ "${SKIP_EXISTING}" == "true" ]]; then
      ok "${profile} already running — skipped (--skip-existing)"
      return
    fi
    ok "${profile} already running"
    return
  fi

  if [[ "${status}" == "Stopped" || "${status}" == "Paused" ]]; then
    log "Resuming ${profile}..."
    minikube start --profile "${profile}" 2>&1 | tail -3
  else
    log "Starting ${profile} (${cpus} CPUs, ${memory} RAM, ${disk} disk)..."
    minikube start \
      --profile      "${profile}" \
      --cpus         "${cpus}"    \
      --memory       "${memory}"  \
      --disk-size    "${disk}"    \
      --driver       docker       \
      2>&1 | tail -5
  fi

  # Enable addons needed for the KubePilot stack
  log "Enabling addons on ${profile}..."
  minikube addons enable metrics-server --profile "${profile}" &>/dev/null || true
  minikube addons enable ingress         --profile "${profile}" &>/dev/null || true

  ok "${profile} started"
}

# ── Start all clusters ────────────────────────────────────────────────────────
section "Starting Clusters"

for entry in "${CLUSTERS[@]}"; do
  IFS='|' read -r profile cpus memory disk <<< "${entry}"
  sep
  echo -e "${CYN}▶ ${profile}${NC}"
  start_cluster "${profile}" "${cpus}" "${memory}" "${disk}"
done

# ── Verify all contexts exist in kubeconfig ───────────────────────────────────
section "Kubeconfig Contexts"

for entry in "${CLUSTERS[@]}"; do
  IFS='|' read -r profile _ <<< "${entry}"
  if kubectl config get-contexts "${profile}" &>/dev/null; then
    ok "context '${profile}' available"
  else
    warn "context '${profile}' missing — trying to update kubeconfig"
    minikube update-context --profile "${profile}" 2>/dev/null || true
  fi
done

# ── Switch active context to minikube (main cluster) ─────────────────────────
kubectl config use-context minikube &>/dev/null
ok "active context → minikube"

# ── Install Prometheus + Grafana on minikube ──────────────────────────────────
if [[ "${INSTALL_MONITORING}" == "true" ]]; then
  section "Monitoring Stack (minikube)"

  NAMESPACE="monitoring"
  RELEASE="kube-prometheus-stack"
  CHART="prometheus-community/kube-prometheus-stack"
  VALUES_FILE="${ROOT_DIR}/config/grafana-values.yaml"

  # Ensure we are on the minikube context before touching the cluster
  kubectl config use-context minikube
  ok "context pinned → minikube"

  # Add / update Helm repo
  log "Updating prometheus-community Helm repo..."
  helm repo add prometheus-community https://prometheus-community.github.io/helm-charts 2>/dev/null || true
  helm repo update 2>/dev/null
  ok "Helm repo ready"

  # Create namespace — explicit check then create, no silent failures
  if kubectl get namespace "${NAMESPACE}" &>/dev/null; then
    ok "namespace '${NAMESPACE}' already exists"
  else
    kubectl create namespace "${NAMESPACE}"
    ok "namespace '${NAMESPACE}' created"
  fi

  # Check if already installed
  CURRENT_REVISION=$(helm list -n "${NAMESPACE}" -q 2>/dev/null | grep -c "^${RELEASE}$" || echo 0)

  HELM_ARGS=(
    --namespace  "${NAMESPACE}"
    --set "prometheus.service.type=NodePort"
    --set "prometheus.prometheusSpec.scrapeInterval=30s"
    --set "grafana.adminPassword=kubepilot"
    --set "grafana.service.type=NodePort"
    --set "grafana.defaultDashboardsEnabled=true"
    --set "defaultRules.create=true"
    --set "alertmanager.enabled=false"
    --set "kubeControllerManager.enabled=false"
    --set "kubeScheduler.enabled=false"
    --timeout 10m
    --wait
  )

  # Apply custom grafana dashboards from values file if it exists
  if [[ -f "${VALUES_FILE}" ]]; then
    HELM_ARGS+=(-f "${VALUES_FILE}")
    ok "Using custom Grafana values from config/grafana-values.yaml"
  fi

  if [[ "${CURRENT_REVISION}" -gt 0 ]]; then
    log "Upgrading existing ${RELEASE} installation..."
  else
    log "Installing ${RELEASE} (this takes 3–8 minutes on first run)..."
  fi

  helm upgrade --install "${RELEASE}" "${CHART}" "${HELM_ARGS[@]}"

  # Wait for all monitoring pods
  log "Waiting for monitoring pods to be ready..."
  kubectl wait --for=condition=ready pod \
    -l "app.kubernetes.io/instance=${RELEASE}" \
    -n "${NAMESPACE}" \
    --timeout=300s

  ok "Monitoring stack running"
  kubectl get pods -n "${NAMESPACE}" --no-headers \
    | awk '{printf "     %-45s %s\n", $1, $3}'
fi

# ── Deploy test workloads on minikube ─────────────────────────────────────────
if [[ "${DEPLOY_TEST_PODS}" == "true" ]]; then
  section "Test Workloads (minikube)"

  if [[ -f "${SCRIPT_DIR}/reset-test-pods.sh" ]]; then
    kubectl config use-context minikube &>/dev/null
    log "Deploying test pods across namespaces..."
    bash "${SCRIPT_DIR}/reset-test-pods.sh"
  else
    warn "reset-test-pods.sh not found — skipping test workloads"
  fi
fi

# ── Port-forwards ─────────────────────────────────────────────────────────────
section "Port-Forwards"

LOG_DIR="${ROOT_DIR}/.pf-logs"
mkdir -p "${LOG_DIR}"

# Kill any stale port-forward processes from a previous run
pkill -f "kubectl port-forward.*monitoring" 2>/dev/null || true
sleep 1

# pf_watch SERVICE LOCAL_PORT SVC_PORT LABEL LOG_FILE
# Runs a self-restarting port-forward in the background.
pf_watch() {
  local svc="$1" local_port="$2" svc_port="$3" ns="$4" logfile="$5"
  (
    while true; do
      kubectl port-forward "${svc}" -n "${ns}" "${local_port}:${svc_port}" \
        >> "${logfile}" 2>&1
      # If it exits for any reason (pod restart, lost connection), wait briefly
      # then reconnect — this handles the Grafana init-restart silently.
      sleep 2
    done
  ) &
  echo $!
}

# Wait for a local port to accept TCP connections (max N seconds)
wait_port() {
  local port="$1" label="$2" timeout="${3:-30}"
  local i=0
  while ! bash -c "echo >/dev/tcp/localhost/${port}" 2>/dev/null; do
    (( i++ ))
    if (( i >= timeout )); then
      warn "${label} did not respond on :${port} after ${timeout}s"
      warn "  Check logs: ${LOG_DIR}/${label}.log"
      return 1
    fi
    sleep 1
  done
  return 0
}

if [[ "${INSTALL_MONITORING}" == "true" ]]; then
  RELEASE="kube-prometheus-stack"
  NAMESPACE="monitoring"

  log "Starting Prometheus port-forward (9090) — auto-restarting..."
  PROM_PID=$(pf_watch "svc/${RELEASE}-prometheus" 9090 9090 "${NAMESPACE}" "${LOG_DIR}/prometheus.log")

  log "Starting Grafana port-forward (3000) — auto-restarting..."
  GRAF_PID=$(pf_watch "svc/${RELEASE}-grafana" 3000 80 "${NAMESPACE}" "${LOG_DIR}/grafana.log")

  log "Waiting for services to accept connections..."
  if wait_port 9090 "prometheus" 30; then
    ok "Prometheus  → http://localhost:9090  (pid ${PROM_PID})"
  fi
  if wait_port 3000 "grafana" 40; then
    ok "Grafana     → http://localhost:3000  (pid ${GRAF_PID})"
    info "Login: admin / kubepilot"
  fi
fi

# ── Qdrant connectivity check ─────────────────────────────────────────────────
# The container itself was already started in the Prerequisites section above,
# before anything that could trip `set -e` and abort the script early.
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${QDRANT_CONTAINER}$"; then
  log "Waiting for Qdrant to accept connections..."
  if wait_port "${QDRANT_PORT}" "qdrant" 30; then
    ok "Qdrant      → http://localhost:${QDRANT_PORT}  (container: ${QDRANT_CONTAINER})"
  fi
fi

# ── Cluster status summary ────────────────────────────────────────────────────
section "Cluster Status"

for entry in "${CLUSTERS[@]}"; do
  IFS='|' read -r profile _ <<< "${entry}"
  status=$(minikube status --profile "${profile}" --format "{{.Host}}" 2>/dev/null || echo "Unknown")
  ip=$(minikube ip --profile "${profile}" 2>/dev/null || echo "—")
  if [[ "${status}" == "Running" ]]; then
    ok "${profile}   ${GRN}${status}${NC}   ip=${ip}"
  else
    warn "${profile}   ${status}"
  fi
done

# ── .env reminder ─────────────────────────────────────────────────────────────
section "Environment"
echo ""
echo -e "  Add / verify these in your ${BOLD}.env${NC}:"
echo ""
echo -e "  ${DIM}PROMETHEUS_URL${NC}=http://localhost:9090"
echo -e "  ${DIM}GRAFANA_URL${NC}=http://localhost:3000"
echo -e "  ${DIM}QDRANT_URL${NC}=http://localhost:6333"
echo ""
echo -e "  Grafana login: ${BOLD}admin / kubepilot${NC}"
echo -e "  Qdrant UI:     ${BOLD}http://localhost:6333/dashboard${NC}"
echo ""
echo -e "  Cluster contexts registered:"
for entry in "${CLUSTERS[@]}"; do
  IFS='|' read -r profile _ <<< "${entry}"
  echo -e "    ${CYN}${profile}${NC}"
done
echo ""

# ── Stop helper reminder ──────────────────────────────────────────────────────
sep
echo -e "  To stop everything:  ${DIM}./scripts/stop.sh${NC}"
echo -e "  To reset test pods:  ${DIM}./scripts/reset-test-pods.sh${NC}"
echo ""
