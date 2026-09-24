'use strict';
const kubectl      = require('../tools/kubectl');
const PolicyEngine  = require('../policy/policyEngine');

const policyEngine = new PolicyEngine();

// ── Executor ─────────────────────────────────────────────────────────────
// Intentionally minimal (architecture-doc §3.6): no branching decisions beyond
// "run this step's command" — every decision (what the fix is, whether it's safe) was
// already made by Planner/Guardian/Policy upstream. The Planner now writes the complete
// kubectl command itself (see PlanStepSchema in schemas.js) instead of picking from a
// fixed action set, so this file no longer keeps its own action→command dispatch table —
// it prefixes "kubectl --context=..." onto whatever command the step carries, sanitizes
// it, and runs it. Only used by the v5 pipeline (planner.js's dry-run tool, graph.js's
// executorNode) — the legacy clusterAgent.js pipeline has its own separate, unrelated
// dispatch logic and never imports this file.
//
// Trade-off worth knowing: the OLD dispatch table computed "increase_memory" itself
// (new limit = max(256Mi, current × 1.5)) as a hard-coded, deterministic formula the LLM
// couldn't override. Now that the Planner writes the exact new value in its own command,
// that specific numeric guardrail is gone — Guardian's judgment is what catches an
// unreasonable memory request now, not a fixed formula.
class Executor {
  // `dryRun: true` marks a command that already carries --dry-run=server — it never
  // mutates regardless of policyEngine.dryRunMode, so it bypasses the simulate-gate
  // exactly like `readOnly` does, and actually reaches kubectl instead of
  // short-circuiting to the literal string '(dry-run)'.
  async _runSafeCommand(cmd, context, { readOnly = false, dryRun = false } = {}) {
    const { safe, command, reason } = policyEngine.sanitizeCommand(cmd);
    if (!safe) throw new Error(`Command blocked by policy sanitizer: ${reason}`);
    if (policyEngine.dryRunMode && !readOnly && !dryRun) {
      console.log(`[EXECUTOR] [DRY-RUN] would execute: ${command}`);
      return '(dry-run)';
    }
    return kubectl.runCommand(command);
  }

  /**
   * Execute one approved plan step.
   * @param {object} step   { command, target: { kind, name, namespace } } — see PlanStepSchema
   * @param {object} ctx    { context: kubeContext }
   */
  async execute(step, ctx) {
    return this._run(step, ctx, false);
  }

  /**
   * Validate one plan step against the REAL cluster (kubectl --dry-run=server) without
   * applying it — used by the Planner (architecture-doc §3.3) before finalizing a plan,
   * and by the Guardian (§3.4) as its own independent check. Reuses the exact same
   * command-construction path as execute(), so a dry-run result reflects precisely what
   * would really run — no separate implementation to drift out of sync.
   *
   * Deliberately bypasses `policyEngine.dryRunMode` (the global "simulate everything,
   * touch nothing" test-mode flag): that flag exists to suppress real mutations, but
   * `--dry-run=server` never mutates regardless of it, so a validation call should
   * always reach the real API server for a real answer, even in a dry-run-mode
   * deployment.
   */
  async dryRun(step, ctx) {
    return this._run(step, ctx, true);
  }

  async _run(step, { context }, dryRun) {
    const command = (step.command ?? '').trim();
    if (!command) return dryRun ? '(no command — nothing to validate)' : undefined;

    if (step.target?.kind === 'Node') {
      return this._executeNodeCommand(command, step.target.name, context, dryRun);
    }
    return this._executeCommand(command, context, dryRun);
  }

  async _executeCommand(command, context, dryRun = false) {
    if (!dryRun && policyEngine.dryRunMode) {
      console.log(`[EXECUTOR] [DRY-RUN] Simulating: ${command}`);
      return;
    }
    const flag = dryRun && !/--dry-run\b/.test(command) ? ' --dry-run=server' : '';
    return this._runSafeCommand(`kubectl --context=${context} ${command}${flag}`, context, { dryRun });
  }

  async _executeNodeCommand(command, nodeName, context, dryRun = false) {
    if (!dryRun && policyEngine.dryRunMode) {
      console.log(`[EXECUTOR] [DRY-RUN] Simulating on node ${nodeName}: ${command}`);
      return;
    }

    // Cheap, unambiguous, and doesn't depend on how the command is phrased — worth
    // keeping as a hard, deterministic check rather than trusting Guardian/Planner every
    // time. "cordon"/"drain" won't false-match "uncordon" (no word boundary between "un"
    // and "cordon").
    if (/\b(cordon|drain)\b/i.test(command)) {
      const nodesJson = await kubectl.getNodes(context);
      const schedulableNodes = (nodesJson.items ?? []).filter(n =>
        n.spec?.unschedulable !== true && n.metadata?.name !== nodeName
      );
      if (schedulableNodes.length === 0) {
        const msg = `BLOCKED: node command on "${nodeName}" — it is the only schedulable node`;
        if (dryRun) return msg; // report the blocker as a finding rather than throwing
        throw new Error(msg);
      }
    }

    const flag = dryRun && !/--dry-run\b/.test(command) ? ' --dry-run=server' : '';
    return this._runSafeCommand(`kubectl --context=${context} ${command}${flag}`, context, { dryRun });
  }
}

module.exports = new Executor();
