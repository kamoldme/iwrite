require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust Railway's reverse proxy
app.set('trust proxy', 1);

// CORS — lock to your domain
const allowedOrigins = [
  'https://iwrite4.me',
  'https://www.iwrite4.me'
];
if (process.env.NODE_ENV !== 'production') {
  allowedOrigins.push('http://localhost:3000', 'http://localhost:5173');
}
// Add Railway staging domain
if (process.env.RAILWAY_PUBLIC_DOMAIN) {
  allowedOrigins.push(`https://${process.env.RAILWAY_PUBLIC_DOMAIN}`);
}
app.use(cors({
  origin(origin, callback) {
    // Allow requests with no origin (mobile apps, curl, server-to-server)
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

// Rate limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 attempts per window
  message: { error: 'Too many attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false
});

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 120, // 120 requests per minute
  message: { error: 'Too many requests, please slow down' },
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/api/auth/register', authLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/google', authLimiter);
app.use('/api', apiLimiter);

app.use(express.json({ limit: '10mb' }));

// Avatar uploads directory (still file-based)
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const avatarsDir = path.join(dataDir, 'avatars');
if (!fs.existsSync(avatarsDir)) fs.mkdirSync(avatarsDir, { recursive: true });

app.use('/uploads/avatars', express.static(avatarsDir));
app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: 0,
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    // No caching for CSS/JS/HTML so updates are immediate
    if (filePath.endsWith('.css') || filePath.endsWith('.js') || filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  }
}));

// Active users tracker (in-memory, 5-minute window)
const activeUsers = new Map(); // userId → { name, lastSeen }
app.use('/api', (req, res, next) => {
  if (req.headers.authorization) {
    try {
      const jwt = require('jsonwebtoken');
      const token = req.headers.authorization.split(' ')[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'iwrite-dev-secret-change-in-production');
      if (decoded.id) activeUsers.set(decoded.id, { email: decoded.email, lastSeen: Date.now() });
    } catch {}
  }
  next();
});
// Cleanup stale entries every 60s
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [id, data] of activeUsers) {
    if (data.lastSeen < cutoff) activeUsers.delete(id);
  }
}, 60000);

// Health check
app.get('/api/health', async (req, res) => {
  try {
    const { pool } = require('./utils/storage');
    await pool.query('SELECT 1');
    res.json({ status: 'ok', uptime: process.uptime(), activeUsers: activeUsers.size });
  } catch (e) {
    res.status(503).json({ status: 'error', message: 'Database unreachable' });
  }
});

// Active users count (admin only, checked via JWT)
app.get('/api/active-users', (req, res) => {
  const { authenticate, requireAdmin } = require('./middleware/auth');
  authenticate(req, res, () => {
    requireAdmin(req, res, () => {
      const now = Date.now();
      const users = [];
      for (const [id, data] of activeUsers) {
        users.push({ id, email: data.email, minutesAgo: Math.round((now - data.lastSeen) / 60000) });
      }
      res.json({ count: users.length, users: users.sort((a, b) => a.minutesAgo - b.minutesAgo) });
    });
  });
});

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/documents', require('./routes/documents'));
app.use('/api/friends', require('./routes/friends'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/share', require('./routes/share'));
app.use('/api/support', require('./routes/support'));
app.use('/api/duels', require('./routes/duels'));

const { findOne, findMany, insertOne } = require('./utils/storage');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');

app.get('/api/auth/google-client-id', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID || '';
  if (!clientId) {
    return res.status(500).json({ error: 'Google Client ID not configured' });
  }
  res.json({ clientId });
});

app.get('/api/stats/public', async (req, res) => {
  try {
    const users = await findMany('users.json');
    const docs = await findMany('documents.json');
    res.json({
      totalWords: users.reduce((sum, u) => sum + (u.totalWords || 0), 0),
      totalSessions: docs.filter(d => !d.deleted && d.duration > 0).length,
      totalWriters: users.filter(u => u.role !== 'admin').length,
      activeNow: activeUsers.size
    });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const users = await findMany('users.json');
    const docs = await findMany('documents.json');

    const leaderboard = users
      .filter(u => u.role !== 'admin')
      .map(u => {
        const userDocs = docs.filter(d => d.userId === u.id && !d.deleted && d.duration > 0);
        const minutesWritten = Math.round(userDocs.reduce((sum, d) => sum + (d.duration / 60), 0) * 10) / 10;
        return {
          name: u.name,
          totalWords: u.totalWords || 0,
          totalSessions: u.totalSessions || 0,
          xp: u.xp || 0,
          level: u.level || 0,
          streak: u.streak || 0,
          minutesWritten,
          avatar: u.avatar || null,
          avatarUpdatedAt: u.avatarUpdatedAt || null
        };
      })
      .sort((a, b) => b.totalWords - a.totalWords)
      .slice(0, 10)
      .map((entry, i) => ({ rank: i + 1, ...entry }));

    res.json(leaderboard);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load leaderboard' });
  }
});

// Simple analytics endpoint
app.post('/api/analytics/pageview', (req, res) => {
  // Fire-and-forget — non-critical
  const { page } = req.body;
  insertOne('logs.json', {
    id: uuid(),
    action: 'pageview',
    userId: null,
    details: { page, ua: req.headers['user-agent'] },
    timestamp: new Date().toISOString()
  }).catch(() => {});
  res.json({ ok: true });
});

// One-time migration endpoint — reads JSON files from Railway volume and inserts into PostgreSQL
app.post('/api/migrate-volume', async (req, res) => {
  const secret = req.headers['x-migrate-secret'];
  if (secret !== process.env.JWT_SECRET) return res.status(403).json({ error: 'Forbidden' });

  const { pool } = require('./utils/storage');
  const dataDir = path.join(__dirname, 'data');
  const files = {
    'users.json': 'users',
    'documents.json': 'documents',
    'comments.json': 'comments',
    'duels.json': 'duels',
    'activities.json': 'activities',
    'logs.json': 'logs',
    'support.json': 'support'
  };

  const results = {};
  for (const [filename, table] of Object.entries(files)) {
    const filepath = path.join(dataDir, filename);
    if (!fs.existsSync(filepath)) { results[filename] = 'not found'; continue; }
    try {
      const records = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
      if (!Array.isArray(records)) { results[filename] = 'not an array'; continue; }
      let inserted = 0, skipped = 0;
      for (const record of records) {
        if (!record.id) { skipped++; continue; }
        try {
          await pool.query(
            `INSERT INTO ${table} (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2`,
            [record.id, JSON.stringify(record)]
          );
          inserted++;
        } catch { skipped++; }
      }
      results[filename] = `${inserted} upserted, ${skipped} skipped (of ${records.length})`;
    } catch (e) { results[filename] = `error: ${e.message}`; }
  }
  res.json({ results });
});

// HTML routes
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'app.html'));
});
app.get('/manual-login', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});
app.get('/shared/:token', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'shared.html'));
});
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'privacy.html'));
});
app.get('/terms', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'terms.html'));
});

// 404 catch-all — must be after all other routes
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, '..', 'public', '404.html'));
});

// Initialize database and start
const { initDB } = require('./utils/storage');

async function start() {
  // Seed admin account
  try {
    await initDB();
    const admin = await findOne('users.json', u => u.email === 'admin@iwrite4.me');
    if (!admin) {
      const hash = await bcrypt.hash('Admin1234', 12);
      await insertOne('users.json', {
        id: uuid(),
        name: 'Admin',
        email: 'admin@iwrite4.me',
        password: hash,
        role: 'admin',
        plan: 'free',
        xp: 0, level: 0, streak: 0, longestStreak: 0,
        lastWritingDate: null, treeStage: 0, totalWords: 0, totalSessions: 0,
        achievements: [], friends: [], friendRequests: [], sentRequests: [], sharedTokens: [],
        createdAt: new Date().toISOString()
      });
      console.log('Admin account seeded');
    }
  } catch (e) {
    console.error('DB init error:', e.message || e);
    console.error('DATABASE_URL set:', !!process.env.DATABASE_URL);
    console.error('Full error:', e);
    process.exit(1);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`iWrite4.me running on port ${PORT}`);
  });
}

start();
