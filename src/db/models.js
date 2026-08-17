// Barrel re-export — schemas live in ./models/{auth,notifications,memory,audit,history}.js,
// split by domain. Kept as a single entry point so every existing
// `require('../db/models')` call site across the codebase keeps working unchanged.
module.exports = {
  ...require('./models/auth'),
  ...require('./models/history'),
  ...require('./models/notifications'),
  ...require('./models/memory'),
  ...require('./models/audit'),
  ...require('./models/clusters'),
  ...require('./models/security'),
};
