const { v4: uuid } = require('uuid');
const { insertOne } = require('./storage');

function logAction(action, details = {}, userId = null) {
  const entry = {
    id: uuid(),
    action,
    userId,
    details,
    timestamp: new Date().toISOString()
  };
  insertOne('logs.json', entry);
  return entry;
}

module.exports = { logAction };
