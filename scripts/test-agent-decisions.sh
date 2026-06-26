#!/usr/bin/env bash
# =============================================================================
# test-agent-decisions.sh — Verify agent LLM decisions against known answers
#
# Creates pods with known failure modes, polls until the agent diagnoses them,
# then checks if the chosen action matches the expected correct answer.
#
# Usage:
#   ./scripts/test-agent-decisions.sh
#   ./scripts/test-agent-decisions.sh --context=cluster2 --timeout=180
# =============================================================================

# ── Defaults ────────────────────────────────────────────────────────────────
CTX="minikube"
API="http://localhost:3001"
TOKEN="${KUBEPILOT_TOKEN:-}"
NS="agent-test"
MAX_TIMEOUT=180
POLL_INTERVAL=10

for arg in "$@"; do
  case $arg in
    --context=*)  CTX="${arg#*=}" ;;
    --api=*)      API="${arg#*=}" ;;
    --token=*)    TOKEN="${arg#*=}" ;;
    --timeout=*)  MAX_TIMEOUT="${arg#*=}" ;;
  esac
done

# ── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GRN='\033[0;32m'; YLW='\033[1;33m'
BLU='\033[0;34m'; DIM='\033[2m'; NC='\033[0m'; BOLD='\033[1m'

passed=0
failed=0
skipped=0

pause_and_exit() {
  echo ""
  echo -e "${DIM}Press Enter to close...${NC}"
  read -r
  exit "${1:-0}"
}

# ── Auto-login ──────────────────────────────────────────────────────────────
if [ -z "$TOKEN" ]; then
  echo -e "${BLU}[setup]${NC} Logging in as admin..."
  TOKEN=$(curl -sf "$API/api/auth/login" \
    -H "Content-Type: application/json" \
    -d '{"email":"admin@admin.com","password":"admin"}' 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])" 2>/dev/null) || true
  if [ -z "$TOKEN" ]; then
    echo -e "${RED}Failed to login. Is the backend running at $API?${NC}"
    pause_and_exit 1
  fi
  echo -e "${GRN}  OK${NC} Logged in"
fi

AUTH="Authorization: Bearer $TOKEN"

# ── Test scenarios ──────────────────────────────────────────────────────────
# name|pod_name|kubectl args|expected action|description
TEST_NAMES=()
TEST_PODS=()
TEST_CMDS=()
TEST_EXPECTED=()
TEST_DESCS=()

add_test() {
  TEST_NAMES+=("$1"); TEST_PODS+=("$2"); TEST_CMDS+=("$3")
  TEST_EXPECTED+=("$4"); TEST_DESCS+=("$5")
}

# ── 1. OOMKilled — bare pod with tiny memory limit
add_test "oom-bare"     "oom-victim"     "__oom_bare__" \
         "increase_memory" "OOMKilled bare pod should trigger increase_memory"

# ── 2. OOMKilled — deployment-managed pod
add_test "oom-deploy"   "oom-deploy"     "__oom_deploy__" \
         "increase_memory" "OOMKilled deployment pod should trigger increase_memory"

# ── 3. ImagePullBackOff — nonexistent image (unfixable)
add_test "image-pull"   "bad-image"      "run bad-image --image=fakerepo/doesnotexist:v999 --restart=Never" \
         "noop"            "ImagePullBackOff cannot be fixed by kubectl — noop"

# ── 4. Crash bare pod — exit code 1 (no deployment to rollback)
add_test "crash-bare"   "crash-bare"     "run crash-bare --image=busybox --restart=Never -- /bin/false" \
         "delete_pod"      "Bare pod exit(1) crash should delete_pod (no controller)"

# ── 5. Exit 127 bare pod — binary not found
add_test "exit-127"     "exit127"        "run exit127 --image=busybox --restart=Never -- /nonexistent-binary" \
         "delete_pod"      "Exit 127 (binary not found) bare pod should delete_pod"

# ── 6. Bad config deployment — crash from env var error, should rollback
add_test "bad-config"   "bad-config"     "__bad_config_deploy__" \
         "rollback"        "Deployment crash from bad config should rollback to previous revision"

# ── 7. CrashLoop deployment — transient failure, should restart
add_test "crashloop-dep" "crashloop-dep" "__crashloop_deploy__" \
         "restart"         "CrashLoop deployment (transient) should restart"

# ── 8. Exit 126 bare pod — permission denied
add_test "exit-126"     "exit126"        "run exit126 --image=busybox --restart=Never -- /etc/hostname" \
         "delete_pod"      "Exit 126 (permission denied) bare pod should delete_pod"

# ── 9. Healthy pod — should NOT be detected (no action)
add_test "healthy"      "healthy-pod"    "run healthy-pod --image=nginx --restart=Never" \
         "__NOT_DETECTED__" "Healthy pod should not trigger any agent action"

# ── 10. Pending pod — unschedulable resources (bare, no deployment)
add_test "pending"      "pending-pod"    "__pending__" \
         "noop"            "Pending pod (impossible resources) — noop, cannot fix scheduling"

NUM_TESTS=${#TEST_NAMES[@]}

# ── Setup ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${BLU}━━━ Agent Decision Test Suite ━━━${NC}"
echo -e "${DIM}cluster=$CTX  namespace=$NS  timeout=${MAX_TIMEOUT}s  poll=${POLL_INTERVAL}s${NC}"
echo ""

kubectl --context="$CTX" create namespace "$NS" 2>/dev/null || true

cleanup() {
  echo ""
  echo -e "${BLU}[cleanup]${NC} Removing test namespace..."
  kubectl --context="$CTX" delete namespace "$NS" --ignore-not-found --wait=false 2>/dev/null || true
}
trap cleanup EXIT

# ── Create test pods ────────────────────────────────────────────────────────
echo -e "${BLU}[create]${NC} Deploying ${NUM_TESTS} test pods..."
for i in $(seq 0 $((NUM_TESTS - 1))); do
  echo -e "  ${BLU}*${NC} ${TEST_NAMES[$i]} — ${TEST_DESCS[$i]}"
  cmd="${TEST_CMDS[$i]}"
  case "$cmd" in

    __oom_bare__)
      kubectl --context="$CTX" -n "$NS" apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: oom-victim
spec:
  restartPolicy: Never
  containers:
  - name: oom
    image: polinux/stress
    command: ["stress", "--vm", "1", "--vm-bytes", "128M"]
    resources:
      limits:
        memory: "4Mi"
EOF
      ;;

    __oom_deploy__)
      kubectl --context="$CTX" -n "$NS" apply -f - <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: oom-deploy
spec:
  replicas: 1
  selector:
    matchLabels:
      app: oom-deploy
  template:
    metadata:
      labels:
        app: oom-deploy
    spec:
      containers:
      - name: oom
        image: polinux/stress
        command: ["stress", "--vm", "1", "--vm-bytes", "128M"]
        resources:
          limits:
            memory: "4Mi"
EOF
      ;;

    __bad_config_deploy__)
      # First create a working revision, then update to a broken one
      kubectl --context="$CTX" -n "$NS" create deployment bad-config --image=nginx 2>/dev/null || true
      kubectl --context="$CTX" -n "$NS" rollout status deployment/bad-config --timeout=60s 2>/dev/null || true
      # Now break it: override entrypoint to a failing command
      kubectl --context="$CTX" -n "$NS" set image deployment/bad-config nginx=busybox 2>/dev/null || true
      kubectl --context="$CTX" -n "$NS" patch deployment bad-config --type=json \
        -p='[{"op":"replace","path":"/spec/template/spec/containers/0/command","value":["/bin/sh","-c","echo BAD_CONFIG && exit 1"]}]' 2>/dev/null || true
      ;;

    __crashloop_deploy__)
      kubectl --context="$CTX" -n "$NS" apply -f - <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: crashloop-dep
spec:
  replicas: 1
  selector:
    matchLabels:
      app: crashloop-dep
  template:
    metadata:
      labels:
        app: crashloop-dep
    spec:
      containers:
      - name: app
        image: busybox
        command: ["/bin/sh", "-c", "sleep 2 && exit 1"]
EOF
      ;;

    __pending__)
      kubectl --context="$CTX" -n "$NS" apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: pending-pod
spec:
  restartPolicy: Never
  containers:
  - name: huge
    image: nginx
    resources:
      requests:
        cpu: "100"
        memory: "999Gi"
EOF
      ;;

    *)
      kubectl --context="$CTX" -n "$NS" $cmd 2>/dev/null || true
      ;;
  esac
done
echo ""

# ── Helper: look up agent decision for a pod ────────────────────────────────
find_decision() {
  local pod="$1"

  # Try audit log first (matches pod name or deployment name in issueKey)
  local result
  result=$(curl -sf "$API/api/audit?limit=500&cluster=$CTX" -H "$AUTH" 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
except: data = {'docs': []}
pod = '${pod}'
ns  = '${NS}'
for d in data.get('docs', []):
    meta = d.get('metadata', {})
    key = meta.get('issueKey', d.get('issueKey', ''))
    action = meta.get('action', d.get('action', ''))
    if ns in key and action and (pod in key or pod.replace('-','') in key.replace('-','')):
        print(action)
        sys.exit(0)
print('')
" 2>/dev/null) || true

  if [ -n "$result" ]; then
    echo "$result"
    return
  fi

  # Fallback: check live server logs (planner decisions)
  result=$(curl -sf "$API/api/logs" -H "$AUTH" 2>/dev/null | python3 -c "
import sys, json
try:
    logs = json.load(sys.stdin)
except: logs = []
pod = '${pod}'
ns  = '${NS}'
for log in reversed(logs):
    msg = log.get('message', '')
    if pod in msg and ns in msg and 'action' in msg and ('[PLANNER]' in msg or '[AI]' in msg):
        parts = msg.split('action')
        if len(parts) > 1:
            tok = parts[-1].strip().lstrip(':').strip().split()[0]
            if tok and tok not in ('=', ''):
                print(tok)
                sys.exit(0)
print('')
" 2>/dev/null) || true

  # Last resort: check escalations
  if [ -z "$result" ]; then
    result=$(curl -sf "$API/api/escalations" -H "$AUTH" 2>/dev/null | python3 -c "
import sys, json
try:
    escs = json.load(sys.stdin)
except: escs = []
pod = '${pod}'
ns  = '${NS}'
for e in escs:
    key = e.get('issueKey', '')
    issue = e.get('issue', {})
    if pod in key and ns in key:
        print('ESCALATED')
        sys.exit(0)
print('')
" 2>/dev/null) || true
  fi

  echo "$result"
}

# ── Poll until all detected or timeout ──────────────────────────────────────
echo -e "${BLU}[poll]${NC} Waiting for agent to process all pods (max ${MAX_TIMEOUT}s)..."

declare -A DECISIONS
detected=0
elapsed=0

while [ "$detected" -lt "$NUM_TESTS" ] && [ "$elapsed" -lt "$MAX_TIMEOUT" ]; do
  sleep "$POLL_INTERVAL"
  elapsed=$((elapsed + POLL_INTERVAL))

  detected=0
  for i in $(seq 0 $((NUM_TESTS - 1))); do
    pod="${TEST_PODS[$i]}"
    if [ -z "${DECISIONS[$pod]:-}" ]; then
      dec=$(find_decision "$pod")
      if [ -n "$dec" ]; then
        DECISIONS[$pod]="$dec"
      fi
    fi
    if [ -n "${DECISIONS[$pod]:-}" ]; then
      detected=$((detected + 1))
    fi
  done

  printf "\r  ${elapsed}s elapsed — ${detected}/${NUM_TESTS} detected "
done
echo ""
echo ""

# ── Results ─────────────────────────────────────────────────────────────────
echo -e "${BOLD}${BLU}━━━ Results ━━━${NC}"
echo ""

for i in $(seq 0 $((NUM_TESTS - 1))); do
  name="${TEST_NAMES[$i]}"
  pod="${TEST_PODS[$i]}"
  expected="${TEST_EXPECTED[$i]}"
  desc="${TEST_DESCS[$i]}"
  actual="${DECISIONS[$pod]:-}"

  # Special case: healthy pod — PASS means agent did NOT detect it
  if [ "$expected" = "__NOT_DETECTED__" ]; then
    if [ -z "$actual" ]; then
      echo -e "  ${GRN}PASS${NC}  ${BOLD}$name${NC} ($pod)"
      echo -e "       expected: no action (healthy)"
      echo -e "       actual:   ${GRN}not detected (correct)${NC}"
      passed=$((passed + 1))
    else
      echo -e "  ${RED}FAIL${NC}  ${BOLD}$name${NC} ($pod)"
      echo -e "       expected: no action (healthy)"
      echo -e "       actual:   ${RED}$actual (false positive!)${NC}"
      failed=$((failed + 1))
    fi
  elif [ -z "$actual" ]; then
    echo -e "  ${YLW}SKIP${NC}  ${BOLD}$name${NC} ($pod)"
    echo -e "       expected: $expected"
    echo -e "       actual:   ${YLW}not detected after ${MAX_TIMEOUT}s${NC}"
    skipped=$((skipped + 1))
  elif [ "$actual" = "$expected" ]; then
    echo -e "  ${GRN}PASS${NC}  ${BOLD}$name${NC} ($pod)"
    echo -e "       expected: $expected"
    echo -e "       actual:   ${GRN}$actual${NC}"
    passed=$((passed + 1))
  else
    echo -e "  ${RED}FAIL${NC}  ${BOLD}$name${NC} ($pod)"
    echo -e "       expected: $expected"
    echo -e "       actual:   ${RED}$actual${NC}"
    echo -e "       ${DIM}$desc${NC}"
    failed=$((failed + 1))
  fi
done

# ── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${BLU}━━━ Summary ━━━${NC}"
echo -e "  ${GRN}$passed passed${NC}  ${RED}$failed failed${NC}  ${YLW}$skipped skipped${NC}  (total: $NUM_TESTS)"
echo ""

if [ "$failed" -gt 0 ]; then
  echo -e "${RED}Some agent decisions were incorrect.${NC}"
  echo -e "Check Dashboard logs for [PLANNER] entries to see the LLM's reasoning."
elif [ "$skipped" -gt 0 ]; then
  echo -e "${YLW}Some tests were not detected. Try --timeout=300 for more time.${NC}"
else
  echo -e "${GRN}All agent decisions match expected answers.${NC}"
fi

pause_and_exit 0
