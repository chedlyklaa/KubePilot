'use strict';
const yaml            = require('js-yaml');
const { ToolMessage } = require('@langchain/core/messages');

const MAX_TOOL_OUTPUT_CHARS = 4_000;
const LOGS_HEAD_CHARS       = 500;
const DEFAULT_HEAD_CHARS    = 2_500;
const DEFAULT_LOG_TAIL      = 200;

const KEEP_FULL_TOOL_RESULTS = 3;
const COMPACT_TRIGGER        = 6;
const COMPACT_HEAD_CHARS     = 300;
const COMPACT_TAIL_CHARS     = 300;
const COMPACT_MIN_CHARS      = COMPACT_HEAD_CHARS + COMPACT_TAIL_CHARS + 200;

const OUTPUT_FORMAT_RE = /(?:^|\s)(?:-o|--output)(?:=|\s+)?(json|yaml)(?=\s|$)/;
const LOGS_VERB_RE     = /^\s*logs\b/;

const NOISE_ANNOTATIONS = ['kubectl.kubernetes.io/last-applied-configuration'];

// Remove fields with no diagnostic value
function stripNoise(obj) {
  if (!obj || typeof obj !== 'object') return 0;
  let removed = 0;
  const drop = (o, key) => { if (key in o) { delete o[key]; removed += 1; } };
  const md = obj.metadata;
  if (md && typeof md === 'object') {
    drop(md, 'managedFields');
    drop(md, 'uid');
    drop(md, 'resourceVersion');
    if (md.annotations) {
      for (const key of NOISE_ANNOTATIONS) drop(md.annotations, key);
      if (!Object.keys(md.annotations).length) delete md.annotations;
    }
  }
  if (Array.isArray(obj.items)) for (const item of obj.items) removed += stripNoise(item);
  return removed;
}

// Clean JSON or YAML tool output
function filterToolOutput(argsStr, out) {
  const format = String(argsStr ?? '').match(OUTPUT_FORMAT_RE)?.[1];
  if (!format || !out) return out;
  try {
    if (format === 'json') {
      const obj = JSON.parse(out);
      stripNoise(obj);
      return JSON.stringify(obj);
    }
    const obj = yaml.load(out);
    if (!stripNoise(obj)) return out;
    const dumped = yaml.dump(obj, { lineWidth: -1, noRefs: true, noArrayIndent: true });
    return dumped.length < out.length ? dumped : out;
  } catch {
    return out;
  }
}

function truncateToolOutput(argsStr, out, max = MAX_TOOL_OUTPUT_CHARS) {
  if (!out || out.length <= max) return out;
  const head = Math.min(LOGS_VERB_RE.test(String(argsStr ?? '')) ? LOGS_HEAD_CHARS : DEFAULT_HEAD_CHARS, max);
  const tail = max - head;
  return `${out.slice(0, head)}\n...(${out.length - max} chars truncated)...\n${out.slice(-tail)}`;
}

// Add a default tail to logs commands
function withDefaultLogTail(argsStr) {
  const s = String(argsStr ?? '').trim();
  if (!LOGS_VERB_RE.test(s)) return s;
  if (/(^|\s)--tail(=|\s)/.test(s) || /(^|\s)(-l|--selector)(=|\s)/.test(s)) return s;
  return `${s} --tail=${DEFAULT_LOG_TAIL}`;
}

// Shrink older tool results
function compactToolHistory(messages, { keepFull = KEEP_FULL_TOOL_RESULTS, trigger = COMPACT_TRIGGER } = {}) {
  const candidates = [];
  messages.forEach((m, i) => {
    if ((m?.getType?.() ?? m?._getType?.()) === 'tool' &&!m.additional_kwargs?.compacted && String(m.content).length >= COMPACT_MIN_CHARS) {
      candidates.push(i);
    }
  });
  if (candidates.length < trigger) return 0;

  const toCompact = candidates.slice(0, -keepFull);
  for (const i of toCompact) {
    const m = messages[i];
    const text = String(m.content);
    messages[i] = new ToolMessage({
      tool_call_id: m.tool_call_id,
      name: m.name,
      content: `${text.slice(0, COMPACT_HEAD_CHARS)}\n...(older result compacted to save context — ` +
        `${text.length - COMPACT_HEAD_CHARS - COMPACT_TAIL_CHARS} chars elided; re-run the command if you ` +
        `need the full output again)...\n${text.slice(-COMPACT_TAIL_CHARS)}`,
      additional_kwargs: { compacted: true },
    });
  }
  return toCompact.length;
}

module.exports = {
  MAX_TOOL_OUTPUT_CHARS,
  stripNoise,
  filterToolOutput,
  truncateToolOutput,
  withDefaultLogTail,
  compactToolHistory,
};
