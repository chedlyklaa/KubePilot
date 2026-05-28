const mongoose = require('mongoose');

async function connect() {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/k8s_agent';
  await mongoose.connect(uri);
  console.log('[DB] Connected to MongoDB at', uri.replace(/\/\/.*@/, '//***@'));
}

module.exports = { connect };
