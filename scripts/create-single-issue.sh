#!/usr/bin/env bash
# scripts/create-single-issue.sh — deploys THREE broken workloads at once, one per
# stage of reset-test-pods.sh's own AUTO / APPROVAL / ESCALATE categorization, then
# live-follows the v5 pipeline's decision trace for all three pods until each resolves.
#
# Since they land in the SAME namespace, the orchestrator's namespace-grouped dispatch
# will very likely bundle all three into ONE workflow (one workflowId investigating/
# planning for the group) rather than three separate ones — a good exercise of the
# multi-issue-group path, not just the single-issue path. trace-cli.js still shows each
# pod's own slice of that shared trace correctly either way.
#
#   web-app     — same shape as [B] payment-gateway: healthy deployment patched to a
#     non-existent image tag -> ImagePullBackOff. One unambiguous fix (roll the image
#     back) -> expect Guardian APPROVE, no human approval, resolves on its own.
#
#   memory-pod  — same shape as [C] ml-inference / [J] worker-pool: healthy deployment
#     patched to a memory limit lower than the workload actually needs -> OOMKilled.
#     Real fix exists (raise the limit) but reset-test-pods.sh documents this exact
#     shape as APPROVAL-required (increase_memory) -> expect it in the dashboard's
#     approval queue, not resolved on its own.
#
#   secret-app  — same shape as [D] notification-svc: an initContainer that hard-fails
#     unless a specific Secret is mounted, and that Secret is never created. No
#     legitimate kubectl action can fabricate real secret material -> expect escalation
#     to a human after MAX_FIX_ATTEMPTS.
#
# Requires the KubePilot server (node index.js / npm run dev) to already be running
# against the target context, with TRACE_ENABLED=true (the default) so
# src/monitoring/incidentTracer.js is actually writing ./logs/<workflowId>.jsonl.
#
# Usage:
#   ./scripts/create-single-issue.sh [context] [namespace]
#   ./scripts/create-single-issue.sh minikube single-issue-test
#   ./scripts/create-single-issue.sh cluster2  single-issue-test
#
#   ./scripts/create-single-issue.sh minikube single-issue-test --clean   # remove all three
set -euo pipefail

# Keeps the window open after the script ends for ANY reason (success, error, or
# Ctrl+C) — otherwise a double-clicked .sh (or a window whose shell exits on script
# end) closes instantly and you never see the final output. Only prompts when stdin
# is an actual terminal, so this stays a no-op if the script is ever driven non-
# interactively (piped input, CI, etc.) instead of hanging forever on a `read`.
trap '[[ -t 0 ]] && read -rp "Press Enter to close this window..." _' EXIT

CTX="${1:-minikube}"
NS="${2:-single-issue-test}"
CLEAN="${3:-}"

kubectl config use-context "${CTX}" >/dev/null

if [[ "${CLEAN}" == "--clean" ]]; then
  echo "Deleting namespace/${NS} on context ${CTX}..."
  kubectl delete namespace "${NS}" --ignore-not-found
  exit 0
fi

kubectl create namespace "${NS}" --dry-run=client -o yaml | kubectl apply -f -

echo "Clearing any existing workloads in namespace/${NS} on context ${CTX}..."
kubectl delete deployments --all -n "${NS}" --ignore-not-found
kubectl delete secrets     --all -n "${NS}" --ignore-not-found
kubectl delete pods        --all -n "${NS}" --ignore-not-found --grace-period=0 --force

# ── [1/3] web-app — ImagePullBackOff (expect: AUTO-fix) ─────────────────────────
echo ""
echo "[1/3] Deploying web-app v1.0.0 (healthy) -> namespace/${NS}"
kubectl apply -n "${NS}" -f - <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-app
  annotations: { kubernetes.io/change-cause: "v1.0.0 stable" }
  labels: { tier: test }
spec:
  replicas: 1
  strategy: { type: Recreate } # one pod at a time — keeps "the pod" for this demo unambiguous
  selector: { matchLabels: { app: web-app } }
  template:
    metadata: { labels: { app: web-app } }
    spec:
      containers:
        - name: app
          image: nginx:1.25-alpine
          resources:
            requests: { memory: "32Mi",  cpu: "25m" }
            limits:   { memory: "128Mi", cpu: "200m" }
EOF
kubectl rollout status deployment/web-app -n "${NS}" --timeout=60s

echo "[1/3] Rolling out a bad image tag -> ImagePullBackOff (the actual incident)"
kubectl set image deployment/web-app app=nginx:v99.99.99-does-not-exist -n "${NS}"
kubectl annotate deployment/web-app kubernetes.io/change-cause="v1.1.0 broken" -n "${NS}" --overwrite

# ── [2/3] memory-pod — OOMKilled (expect: APPROVAL-required) ────────────────────
echo ""
echo "[2/3] Deploying memory-pod v1.0.0 (healthy, 256Mi limit) -> namespace/${NS}"
kubectl apply -n "${NS}" -f - <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: memory-pod
  annotations: { kubernetes.io/change-cause: "v1.0.0 stable — 256Mi limit" }
  labels: { tier: test }
spec:
  replicas: 1
  strategy: { type: Recreate } # one pod at a time — keeps "the pod" for this demo unambiguous
  selector: { matchLabels: { app: memory-pod } }
  template:
    metadata: { labels: { app: memory-pod } }
    spec:
      containers:
        - name: app
          image: polinux/stress:latest
          command: ["stress"]
          # Allocates a fixed ~150M and holds it — comfortably under the 256Mi limit
          # below, so this starts out genuinely healthy (Running, no restarts).
          args: ["--vm", "1", "--vm-bytes", "150M", "--vm-hang", "0"]
          resources:
            requests: { memory: "64Mi",  cpu: "50m" }
            limits:   { memory: "256Mi", cpu: "500m" }
EOF
kubectl rollout status deployment/memory-pod -n "${NS}" --timeout=60s

echo "[2/3] Lowering the memory limit to 50Mi — below the ~150M the workload actually needs -> OOMKilled (the actual incident)"
# --requests must drop alongside --limits in the SAME call — the API server rejects a
# limit lower than the existing request (confirmed live, 2026-09-09: leaving requests at
# the stage-1 64Mi while only lowering --limits to 50Mi fails validation outright with
# "must be less than or equal to memory limit of 50Mi", aborting the script via set -e
# before this incident was ever actually created).
kubectl set resources deployment/memory-pod -n "${NS}" -c app --limits=memory=50Mi --requests=memory=32Mi
kubectl annotate deployment/memory-pod kubernetes.io/change-cause="v1.1.0 broken — 50Mi limit, needs ~150Mi" -n "${NS}" --overwrite

# ── [3/3] secret-app — missing Secret (expect: ESCALATION) ──────────────────────
echo ""
echo "[3/3] Deploying secret-app -> namespace/${NS} (no Secret created — intentional)"
# No Recreate/rollout-status wait here: unlike the other two, this one is broken from
# the very first apply (the initContainer fails immediately, every time, until a human
# creates the missing Secret) — there is no healthy "v1.0.0" stage.
kubectl apply -n "${NS}" -f - <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: secret-app
  labels: { tier: test }
spec:
  replicas: 1
  selector: { matchLabels: { app: secret-app } }
  template:
    metadata: { labels: { app: secret-app } }
    spec:
      initContainers:
        - name: check-secrets
          image: busybox:1.36
          command: ["sh", "-c"]
          args:
            - |
              echo "[secret-app] Checking SMTP credentials..."
              test -f /secrets/smtp-api-key || \
                (echo "FATAL: /secrets/smtp-api-key not found. Deploy aborted."; exit 1)
          volumeMounts:
            - name: smtp-secret
              mountPath: /secrets
      containers:
        - name: app
          image: nginx:1.25-alpine
          resources:
            requests: { memory: "32Mi",  cpu: "25m" }
            limits:   { memory: "128Mi", cpu: "200m" }
      volumes:
        - name: smtp-secret
          secret:
            secretName: smtp-credentials
EOF

echo ""
echo "Waiting for all three broken pods to be scheduled..."
APPS=(web-app memory-pod secret-app)
declare -A PODS
for APP in "${APPS[@]}"; do
  POD=""
  for i in $(seq 1 30); do
    POD=$(kubectl --context "${CTX}" get pods -n "${NS}" -l app="${APP}" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
    [[ -n "${POD}" ]] && break
    sleep 1
  done
  if [[ -z "${POD}" ]]; then
    echo "Pod for ${APP} never appeared after 30s — check: kubectl --context ${CTX} get pods -n ${NS} -l app=${APP}"
    exit 1
  fi
  PODS["${APP}"]="${POD}"
  echo "  ${APP} -> ${NS}/${POD}"
done

echo ""
echo "Waiting for the orchestrator to pick these up (next fleet cycle) and following all"
echo "three live — Ctrl+C to stop at any time. Full raw log: logs/<workflowId>.jsonl"
echo "(they'll likely all land in ONE namespace-grouped workflow, not three separate ones)"
echo ""
sleep 2

# Ctrl+C stops the follow loop gracefully (falls through to the pause below) instead
# of killing the whole script/window outright, so the window stays open either way.
INTERRUPTED=0
trap 'INTERRUPTED=1' INT

# Live-follows all three pods' traces by re-rendering trace-cli's timeline for each one
# every few seconds — reuses scripts/trace-cli.js directly instead of re-implementing a
# JSONL reader here, so the two stay in sync. Stops once every pod's rendered output has
# hit a REFLECTOR line (the pipeline's terminal step — fixed/blocked/escalated).
while [[ "${INTERRUPTED}" == "0" ]]; do
  printf '\033c' # clear screen between refreshes
  ALL_DONE=1
  for APP in "${APPS[@]}"; do
    POD="${PODS[$APP]}"
    OUTPUT=$(node scripts/trace-cli.js pod "${NS}/${POD}" 2>&1)
    echo "${OUTPUT}"
    echo ""
    echo "${OUTPUT}" | grep -q "REFLECTOR" || ALL_DONE=0
  done
  echo "(refreshing every 3s — Ctrl+C to stop)"
  if [[ "${ALL_DONE}" == "1" ]]; then
    echo ""
    echo "All three pods reached a terminal outcome."
    break
  fi
  sleep 3 || true
done

echo ""
echo "Clean up afterward:"
echo "  ./scripts/create-single-issue.sh ${CTX} ${NS} --clean"
