'use strict';
const fs   = require('fs');
const yaml = require('js-yaml');
const { spawn } = require('child_process');

// jobId → { status, log, error, profile, tier, createdAt }
const jobs = new Map();

// Purge jobs older than 1 hour
setInterval(() => {
  const cutoff = Date.now() - 3_600_000;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) jobs.delete(id);
  }
}, 900_000).unref();

class ProvisionService {
  startJob(profile, tier, userName, configPath) {
    if (!profile || !/^[a-z0-9][a-z0-9\-]*$/.test(profile))
      throw Object.assign(new Error('invalid profile name'), { status: 400 });

    const jobId = require('crypto').randomUUID();
    const job   = { status: 'running', log: '', profile, tier: tier ?? 'dev', createdAt: Date.now() };
    jobs.set(jobId, job);

    console.log(`[PROVISION] minikube start --profile ${profile}  (user: ${userName}  job: ${jobId})`);

    const proc = spawn('minikube', ['start', '--profile', profile], {
      shell: true,
      env: { ...process.env, MINIKUBE_IN_STYLE: '0' },
    });

    proc.on('error', spawnErr => {
      job.status = 'failed';
      job.error  = spawnErr.code === 'ENOENT'
        ? 'minikube is not installed or not in PATH'
        : spawnErr.message;
    });

    proc.stdout.on('data', chunk => { job.log += chunk.toString(); });
    proc.stderr.on('data', chunk => { job.log += chunk.toString(); });

    proc.on('close', code => {
      if (code === 0) {
        this._addToConfig(configPath, profile, tier);
        job.status = 'done';
      } else {
        job.status = 'failed';
        job.error  = job.error ?? `minikube start exited with code ${code}`;
      }
    });

    return jobId;
  }

  getJob(jobId) {
    return jobs.get(jobId) ?? null;
  }

  _addToConfig(configPath, profile, tier) {
    try {
      let clusters = [];
      try { clusters = yaml.load(fs.readFileSync(configPath, 'utf8')).clusters ?? []; } catch {}
      if (!clusters.find(c => c.context === profile)) {
        clusters.push({ name: profile, context: profile, tier: tier ?? 'dev', namespaces: ['*'] });
        fs.writeFileSync(configPath, yaml.dump({ clusters }), 'utf8');
      }
    } catch { /* config write failure is non-fatal */ }
  }
}

module.exports = new ProvisionService();
