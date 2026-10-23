'use strict';
const { agentClient } = require('../mesh/agentClient');

// ── v5 agent clients ───────────────────────────────────────────────────────
// One place that maps each agent's in-process API (positional args, class instances)
// onto a single JSON input object per call — the shape every agent exposes over the
// bus. graph.js calls these clients; agent-services/<name>.js serves the SAME local
// adapters as its handlers, so local and remote mode run identical code.
//
// Adapters look the agent module's method up at CALL time (m.diagnose(...), not a
// captured reference), so the plain-Node harnesses in scripts/ that monkey-patch e.g.
// fastPath.diagnose keep working through the client.
//
// ctx (second argument) is the bus handler context in a service ({ signal, env, hopMs })
// and the caller's request options in local mode — only `signal` is read from it.

const LOCAL = {
  fastpath: () => {
    const m = require('./fastPath');
    return {
      diagnose: ({ issue, clusterConfigs }) => m.diagnose(issue, clusterConfigs),
    };
  },

  investigator: () => {
    const m = require('./investigator');
    return {
      investigate: ({ issues, clusterConfigs, fastPathSeed = null, lastAttemptFailure = null }, ctx) =>
        m.investigate(issues, clusterConfigs, fastPathSeed, lastAttemptFailure, { signal: ctx?.signal }),
    };
  },

  planner: () => {
    const m = require('./planner');
    return {
      plan: ({ issues, rca, clusterConfigs, lastAttemptFailure = null }) =>
        m.plan(issues, rca, clusterConfigs, lastAttemptFailure),
    };
  },

  // GuardianAgent is constructed per (cluster, tier) in-process; over the wire the
  // cluster and tier simply travel with the review input.
  guardian: () => {
    const GuardianAgent = require('./guardianAgent');
    return {
      review: ({ clusterName, tier, review }) => new GuardianAgent(clusterName, tier).review(review),
    };
  },

  // Reflexion is the sole owner of the knowledge base (architecture-doc §3.7): reads
  // (getContext), post-incident analysis (reflect) AND writes (remember). Routing the
  // write through here matters once reflection runs as its own service — episodicMemory
  // keeps an in-memory index of resolved episodes, and an episode stored by another
  // process would never reach the reflection service's index.
  reflection: () => {
    const r  = require('./reflectionAgent');
    const em = require('../memory/episodicMemory');
    return {
      getContext: input => r.getContext(input),
      reflect:    input => r.reflect(input),
      remember:   async episode => { await em.store(episode); return true; },
    };
  },
};

const METHODS = {
  fastpath:     ['diagnose'],
  investigator: ['investigate'],
  planner:      ['plan'],
  guardian:     ['review'],
  reflection:   ['getContext', 'reflect', 'remember'],
};

const clients = Object.fromEntries(
  Object.keys(LOCAL).map(name => [name, agentClient(name, METHODS[name], LOCAL[name])])
);

module.exports = {
  fastPathClient:     clients.fastpath,
  investigatorClient: clients.investigator,
  plannerClient:      clients.planner,
  guardianClient:     clients.guardian,
  reflectionClient:   clients.reflection,
  // For agent-services/*.js: the same adapter the local client uses.
  localAdapter: name => LOCAL[name](),
  METHODS,
};
