'use strict';

const audit = require('../audit/logger');

// ── Constants ──────────────────────────────────────────────────────────────────

const ALLOWED_ACTIONS = new Set([
  'restart', 'rollback', 'scale_down', 'increase_memory', 'delete_pod', 'noop',
  'cordon_node', 'drain_node', 'uncordon_node',
]);

const NODE_ACTIONS = new Set(['cordon_node', 'drain_node', 'uncordon_node']);

// §Fix-SanitizerFalsePositive (2026-09-16) — kubectl.js's runCommand() never hands a
// command to a shell: it calls child_process.execFile('kubectl', argv, ...) with argv
// built by its own quote-respecting tokenizer (see kubectl.js's _parseArgs). A single-
// or double-quoted segment always becomes exactly ONE argv element, with the wrapping
// quotes stripped — so whatever punctuation lives INSIDE a quoted value (a JSON patch
// body, a jsonpath expression, a label-selector value) is handed to execFile as inert
// literal text, never interpreted as chaining/substitution/redirection, because there
// is no shell in this path to interpret it as anything else. Blacklisting those
// characters on the raw string (the old SHELL_INJECTION_RE, which included quotes
// themselves in the blacklist) was therefore blocking legitimate commands, not
// preventing any exploit that could actually occur here — confirmed live (2026-09-14):
// a correctly-formed `--type='json' -p='[{"op":"remove",...}]'` patch, the real fix for
// a bad nodeSelector, was rejected before it ever reached the cluster.
//
// An UNQUOTED occurrence of one of these characters is still worth rejecting: no
// legitimate kubectl argument outside a quoted value ever needs `; | & \` $( ) < >` or a
// raw newline/CR, so seeing one there is still a strong "something is wrong" signal —
// zero cost to any real command, and cheap defense-in-depth should a future refactor
// ever introduce a shell into this path. {}[] stay excluded even when unquoted, same
// reasoning as before: required by bare jsonpath (-o jsonpath={.spec...}), and neither
// executes anything on their own even in a real shell.
const UNQUOTED_METACHAR_RE = /[;&|`$()<>\\\n\r]/;

// Every kubectl invocation must start with the literal word "kubectl"
const KUBECTL_RE         = /^kubectl\b/;
// Valid Kubernetes resource name: lowercase alphanumeric + hyphens/dots
const K8S_NAME_RE        = /^[a-z0-9]([a-z0-9\-.]*[a-z0-9])?$/;

// An unterminated quote would let everything after it be treated as "inside a quote"
// by _hasUnquotedMetachar below, hiding a genuinely unquoted metacharacter from
// detection (e.g. `logs x' ; rm -rf /`). No legitimate kubectl command ever has an
// odd number of either quote character, so reject outright rather than guess intent.
function _hasUnbalancedQuotes(s) {
  return (s.match(/'/g) || []).length % 2 !== 0 || (s.match(/"/g) || []).length % 2 !== 0;
}

// Walks the command tracking single-/double-quote state (non-nesting — kubectl syntax
// never needs one quote style nested inside the other) and flags an UNQUOTED_METACHAR_RE
// character only when it's outside any quoted segment. Callers must check
// _hasUnbalancedQuotes(s) first — quote-state tracking is meaningless otherwise.
function _hasUnquotedMetachar(s) {
  let inSingle = false, inDouble = false;
  for (const ch of s) {
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (inSingle || inDouble) continue;
    if (UNQUOTED_METACHAR_RE.test(ch)) return true;
  }
  return false;
}

// Used by v5 COMMAND GATE Rule V7 (validateCommand's command-completeness check) — walks
// the command's tokens after the verb, skipping flags and (best-effort) their values,
// looking for either a "type/name" slash form or a second bare identifier ("type name")
// naming what to act on. Deliberately conservative: only trips on the concrete failure
// mode found live (a verb with nothing at all to act on), not a general command parser.
function _hasResourceName(command) {
  const tokens = command.trim().split(/\s+/);
  const nonFlag = [];
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('-')) {
      if (!t.includes('=') && i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) i++; // skip its value
      continue;
    }
    nonFlag.push(t);
  }
  if (nonFlag.length === 0) return false;
  if (nonFlag[0].includes('/')) return true; // "pod/name" form
  return nonFlag.length >= 2;                // "pod name" form
}

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
  // §Fix-DryRunDefault (2026-09-18) — simulate by default. A prior uncommitted edit
  // hardcoded this to `false` (real execution) while the comment and the log line right
  // below it both claimed the opposite ("hardcoded on"/"DRY-RUN MODE") — investigated and
  // confirmed unintended: every call site across both pipelines (graph.js, executor.js,
  // clusterAgent.js, investigator.js, planner.js) constructs `new PolicyEngine()` with no
  // argument, so that bug meant every approved remediation command executed for real by
  // default, with no override available at all (the old POLICY_DRY_RUN env toggle had
  // also been removed in the same edit).
  //
  // Two override paths, in priority order:
  //   1. An explicit `{ dryRunMode }` constructor option always wins — for a caller that
  //      wants to state its choice directly in code, e.g. a future test harness.
  //   2. Absent that, ALLOW_LIVE_KUBECTL_EXECUTION=true flips the default to real
  //      execution. This is NOT the old POLICY_DRY_RUN toggle (that one made the SAFE
  //      state opt-in via env var — exactly the "silently flip and forget" surface this
  //      rework avoids); this one only ever makes the UNSAFE state opt-in, requires an
  //      unambiguous, hard-to-set-by-accident name, and its effect is loudly logged
  //      below regardless of which path set it. Its only known consumer today is
  //      starting `node index.js` for the real-cluster benchmarks (dual-cluster-must-
  //      fix-demo.js / agent-benchmark-advanced1.js), which drive an already-running
  //      server over HTTP and so have no single call site of their own to override —
  //      simulating there would make their own "real fix rate" numbers meaningless.
  constructor(opts = {}) {
    const allowLiveExecution = process.env.ALLOW_LIVE_KUBECTL_EXECUTION === 'true';
    this.dryRunMode = opts.dryRunMode ?? !allowLiveExecution;
    if (this.dryRunMode) {
      console.warn('[PolicyEngine] DRY-RUN MODE — kubectl commands will be simulated, not executed');
    } else {
      console.warn('[PolicyEngine] LIVE MODE — kubectl commands WILL be executed for real'
        + (opts.dryRunMode === false ? ' (explicit constructor option)' : ' (ALLOW_LIVE_KUBECTL_EXECUTION=true)'));
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

    // ── Rule 9: Resource quota headroom ────────────────────────────────────────
    // increase_memory asks Kubernetes for more memory than the container has now. If
    // the namespace's ResourceQuota already has no headroom left, that request is
    // guaranteed to be rejected by the API server — block it here instead of burning a
    // fix attempt (and a Guardian review, and a risk score) on an action that was always
    // going to fail, and go straight to escalation instead.
    // hasMemoryHeadroom is null when there's no data to judge from (quota awareness
    // disabled, fetch failed, or no quota configured) — only an explicit false blocks.
    if (action === 'increase_memory' && context.hasMemoryHeadroom === false) {
      blockedRules.push(
        'POLICY_QUOTA_EXHAUSTED: namespace ResourceQuota has no memory headroom left — increase_memory would be rejected by Kubernetes'
      );
      action = 'noop';
      status = 'rejected';
      warnings.push('Quota exhausted — escalate to raise the ResourceQuota or free up capacity manually');
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

    // See §Fix-SanitizerFalsePositive above — quote-aware: a metacharacter INSIDE a
    // matched quote is inert under execFile, only an unquoted one (or an unterminated
    // quote hiding one) is rejected.
    if (_hasUnbalancedQuotes(trimmed)) {
      return {
        safe: false, command: null,
        reason: `unbalanced quotes — cannot safely determine command structure: "${trimmed.slice(0, 80)}"`,
      };
    }
    if (_hasUnquotedMetachar(trimmed)) {
      return {
        safe: false, command: null,
        reason: `shell metacharacters detected outside any quoted value — possible injection attempt: "${trimmed.slice(0, 80)}"`,
      };
    }

    // --force on a delete bypasses graceful termination and finalizers
    if (/--force/.test(trimmed) && /\bdelete\b/.test(trimmed)) {
      return {
        safe: false, command: null,
        reason: '--force delete is forbidden — use standard pod deletion for graceful termination',
      };
    }

    // Write commands must include an explicit namespace — except cluster-scoped node
    // operations (cordon/uncordon/drain/taint), which have no namespace concept at all.
    const isReadOnly      = /\b(get|describe|logs|top|rollout\s+status|version|cluster-info)\b/.test(trimmed);
    const isClusterScoped = /\b(cordon|uncordon|drain|taint)\b/.test(trimmed);
    const hasNs      = /-n\s+\S+|--namespace[= ]\S+|--all-namespaces/.test(trimmed);
    if (!isReadOnly && !isClusterScoped && !hasNs) {
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
      // Without this, a blocked/modified audit entry records THAT something was
      // blocked and WHY, but not WHICH resource — impossible to verify from the
      // audit log alone which target a given policy decision applied to.
      target:         plan.target ?? null,
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

    // ── Rule N6: PodDisruptionBudget protection ───────────────────────────
    // blockingPDBs are PDBs (in namespaces with pods on this node) that already allow
    // zero further disruptions — draining would either be rejected by Kubernetes or,
    // worse, force past a safety margin someone configured on purpose. Namespace-level
    // approximation (not full label-selector matching), so it can only be more cautious
    // than necessary, never less.
    const blockingPDBs = context.blockingPDBs ?? [];
    if (action === 'drain_node' && blockingPDBs.length > 0) {
      const names = blockingPDBs.map(p => `${p.metadata?.namespace}/${p.metadata?.name}`).join(', ');
      blockedRules.push(`NODE_POLICY_PDB_BLOCKED: drain_node blocked — PodDisruptionBudget(s) with zero disruptions allowed: ${names}`);
      action = 'noop';
      status = 'rejected';
    }

    if (status === 'approved' && action !== plan.action) status = 'modified';

    const reason = blockedRules.length
      ? blockedRules.join(' | ')
      : `Node action "${action}" passed all policy checks`;

    return this._build(status, action, reason, blockedRules, warnings, plan, context);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // v5 COMMAND GATE — free-form Planner (no fixed action set)
  // ─────────────────────────────────────────────────────────────────────────────
  //
  // validate()/validateNodeAction() above stay untouched for the LEGACY pipeline
  // (clusterAgent.js/plannerAgent.js), which still picks from a fixed action set. The v5
  // Planner (planner.js) writes the complete kubectl command itself instead, so most of
  // validate()'s ~15 rules can't apply the same way — they depended on knowing "this is
  // SPECIFICALLY the increase_memory action", not just some command that happens to touch
  // memory. Guardian now carries that issue-specific judgment (see guardianAgent.js's
  // COMMAND JUDGMENT section). What's kept here is deliberately narrower: checks that
  // don't need to know the model's INTENT, only what the command structurally does —
  // verb + target.kind, both cheap and reliable regardless of how the command is phrased.

  /**
   * Deterministic gate for one free-form command step.
   * @param {object} step    { command, target: {kind,name,namespace}, reversible }
   * @param {object} context { cluster, tier, hasController, ownerKind, attemptHistory }
   * @returns {{ status, command, reason, blockedRules, warnings, dryRun, meta }}
   */
  validateCommand(step, context) {
    const blockedRules = [];
    const warnings = [];
    const originalCommand = (step.command ?? '').trim();
    let command = originalCommand;
    let status = 'approved';

    const {
      cluster        = 'unknown',
      tier           = 'dev',
      hasController  = false,
      ownerKind      = null,
      attemptHistory = [],
      issueType      = null,
    } = context;

    const verb       = command.split(/\s+/)[0] ?? '';
    const targetKind = step.target?.kind;

    // ── Rule V1: empty command ──────────────────────────────────────────────
    if (!command) {
      blockedRules.push('POLICY_EMPTY_COMMAND: step has no command to run');
      status = 'rejected';
    }

    // ── Rule V2: absolute blast-radius floor ────────────────────────────────
    // Never delete a Namespace or a PersistentVolume automatically, regardless of what
    // Guardian approved — architecture-doc §9's "blast-radius limits... independent of
    // Guardian judgment", not previously implemented anywhere in this codebase.
    else if (verb === 'delete' && (targetKind === 'Namespace' || targetKind === 'PersistentVolume')) {
      blockedRules.push(`POLICY_BLAST_RADIUS_FLOOR: deleting a ${targetKind} is never allowed automatically`);
      status = 'rejected';
    }

    // ── Rule V3: --force delete ──────────────────────────────────────────────
    // Also caught by sanitizeCommand() at execution time, but reject it here too so it
    // never reaches a human-approval prompt looking already-vetted.
    else if (verb === 'delete' && /--force\b/.test(command)) {
      blockedRules.push('POLICY_FORCE_DELETE: --force delete is forbidden — bypasses graceful termination');
      status = 'rejected';
    }

    // ── Rule V4: controller safety ───────────────────────────────────────────
    // A pod delete against a controller-managed pod can't do what it's presumably meant
    // to — Kubernetes recreates the pod immediately.
    else if (verb === 'delete' && targetKind === 'Pod' && hasController) {
      blockedRules.push(`POLICY_CONTROLLER_DELETE: deleting a pod owned by a ${ownerKind ?? 'controller'} is pointless — it will be recreated immediately`);
      status = 'rejected';
    }

    // ── Rule V5: Job-managed pods ─────────────────────────────────────────────
    else if (ownerKind === 'Job' && !['get', 'describe', 'logs', 'top'].includes(verb)) {
      blockedRules.push('POLICY_JOB_ACTION: Job-managed pods should not be mutated automatically — they run to completion');
      status = 'rejected';
    }

    // ── Rule V6: production — direct pod delete on a controller-managed pod ──
    else if (tier === 'production' && verb === 'delete' && targetKind === 'Pod' && hasController) {
      blockedRules.push('POLICY_PROD_DELETE: deleting a deployment-managed pod is forbidden in production');
      status = 'rejected';
    }

    // ── Rule V7: command completeness ─────────────────────────────────────────
    // Confirmed live (2026-08-28): Guardian approved "apply -n shop -f -" as SAFE,
    // grading the intent ("correctly addresses the missing key") without noticing the
    // command reads a manifest from stdin that this pipeline never provides — it would
    // hang or fail immediately if actually executed. Guardian judges intent; this
    // catches structural incompleteness, which is exactly what a deterministic check is
    // for — no LLM needed, pure string inspection like the other V-rules.
    // Confirmed live again (2026-08-31): the bare "-f -" form got caught, but the model
    // also reaches for "-f /dev/stdin" for the identical stdin-read intent — a different
    // spelling of the same structural gap (still nothing ever piped into it) that slipped
    // through the original pattern, which only matched the literal dash.
    else if (/(^|\s)(-f|--filename|--patch-file)[\s=]*(-|\/dev\/stdin|\/dev\/fd\/0)(\s|$)/.test(command)) {
      blockedRules.push('POLICY_INCOMPLETE_COMMAND: command reads from stdin ("-f -" / "-f /dev/stdin" / "--patch-file -") but no manifest content is ever piped into it — would hang or fail if actually run');
      status = 'rejected';
    }
    else if (['delete', 'patch', 'scale'].includes(verb) && !_hasResourceName(command)) {
      blockedRules.push(`POLICY_INCOMPLETE_COMMAND: "${verb}" has no resource name to act on`);
      status = 'rejected';
    }

    // ── Rule V8: retry protection ─────────────────────────────────────────────
    // Matched on the literal command now, not an action name — two differently-worded
    // commands aren't necessarily the same fix, so only an EXACT repeat counts.
    else if (attemptHistory.filter(e => e.command === command && e.outcome === 'failed').length >= 2) {
      blockedRules.push('POLICY_RETRY_LIMIT: this exact command has already failed twice — escalating instead of repeating it');
      status = 'rejected';
    }

    // ── Rule V9: unverified image substitution ────────────────────────────────
    // §Fix-ImageSubstitution (2026-09-14) — kubectl cannot fix a bad/missing image
    // reference; SYSTEM_PROMPT already tells the Planner to leave "command" EMPTY for
    // ImagePullBackOff/ErrImagePull rather than invent a replacement, but an LLM
    // instruction is advice, not a guarantee. Confirmed live: the Planner sometimes
    // submitted "set image ... nginx:1.21" (once "nginx:latest" in a later run) for a
    // deployment whose actual intended image is genuinely unknowable, and it was approved
    // and executed — silently changing what the app runs, with no escalation, on a
    // non-deterministic LLM judgment call with nothing deterministic backing it up. This
    // is exactly the "hard, structural, group-wide gate" rule V-rules exist for (per this
    // function's own design — a judgment call belongs to Guardian, a hard rule belongs
    // here). Scoped to image-pull-failure issue types specifically — a rollback-style
    // image change (kubectl rollout undo, or "set image" restoring a PREVIOUS revision's
    // own image) for a different root cause is not this pattern and stays unblocked.
    else if (/ImagePullBackOff|ErrImagePull/i.test(issueType ?? '') && (/^set\s+image\b/.test(command) || /--image=/.test(command))) {
      blockedRules.push(`POLICY_UNVERIFIED_IMAGE_SUBSTITUTION: cannot fix ${issueType} by substituting a different image — the correct image is not knowable from the investigation; escalate for a human to supply the right one`);
      status = 'rejected';
    }

    if (status === 'rejected') command = '';

    const reason = blockedRules.length ? blockedRules.join(' | ') : 'Command passed all policy checks';
    const result = {
      status, command, reason, blockedRules, warnings,
      dryRun: this.dryRunMode,
      meta: { originalCommand, tier, cluster, target: step.target ?? null },
    };
    if (result.status === 'rejected') {
      audit.blocked({ cluster, agent: 'PolicyEngine', action: originalCommand, reason: result.reason, metadata: { blockedRules, target: step.target ?? null } });
    }
    return result;
  }

  /**
   * Deterministic gate for one free-form NODE command step.
   * @param {object} step    { command, target: {name} }
   * @param {object} context { cluster, tier, isControlPlane, drainAttempts, affectedPods, blockingPDBs }
   */
  validateNodeCommand(step, context) {
    const blockedRules = [];
    const warnings = [];
    const originalCommand = (step.command ?? '').trim();
    let command = originalCommand;
    let status = 'approved';

    const {
      cluster        = 'unknown',
      tier           = 'dev',
      isControlPlane = false,
      drainAttempts  = 0,
      affectedPods   = 0,
    } = context;

    // "cordon"/"drain" won't false-match "uncordon" — no word boundary between "un" and
    // "cordon", so \bcordon\b only matches the standalone verb.
    const isDrain    = /\bdrain\b/i.test(command);
    const isCordon   = /\bcordon\b/i.test(command);

    // Node commands take exactly one bare argument (the node name) — no resource-type
    // prefix, unlike pod-scoped commands — so a plain token count after the verb is
    // enough here (see _hasResourceName's fuller version for the pod-scoped case).
    const hasNodeName = command.trim().split(/\s+/).slice(1).some(t => !t.startsWith('-'));

    if (!command) {
      blockedRules.push('NODE_POLICY_EMPTY_COMMAND: step has no command to run');
      status = 'rejected';
    } else if (!hasNodeName) {
      blockedRules.push('NODE_POLICY_INCOMPLETE_COMMAND: no node name to act on');
      status = 'rejected';
    } else if (isDrain && isControlPlane) {
      blockedRules.push('NODE_POLICY_CONTROL_PLANE: draining a control-plane node is forbidden — requires explicit human action');
      status = 'rejected';
    } else {
      if (isCordon && isControlPlane) {
        warnings.push('NODE_POLICY_CONTROL_PLANE: cordoning a control-plane node — human approval required');
      }
      if (isDrain && tier === 'production') {
        warnings.push('NODE_POLICY_PROD_DRAIN: draining a production node requires human approval');
      }
      if (isDrain && drainAttempts >= 2) {
        blockedRules.push(`NODE_POLICY_DRAIN_RETRY: drain attempted ${drainAttempts} times already — blocking, escalate manually`);
        status = 'rejected';
      }
      if (isDrain && affectedPods > 20) {
        warnings.push(`NODE_POLICY_BLAST_RADIUS: drain will evict ~${affectedPods} pods — verify cluster has capacity`);
      }
      const blockingPDBs = context.blockingPDBs ?? [];
      if (status !== 'rejected' && isDrain && blockingPDBs.length > 0) {
        const names = blockingPDBs.map(p => `${p.metadata?.namespace}/${p.metadata?.name}`).join(', ');
        blockedRules.push(`NODE_POLICY_PDB_BLOCKED: drain blocked — PodDisruptionBudget(s) with zero disruptions allowed: ${names}`);
        status = 'rejected';
      }
    }

    if (status === 'rejected') command = '';

    const reason = blockedRules.length ? blockedRules.join(' | ') : 'Node command passed all policy checks';
    return {
      status, command, reason, blockedRules, warnings,
      dryRun: this.dryRunMode,
      meta: { originalCommand, tier, cluster },
    };
  }

  /**
   * Command-text equivalent of evaluateRiskOverrides() — same escalation reasoning, just
   * detecting "what kind of change is this" from verb/target instead of a known action
   * name. `step.reversible` is used directly for the non-reversible override now, since
   * the Planner self-reports it per step rather than it being looked up from a table.
   */
  evaluateRiskOverridesForCommand(step, context) {
    const { tier, oomKilled, deploymentExists, issueType } = context;
    let risk          = (step.risk || 'LOW').toUpperCase();
    let forceApproval = false;
    const reasons     = [];
    const command      = step.command ?? '';
    const verb         = command.trim().split(/\s+/)[0] ?? '';

    if (context.criticality === 'critical' && risk !== 'HIGH') {
      risk = 'HIGH';
      forceApproval = true;
      reasons.push('cluster marked critical — all actions require human approval');
    }

    // A resource/limit change for an OOM issue is an irreversible live resource change —
    // always HIGH, detected by verb+text now instead of a known "increase_memory" name.
    const looksLikeResourceChange = verb === 'set' || verb === 'patch' || /\b(resources|limits|requests)\b/i.test(command);
    if ((oomKilled || issueType === 'OOMKilled') && looksLikeResourceChange) {
      if (risk !== 'HIGH') { risk = 'HIGH'; reasons.push('OOM + resource change unconditionally elevated to HIGH'); }
      forceApproval = true;
    }

    if (tier === 'production' && risk === 'MEDIUM') {
      risk = 'HIGH';
      forceApproval = true;
      reasons.push('production tier elevates MEDIUM to HIGH');
    }

    if (verb === 'delete' && step.target?.kind === 'Pod' && deploymentExists) {
      risk = 'HIGH';
      forceApproval = true;
      reasons.push('deleting a deployment-managed pod elevated to HIGH');
    }

    // §Fix-RiskEngineRetirement (2026-09-18) — objective floor moved here from the
    // now-retired RiskEngine.calculateRisk() call in graph.js's policyNode (see that
    // file's comment for the full analysis). Draining a node evicts every pod on it —
    // a structurally large, hard-to-fully-undo blast radius regardless of what the
    // Planner self-reported for `reversible` or what Guardian classified it as; this is
    // the one case that formula's independent blast-radius scoring was ever actually
    // load-bearing for (every other combination checked was already covered by one of
    // this function's own floors above). Matches the legacy pipeline's
    // HIGH_RISK_ACTIONS set (clusterAgent.js), which always required approval for
    // drain_node regardless of computed risk — the v5 pipeline dropped that fixed set
    // when the Planner became free-form (see graph.js's requiresApproval comment), and
    // this restores the one entry from it that wasn't already redundant with a floor
    // that already exists here.
    if (step.target?.kind === 'Node' && /\bdrain\b/i.test(command)) {
      forceApproval = true;
      if (risk !== 'HIGH') { risk = 'HIGH'; reasons.push('draining a node is always elevated to HIGH — evicts every pod on it'); }
    }

    if (tier === 'production' && risk === 'HIGH') forceApproval = true;

    if (step.reversible === false) {
      forceApproval = true;
      if (risk !== 'HIGH') { risk = 'HIGH'; reasons.push('non-reversible step elevated to HIGH'); }
    }

    return {
      risk,
      forceApproval,
      reason: reasons.join('; ') || `risk stays at ${risk}`,
    };
  }
}

module.exports = PolicyEngine;
