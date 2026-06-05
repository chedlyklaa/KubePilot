#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# install-monitoring.sh
# Installs the kube-prometheus-stack (Prometheus + Grafana + kube-state-metrics
# + node-exporter) into a Minikube cluster via Helm.
#
# Requirements: helm >=3, kubectl, a running Minikube cluster
#
# Usage:
#   chmod +x scripts/install-monitoring.sh
#   ./scripts/install-monitoring.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

NAMESPACE="monitoring"
RELEASE="kube-prometheus-stack"
CHART="prometheus-community/kube-prometheus-stack"
PROMETHEUS_PORT=9090
GRAFANA_PORT=3000

echo "=== KubePilot Monitoring Stack Installer ==="

# ── Step 1: Add Helm repo ─────────────────────────────────────────────────────
echo "[1/5] Adding prometheus-community Helm repo..."
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts 2>/dev/null || true
helm repo update

# ── Step 2: Create namespace ──────────────────────────────────────────────────
echo "[2/5] Creating namespace '${NAMESPACE}'..."
kubectl create namespace "${NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -

# ── Step 3: Install chart ─────────────────────────────────────────────────────
echo "[3/5] Installing ${CHART}..."
helm upgrade --install "${RELEASE}" "${CHART}" \
  --namespace "${NAMESPACE}" \
  --set prometheus.service.type=NodePort \
  --set prometheus.service.nodePort=${PROMETHEUS_PORT} \
  --set grafana.service.type=NodePort \
  --set grafana.service.nodePort=${GRAFANA_PORT} \
  --set grafana.adminPassword=kubepilot \
  --set grafana.defaultDashboardsEnabled=true \
  --set defaultRules.create=true \
  --set alertmanager.enabled=false \
  --wait \
  --timeout 10m

# ── Step 4: Verify pods ───────────────────────────────────────────────────────
echo "[4/5] Waiting for pods to be ready..."
kubectl wait --for=condition=ready pod \
  -l "app.kubernetes.io/instance=${RELEASE}" \
  -n "${NAMESPACE}" \
  --timeout=300s

echo ""
echo "[5/5] Stack status:"
kubectl get pods -n "${NAMESPACE}"

# ── Port-forward helpers ──────────────────────────────────────────────────────
echo ""
echo "=== Access Instructions ==="
echo ""
echo "Prometheus  (background):  kubectl port-forward svc/${RELEASE}-prometheus -n ${NAMESPACE} ${PROMETHEUS_PORT}:9090 &"
echo "Grafana     (background):  kubectl port-forward svc/${RELEASE}-grafana      -n ${NAMESPACE} ${GRAFANA_PORT}:80   &"
echo ""
echo "Or use minikube service:"
echo "  minikube service ${RELEASE}-prometheus -n ${NAMESPACE} --url"
echo "  minikube service ${RELEASE}-grafana    -n ${NAMESPACE} --url"
echo ""
echo "Grafana credentials:  admin / kubepilot"
echo ""
echo "Add to your .env:"
echo "  PROMETHEUS_URL=http://localhost:${PROMETHEUS_PORT}"
echo ""
echo "=== Installation complete ==="

# ── Optional: start port-forward immediately ──────────────────────────────────
read -rp "Start Prometheus port-forward now? [y/N] " START_PF
if [[ "${START_PF,,}" == "y" ]]; then
  kubectl port-forward \
    "svc/${RELEASE}-prometheus" \
    -n "${NAMESPACE}" \
    "${PROMETHEUS_PORT}:9090" &
  echo "Prometheus forwarded → http://localhost:${PROMETHEUS_PORT}"
fi
