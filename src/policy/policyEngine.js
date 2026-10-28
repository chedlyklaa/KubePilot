'use strict';

const audit = require('../audit/logger');

const ALLOWED_ACTIONS = new Set([
  'restart', 'rollback', 'scale_down', 'increase_memory', 'delete_pod', 'noop',
  'cordon_node', 'drain_node', 'uncordon_node',
]);

const NODE_ACTIONS = new Set(['cordon_node', 'drain_node', 'uncordon_node']);

const UNQUOTED_METACHAR_RE = /[;&|`$()<>\\\n\r]/;

const KUBECTL_RE         = /^kubectl\b/;
const K8S_NAME_RE        = /^[a-z0-9]([a-z0-9\-.]*[a-z0-9])?$/;

// Check for unbalanced quotes
function _hasUnbalancedQuotes(s) {
  return (s.match(/'/g) || []).length % 2 !== 0 || (s.match(/"/g) || []).length % 2 !== 0;
}

// Check for shell characters outside quotes
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

// Check if the command has a resource name
function _hasResourceName(command) {
  const tokens = command.trim().split(/\s+/);
  const nonFlag = [];
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('-')) {
      if (!t.includes('=') && i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) i++;
      continue;
    }
    nonFlag.push(t);
  }
  if (nonFlag.length === 0) return false;
  if (nonFlag[0].includes('/')) return true;
  return nonFlag.length >= 2;
}

// Safety rules for actions before they run
class PolicyEngine {
  // Create the policy engine
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

  // Validate a plan against the policy rules
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

    if (!ALLOWED_ACTIONS.has(action)) {
      blockedRules.push(`POLICY_UNKNOWN_ACTION: "${action}" is not in the allowed action set`);
      const result = this._build('rejected', 'noop', blockedRules[0], blockedRules, warnings, plan, context);
      this._audit(result, plan, context);
      return result;
    }

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

    if (action === 'scale_down' && !deploymentExists) {
      blockedRules.push(
        'POLICY_SCALE_BARE: scale_down requires a Deployment controller — none present'
      );
      action = 'noop';
      if (status !== 'rejected') status = 'modified';
      warnings.push('scale_down rejected — no Deployment controller; use delete_pod explicitly if intended');
    }

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

    if (tier === 'production') {
      if (plan.action === 'delete_pod' && deploymentExists) {
        blockedRules.push(
          'POLICY_PROD_DELETE: delete_pod on a deployment-managed pod is forbidden in production'
        );
        action = 'noop';
        status = 'rejected';
      }

      if (risk === 'HIGH') {
        warnings.push('POLICY_PROD_HIGH_RISK: high-risk action in production — human approval is mandatory');
      }
    }

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

    if (action === 'delete_pod' && !hasController) {
      blockedRules.push(
        'POLICY_BARE_DELETE: delete_pod on unmanaged bare pod (no controller) — pod will be permanently destroyed with no recreation'
      );
      action = 'noop';
      if (status !== 'rejected') status = 'modified';
      warnings.push('delete_pod blocked on bare pod — escalation recommended; pod has no controller to recreate it');
    }

    if (ownerKind === 'Job' && action !== 'noop') {
      blockedRules.push(
        `POLICY_JOB_ACTION: Jobs run to completion — "${action}" is not valid; only noop is allowed`
      );
      action = 'noop';
      if (status !== 'rejected') status = 'modified';
      warnings.push('Action overridden to noop — Job-managed pods should not be restarted or deleted');
    }

    if (context.recentDeployment && deploymentExists && action !== 'rollback' && action !== 'noop') {
      blockedRules.push(
        `POLICY_CHANGE_CORR: recent deployment change detected — non-rollback action "${action}" blocked; rollback is the expected response`
      );
      action = 'rollback';
      if (status !== 'rejected') status = 'modified';
      warnings.push('Action overridden to rollback — a recent deployment change was correlated with this failure');
    }

    if (action === 'increase_memory' && context.hasMemoryHeadroom === false) {
      blockedRules.push(
        'POLICY_QUOTA_EXHAUSTED: namespace ResourceQuota has no memory headroom left — increase_memory would be rejected by Kubernetes'
      );
      action = 'noop';
      status = 'rejected';
      warnings.push('Quota exhausted — escalate to raise the ResourceQuota or free up capacity manually');
    }

    if (status === 'approved' && action !== plan.action) status = 'modified';

    const reason = blockedRules.length > 0
      ? blockedRules.join(' | ')
      : `Action "${action}" passed all policy checks`;

    const result = this._build(status, action, reason, blockedRules, warnings, plan, context);
    this._audit(result, plan, context);
    return result;
  }

  // Sanitize a kubectl command
  sanitizeCommand(cmd) {
    if (!cmd || typeof cmd !== 'string') {
      return { safe: false, command: null, reason: 'empty or non-string command' };
    }

    const trimmed = cmd.trim();

    if (!KUBECTL_RE.test(trimmed)) {
      return {
        safe: false, command: null,
        reason: `command must start with "kubectl" — received: "${trimmed.slice(0, 60)}"`,
      };
    }

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

    if (/--force/.test(trimmed) && /\bdelete\b/.test(trimmed)) {
      return {
        safe: false, command: null,
        reason: '--force delete is forbidden — use standard pod deletion for graceful termination',
      };
    }

    const isReadOnly      = /\b(get|describe|logs|top|rollout\s+status|version|cluster-info)\b/.test(trimmed);
    const isClusterScoped = /\b(cordon|uncordon|drain|taint)\b/.test(trimmed);
    const hasNs      = /-n\s+\S+|--namespace[= ]\S+|--all-namespaces/.test(trimmed);
    if (!isReadOnly && !isClusterScoped && !hasNs) {
      return {
        safe: false, command: null,
        reason: 'write command is missing a namespace flag (-n <ns> or --all-namespaces)',
      };
    }

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

  // Raise the risk level when rules require it
  evaluateRiskOverrides(plan, context) {
    const { tier, oomKilled, deploymentExists, issueType } = context;
    let risk          = (plan.risk || 'LOW').toUpperCase();
    let forceApproval = false;
    const reasons     = [];

    if (context.criticality === 'critical' && risk !== 'HIGH') {
      risk = 'HIGH';
      forceApproval = true;
      reasons.push('cluster marked critical — all actions require human approval');
    }

    if ((oomKilled || issueType === 'OOMKilled') && plan.action === 'increase_memory') {
      if (risk !== 'HIGH') {
        risk = 'HIGH';
        reasons.push('OOM + increase_memory unconditionally elevated to HIGH');
      }
      forceApproval = true;
    }

    if (tier === 'production' && risk === 'MEDIUM') {
      risk = 'HIGH';
      forceApproval = true;
      reasons.push('production tier elevates MEDIUM to HIGH');
    }

    if (plan.action === 'delete_pod' && deploymentExists) {
      risk = 'HIGH';
      forceApproval = true;
      reasons.push('delete_pod on deployment-managed pod elevated to HIGH');
    }

    if (tier === 'production' && risk === 'HIGH') {
      forceApproval = true;
    }

    return {
      risk,
      forceApproval,
      reason: reasons.join('; ') || `risk stays at ${risk}`,
    };
  }

  // Build a validation result
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
  // Validate a node action
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

    if (!NODE_ACTIONS.has(action)) {
      blockedRules.push(`NODE_POLICY_INVALID: "${action}" is not a node action`);
      return this._build('rejected', 'noop', blockedRules[0], blockedRules, warnings, plan, context);
    }

    if (isControlPlane) {
      if (action === 'drain_node') {
        blockedRules.push('NODE_POLICY_CONTROL_PLANE: drain_node on a control-plane node is forbidden — requires explicit human action');
        action = 'noop';
        status = 'rejected';
      } else if (action === 'cordon_node') {
        warnings.push('NODE_POLICY_CONTROL_PLANE: cordoning a control-plane node — human approval required');
      }
    }

    if (status !== 'rejected' && tier === 'production' && action === 'drain_node') {
      warnings.push('NODE_POLICY_PROD_DRAIN: draining a production node requires human approval');
    }

    if (action === 'drain_node' && drainAttempts >= 2) {
      blockedRules.push(`NODE_POLICY_DRAIN_RETRY: drain_node attempted ${drainAttempts} times — blocking; escalate manually`);
      action = 'noop';
      if (status !== 'rejected') status = 'modified';
    }

    if (action === 'drain_node' && affectedPods > 20) {
      warnings.push(`NODE_POLICY_BLAST_RADIUS: drain will evict ~${affectedPods} pods — verify cluster has capacity`);
    }

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

  // Validate a free-form command step
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

    if (!command) {
      blockedRules.push('POLICY_EMPTY_COMMAND: step has no command to run');
      status = 'rejected';
    }

    else if (verb === 'delete' && (targetKind === 'Namespace' || targetKind === 'PersistentVolume')) {
      blockedRules.push(`POLICY_BLAST_RADIUS_FLOOR: deleting a ${targetKind} is never allowed automatically`);
      status = 'rejected';
    }

    else if (verb === 'delete' && /--force\b/.test(command)) {
      blockedRules.push('POLICY_FORCE_DELETE: --force delete is forbidden — bypasses graceful termination');
      status = 'rejected';
    }

    else if (verb === 'delete' && targetKind === 'Pod' && hasController) {
      blockedRules.push(`POLICY_CONTROLLER_DELETE: deleting a pod owned by a ${ownerKind ?? 'controller'} is pointless — it will be recreated immediately`);
      status = 'rejected';
    }

    else if (ownerKind === 'Job' && !['get', 'describe', 'logs', 'top'].includes(verb)) {
      blockedRules.push('POLICY_JOB_ACTION: Job-managed pods should not be mutated automatically — they run to completion');
      status = 'rejected';
    }

    else if (tier === 'production' && verb === 'delete' && targetKind === 'Pod' && hasController) {
      blockedRules.push('POLICY_PROD_DELETE: deleting a deployment-managed pod is forbidden in production');
      status = 'rejected';
    }

    else if (/(^|\s)(-f|--filename|--patch-file)[\s=]*(-|\/dev\/stdin|\/dev\/fd\/0)(\s|$)/.test(command)) {
      blockedRules.push('POLICY_INCOMPLETE_COMMAND: command reads from stdin ("-f -" / "-f /dev/stdin" / "--patch-file -") but no manifest content is ever piped into it — would hang or fail if actually run');
      status = 'rejected';
    }
    else if (['delete', 'patch', 'scale'].includes(verb) && !_hasResourceName(command)) {
      blockedRules.push(`POLICY_INCOMPLETE_COMMAND: "${verb}" has no resource name to act on`);
      status = 'rejected';
    }

    else if (attemptHistory.filter(e => e.command === command && e.outcome === 'failed').length >= 2) {
      blockedRules.push('POLICY_RETRY_LIMIT: this exact command has already failed twice — escalating instead of repeating it');
      status = 'rejected';
    }

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

  // Validate a node command step
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

    const isDrain    = /\bdrain\b/i.test(command);
    const isCordon   = /\bcordon\b/i.test(command);

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

  // Raise the risk level for a command
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
