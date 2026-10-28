module.exports = {
  ...require('./models/auth'),
  ...require('./models/history'),
  ...require('./models/notifications'),
  ...require('./models/memory'),
  ...require('./models/audit'),
  ...require('./models/clusters'),
  ...require('./models/security'),
};
