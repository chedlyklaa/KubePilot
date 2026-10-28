'use strict';
const store = new Map();

const set   = (issueKey, data) => store.set(issueKey, data);
const get   = (issueKey) => store.get(issueKey) ?? null;
const clear = (issueKey) => store.delete(issueKey);

module.exports = { set, get, clear };
