#!/usr/bin/env bash
# =============================================================================
# stop.sh — Stop all KubePilot clusters and monitoring port-forwards
#
# Usage:
#   ./scripts/stop.sh [--delete]
#
# Options:
#   --delete   Fully delete all minikube profiles (destructive — loses all data)
# =============================================================================
set -euo pipefail

DELETE=false
for arg in "$@"; do
  [[ "${arg}" == "--delete" ]] && DELETE=true
done

RED='\033[0;31m'; GRN='\033[0;32m'; YLW='\033[1;33m'
BLU='\033[0;34m'; NC='\033[0m'; BOLD='\033[1m'

log()     { echo -e "${BLU}[stop]${NC} $*"; }
ok()      { echo -e "${GRN}  ✓${NC}  $*"; }
warn()    { echo -e "${YLW}  ⚠${NC}  $*"; }
section() { echo -e "\n${BOLD}${BLU}━━━ $* ━━━${NC}"; }

PROFILES=("minikube" "cluster2" "staging-cluster")

# ── Kill port-forwards ────────────────────────────────────────────────────────
section "Port-Forwards"
if pkill -f "kubectl port-forward" 2>/dev/null; then
  ok "Port-forward processes terminated"
else
  warn "No port-forward processes found"
fi

# ── Stop / delete clusters ────────────────────────────────────────────────────
section "Clusters"

for profile in "${PROFILES[@]}"; do
  status=$(minikube status --profile "${profile}" --format "{{.Host}}" 2>/dev/null || echo "NotFound")

  if [[ "${status}" == "NotFound" || -z "${status}" ]]; then
    warn "${profile} — not found, skipping"
    continue
  fi

  if [[ "${DELETE}" == "true" ]]; then
    log "Deleting ${profile}..."
    minikube delete --profile "${profile}" &>/dev/null
    ok "${profile} deleted"
  else
    log "Stopping ${profile}..."
    minikube stop --profile "${profile}" &>/dev/null
    ok "${profile} stopped"
  fi
done

echo ""
if [[ "${DELETE}" == "true" ]]; then
  echo -e "  All clusters ${RED}deleted${NC}. Run ${BOLD}./scripts/start.sh${NC} to recreate them."
else
  echo -e "  All clusters stopped. Run ${BOLD}./scripts/start.sh${NC} to restart."
fi
echo ""
