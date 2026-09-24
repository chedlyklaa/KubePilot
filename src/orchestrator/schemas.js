'use strict';
const { z } = require('zod');

// ── Structured handoff schemas ────────────────────────────────────────────
// Enforced at every agent-to-agent boundary in the LangGraph StateGraph via
// `model.withStructuredOutput(schema)`, per architecture-doc §7.2. This is what
// lets the deterministic Policy node parse validated structs instead of prose —
// a malformed agent output fails schema validation (LangGraph node retryPolicy
// re-prompts) before it can reach the next node, let alone the cluster.

// Fixed action vocabulary — still used by the LEGACY pipeline (plannerAgent.js
// VALID_ACTIONS, policyEngine.js ALLOWED_ACTIONS, clusterAgent.js), which is no longer
// reachable from the main entrypoint. The v5 pipeline (planner.js/graph.js) does NOT
// constrain PlanStepSchema.action/GuardianVerdictSchema.suggestedCommand to this list
// any more — the Planner writes the complete kubectl command itself (see PlanStepSchema
// below) rather than picking from a closed set, so Guardian/Policy validate the literal
// command text instead of an action name. Kept here only because the legacy pipeline
// still imports it.
const ACTIONS = [
  'restart', 'rollback', 'delete_pod', 'scale_down', 'increase_memory', 'noop',
  'cordon_node', 'drain_node', 'uncordon_node',
];

// ── Orchestrator output: raw signals → classified incidents ────────────────
// scope-discriminated union, not one flat object gated by a .superRefine() — a
// superRefine is a RUNTIME-ONLY check: it's invisible to the JSON Schema /
// function-parameters withStructuredOutput() actually sends the model, so the old
// "namespace required only when scope is pod" rule could reject bad output but never
// stop the model producing it in the first place. Confirmed live (2026-08-24): the
// identical prompt, run as a plain (non-structured) chat completion, filled in
// namespace/podName correctly every time — only the structured/tool-calling decoding
// path dropped them. A discriminated union puts each scope's required fields in that
// branch's own JSON Schema `required` list, which the model actually sees. The one
// thing that still can't be a hard schema requirement — "podName OR deployment, at
// least one" — stays a superRefine on the union as a whole, since JSON Schema has no
// "required one of" construct.
//
// Originally a single flat object (namespace/podName/deployment/nodeName all
// nullable) gated only by superRefine — confirmed live (2026-08-19) against both
// synthetic and real-cluster fixtures that without ANY enforcement here the model
// reliably explains WHICH pod/namespace in evidenceSummary prose while leaving the
// structured fields null, which silently collapsed unrelated incidents into one
// dispatch group (`ns:<cluster>:default`) and starved the Investigator of a podName
// to fetch logs for. That failure mode is why enforcement exists here at all; this
// revision keeps the enforcement but moves most of it where the model can see it.
const BaseIncidentFields = {
  type:         z.string(),                          // e.g. "CrashLoopBackOff", "NodeMemoryPressure"
  severity:     z.enum(['low', 'medium', 'high', 'critical']),
  clusterName:  z.string(),
  exitCode:     z.number().nullable().optional(),
  oomKilled:    z.boolean().optional(),
  restartCount: z.number().optional(),
  evidenceSummary: z.string(), // short justification for why this was classified as an incident
  // §Fix-CorrelationGrouping (2026-09-04) — structured version of what the model was
  // already narrating in evidenceSummary prose ("same image tag as X — likely one shared
  // rollout"). If this incident shares a root cause or a cascading relationship with
  // ANOTHER incident in THIS SAME response (e.g. an app crashing because its database in
  // the same namespace is down), give every incident in that relationship the exact SAME
  // short tag string. Leave null when an incident stands alone — this is what determines
  // whether incidents get investigated together downstream, so an invented/over-eager tag
  // wastes a shared investigation on things that aren't actually related, and a missing
  // one when there IS a real relationship loses the correlation entirely.
  correlationTag: z.string().nullable().optional(),
  // §Triage (2026-09-04) — lets the Orchestrator route a trivial single-pod incident to
  // the lightweight fast-path node (src/agents/fastPath.js) instead of the full
  // 11-layer Investigator. Real model judgment, gated by a deterministic sibling
  // pre-check injected into the prompt (see orchestratorAgent.js's
  // _annotateSiblingInfo/_findOvercalledSimple) — UNKNOWN and any value the deterministic
  // gate can't confirm are always treated as COMPLEX downstream, never SIMPLE.
  complexity: z.enum(['SIMPLE', 'COMPLEX', 'UNKNOWN']).default('UNKNOWN'),
  // Deliberately NOT asked of the model — computed deterministically in code after
  // classification (orchestratorAgent.js's _deriveBlastScope) from the incident's own
  // already-required identity fields plus the sibling pre-check, then unconditionally
  // overwritten onto the incident. Same reasoning as PlanStepSchema.clusterName below:
  // this codebase has a proven pattern of the model unreliably self-reporting identity-
  // shaped fields under ambiguity, and blast_radius/resource/controller are all fully
  // derivable from data already in hand — no need to trust the model with them at all.
  blastScope: z.object({
    resource:     z.string(),               // "namespace/name"
    controller:   z.string().nullable(),    // e.g. "deployment/app", or null if bare
    blast_radius: z.enum(['single_pod', 'workload', 'node', 'cluster']),
  }).nullable().default(null),
};

const PodIncidentSchema = z.object({
  ...BaseIncidentFields,
  scope:      z.literal('pod'),
  namespace:  z.string(),                             // real requirement now, not nullable/optional
  podName:    z.string().nullable().optional(),
  deployment: z.string().nullable().optional(),
});

const NodeIncidentSchema = z.object({
  ...BaseIncidentFields,
  scope:    z.literal('node'),
  nodeName: z.string(),                               // real requirement now
});

const ClusterIncidentSchema = z.object({
  ...BaseIncidentFields,
  scope: z.literal('cluster'),
});

const IncidentSchema = z.discriminatedUnion('scope', [
  PodIncidentSchema, NodeIncidentSchema, ClusterIncidentSchema,
]).superRefine((incident, ctx) => {
  if (incident.scope === 'pod' && !incident.podName && !incident.deployment) {
    ctx.addIssue({ code: 'custom', path: ['podName'], message: 'podName or deployment is required when scope is "pod"' });
  }
});

const IncidentListSchema = z.object({
  incidents: z.array(IncidentSchema),
});

// ── Investigator output ─────────────────────────────────────────────────────
const InvestigationReportSchema = z.object({
  rootCause:         z.string(),
  layer:              z.string(),   // which of the 11+ layers the fix belongs to
  symptom:            z.string(),
  componentsInvolved: z.array(z.string()).default([]),
  confidence:         z.number().min(0).max(1),
  evidence:           z.array(z.string()).default([]),
  recommendedFocus:   z.string(),
  riskLevel:          z.enum(['low', 'medium', 'high', 'critical']),
  // Multi-layer investigation detail (src/agents/investigator.js) — optional so the
  // legacy investigatorAgent.js's flatter output still validates unchanged.
  layersInspected:   z.array(z.string()).default([]),
  // `status`/`commandsRun` per finding: lets Guardian/UI read a layer's health at a
  // glance instead of parsing `summary` prose, and keeps each finding traceable to the
  // specific evidence that produced it (self-reported by the model — commandLog above
  // already records the ground-truth full command list independent of this).
  perLayerFindings: z.array(z.object({
    layer:       z.string(),
    status:      z.enum(['healthy', 'warning', 'critical', 'unknown']).default('unknown'),
    summary:     z.string(),
    commandsRun: z.array(z.string()).default([]),
  })).default([]),
  // Self-assessed evidence quality/completeness (0-1), distinct from `confidence` (how
  // sure the model is about the root cause). The agentic execution-layer loop in
  // investigator.js requires BOTH >= 0.9 before accepting a submission as final —
  // defaults to 0 so an omitted value fails that gate rather than crashing validation.
  evidenceSufficiency: z.number().min(0).max(1).default(0),
  // Investigator's own assessed severity, informed by the real evidence it gathered —
  // separate from (and potentially more accurate than) the Orchestrator's
  // classification-time severity, which is guessed from raw signals before any
  // investigation happens. Report-only: shown alongside the original severity, does not
  // feed back into dispatch priority/queue ordering.
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  // Why the model believes this conclusion is right and why now is the right time to
  // submit rather than keep gathering evidence — distinct from rootCause (WHAT the cause
  // is). Required for the same reason every tool call below now carries its own
  // "reasoning" argument: a prompt-only ask to "explain yourself" doesn't reliably hold
  // in this pipeline (see investigator.js's execution-layer tool), so it's captured as a
  // required structured field instead.
  reasoning: z.string(),
});

// ── Fast Path diagnosis output (src/agents/fastPath.js) ─────────────────────
// Deliberately NOT a reuse of InvestigationReportSchema above: the Fast Path's job is
// narrower (confirm-or-escalate a SINGLE SIMPLE incident from one bounded, already-
// gathered evidence bundle, in exactly one LLM call — no layer taxonomy, no
// per-component attribution, no multi-incident grouping). Forcing the model to fill in
// InvestigationReportSchema's group-oriented fields (layersInspected, perLayerFindings,
// componentsInvolved) for this narrower job would add prompt surface for no benefit.
// When a Fast Path diagnosis IS accepted, fastPath.js's own adapter maps it into an
// InvestigationReportSchema-shaped `rca` (including the legacy flat fields) so
// plannerNode/guardianNode need zero changes to consume it — same pattern
// investigator.js already uses for its own legacy-compatibility fields.
const FastPathDiagnosisSchema = z.object({
  rootCause:          z.string(),
  confidence:         z.number().min(0).max(1),
  supportingEvidence: z.array(z.string()).min(1),
  alternativeHypotheses: z.array(z.string()).default([]),
  missingInformation:    z.array(z.string()).default([]),
  // Both required, no default — an omitted answer must fail validation rather than be
  // silently treated as "false", since both directly gate whether this diagnosis is
  // trusted to skip the Full Investigator (see fastPath.js's acceptance check).
  evidenceSufficient:        z.boolean(),
  requiresDeepInvestigation: z.boolean(),
  // Not in the minimal required-fields list this schema was scoped from — added because
  // InvestigationReportSchema (which a sufficient diagnosis must adapt into for
  // Planner/Guardian) requires both `severity` and `riskLevel` with no default; asking
  // the model for one assessed severity here and reusing it for both downstream fields
  // avoids asking a second, largely redundant question.
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  reasoning: z.string(),
  // §Fix-FastPathBoundedEvidence (Phase 6, 2026-09-18) — before this, the layer was
  // derived deterministically from a fixed evidence-PROFILE name (one of 6 hardcoded
  // categories keyed by issue.type); now that the model chooses its own evidence
  // within a bound rather than following a fixed profile, there's no fixed category
  // left to derive a layer from, so it's asked directly instead. Optional/defaulted
  // (not required) so an omitted answer degrades gracefully to 'application' (the old
  // fallback default) rather than failing validation over a field that's genuinely
  // secondary to the diagnosis itself.
  layer: z.string().optional(),
});

// ── Planner output — a sequence of steps, not a single command (§Planner) ──
// `action` is now a short FREE-TEXT label (e.g. "restart the deployment", "patch the
// ConfigMap and roll out") — for logging/display only, never matched against a fixed
// list. The thing that actually runs is `command`: the Planner writes the COMPLETE
// kubectl command itself (any verb, any resource) instead of picking from a closed
// action set. This trades a deterministic Policy check ("this action string is always
// safe for this issue type") for Guardian reviewing the literal command text — see
// guardianAgent.js's SYSTEM prompt. PolicyEngine.validateCommand()/validateNodeCommand()
// keep only the checks that don't need to know the model's INTENT, just what the
// command structurally does (verb + target.kind): never delete a Namespace/PV, never
// delete a controller-managed pod, no --force delete, Job pods aren't mutated, retry
// protection on an identical repeated command. The legacy PlanStepSchema-adjacent shape
// (fixed `action` enum) lives on unchanged in the LEGACY pipeline (plannerAgent.js) —
// this schema is v5-only.
const PlanStepSchema = z.object({
  action: z.string(),  // short human-readable label — free text, not validated against ACTIONS
  // The complete kubectl command for this step: verb + all arguments, WITHOUT "kubectl"
  // or "--context=..." (both are injected server-side, same convention as the read-only
  // execution layer in investigator.js) — e.g. "rollout restart deployment/api -n prod"
  // or "patch configmap app-config -n prod --type=merge -p '{...}'".
  command: z.string(),
  target: z.object({
    kind:      z.string(),
    name:      z.string(),
    namespace: z.string().nullable().optional(),
  }),
  reason: z.string(),
  risk:   z.enum(['low', 'medium', 'high', 'critical']),
  // §7.7 — every step declares its rollback semantics explicitly.
  reversible: z.boolean(),
  // The literal command that undoes this step (e.g. "uncordon node-1" undoes "cordon
  // node-1"), or null if genuinely not reversible — the Planner writes this itself now,
  // not a lookup from a fixed action's known inverse.
  inverseCommand: z.string().nullable().optional(),
  // Which issue(s) (by their `namespace/resource` key) this step addresses — a plan can
  // now have more steps than issues (e.g. cordon→drain→patch→uncordon for one incident)
  // or fewer (one shared root-cause fix for several). Falls back to target-identity
  // matching in graph.js if the model omits this — never a hard requirement.
  issueKeys: z.array(z.string()).default([]),
  // Which cluster this step targets — populated by plannerNode (graph.js) from the
  // issue the step resolves to, UNCONDITIONALLY overwriting whatever (if anything) the
  // model put here. Deliberately not trusted as a model-supplied identity field: this
  // codebase has a proven, repeated pattern of the model unreliably self-reporting
  // identity fields under ambiguity (see the scope:"cluster" gaming fix in
  // orchestratorAgent.js, where even an explicit corrective prompt didn't change its
  // answer) — a plan step's cluster is always fully derivable from its own issueKeys/
  // target-identity match already, so there is no need to ask the model for it at all.
  clusterName: z.string().nullable().optional(),
});

const PlanSchema = z.object({
  steps:        z.array(PlanStepSchema).min(1),
  dryRunOk:     z.boolean().optional(),
  nonReversible: z.boolean().default(false), // true if any step lacks a safe inverse
});

// ── Guardian verdict — the four verdicts from architecture-doc §3.4 ────────
const GuardianVerdictSchema = z.object({
  verdict: z.enum(['APPROVE', 'REJECT', 'MODIFY', 'DELEGATE_HUMAN']),
  classification:  z.enum(['SAFE', 'CAUTIOUS', 'RISKY', 'DANGEROUS']),
  reason:          z.string(),
  // A corrected COMMAND (free text), not a fixed action name — matches PlanStepSchema's
  // move away from a closed action set. MODIFY without a usable suggestedCommand
  // downgrades to APPROVE (see guardianAgent.js).
  suggestedCommand: z.string().nullable().optional(),
  confidence:      z.number().min(0).max(1),
  approvalRequired: z.boolean().default(false), // Guardian's own read; Policy node makes the final call
  // Set when guardian re-fetched live state (§7.5) and it disagreed with the
  // Investigator's snapshot — Policy treats this as a strong signal to re-investigate.
  stateDrift: z.boolean().default(false),
  // Guardian's own risk narrative, distinct from the Planner's `risk` tier — a short
  // list of concrete warnings (e.g. "control-plane node", "no replicas to absorb
  // disruption") rather than a single classification label.
  safetyConcerns: z.array(z.string()).default([]),
  // §Fix-3 (confabulation guard) — the specific evidence phrases Guardian claims its
  // verdict is grounded in. Not independently verified against the source text (that
  // would need a second LLM pass), but forcing the model to point at something makes an
  // ungrounded claim ("the outage has been resolved" with nothing supporting it)
  // visible in the record rather than silently baked into `reason` alone.
  evidenceCited: z.array(z.string()).default([]),
  impactSummary:  z.string().nullable().optional(),
  estimatedBlastRadius: z.enum(['single_pod', 'single_node', 'cluster', 'multi_cluster']).nullable().optional(),
});

module.exports = {
  ACTIONS,
  IncidentSchema,
  IncidentListSchema,
  InvestigationReportSchema,
  FastPathDiagnosisSchema,
  PlanStepSchema,
  PlanSchema,
  GuardianVerdictSchema,
};
