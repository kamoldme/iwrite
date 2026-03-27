const { Pool } = require('pg');

const connStr = process.env.DATABASE_URL;
const isInternal = connStr && connStr.includes('.railway.internal');
const isLocal = !connStr || connStr.includes('localhost');

const pool = new Pool({
  connectionString: connStr,
  ssl: (!isLocal && !isInternal) ? { rejectUnauthorized: false } : false
});

const TABLE_MAP = {
  'users.json': 'users',
  'documents.json': 'documents',
  'comments.json': 'comments',
  'duels.json': 'duels',
  'activities.json': 'activities',
  'logs.json': 'logs',
  'support.json': 'support',
  'stories.json': 'stories',
  'story-comments.json': 'story_comments',
  'story-likes.json': 'story_likes',
  'story-comment-likes.json': 'story_comment_likes',
  'notifications.json': 'notifications',
  'app-settings.json': 'app_settings'
};

function getTable(filename) {
  return TABLE_MAP[filename] || filename.replace('.json', '');
}

async function initDB() {
  const tables = Object.values(TABLE_MAP);
  for (const table of tables) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${table} (
        id UUID PRIMARY KEY,
        data JSONB NOT NULL
      )
    `);
  }
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_email ON users ((data->>'email'))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_googleid ON users ((data->>'googleId'))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_documents_userid ON documents ((data->>'userId'))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_comments_documentid ON comments ((data->>'documentId'))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_duels_status ON duels ((data->>'status'))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_activities_userid ON activities ((data->>'userId'))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_stories_userid ON stories ((data->>'userId'))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_stories_status ON stories ((data->>'status'))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_story_comments_storyid ON story_comments ((data->>'storyId'))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_story_comments_status ON story_comments ((data->>'status'))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_story_likes_storyid ON story_likes ((data->>'storyId'))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_story_likes_user_story ON story_likes ((data->>'userId'), (data->>'storyId'))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_story_comment_likes_commentid ON story_comment_likes ((data->>'commentId'))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_story_comment_likes_user_comment ON story_comment_likes ((data->>'userId'), (data->>'commentId'))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_notifications_userid ON notifications ((data->>'userId'))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications ((data->>'read'))`);
}

async function findOne(filename, predicate) {
  const table = getTable(filename);
  const { rows } = await pool.query(`SELECT data FROM ${table}`);
  const items = rows.map(r => r.data);
  return items.find(predicate) || null;
}

async function findMany(filename, predicate) {
  const table = getTable(filename);
  const { rows } = await pool.query(`SELECT data FROM ${table}`);
  const items = rows.map(r => r.data);
  return predicate ? items.filter(predicate) : items;
}

async function insertOne(filename, record) {
  const table = getTable(filename);
  await pool.query(
    `INSERT INTO ${table} (id, data) VALUES ($1, $2)`,
    [record.id, JSON.stringify(record)]
  );
  return record;
}

async function updateOne(filename, predicate, updates) {
  const table = getTable(filename);
  const { rows } = await pool.query(`SELECT data FROM ${table}`);
  const items = rows.map(r => r.data);
  const item = items.find(predicate);
  if (!item) return null;
  const updated = { ...item, ...updates };
  await pool.query(
    `UPDATE ${table} SET data = $1 WHERE id = $2`,
    [JSON.stringify(updated), item.id]
  );
  return updated;
}

async function deleteOne(filename, predicate) {
  const table = getTable(filename);
  const { rows } = await pool.query(`SELECT data FROM ${table}`);
  const items = rows.map(r => r.data);
  const item = items.find(predicate);
  if (!item) return false;
  await pool.query(`DELETE FROM ${table} WHERE id = $1`, [item.id]);
  return true;
}

async function read(filename) {
  return findMany(filename);
}

async function write(filename, data) {
  const table = getTable(filename);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM ${table}`);
    for (const record of data) {
      await client.query(
        `INSERT INTO ${table} (id, data) VALUES ($1, $2)`,
        [record.id, JSON.stringify(record)]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { initDB, pool, read, write, findOne, findMany, insertOne, updateOne, deleteOne };
