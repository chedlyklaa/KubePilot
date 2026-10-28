'use strict';

// Load active MongoDB records into a map
async function restoreActiveRecords(Model, filter, nextId, mapToEntry) {
  const docs = await Model.find(filter);
  return docs.map(doc => {
    const id = nextId();
    return [id, mapToEntry(doc, id)];
  });
}

module.exports = { restoreActiveRecords };
