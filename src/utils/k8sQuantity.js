'use strict';

// Parse a Kubernetes memory quantity string (e.g. "128Mi", "1Gi", "512M") into MiB.
// Shared by executor.js and clusterAgent.js — was previously duplicated verbatim in
// both, risking the two pipelines silently computing different memory limits for the
// same input string if only one copy got a fix (e.g. a missing Ti/E suffix).
function parseMiB(str) {
  if (!str) return 128;
  const num = parseFloat(str);
  if (isNaN(num)) return 128;
  if (/Gi$/i.test(str)) return Math.round(num * 1024);
  if (/G$/i.test(str))  return Math.round(num * 1000);
  if (/Mi$/i.test(str) || /M$/i.test(str)) return Math.round(num);
  if (/Ki$/i.test(str)) return Math.round(num / 1024);
  if (/k$/i.test(str))  return Math.round(num / 1000);
  return Math.round(num / (1024 * 1024)); // assume raw bytes
}

module.exports = { parseMiB };
