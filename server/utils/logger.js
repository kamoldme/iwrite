const { v4: uuid } = require('uuid');
const { insertOne } = require('./storage');

async function logAction(action, details = {}, userId = null) {
  const entry = {
    id: uuid(),
    action,
    userId,
    details,
    timestamp: new Date().toISOString()
  };
  await insertOne('logs.json', entry);
  return entry;
}

module.exports = { logAction };
