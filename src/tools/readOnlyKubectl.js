'use strict';
const kubectl      = require('./kubectl');
const PolicyEngine = require('../policy/policyEngine');
const { findOverrideFlag } = require('./kubectlArgGuard');

// Moved verbatim out of src/agents/investigator.js so the k8s-read gateway
// (agent-services/k8s-read.js) can run the read-only gate without loading any LLM/agent
// code. investigator.js re-exports _isReadOnlyCommand, and its executeReadOnlyCommand now
// routes through the k8s-read client (src/tools/k8sGateway.js), so Fast Path, Planner and
// Investigator all go through the same gate whichever mode the gateway is in.

const policyEngine = new PolicyEngine();
const MAX_TOOL_OUTPUT_CHARS = 4_000;

// ── Read-only execution layer ────────────────────────────────────────────────
// The Investigator may run ANY command it wants — as long as it only reads. This is an
// ALLOWLIST (not a denylist) of kubectl verbs: safer, since a denylist can always miss
// a mutating subcommand kubectl adds later. This is the app-level layer of a defense-
// in-depth design — the operator is expected to additionally bind the credentials this
// process runs with to a read-only (Viewer) ClusterRole at the Kubernetes RBAC level
// (architecture-doc §7.3's read-only ServiceAccount), so even a bug here can't mutate
// the cluster.
const READONLY_VERBS = new Set([
  'get', 'describe', 'logs', 'top', 'explain',
  'api-resources', 'api-versions', 'version', 'cluster-info',
]);
// Streaming/blocking flags — would hang the child process until kubectl.js's own
// execFile timeout kills it; rejected outright instead of burning that timeout.
const BLOCKED_FLAGS_RE = /(^|\s)(-f|--follow|-w|--watch)(\s|=|$)/;
// Secret VALUES must never reach the LLM — block the resource noun entirely here and
// point the model at the dedicated Config-layer summary (key names only) instead.
// Matches the bare noun AND kubectl's fully-qualified resource.version.group forms
// (`secrets.v1.`, `secret.v1`, `secrets.v1.core`), which name the same resource.
const BLOCKED_RESOURCE_RE = /^secrets?(\.|$)/i;
// `get --raw /api/v1/.../secrets` reads any API path directly, bypassing the resource
// check entirely — no legitimate investigation needs it.
const RAW_FLAG_RE = /(^|\s)["']?--raw(\s|=|$)/;

function _isReadOnlyCommand(argsStr) {
  const trimmed = (argsStr ?? '').trim();
  if (!trimmed) return { ok: false, reason: 'empty command' };

  const tokens = trimmed.split(/\s+/);
  const verb = tokens[0];
  if (!READONLY_VERBS.has(verb)) {
    return { ok: false, reason: `verb "${verb}" is not on the read-only allowlist (${[...READONLY_VERBS].join(', ')})` };
  }
  if (BLOCKED_FLAGS_RE.test(` ${trimmed} `)) {
    return { ok: false, reason: 'streaming flags (-f/--follow/-w/--watch) are not allowed' };
  }
  const override = findOverrideFlag(trimmed);
  if (override) {
    return { ok: false, reason: `${override} is not allowed — the cluster and identity are set by the platform, not by the command` };
  }
  if (RAW_FLAG_RE.test(trimmed)) {
    return { ok: false, reason: '--raw API paths are not allowed — use a resource read (get/describe) instead' };
  }
  // Check EVERY non-flag token, not just the first — checking only tokens.slice(1)'s
  // FIRST non-flag entry let a flag's VALUE masquerade as the resource-type token
  // whenever it happened to come first (e.g. "get -n kube-system secrets -o json":
  // the first non-flag token is "kube-system", the -n value, not "secrets" — so the
  // real resource type was never inspected and the command executed for real, found
  // in review 2026-08-26). BLOCKED_RESOURCE_RE only matches "secret"/"secrets" as a
  // whole word or before a "." (the qualified `secrets.v1.` form), so this still doesn't
  // false-positive on a namespace/label VALUE like "secret-storage" — it trips on
  // "secret/foo", "pods,secrets", "secrets.v1." whichever position they're in. A
  // namespace literally named "secret" would be a rare false positive; that's an
  // acceptable trade for never letting a real Secret read slip through undetected.
  // Wrapping quotes are stripped first: kubectl receives `"secrets"` as plain secrets.
  const resourceTypes = tokens.slice(1)
    .map(t => t.replace(/^["']+|["']+$/g, ''))
    .filter(t => !t.startsWith('-'))
    .flatMap(t => t.split(',').map(x => x.split('/')[0]));
  if (resourceTypes.some(t => BLOCKED_RESOURCE_RE.test(t))) {
    return { ok: false, reason: 'reading Secret values is blocked — use the Config-layer summary (key names only) instead' };
  }
  return { ok: true };
}

// `argsStr` is everything AFTER "kubectl" — the model never supplies "kubectl" or
// "--context" itself, both are injected here, so a hallucinated or malicious context
// value can never redirect the command at a different cluster.
async function executeReadOnlyCommand(argsStr, context) {
  const gate = _isReadOnlyCommand(argsStr);
  if (!gate.ok) {
    console.warn(`[INVESTIGATOR] [EXEC-LAYER] blocked: "${argsStr}" — ${gate.reason}`);
    return `ERROR: command blocked — ${gate.reason}`;
  }

  // Unquoted --context=, matching every other sanitizer-routed call site in this
  // codebase — no functional need to quote it (context names are plain identifiers),
  // and it keeps our own server-built prefix out of policyEngine's quote-balance check.
  const fullCommand = `kubectl --context=${context} ${argsStr.trim()}`;
  const { safe, command, reason } = policyEngine.sanitizeCommand(fullCommand);
  if (!safe) {
    console.warn(`[INVESTIGATOR] [EXEC-LAYER] blocked by sanitizer: "${argsStr}" — ${reason}`);
    return `ERROR: command blocked — ${reason}`;
  }

  try {
    console.log(`[INVESTIGATOR] [EXEC-LAYER] running: ${command}`);
    const out = await kubectl.runCommand(command);
    return out.length > MAX_TOOL_OUTPUT_CHARS ? out.slice(0, MAX_TOOL_OUTPUT_CHARS) + '\n...(truncated)' : out;
  } catch (err) {
    return `ERROR: ${err.message}`;
  }
}

module.exports = { _isReadOnlyCommand, executeReadOnlyCommand, READONLY_VERBS, MAX_TOOL_OUTPUT_CHARS };
