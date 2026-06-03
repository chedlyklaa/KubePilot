// src/tools/kubectl.js

const { exec } = require('child_process');

/**
 * Execute shell command safely
 */
function runCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        return reject(new Error(stderr?.trim() || error.message || 'Unknown kubectl error'));
      }

      resolve(stdout.trim());
    });
  });
}

/**
 * Get all pods from a namespace
 */
async function getPods(namespace = 'default', context, asJson = false) {
  const cmd = `kubectl --context=${context} get pods -n ${namespace}${asJson ? ' -o json' : ''}`;
  const out  = await runCommand(cmd);
  return asJson ? JSON.parse(out) : out;
}

/**
 * Describe a pod
 */
async function describePod(podName, namespace = 'default', context) {
  const cmd = `kubectl --context=${context} describe pod ${podName} -n ${namespace}`;

  return await runCommand(cmd);
}

/**
 * Get pod logs
 */
async function getLogs(podName, namespace = 'default', context) {
  const cmd = `kubectl --context=${context} logs ${podName} -n ${namespace} --tail=50`;

  return await runCommand(cmd);
}

/**
 * Restart deployment
 */
async function restartDeployment(
  deployment,
  namespace = 'default',
  context
) {
  const cmd = `kubectl --context=${context} rollout restart deployment/${deployment} -n ${namespace}`;

  return await runCommand(cmd);
}

/**
 * Scale deployment
 */
async function scaleDeployment(
  deployment,
  replicas,
  namespace = 'default',
  context
) {
  // Pre-flight: confirm the Deployment actually exists before scaling.
  // Without this, kubectl emits two concatenated stderr lines that look like
  // "no objects passed to scale deployments.apps "<name>" not found".
  try {
    await runCommand(`kubectl --context=${context} get deployment/${deployment} -n ${namespace} --no-headers`);
  } catch {
    throw new Error(
      `Deployment "${deployment}" not found in namespace "${namespace}". ` +
      `The pod may be a bare pod or managed by a ReplicaSet — use delete_pod instead.`
    );
  }

  const cmd = `kubectl --context=${context} scale deployment/${deployment} --replicas=${replicas} -n ${namespace}`;
  return await runCommand(cmd);
}

/**
 * Delete pod
 */
async function deletePod(podName, namespace = 'default', context) {
  const cmd = `kubectl --context=${context} delete pod ${podName} -n ${namespace}`;

  return await runCommand(cmd);
}

module.exports = {
  runCommand,
  getPods,
  describePod,
  getLogs,
  restartDeployment,
  scaleDeployment,
  deletePod,
};