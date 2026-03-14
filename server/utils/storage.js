const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

// In-memory cache — eliminates blocking file reads on every request
const _cache = {};

function ensureFile(filename, defaultData = []) {
  const filepath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filepath)) {
    fs.writeFileSync(filepath, JSON.stringify(defaultData, null, 2));
  }
  return filepath;
}

function read(filename) {
  if (_cache[filename]) return _cache[filename];
  const filepath = ensureFile(filename);
  const raw = fs.readFileSync(filepath, 'utf-8');
  const data = JSON.parse(raw);
  _cache[filename] = data;
  return data;
}

function write(filename, data) {
  // Update cache immediately (sync), flush to disk async
  _cache[filename] = data;
  const filepath = ensureFile(filename);
  fs.writeFile(filepath, JSON.stringify(data, null, 2), () => {});
}

function findOne(filename, predicate) {
  const data = read(filename);
  return data.find(predicate) || null;
}

function insertOne(filename, record) {
  const data = read(filename);
  data.push(record);
  write(filename, data);
  return record;
}

function updateOne(filename, predicate, updates) {
  const data = read(filename);
  const index = data.findIndex(predicate);
  if (index === -1) return null;
  data[index] = { ...data[index], ...updates };
  write(filename, data);
  return data[index];
}

function deleteOne(filename, predicate) {
  const data = read(filename);
  const index = data.findIndex(predicate);
  if (index === -1) return false;
  data.splice(index, 1);
  write(filename, data);
  return true;
}

function findMany(filename, predicate) {
  const data = read(filename);
  return predicate ? data.filter(predicate) : data;
}

module.exports = { read, write, findOne, insertOne, updateOne, deleteOne, findMany };
