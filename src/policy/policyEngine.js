'use strict';

const audit = require('../audit/logger');

// ── Constants ──────────────────────────────────────────────────────────────────

const ALLOWED_ACTIONS = new Set([
  'restart', 'rollback', 'scale_down', 'increase_memory', 'delete_pod', 'noop',
  'cordon_node', 'drain_node', 'uncordon_node',
]);

const NODE_ACTIONS = new Set(['cordon_node', 'drain_node', 'uncordon_node']);

// Characters that enable shell injection or command chaining.
// Includes \n and \r because exec() passes strings to /bin/sh -c which splits on newlines,
// and quotes allow escaping the kubectl argument context.
const SHELL_INJECTION_RE = /[;&|`$(){}[\]<>\\\n\r'"]/;
// Every kubectl invocation must start with the literal word "kubectl"
const KUBECTL_RE         = /^kubectl\b/;
// Valid Kubernetes resource name: lowercase alphanumeric + hyphens/dots
const K8S_NAME_RE        = /^[a-z0-9]([a-z0-9\-.]*[a-z0-9])?$/;

// ── PolicyEngine ───────────────────────────────────────────────────────────────

/**
 * Deterministic, non-bypassable safety gate.
 *
 * Sits between PlannerAgent and GuardianAgent.  Even if the Planner, Guardian,
 * and RiskEngine all approve an action, the PolicyEngine can still BLOCK or
 * MODIFY it based on hard-coded invariants that LLMs must never override.
 *
 * Architecture:
 *   PlannerAgent → PolicyEngine → GuardianAgent → RiskEngine → Executor
 */
class PolicyEngine {
  /**
   * @param {object}  [opts]
   * @param {boolean} [opts.dryRunMode=false]  Simulate kubectl commands without executing them.
   */
  constructor({ dryRunMode = false } = {}) {
    this.dryRunMode = dryRunMode || process.env.POLICY_DRY_RUN === 'true';
    if (this.dryRunMode) {
      console.warn('[PolicyEngine] DRY-RUN MODE — kubectl commands will be simulated, not executed');
    }
    console.log(`[PolicyEngine] Initialized  dryRun=${this.dryRunMode}`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PRIMARY GATE
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Validate a planner proposal against all hard policy rules.
   * The caller MUST respect the returned status and use the returned action.
   *
   * @param {object} plan
   *   { action: string, target: { kind, name, namespace }, reason: string, risk: string }
   * @param {object} context
   *   { cluster, issueType, tier, deploymentExists, exitCode, oomKilled, attemptHistory }
   * @returns {{ status, action, reason, blockedRules, warnings, dryRun, meta }}
   */
  validate(plan, context) {
    const blockedRules = [];
    const warnings     = [];
    let action = plan.action;
    let status = 'approved';

    const {
      cluster          = 'unknown',
      issueType        = '',
      tier             = 'dev',
      deploymentExists = false,
      oomKilled        = false,
      attemptHistory   = [],
    } = context;

    const risk = (plan.risk || 'LOW').toUpperCase();

    // ── Rule 1: Action whitelist ───────────────────────────────────────────────
    // Catch any action string that is not in the known-safe set (e.g. LLM hallucination).
    if (!ALLOWED_ACTIONS.has(action)) {
      blockedRules.push(`POLICY_UNKNOWN_ACTION: "${action}" is not in the allowed action set`);
      const result = this._build('rejected', 'noop', blockedRules[0], blockedRules, warnings, plan, context);
      this._audit(result, plan, context);
      return result;
    }

    // ── Rule 2: OOMKilled absolute ────────────────────────────────────────────
    // Container was killed by the kernel OOM killer — restarting without increasing
    // memory will always fail again.  Only increase_memory (or noop pending approval)
    // is a meaningful response.
    if (oomKilled === true || issueType === 'OOMKilled') {
      if (action !== 'increase_memory' && action !== 'noop') {
        blockedRules.push(
          `POLICY_OOM_ACTION: OOMKilled requires increase_memory — "${action}" is forbidden (restart will loop)`
        );
        action = 'increase_memory';
        status = 'modified';
        warnings.push('Action overridden to increase_memory per OOM absolute policy');
      }
    }

    // ── Rule 3: Controller safety — delete_pod forbidden on managed pods ──────
    // Any controller (Deployment, StatefulSet, DaemonSet) will recreate deleted pods.
    const hasController = context.hasController ?? deploymentExists;
    const ownerKind     = context.ownerKind ?? (deploymentExists ? 'Deployment' : null);

    if (hasController && action === 'delete_pod') {
      blockedRules.push(
        `POLICY_CONTROLLER_DELETE: delete_pod forbidden when ${ownerKind ?? 'controller'} exists — use restart or rollback`
      );
      action = 'restart';
      if (status !== 'rejected') status = 'modified';
      warnings.push(`delete_pod overridden to restart — target is ${ownerKind}-managed`);
    }

    // ── Rule 3a: scale_down requires a Deployment controller (all tiers) ────────
    // Without a Deployment there is nothing to scale; _applyFix would silently
    // fall back to delete_pod, bypassing the delete_pod risk/approval gates.
    if (action === 'scale_down' && !deploymentExists) {
      blockedRules.push(
        'POLICY_SCALE_BARE: scale_down requires a Deployment controller — none present'
      );
      action = 'noop';
      if (status !== 'rejected') status = 'modified';
      warnings.push('scale_down rejected — no Deployment controller; use delete_pod explicitly if intended');
    }

    // ── Rule 4: ImagePullBackOff ──────────────────────────────────────────────
    // kubectl cannot fix a bad image URL or missing pull credentials.
    // Any action other than noop (or restart as a retry hint) is pointless here.
    if (issueType === 'ImagePullBackOff') {
      if (action !== 'noop') {
        blockedRules.push(
          `POLICY_IMAGE_PULL: ImagePullBackOff only allows noop — "${action}" is forbidden (rollback/restart won't fix a missing image)`
        );
        action = 'noop';
        if (status !== 'rejected') status = 'modified';
        warnings.push('Action overridden to noop — image pull errors require manual image/credential fix');
      }
    }

    // ── Rule 5: Tier-based restrictions ──────────────────────────────────────
    if (tier === 'production') {
      // delete_pod on a controller-managed pod: Kubernetes recreates it instantly.
      // Must check plan.action (original intent) because Rule 3 may have already
      // mutated action → 'restart', making the check on `action` dead code.
      if (plan.action === 'delete_pod' && deploymentExists) {
        blockedRules.push(
          'POLICY_PROD_DELETE: delete_pod on a deployment-managed pod is forbidden in production'
        );
        action = 'noop';
        status = 'rejected';
      }

      // High-risk in production: flag for mandatory human approval (enforced by caller).
      if (risk === 'HIGH') {
        warnings.push('POLICY_PROD_HIGH_RISK: high-risk action in production — human approval is mandatory');
      }
    }

    // ── Rule 6: Retry protection ──────────────────────────────────────────────
    // If the identical action already failed twice on this issue, trying it a third
    // time will produce the same result.  Switch to noop and let humans decide.
    if (attemptHistory.length >= 2) {
      const sameActionFailures = attemptHistory.filter(
        e => e.action === action && e.outcome === 'failed'
      ).length;

      if (sameActionFailures >= 2) {
        blockedRules.push(
          `POLICY_RETRY_LIMIT: "${action}" has failed ${sameActionFailures} time(s) — switching to noop and flagging for escalation`
        );
        action = 'noop';
        if (status !== 'rejected') status = 'modified';
        warnings.push('Retry protection triggered — escalation is recommended after repeated identical failures');
      }
    }

    // ── Rule 7: Bare pod delete_pod block ──────────────────────────────────
    // A bare pod with no controller is truly one-shot.
    // delete_pod destroys it permanently with no recreation.
    if (action === 'delete_pod' && !hasController) {
      blockedRules.push(
        'POLICY_BARE_DELETE: delete_pod on unmanaged bare pod (no controller) — pod will be permanently destroyed with no recreation'
      );
      action = 'noop';
      if (status !== 'rejected') status = 'modified';
      warnings.push('delete_pod blocked on bare pod — escalation recommended; pod has no controller to recreate it');
    }

    // ── Rule 7b: Job pods — only noop allowed ─────────────────────────────
    if (ownerKind === 'Job' && action !== 'noop') {
      blockedRules.push(
        `POLICY_JOB_ACTION: Jobs run to completion — "${action}" is not valid; only noop is allowed`
      );
      action = 'noop';
      if (status !== 'rejected') status = 'modified';
      warnings.push('Action overridden to noop — Job-managed pods should not be restarted or deleted');
    }

    // ── Rule 8: Change correlation constraint ────────────────────────────────
    // When a recent deployment/config change is correlated with the failure,
    // rollback is almost always the correct action. Block non-rollback actions
    // unless the planner explicitly justified why rollback is wrong.
    if (context.recentDeployment && deploymentExists && action !== 'rollback' && action !== 'noop') {
      blockedRules.push(
        `POLICY_CHANGE_CORR: recent deployment change detected — non-rollback action "${action}" blocked; rollback is the expected response`
      );
      action = 'rollback';
      if (status !== 'rejected') status = 'modified';
      warnings.push('Action overridden to rollback — a recent deployment change was correlated with this failure');
    }

    // ── Finalize ──────────────────────────────────────────────────────────────
    if (status === 'approved' && action !== plan.action) status = 'modified';

    const reason = blockedRules.length > 0
      ? blockedRules.join(' | ')
      : `Action "${action}" passed all policy checks`;

    const result = this._build(status, action, reason, blockedRules, warnings, plan, context);
    this._audit(result, plan, context);
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // COMMAND SANITIZER
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Inspect a raw kubectl command string before it reaches exec().
   * Called by ClusterAgent._runSafeCommand() for every direct runCommand() call.
   *
   * @param {string} cmd
   * @returns {{ safe: boolean, command: string|null, reason: string }}
   */
  sanitizeCommand(cmd) {
    if (!cmd || typeof cmd !== 'string') {
      return { safe: false, command: null, reason: 'empty or non-string command' };
    }

    const trimmed = cmd.trim();

    // Must start with "kubectl"
    if (!KUBECTL_RE.test(trimmed)) {
      return {
        safe: false, command: null,
        reason: `command must start with "kubectl" — received: "${trimmed.slice(0, 60)}"`,
      };
    }

    // No shell metacharacters — blocks chaining, subshells, redirects, injection
    if (SHELL_INJECTION_RE.test(trimmed)) {
      return {
        safe: false, command: null,
        reason: `shell metacharacters detected — possible injection attempt: "${trimmed.slice(0, 80)}"`,
      };
    }

    // --force on a delete bypasses graceful termination and finalizers
    if (/--force/.test(trimmed) && /\bdelete\b/.test(trimmed)) {
      return {
        safe: false, command: null,
        reason: '--force delete is forbidden — use standard pod deletion for graceful termination',
      };
    }

    // Write commands must include an explicit namespace
    const isReadOnly = /\b(get|describe|logs|top|rollout\s+status|version|cluster-info)\b/.test(trimmed);
    const hasNs      = /-n\s+\S+|--namespace[= ]\S+|--all-namespaces/.test(trimmed);
    if (!isReadOnly && !hasNs) {
      return {
        safe: false, command: null,
        reason: 'write command is missing a namespace flag (-n <ns> or --all-namespaces)',
      };
    }

    // Validate embedded resource name tokens after type/ prefix
    const resourceMatch = trimmed.match(
      /(?:deployment\/|pod\/|replicaset\/|statefulset\/)([a-zA-Z0-9][a-zA-Z0-9\-.]*)/
    );
    if (resourceMatch) {
      const name = resourceMatch[1];
      if (!K8S_NAME_RE.test(name.toLowerCase())) {
        return {
          safe: false, command: null,
          reason: `resource name "${name}" contains invalid characters`,
        };
      }
    }

    return { safe: true, command: trimmed, reason: 'passed all sanitization checks' };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // RISK OVERRIDES
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Deterministically escalate the risk level when policy rules require it,
   * regardless of what the LLM classified as the risk.
   *
   * @param {object} plan    - PlannerAgent output (action may already be modified by validate())
   * @param {object} context - Runtime context
   * @returns {{ risk: string, forceApproval: boolean, reason: string }}
   */
  evaluateRiskOverrides(plan, context) {
    const { tier, oomKilled, deploymentExists, issueType } = context;
    let risk          = (plan.risk || 'LOW').toUpperCase();
    let forceApproval = false;
    const reasons     = [];

    // Cluster criticality: critical clusters always gate human approval
    if (context.criticality === 'critical' && risk !== 'HIGH') {
      risk = 'HIGH';
      forceApproval = true;
      reasons.push('cluster marked critical — all actions require human approval');
    }

    // OOM + increase_memory: irreversible live resource change — always HIGH
    if ((oomKilled || issueType === 'OOMKilled') && plan.action === 'increase_memory') {
      if (risk !== 'HIGH') {
        risk = 'HIGH';
        reasons.push('OOM + increase_memory unconditionally elevated to HIGH');
      }
      forceApproval = true;
    }

    // Production tier: MEDIUM → HIGH to enforce the human gate
    if (tier === 'production' && risk === 'MEDIUM') {
      risk = 'HIGH';
      forceApproval = true;
      reasons.push('production tier elevates MEDIUM to HIGH');
    }

    // delete_pod on deployment-managed pod: always HIGH (Kubernetes recreates instantly)
    if (plan.action === 'delete_pod' && deploymentExists) {
      risk = 'HIGH';
      forceApproval = true;
      reasons.push('delete_pod on deployment-managed pod elevated to HIGH');
    }

    // Any HIGH action in production forces human approval
    if (tier === 'production' && risk === 'HIGH') {
      forceApproval = true;
    }

    return {
      risk,
      forceApproval,
      reason: reasons.join('; ') || `risk stays at ${risk}`,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PRIVATE HELPERS
  // ─────────────────────────────────────────────────────────────────────────────

  _build(status, action, reason, blockedRules, warnings, plan, context) {
    return {
      status,
      action,
      reason,
      blockedRules,
      warnings,
      dryRun: this.dryRunMode,
      meta: {
        originalAction: plan.action,
        tier:           context.tier      ?? 'dev',
        issueType:      context.issueType ?? '',
        cluster:        context.cluster   ?? 'unknown',
      },
    };
  }

  _audit(result, plan, context) {
    // No noise for clean pass-throughs — only log when the policy acted
    if (result.status === 'approved') return;

    const metadata = {
      policyStatus:   result.status,
      originalAction: plan.action,
      finalAction:    result.action,
      blockedRules:   result.blockedRules,
      warnings:       result.warnings,
      tier:           context.tier,
      issueType:      context.issueType,
      dryRun:         this.dryRunMode,
    };

    if (result.status === 'rejected') {
      audit.blocked({
        cluster:  context.cluster || 'unknown',
        agent:    'PolicyEngine',
        action:   plan.action,
        reason:   result.reason,
        metadata,
      });
    } else {
      audit.success({
        cluster:  context.cluster || 'unknown',
        agent:    'PolicyEngine',
        action:   result.action,
        metadata: {
          ...metadata,
          note: `action modified from "${plan.action}" to "${result.action}"`,
        },
      });
    }
  }
  // ─────────────────────────────────────────────────────────────────────────────
  // NODE ACTION GATE
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Validate a node-level action (cordon / drain / uncordon).
   *
   * @param {object} plan    { action, target: { nodeName }, reason, risk }
   * @param {object} context { cluster, tier, isControlPlane, drainAttempts, affectedPods }
   * @returns {{ status, action, reason, blockedRules, warnings }}
   */
  validateNodeAction(plan, context) {
    const blockedRules = [];
    const warnings     = [];
    let action = plan.action;
    let status = 'approved';

    const {
      cluster        = 'unknown',
      tier           = 'dev',
      isControlPlane = false,
      drainAttempts  = 0,
      affectedPods   = 0,
    } = context;

    // ── Rule N1: Only node actions allowed here ────────────────────────────
    if (!NODE_ACTIONS.has(action)) {
      blockedRules.push(`NODE_POLICY_INVALID: "${action}" is not a node action`);
      return this._build('rejected', 'noop', blockedRules[0], blockedRules, warnings, plan, context);
    }

    // ── Rule N2: Control-plane protection ─────────────────────────────────
    // Never drain a control-plane node automatically. Cordon is allowed with approval.
    if (isControlPlane) {
      if (action === 'drain_node') {
        blockedRules.push('NODE_POLICY_CONTROL_PLANE: drain_node on a control-plane node is forbidden — requires explicit human action');
        action = 'noop';
        status = 'rejected';
      } else if (action === 'cordon_node') {
        warnings.push('NODE_POLICY_CONTROL_PLANE: cordoning a control-plane node — human approval required');
      }
    }

    // ── Rule N3: Production tier requires human approval for drain ─────────
    if (status !== 'rejected' && tier === 'production' && action === 'drain_node') {
      warnings.push('NODE_POLICY_PROD_DRAIN: draining a production node requires human approval');
    }

    // ── Rule N4: Drain retry protection ────────────────────────────────────
    if (action === 'drain_node' && drainAttempts >= 2) {
      blockedRules.push(`NODE_POLICY_DRAIN_RETRY: drain_node attempted ${drainAttempts} times — blocking; escalate manually`);
      action = 'noop';
      if (status !== 'rejected') status = 'modified';
    }

    // ── Rule N5: Large blast radius warning ───────────────────────────────
    if (action === 'drain_node' && affectedPods > 20) {
      warnings.push(`NODE_POLICY_BLAST_RADIUS: drain will evict ~${affectedPods} pods — verify cluster has capacity`);
    }

    if (status === 'approved' && action !== plan.action) status = 'modified';

    const reason = blockedRules.length
      ? blockedRules.join(' | ')
      : `Node action "${action}" passed all policy checks`;

    return this._build(status, action, reason, blockedRules, warnings, plan, context);
  }
}

module.exports = PolicyEngine;
