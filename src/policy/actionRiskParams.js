'use strict';

// Risk-scoring inputs per remediation action, fed to RiskEngine.calculateRisk() to
// decide whether an action gets force-escalated to HIGH risk (blocking auto-execution).
// Shared by graph.js and clusterAgent.js — was previously duplicated verbatim in both,
// risking the two pipelines silently diverging on when the same action gets blocked
// vs. auto-approved if only one copy got tuned after an incident.
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

module.exports = { ACTION_RISK_PARAMS };
