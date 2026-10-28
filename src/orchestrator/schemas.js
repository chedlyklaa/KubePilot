'use strict';
const { z } = require('zod');

const BaseIncidentFields = {
  type:         z.string(),
  severity:     z.enum(['low', 'medium', 'high', 'critical']),
  clusterName:  z.string(),
  exitCode:     z.number().nullable().optional(),
  oomKilled:    z.boolean().optional(),
  restartCount: z.number().optional(),
  evidenceSummary: z.string(),
  correlationTag: z.string().nullable().optional(),
  complexity: z.enum(['SIMPLE', 'COMPLEX', 'UNKNOWN']).default('UNKNOWN'),
  blastScope: z.object({
    resource:     z.string(),
    controller:   z.string().nullable(),
    blast_radius: z.enum(['single_pod', 'workload', 'node', 'cluster']),
  }).nullable().default(null),
};

const PodIncidentSchema = z.object({
  ...BaseIncidentFields,
  scope:      z.literal('pod'),
  namespace:  z.string(),
  podName:    z.string().nullable().optional(),
  deployment: z.string().nullable().optional(),
});

const NodeIncidentSchema = z.object({
  ...BaseIncidentFields,
  scope:    z.literal('node'),
  nodeName: z.string(),
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

const InvestigationReportSchema = z.object({
  rootCause:         z.string(),
  layer:              z.string(),
  symptom:            z.string(),
  componentsInvolved: z.array(z.string()).default([]),
  confidence:         z.number().min(0).max(1),
  evidence:           z.array(z.string()).default([]),
  recommendedFocus:   z.string(),
  riskLevel:          z.enum(['low', 'medium', 'high', 'critical']),
  layersInspected:   z.array(z.string()).default([]),
  perLayerFindings: z.array(z.object({
    layer:       z.string(),
    status:      z.enum(['healthy', 'warning', 'critical', 'unknown']).default('unknown'),
    summary:     z.string(),
    commandsRun: z.array(z.string()).default([]),
  })).default([]),
  evidenceSufficiency: z.number().min(0).max(1).default(0),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  reasoning: z.string(),
});

const FastPathDiagnosisSchema = z.object({
  rootCause:          z.string(),
  confidence:         z.number().min(0).max(1),
  supportingEvidence: z.array(z.string()).min(1),
  alternativeHypotheses: z.array(z.string()).default([]),
  missingInformation:    z.array(z.string()).default([]),
  evidenceSufficient:        z.boolean(),
  requiresDeepInvestigation: z.boolean(),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  reasoning: z.string(),
  layer: z.string().optional(),
});

const PlanStepSchema = z.object({
  action: z.string(),
  command: z.string(),
  target: z.object({
    kind:      z.string(),
    name:      z.string(),
    namespace: z.string().nullable().optional(),
  }),
  reason: z.string(),
  risk:   z.enum(['low', 'medium', 'high', 'critical']),
  reversible: z.boolean(),
  inverseCommand: z.string().nullable().optional(),
  issueKeys: z.array(z.string()).default([]),
  clusterName: z.string().nullable().optional(),
});

const PlanSchema = z.object({
  steps:        z.array(PlanStepSchema).min(1),
  dryRunOk:     z.boolean().optional(),
  nonReversible: z.boolean().default(false),
});

const GuardianVerdictSchema = z.object({
  verdict: z.enum(['APPROVE', 'REJECT', 'MODIFY', 'DELEGATE_HUMAN']),
  classification:  z.enum(['SAFE', 'CAUTIOUS', 'RISKY', 'DANGEROUS']),
  reason:          z.string(),
  suggestedCommand: z.string().nullable().optional(),
  confidence:      z.number().min(0).max(1),
  approvalRequired: z.boolean().default(false),
  stateDrift: z.boolean().default(false),
  safetyConcerns: z.array(z.string()).default([]),
  evidenceCited: z.array(z.string()).default([]),
  impactSummary:  z.string().nullable().optional(),
  estimatedBlastRadius: z.enum(['single_pod', 'single_node', 'cluster', 'multi_cluster']).nullable().optional(),
});

module.exports = {
  IncidentSchema,
  IncidentListSchema,
  InvestigationReportSchema,
  FastPathDiagnosisSchema,
  PlanStepSchema,
  PlanSchema,
  GuardianVerdictSchema,
};
