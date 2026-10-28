'use strict';

// Parse a memory quantity into MiB
function parseMiB(str) {
  if (!str) return 128;
  const num = parseFloat(str);
  if (isNaN(num)) return 128;
  if (/Gi$/i.test(str)) return Math.round(num * 1024);
  if (/G$/i.test(str))  return Math.round(num * 1000);
  if (/Mi$/i.test(str) || /M$/i.test(str)) return Math.round(num);
  if (/Ki$/i.test(str)) return Math.round(num / 1024);
  if (/k$/i.test(str))  return Math.round(num / 1000);
  return Math.round(num / (1024 * 1024));
}

module.exports = { parseMiB };
