'use strict';
const kubectl      = require('../tools/kubectl');
const PolicyEngine  = require('../policy/policyEngine');

const policyEngine = new PolicyEngine();

// Runs approved plan steps
class Executor {
  // Run a sanitized kubectl command
  async _runSafeCommand(cmd, context, { readOnly = false, dryRun = false } = {}) {
    const { safe, command, reason } = policyEngine.sanitizeCommand(cmd);
    if (!safe) throw new Error(`Command blocked by policy sanitizer: ${reason}`);
    if (policyEngine.dryRunMode && !readOnly && !dryRun) {
      console.log(`[EXECUTOR] [DRY-RUN] would execute: ${command}`);
      return '(dry-run)';
    }
    return kubectl.runCommand(command);
  }

  // Execute one plan step
  async execute(step, ctx) {
    return this._run(step, ctx, false);
  }

  // Dry run one plan step on the cluster
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

    if (/\b(cordon|drain)\b/i.test(command)) {
      const nodesJson = await kubectl.getNodes(context);
      const schedulableNodes = (nodesJson.items ?? []).filter(n =>
        n.spec?.unschedulable !== true && n.metadata?.name !== nodeName
      );
      if (schedulableNodes.length === 0) {
        const msg = `BLOCKED: node command on "${nodeName}" — it is the only schedulable node`;
        if (dryRun) return msg;
        throw new Error(msg);
      }
    }

    const flag = dryRun && !/--dry-run\b/.test(command) ? ' --dry-run=server' : '';
    return this._runSafeCommand(`kubectl --context=${context} ${command}${flag}`, context, { dryRun });
  }
}

module.exports = new Executor();
