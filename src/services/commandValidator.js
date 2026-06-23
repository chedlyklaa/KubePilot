'use strict';

// ── Intent schemas ────────────────────────────────────────────────────────────
// Each entry maps an action key to the fields the user MUST supply explicitly.
// Fields listed here can NEVER be inferred, defaulted, or invented by the LLM.
const INTENT_SCHEMAS = {
  // ── Pod operations ──────────────────────────────────────────────────────────
  create_pod:               { required: ['name', 'image', 'namespace'] },
  delete_pod:               { required: ['pod', 'namespace'] },
  describe_pod:             { required: ['pod', 'namespace'] },
  get_logs:                 { required: ['pod', 'namespace'] },

  // ── Deployment operations ───────────────────────────────────────────────────
  create_deployment:        { required: ['name', 'image', 'namespace'] },
  delete_deployment:        { required: ['deployment', 'namespace'] },
  describe_deployment:      { required: ['deployment', 'namespace'] },
  scale_deployment:         { required: ['deployment', 'replicas', 'namespace'] },
  restart_deployment:       { required: ['deployment', 'namespace'] },
  rollout_undo:             { required: ['deployment', 'namespace'] },
  rollout_status:           { required: ['deployment', 'namespace'] },
  update_image:             { required: ['deployment', 'image', 'tag', 'namespace'] },
  set_resources:            { required: ['deployment', 'namespace'] },
  patch_resource:           { required: ['resource_type', 'name', 'namespace'] },

  // ── StatefulSet / DaemonSet ─────────────────────────────────────────────────
  restart_statefulset:      { required: ['statefulset', 'namespace'] },
  scale_statefulset:        { required: ['statefulset', 'replicas', 'namespace'] },
  delete_statefulset:       { required: ['statefulset', 'namespace'] },
  restart_daemonset:        { required: ['daemonset', 'namespace'] },
  delete_daemonset:         { required: ['daemonset', 'namespace'] },

  // ── Service operations ──────────────────────────────────────────────────────
  create_service:           { required: ['name', 'namespace', 'port'] },
  delete_service:           { required: ['service', 'namespace'] },
  describe_service:         { required: ['service', 'namespace'] },
  expose_deployment:        { required: ['deployment', 'port', 'namespace'] },

  // ── Ingress ─────────────────────────────────────────────────────────────────
  create_ingress:           { required: ['name', 'namespace', 'host'] },
  delete_ingress:           { required: ['name', 'namespace'] },

  // ── ConfigMap / Secret ──────────────────────────────────────────────────────
  create_configmap:         { required: ['name', 'namespace'] },
  delete_configmap:         { required: ['name', 'namespace'] },
  create_secret:            { required: ['name', 'namespace'] },
  delete_secret:            { required: ['name', 'namespace'] },

  // ── Namespace operations ────────────────────────────────────────────────────
  create_namespace:         { required: ['name'] },
  delete_namespace:         { required: ['name'] },

  // ── PVC operations ──────────────────────────────────────────────────────────
  delete_pvc:               { required: ['pvc', 'namespace'] },
  describe_pvc:             { required: ['pvc', 'namespace'] },

  // ── RBAC ────────────────────────────────────────────────────────────────────
  create_role:              { required: ['name', 'namespace'] },
  create_cluster_role:      { required: ['name'] },
  create_role_binding:      { required: ['name', 'namespace', 'role', 'subject'] },
  create_cluster_role_binding: { required: ['name', 'role', 'subject'] },
  delete_role:              { required: ['name', 'namespace'] },
  delete_role_binding:      { required: ['name', 'namespace'] },

  // ── Node operations ─────────────────────────────────────────────────────────
  drain_node:               { required: ['node'] },
  cordon_node:              { required: ['node'] },
  uncordon_node:            { required: ['node'] },
  label_node:               { required: ['node', 'label'] },
  taint_node:               { required: ['node', 'taint'] },
  describe_node:            { required: ['node'] },

  // ── Apply ───────────────────────────────────────────────────────────────────
  apply_manifest:           { required: ['manifest'] },

  // ── Read-only (namespace optional) ─────────────────────────────────────────
  get_pods:                 { required: [] },
  get_deployments:          { required: [] },
  get_services:             { required: [] },
  get_nodes:                { required: [] },
  get_events:               { required: [] },
  top_pods:                 { required: [] },
  top_nodes:                { required: [] },
};

// Human-readable labels for each required field used in clarification questions.
const FIELD_LABELS = {
  name:          'resource name',
  pod:           'pod name',
  deployment:    'deployment name',
  statefulset:   'StatefulSet name',
  daemonset:     'DaemonSet name',
  service:       'service name',
  ingress:       'ingress name',
  node:          'node name',
  namespace:     'namespace',
  image:         'image name (e.g. nginx)',
  tag:           'image tag (e.g. 1.25.0)',
  replicas:      'replica count',
  port:          'port number',
  host:          'hostname',
  role:          'role name',
  subject:       'subject (user or serviceaccount name)',
  label:         'label in key=value format',
  taint:         'taint in key=value:effect format',
  manifest:      'manifest file path or YAML content',
  pvc:           'PersistentVolumeClaim name',
  resource_type: 'resource type (e.g. deployment, pod, configmap)',
};

class CommandCompletenessValidator {
  /**
   * Checks whether all required fields for the given action are present.
   * @param {{ action: string, params?: Record<string, any> }} intent
   * @returns {{ complete: boolean, missingFields: string[] }}
   */
  validate(intent) {
    if (!intent?.action) return { complete: false, missingFields: ['action'] };

    const schema = INTENT_SCHEMAS[intent.action];
    if (!schema) {
      // Unknown action: let the LLM decide — do not block
      return { complete: true, missingFields: [] };
    }

    const missingFields = schema.required.filter(f => {
      const v = intent.params?.[f];
      if (v == null) return true;
      const s = String(v).trim().toLowerCase();
      return s === '' || s === 'unknown' || s === 'unspecified' || s === 'null';
    });

    return { complete: missingFields.length === 0, missingFields };
  }

  /**
   * Returns ambiguous candidates when the same name matches multiple resource types.
   * @param {{ ambiguousCandidates?: string[] }} intent
   * @returns {string[] | null}
   */
  detectAmbiguity(intent) {
    const c = intent?.ambiguousCandidates;
    return Array.isArray(c) && c.length > 1 ? c : null;
  }

  /**
   * Builds a focused clarification question from missing fields or ambiguous candidates.
   * @param {string} action
   * @param {string[]} missingFields
   * @param {string[] | null} candidates
   * @returns {string}
   */
  buildQuestion(action, missingFields, candidates) {
    if (candidates?.length > 1) {
      return `I found multiple possible targets: ${candidates.join(', ')}. Which one should I target?`;
    }
    if (missingFields.length === 0) return 'Can you provide more details?';

    const humanFields = missingFields.map(f => FIELD_LABELS[f] ?? f);
    if (humanFields.length === 1) {
      return `What ${humanFields[0]} should I use?`;
    }
    const last = humanFields.pop();
    return `I need a few more details — what ${humanFields.join(', ')} and ${last} should I use?`;
  }

  /** Returns the schema for a given action, or null if unknown. */
  getSchema(action) {
    return INTENT_SCHEMAS[action] ?? null;
  }

  /** Expose schemas for reference by other modules. */
  static get INTENT_SCHEMAS() { return INTENT_SCHEMAS; }
}

module.exports = { CommandCompletenessValidator, INTENT_SCHEMAS };
