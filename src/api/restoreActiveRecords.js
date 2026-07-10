'use strict';

// Shared "replay active Mongo documents into an in-memory Map at boot" helper — used by
// stores that keep an in-memory cache backed by MongoDB (escalations, silences).
// `nextId` is called once per restored doc and should return this store's own next
// sequential id (keeps id generation local to each store, matching its runtime-created ids).
async function restoreActiveRecords(Model, filter, nextId, mapToEntry) {
  const docs = await Model.find(filter);
  return docs.map(doc => {
    const id = nextId();
    return [id, mapToEntry(doc, id)];
  });
}

module.exports = { restoreActiveRecords };
