#!/usr/bin/env bash
# Exercises the live RBAC watch (src/services/rbacWatcher.js) end to end against a
# real cluster: create a binding, patch it to multi-subject, delete it — and (if
# KUBEPILOT_EMAIL/KUBEPILOT_PASSWORD are set) verify each step shows up via the API
# the dashboard's RbacSyncPage uses. Requires the KubePilot backend already running
# (`npm start`) and a reachable kubeconfig context (the watch needs the same cluster
# access `kubectl` does).
#
# Usage:
#   ./scripts/test-rbac-watch.sh
#   CONTEXT=cluster3 CLUSTER_NAME=cluster3 KUBEPILOT_EMAIL=you@x.com KUBEPILOT_PASSWORD=... ./scripts/test-rbac-watch.sh

set -euo pipefail

CONTEXT="${CONTEXT:-minikube}"
CLUSTER_NAME="${CLUSTER_NAME:-minikube}"
API_BASE="${API_BASE:-http://localhost:3000}"
TEST_EMAIL="${TEST_EMAIL:-testwatch@example.com}"
TEST_EMAIL_2="${TEST_EMAIL_2:-testwatch2@example.com}"
BINDING_NAME="kp-test-watch"
TOKEN=""

log()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$1"; }
ok()   { printf '  \033[1;32m✓ %s\033[0m\n' "$1"; }
warn() { printf '  \033[1;33m! %s\033[0m\n' "$1"; }

cleanup() {
  log "Cleanup: deleting $BINDING_NAME from $CONTEXT (ignore-not-found)"
  kubectl --context "$CONTEXT" delete clusterrolebinding "$BINDING_NAME" --ignore-not-found >/dev/null 2>&1 || true
}
trap cleanup EXIT

log "1. Checking kubectl access to context \"$CONTEXT\""
if ! kubectl --context "$CONTEXT" get clusterrolebindings >/dev/null 2>&1; then
  echo "kubectl cannot reach context \"$CONTEXT\" — the watch needs the same access. Aborting." >&2
  exit 1
fi
ok "kubectl reaches $CONTEXT"

log "2. Checking KubePilot API is up at $API_BASE"
if ! curl -sf -o /dev/null "$API_BASE/api/auth/me" -H "Authorization: Bearer invalid" --max-time 3 2>/dev/null; then
  # 401 is expected (bad token) — curl -f treats 401 as failure, so probe differently
  code=$(curl -s -o /dev/null -w '%{http_code}' "$API_BASE/api/auth/me" --max-time 3 || echo 000)
  if [ "$code" = "000" ]; then
    echo "No response from $API_BASE — start the backend first (npm start). Aborting." >&2
    exit 1
  fi
fi
ok "API reachable ($API_BASE)"

if [ -n "${KUBEPILOT_EMAIL:-}" ] && [ -n "${KUBEPILOT_PASSWORD:-}" ]; then
  log "3. Logging in as $KUBEPILOT_EMAIL"
  LOGIN_RESP=$(curl -s -X POST "$API_BASE/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$KUBEPILOT_EMAIL\",\"password\":\"$KUBEPILOT_PASSWORD\"}")
  TOKEN=$(printf '%s' "$LOGIN_RESP" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).token ?? ""' 2>/dev/null || echo "")
  if [ -z "$TOKEN" ]; then
    warn "Login failed, continuing without API verification: $LOGIN_RESP"
  else
    ok "Logged in, token acquired"
  fi
else
  warn "KUBEPILOT_EMAIL/KUBEPILOT_PASSWORD not set — will skip pending-changes/advisories API checks"
  warn "(re-run with those env vars, or just watch RbacSyncPage in the dashboard during this script)"
fi

api_get() {
  [ -n "$TOKEN" ] || return 0
  curl -s "$API_BASE$1" -H "Authorization: Bearer $TOKEN"
}

show_pending() {
  [ -n "$TOKEN" ] || { warn "(skipped: no token) check RbacSyncPage in the dashboard"; return; }
  api_get "/api/rbac/pending-changes" | node -pe '
    const d = JSON.parse(require("fs").readFileSync(0,"utf8"));
    const c = d.clusters.find(c => c.context === process.env.CONTEXT);
    JSON.stringify(c ? c.pending : d, null, 2)'
}

show_advisories() {
  [ -n "$TOKEN" ] || { warn "(skipped: no token) check RbacSyncPage in the dashboard"; return; }
  api_get "/api/rbac/multi-subject-advisories" | node -pe 'JSON.stringify(JSON.parse(require("fs").readFileSync(0,"utf8")).advisories, null, 2)'
}

log "4. Creating ClusterRoleBinding \"$BINDING_NAME\" (view → $TEST_EMAIL) on $CONTEXT"
kubectl --context "$CONTEXT" create clusterrolebinding "$BINDING_NAME" \
  --clusterrole=view --user="$TEST_EMAIL" >/dev/null
ok "Created"
sleep 2
log "   → pending-changes should now show an ADDED entry for $TEST_EMAIL"
show_pending

log "5. Patching binding to add a second User subject ($TEST_EMAIL_2) — tests multi-subject advisory path"
kubectl --context "$CONTEXT" patch clusterrolebinding "$BINDING_NAME" --type=json \
  -p="[{\"op\":\"add\",\"path\":\"/subjects/-\",\"value\":{\"kind\":\"User\",\"name\":\"$TEST_EMAIL_2\",\"apiGroup\":\"rbac.authorization.k8s.io\"}}]" >/dev/null
ok "Patched"
sleep 2
log "   → pending-changes should NO LONGER list $TEST_EMAIL (binding is now ambiguous)"
show_pending
log "   → multi-subject-advisories should now list \"$BINDING_NAME\" with both users"
show_advisories

log "6. Deleting binding — DELETED events are unambiguous, should go straight to pending-changes"
kubectl --context "$CONTEXT" delete clusterrolebinding "$BINDING_NAME" >/dev/null
ok "Deleted"
sleep 2
log "   → pending-changes should show DELETED entries for both $TEST_EMAIL and $TEST_EMAIL_2"
show_pending
log "   → multi-subject-advisories should be empty again for this binding"
show_advisories

log "Done. Check the backend console for [RBAC-WATCH] logs confirming no reconnects happened during the test."
