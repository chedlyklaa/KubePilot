#!/usr/bin/env bash
# Deploy three broken workloads in one namespace and follow the pipeline trace for each pod
#
# Usage: ./scripts/create-single-issue.sh [context] [namespace] [--clean]
set -euo pipefail

# Keep the window open when the script exits
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

# [1/3] web-app — ImagePullBackOff (expect: AUTO-fix)
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

# [2/3] memory-pod — OOMKilled (expect: APPROVAL-required)
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
# Lower requests and limits together
kubectl set resources deployment/memory-pod -n "${NS}" -c app --limits=memory=50Mi --requests=memory=32Mi
kubectl annotate deployment/memory-pod kubernetes.io/change-cause="v1.1.0 broken — 50Mi limit, needs ~150Mi" -n "${NS}" --overwrite

# [3/3] secret-app — missing Secret (expect: ESCALATION)
echo ""
echo "[3/3] Deploying secret-app -> namespace/${NS} (no Secret created — intentional)"
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

# Stop following on Ctrl+C
INTERRUPTED=0
trap 'INTERRUPTED=1' INT

# Follow each pod's trace until it reaches a terminal step
while [[ "${INTERRUPTED}" == "0" ]]; do
  printf '\033c'
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
