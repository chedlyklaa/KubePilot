'use strict';
// Ephemeral in-memory store for human override feedback captured at denial time.
// Maps issueKey → { overrideReasons, preferredAction, adminNote }.
// Written by approvalStore.deny(); consumed once by ReflectionAgent then cleared.
const store = new Map();

const set   = (issueKey, data) => store.set(issueKey, data);
const get   = (issueKey) => store.get(issueKey) ?? null;
const clear = (issueKey) => store.delete(issueKey);

module.exports = { set, get, clear };
