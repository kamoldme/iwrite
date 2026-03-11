const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function ensureFile(filename, defaultData = []) {
  const filepath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filepath)) {
    fs.writeFileSync(filepath, JSON.stringify(defaultData, null, 2));
  }
  return filepath;
}

function read(filename) {
  const filepath = ensureFile(filename);
  const raw = fs.readFileSync(filepath, 'utf-8');
  return JSON.parse(raw);
}

function write(filename, data) {
  const filepath = ensureFile(filename);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
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
