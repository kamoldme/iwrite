/**
 * Migration script: JSON files → PostgreSQL
 *
 * Run once after setting up PostgreSQL:
 *   DATABASE_URL=postgres://... node server/migrate-to-pg.js
 *
 * Safe to re-run — uses INSERT ... ON CONFLICT DO NOTHING
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: !DATABASE_URL.includes('localhost') ? { rejectUnauthorized: false } : false
});

const DATA_DIR = path.join(__dirname, 'data');

const FILES_TO_TABLES = {
  'users.json': 'users',
  'documents.json': 'documents',
  'comments.json': 'comments',
  'duels.json': 'duels',
  'activities.json': 'activities',
  'logs.json': 'logs',
  'support.json': 'support'
};

async function migrate() {
  console.log('Connecting to PostgreSQL...');
  await pool.query('SELECT 1');
  console.log('Connected.\n');

  // Create tables
  for (const table of Object.values(FILES_TO_TABLES)) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${table} (
        id UUID PRIMARY KEY,
        data JSONB NOT NULL
      )
    `);
    console.log(`Table "${table}" ready`);
  }

  // Create indexes
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_email ON users ((data->>'email'))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_googleid ON users ((data->>'googleId'))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_documents_userid ON documents ((data->>'userId'))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_comments_documentid ON comments ((data->>'documentId'))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_duels_status ON duels ((data->>'status'))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_activities_userid ON activities ((data->>'userId'))`);
  console.log('Indexes created.\n');

  // Migrate each file
  let totalRecords = 0;
  for (const [filename, table] of Object.entries(FILES_TO_TABLES)) {
    const filepath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filepath)) {
      console.log(`Skipping ${filename} — file not found`);
      continue;
    }

    const raw = fs.readFileSync(filepath, 'utf-8');
    let records;
    try {
      records = JSON.parse(raw);
    } catch {
      console.log(`Skipping ${filename} — invalid JSON`);
      continue;
    }

    if (!Array.isArray(records) || records.length === 0) {
      console.log(`Skipping ${filename} — empty or not an array`);
      continue;
    }

    let inserted = 0;
    let skipped = 0;
    for (const record of records) {
      if (!record.id) {
        skipped++;
        continue;
      }
      try {
        await pool.query(
          `INSERT INTO ${table} (id, data) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
          [record.id, JSON.stringify(record)]
        );
        inserted++;
      } catch (e) {
        console.error(`  Error inserting ${record.id} into ${table}:`, e.message);
        skipped++;
      }
    }

    console.log(`${filename} → ${table}: ${inserted} inserted, ${skipped} skipped (of ${records.length})`);
    totalRecords += inserted;
  }

  console.log(`\nMigration complete. ${totalRecords} total records migrated.`);
  await pool.end();
}

migrate().catch(e => {
  console.error('Migration failed:', e);
  process.exit(1);
});
