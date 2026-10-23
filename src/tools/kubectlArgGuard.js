'use strict';
const { _parseArgs } = require('./kubectl');

// ── Credential / target override guard ─────────────────────────────────────
// Every model-written kubectl command (the read gate in readOnlyKubectl.js, and plan steps
// in executor.js) gets `--context=<ctx>` prepended by OUR code, and runCommand() points
// KUBECONFIG at the right identity file (clusterIdentity.js). kubectl's own global flags
// override both: `--kubeconfig=<mounted bootstrap file>` swaps the reader identity for the
// system:masters one, and a second `--context=` (last flag wins) redirects the command at
// another cluster. So none of these may appear in model-supplied text at all.
//
// Checked on kubectl's real argv (the same quote-aware tokenizer runCommand uses), so a
// quoted `"--kubeconfig=x"` is seen exactly as kubectl will see it.
const OVERRIDE_FLAGS = new Set([
  'kubeconfig', 'context', 'cluster', 'user', 'server', 'token',
  'as', 'as-group', 'as-uid', 'username', 'password',
  'client-certificate', 'client-key', 'certificate-authority',
  'insecure-skip-tls-verify', 'tls-server-name', 'disable-compression',
]);

// Short flags that consume a value: once one is reached in a combined group like `-ojson`
// or `-lapp=x`, the rest of the token is its value, not more flags. Only letters that take
// a value under EVERY verb belong here (-p/-f are booleans for `logs`, so `-ps` must still
// be caught); a rare glued value like `-p{...s...}` is a false positive, never a miss.
const VALUE_SHORT_FLAGS = new Set(['o', 'n', 'l', 'c', 'L']);

function findOverrideFlag(argsStr) {
  for (const arg of _parseArgs(`kubectl ${argsStr ?? ''}`)) {
    if (arg === '--') break; // everything after is positional
    if (arg.startsWith('--')) {
      const name = arg.slice(2).split('=')[0].toLowerCase();
      if (OVERRIDE_FLAGS.has(name)) return `--${name}`;
    } else if (arg.startsWith('-') && arg.length > 1) {
      // `-s` is the short form of --server; it can also hide inside a group (`-As url`).
      for (const ch of arg.slice(1)) {
        if (ch === 's') return '-s';
        if (ch === '=' || VALUE_SHORT_FLAGS.has(ch)) break;
      }
    }
  }
  return null;
}

module.exports = { findOverrideFlag, OVERRIDE_FLAGS };
