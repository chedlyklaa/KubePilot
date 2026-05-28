#!/usr/bin/env bash
# reset-test-pods.sh
# Cleans ALL existing test deployments from the default namespace,
# then recreates 6 broken scenarios to test every agent code path.
#
# Usage:  ./scripts/reset-test-pods.sh

set -euo pipefail

NS="default"
CTX="minikube"

RED='\033[0;31m'; GRN='\033[0;32m'; YLW='\033[1;33m'; BLU='\033[0;34m'; NC='\033[0m'
log()  { echo -e "${BLU}[reset]${NC} $*"; }
ok()   { echo -e "${GRN}[ok]${NC}    $*"; }
warn() { echo -e "${YLW}[warn]${NC}  $*"; }
sep()  { echo -e "${BLU}──────────────────────────────────────────────────${NC}"; }

kubectl config use-context "${CTX}" >/dev/null

# ─── 1. Wipe ALL existing deployments and bare pods in default ────────────────
sep
log "Deleting all existing deployments in namespace '${NS}'…"

# Delete known old test deployments
for dep in broken-service oom-service crash-transient bad-image-deploy oom-victim \
           config-missing bad-command over-replicated; do
  kubectl delete deployment "${dep}" -n "${NS}" --ignore-not-found=true 2>/dev/null && \
    warn "  deleted deployment/${dep}" || true
done

# Delete any leftover bare pods
log "Deleting any leftover bare pods…"
kubectl delete pods --all -n "${NS}" --ignore-not-found=true 2>/dev/null || true

log "Waiting for pods to terminate…"
kubectl wait --for=delete pod --all -n "${NS}" --timeout=60s 2>/dev/null || true
ok "Namespace '${NS}' is clean"
sep

# ─── Helper ───────────────────────────────────────────────────────────────────
apply() { kubectl apply -n "${NS}" -f -; }

# ═══════════════════════════════════════════════════════════════════════════════
# [A] AUTO-FIX — CrashLoopBackOff transient crash
#     Agent action : restart   |  risk: LOW  |  no approval needed
# ═══════════════════════════════════════════════════════════════════════════════
echo -e "\n${GRN}[A] AUTO-FIX — CrashLoopBackOff (exit 1, transient)${NC}"
apply <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: crash-transient
spec:
  replicas: 1
  selector:
    matchLabels:
      app: crash-transient
  template:
    metadata:
      labels:
        app: crash-transient
    spec:
      containers:
        - name: app
          image: busybox:1.36
          command: ["sh", "-c", "echo 'starting'; sleep 2; exit 1"]
          resources:
            requests: { memory: "16Mi", cpu: "10m" }
            limits:   { memory: "32Mi", cpu: "50m" }
EOF
ok "crash-transient created"

# ═══════════════════════════════════════════════════════════════════════════════
# [B] AUTO-FIX — Bad image → rollback
#     Agent action : rollback  |  risk: MEDIUM  |  no approval needed
# ═══════════════════════════════════════════════════════════════════════════════
echo -e "\n${GRN}[B] AUTO-FIX — ImagePullBackOff (bad image tag → rollback)${NC}"

# Revision 1: healthy
apply <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: bad-image-deploy
  annotations:
    kubernetes.io/change-cause: "v1 healthy"
spec:
  replicas: 1
  selector:
    matchLabels:
      app: bad-image-deploy
  template:
    metadata:
      labels:
        app: bad-image-deploy
    spec:
      containers:
        - name: app
          image: nginx:1.25
          resources:
            requests: { memory: "16Mi", cpu: "10m" }
            limits:   { memory: "64Mi", cpu: "100m" }
EOF

kubectl rollout status deployment/bad-image-deploy -n "${NS}" --timeout=60s 2>/dev/null || true

# Revision 2: broken image tag
kubectl set image deployment/bad-image-deploy app=nginx:this-tag-does-not-exist -n "${NS}"
kubectl annotate deployment/bad-image-deploy kubernetes.io/change-cause="v2 broken" -n "${NS}" --overwrite
ok "bad-image-deploy set to broken image (needs rollback)"

# ═══════════════════════════════════════════════════════════════════════════════
# [C] NEEDS APPROVAL — OOMKilled → increase_memory
#     Agent action : increase_memory  |  HIGH_RISK → approval gate fires
# ═══════════════════════════════════════════════════════════════════════════════
echo -e "\n${YLW}[C] NEEDS APPROVAL — OOMKilled (memory limit 40Mi, allocates 200MB)${NC}"
apply <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: oom-victim
spec:
  replicas: 1
  selector:
    matchLabels:
      app: oom-victim
  template:
    metadata:
      labels:
        app: oom-victim
    spec:
      containers:
        - name: app
          image: polinux/stress:latest
          command: ["stress"]
          args: ["--vm", "1", "--vm-bytes", "200M", "--vm-hang", "0"]
          resources:
            requests: { memory: "20Mi", cpu: "10m" }
            limits:   { memory: "40Mi", cpu: "100m" }
EOF
ok "oom-victim created (will OOMKill → agent asks for approval)"

# ═══════════════════════════════════════════════════════════════════════════════
# [D] ESCALATE — Missing ConfigMap (init container always fails)
#     Agent tries restart/noop every cycle, never works → escalates after 3x
# ═══════════════════════════════════════════════════════════════════════════════
echo -e "\n${RED}[D] ESCALATE — Missing ConfigMap (init container crash, unresolvable)${NC}"
apply <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: config-missing
spec:
  replicas: 1
  selector:
    matchLabels:
      app: config-missing
  template:
    metadata:
      labels:
        app: config-missing
    spec:
      initContainers:
        - name: check-config
          image: busybox:1.36
          command: ["sh", "-c", "cat /config/app.properties || (echo 'FATAL: config missing'; exit 1)"]
          volumeMounts:
            - name: cfg
              mountPath: /config
      containers:
        - name: app
          image: nginx:1.25
          resources:
            requests: { memory: "16Mi", cpu: "10m" }
            limits:   { memory: "64Mi", cpu: "100m" }
      volumes:
        - name: cfg
          configMap:
            name: app-config-missing   # intentionally absent
EOF
ok "config-missing created (init always fails → escalates after 3 attempts)"

# ═══════════════════════════════════════════════════════════════════════════════
# [E] ESCALATE — Bad entrypoint (binary doesn't exist, no prior revision)
#     Agent tries rollback, fails every time → escalates
# ═══════════════════════════════════════════════════════════════════════════════
echo -e "\n${RED}[E] ESCALATE — Bad entrypoint (no rollback possible)${NC}"
apply <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: bad-command
spec:
  replicas: 1
  selector:
    matchLabels:
      app: bad-command
  template:
    metadata:
      labels:
        app: bad-command
    spec:
      containers:
        - name: app
          image: nginx:1.25
          command: ["/bin/this-binary-does-not-exist"]
          resources:
            requests: { memory: "16Mi", cpu: "10m" }
            limits:   { memory: "64Mi", cpu: "100m" }
EOF
ok "bad-command created (exec error on start → escalates)"

# ═══════════════════════════════════════════════════════════════════════════════
# [F] AUTO-FIX — Crash exit code 2 (bad config flag, not OOM)
#     Simulates a misconfigured flag passed to the app.
#     Agent action : restart  |  risk: LOW
# ═══════════════════════════════════════════════════════════════════════════════
echo -e "\n${GRN}[F] AUTO-FIX — CrashLoopBackOff exit 2 (bad config flag)${NC}"
apply <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: bad-config-flag
spec:
  replicas: 1
  selector:
    matchLabels:
      app: bad-config-flag
  template:
    metadata:
      labels:
        app: bad-config-flag
    spec:
      containers:
        - name: app
          image: busybox:1.36
          command: ["sh", "-c"]
          args: ["echo 'bad flag --unknown-option'; exit 2"]
          resources:
            requests: { memory: "16Mi", cpu: "10m" }
            limits:   { memory: "32Mi", cpu: "50m" }
EOF
ok "bad-config-flag created (exit 2 → restart)"

# ─── Summary ──────────────────────────────────────────────────────────────────
sep
echo ""
echo -e "${BLU}All 6 scenarios deployed in namespace '${NS}':${NC}"
echo ""
echo -e "  ${GRN}[A]${NC} crash-transient   — CrashLoopBackOff exit 1     → ${GRN}AUTO restart${NC}"
echo -e "  ${GRN}[B]${NC} bad-image-deploy  — ImagePullBackOff             → ${GRN}AUTO rollback${NC}"
echo -e "  ${YLW}[C]${NC} oom-victim        — OOMKilled (40Mi limit)       → ${YLW}APPROVAL required (increase_memory)${NC}"
echo -e "  ${RED}[D]${NC} config-missing    — Init crash, ConfigMap absent → ${RED}ESCALATE after 3 attempts${NC}"
echo -e "  ${RED}[E]${NC} bad-command       — Bad entrypoint               → ${RED}ESCALATE after 3 attempts${NC}"
echo -e "  ${GRN}[F]${NC} bad-config-flag   — CrashLoopBackOff exit 2     → ${GRN}AUTO restart${NC}"
echo ""
echo -e "${BLU}Watch:${NC}  kubectl get pods -n ${NS} -w"
echo ""
