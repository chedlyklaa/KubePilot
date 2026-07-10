// benchmark/runner/run.js
//
// Deterministic regression benchmark for the PolicyEngine + RiskEngine decision layer.
// For each fixture in benchmark/scenarios/scenarios.yaml, builds the same { plan, context }
// shape ClusterAgent builds in src/agents/clusterAgent.js, calls the REAL
// PolicyEngine.validate() and RiskEngine.calculateRisk(), and asserts the outcome against
// the scenario's expected action/status/decision.
//
// This intentionally does NOT exercise PlannerAgent's LLM output, real kubectl execution,
// or a live cluster — it is fast and fully deterministic on purpose, so it can run in CI
// with no external dependencies. For end-to-end coverage against a real minikube cluster
// and a running API server, see benchmark/agent-benchmark-advanced1.js or
// scripts/test-agent-decisions.sh.

'use strict';

const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const PolicyEngine = require('../../src/policy/policyEngine');
const RiskEngine    = require('../../src/risk/engine');

// Mirrors ACTION_RISK_PARAMS in src/agents/clusterAgent.js — kept in sync manually.
// If PolicyEngine's ALLOWED_ACTIONS gains a new action, add its risk params here too.
const ACTION_RISK_PARAMS = {
  restart:         { engineAction: 'restart_deployment', blastRadius: 2, reversibility: 0.9, costImpact: 0   },
  rollback:        { engineAction: 'apply_manifest',     blastRadius: 3, reversibility: 0.8, costImpact: 0   },
  delete_pod:      { engineAction: 'delete_pod',         blastRadius: 1, reversibility: 0.7, costImpact: 0   },
  scale_down:      { engineAction: 'scale_small',        blastRadius: 4, reversibility: 0.6, costImpact: 50  },
  increase_memory: { engineAction: 'scale_large',        blastRadius: 2, reversibility: 0.5, costImpact: 100 },
  cordon_node:     { engineAction: 'scale_small',        blastRadius: 5, reversibility: 0.9, costImpact: 0   },
  drain_node:      { engineAction: 'scale_large',        blastRadius: 9, reversibility: 0.7, costImpact: 0   },
  uncordon_node:   { engineAction: 'scale_small',        blastRadius: 1, reversibility: 1.0, costImpact: 0   },
};

// Actions that always require human approval regardless of computed risk score —
// mirrors HIGH_RISK_ACTIONS in src/agents/clusterAgent.js.
const HIGH_RISK_ACTIONS = new Set(['increase_memory', 'drain_node']);

class BenchmarkRunner {
  constructor() {
    this.policyEngine = new PolicyEngine();
    this.riskEngine   = new RiskEngine();
    this.results      = [];
    this.scenarioPath = path.join(__dirname, '../scenarios/scenarios.yaml');
  }

  loadScenarios() {
    try {
      const file   = fs.readFileSync(this.scenarioPath, 'utf8');
      const config = yaml.load(file);
      return config.scenarios || [];
    } catch (error) {
      console.error('[BENCHMARK] Failed to load scenarios:', error.message);
      process.exit(1);
    }
  }

  run() {
    console.log('\n====================================');
    console.log('POLICY + RISK ENGINE BENCHMARK');
    console.log('(deterministic — no cluster, no LLM, no server required)');
    console.log('====================================');

    const scenarios = this.loadScenarios();
    console.log(`Loaded ${scenarios.length} scenarios`);

    for (const scenario of scenarios) this.runScenario(scenario);

    this.printFinalResults();
    this.exportResults();

    return this.results.every(r => r.pass);
  }

  // Builds the real PolicyEngine plan/context shape and runs it through the real
  // policy + risk pipeline, mirroring ClusterAgent._handle()'s own wiring.
  runScenario(scenario) {
    const startTime = Date.now();

    const plan = {
      action: scenario.proposedAction,
      target: {
        kind:      scenario.deploymentExists ? 'deployment' : 'pod',
        name:      scenario.podName ?? 'bench-pod',
        namespace: scenario.namespace ?? 'default',
      },
      reason: scenario.issue,
      risk:   scenario.proposedRisk ?? 'LOW',
    };

    const ctx = {
      cluster:          scenario.cluster,
      issueType:        scenario.issue,
      tier:             scenario.tier,
      deploymentExists: !!scenario.deploymentExists,
      hasController:    scenario.hasController ?? !!scenario.deploymentExists,
      ownerKind:        scenario.ownerKind ?? (scenario.deploymentExists ? 'Deployment' : null),
      exitCode:         scenario.exitCode ?? null,
      oomKilled:        !!scenario.oomKilled,
      attemptHistory:   scenario.attemptHistory ?? [],
      recentDeployment: !!scenario.recentDeployment,
    };

    const policyResult = this.policyEngine.validate(plan, ctx);

    // Risk engine only runs when the policy engine actually approved/modified an
    // executable action — same short-circuit ClusterAgent applies for a noop/rejected result.
    let riskResult = null;
    if (policyResult.status !== 'rejected' && policyResult.action !== 'noop') {
      const params = ACTION_RISK_PARAMS[policyResult.action];
      if (params) {
        riskResult = this.riskEngine.calculateRisk({
          action:        params.engineAction,
          clusterTier:   scenario.tier,
          blastRadius:   params.blastRadius,
          reversibility: params.reversibility,
          llmConfidence: scenario.llmConfidence ?? 0.8,
          costImpact:    params.costImpact,
        });
      }
    }

    // Overall decision — mirrors ClusterAgent's own logic: a rejected plan blocks outright,
    // a noop needs no further approval routing, HIGH_RISK_ACTIONS always require a human
    // regardless of score, otherwise the risk engine's own decision governs.
    let decision;
    if (policyResult.status === 'rejected')            decision = 'BLOCK';
    else if (policyResult.action === 'noop')            decision = 'NOOP';
    else if (HIGH_RISK_ACTIONS.has(policyResult.action)) decision = 'NOTIFY';
    else                                                 decision = riskResult?.decision ?? 'NOTIFY';

    const pass =
      policyResult.action === scenario.expectedAction &&
      policyResult.status === scenario.expectedStatus &&
      decision === scenario.expectedDecision;

    const result = {
      scenario:         scenario.name,
      issue:            scenario.issue,
      proposedAction:   scenario.proposedAction,
      policyStatus:     policyResult.status,
      finalAction:      policyResult.action,
      riskScore:        riskResult?.score ?? null,
      decision,
      expectedAction:   scenario.expectedAction,
      expectedStatus:   scenario.expectedStatus,
      expectedDecision: scenario.expectedDecision,
      pass,
      durationMs:       Date.now() - startTime,
    };
    this.results.push(result);

    console.log(`\n------------------------------------`);
    console.log(`Scenario: ${scenario.name}`);
    console.log(`  proposed=${scenario.proposedAction} → policy=${policyResult.status}(${policyResult.action}) risk=${riskResult?.score ?? 'n/a'} decision=${decision}`);
    console.log(`  expected: action=${scenario.expectedAction} status=${scenario.expectedStatus} decision=${scenario.expectedDecision}`);
    console.log(`  ${pass ? 'PASS' : 'FAIL'}`);
  }

  printFinalResults() {
    const total  = this.results.length;
    const passed = this.results.filter(r => r.pass).length;
    const failed = total - passed;

    console.log('\n====================================');
    console.log('BENCHMARK RESULTS');
    console.log('====================================');
    console.log(`Total: ${total}   Passed: ${passed}   Failed: ${failed}`);

    if (failed > 0) {
      console.log('\nFailed scenarios:');
      for (const r of this.results.filter(x => !x.pass)) {
        console.log(`  - ${r.scenario}`);
        console.log(`      expected: action=${r.expectedAction} status=${r.expectedStatus} decision=${r.expectedDecision}`);
        console.log(`      actual:   action=${r.finalAction} status=${r.policyStatus} decision=${r.decision}`);
      }
    }
  }

  exportResults() {
    const outputPath = path.join(__dirname, '../results.json');
    fs.writeFileSync(outputPath, JSON.stringify(this.results, null, 2));
    console.log(`\n[BENCHMARK] Results exported to ${outputPath}`);
  }
}

// ── Export for index.js --benchmark ──────────────────────────────────────────
async function runBenchmark() {
  const runner = new BenchmarkRunner();
  return runner.run();
}

module.exports = { runBenchmark };

// Allow running directly: node benchmark/runner/run.js
// PolicyEngine.validate() fires an unawaited audit write to MongoDB on every call
// (src/policy/policyEngine.js _audit) — with no DB connected, each one hangs on
// Mongoose's command buffer for its full timeout before failing. That's harmless in
// the real running app (Mongo is connected), but would otherwise leave this
// intentionally dependency-free benchmark hanging for tens of seconds after its own
// results are already printed. Exit explicitly once the benchmark itself is done
// instead of waiting for those unrelated dangling writes to settle.
if (require.main === module) {
  runBenchmark().then(passed => process.exit(passed ? 0 : 1));
}
