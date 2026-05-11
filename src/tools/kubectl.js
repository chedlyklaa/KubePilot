// src/tools/kubectl.js

const { exec } = require('child_process');

/**
 * Execute shell command safely
 */
function runCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        return reject(stderr || error.message);
      }

      resolve(stdout.trim());
    });
  });
}

/**
 * Get all pods from a namespace
 */
async function getPods(namespace = 'default', context) {
  const cmd = `kubectl --context=${context} get pods -n ${namespace}`;

  return await runCommand(cmd);
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
  const cmd = `kubectl --context=${context} scale deployment ${deployment} --replicas=${replicas} -n ${namespace}`;

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
  getPods,
  describePod,
  getLogs,
  restartDeployment,
  scaleDeployment,
  deletePod,
};