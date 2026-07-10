# Autonomous Multi-Cluster AKS Agent

AI-powered autonomous management system for Azure Kubernetes Service (AKS) clusters.

## Project Structure

```txt
aks-agent/
├── index.js
├── config/
├── src/
├── benchmark/
```

---

# Features

- Multi-cluster AKS orchestration
- Risk-based autonomous actions
- Kubernetes tool integrations
- Azure integrations
- Temporal memory system
- Cross-cluster consistency checks
- Teams notifications
- Benchmark framework

---

# Requirements

Install:

- Node.js >= 20
- Git
- kubectl
- Azure CLI
- Helm

Verify:

```bash
node -v
kubectl version --client
az version
helm version
```

---

# Installation

Clone repository:

```bash
git clone <repo-url>
cd aks-agent
```

Install dependencies:

```bash
npm install
```

---

# Environment Variables

Create `.env`:

```env
ANTHROPIC_API_KEY=your_key_here
AZURE_SUBSCRIPTION_ID=your_subscription
```

---

# Run Project

Development mode:

```bash
npm run dev
```

Production:

```bash
npm start
```

Benchmark mode:

```bash
npm run benchmark
```

---

# Azure Login

Authenticate Azure CLI:

```bash
az login
```

Get AKS credentials:

```bash
az aks get-credentials \
  --resource-group YOUR_RG \
  --name YOUR_CLUSTER
```

Verify:

```bash
kubectl get nodes
```

---

# Future Components

- Redis shared memory
- PostgreSQL audit storage
- Grafana dashboards

Already implemented (see `chaos/`, `src/api/`): Prometheus integration, Chaos Mesh
benchmark scenarios (pod-kill, cpu-stress, memory-stress, network-delay), and the
Approval API.

---

# Author

PFE Project — Autonomous Multi-Cluster AKS Agent
