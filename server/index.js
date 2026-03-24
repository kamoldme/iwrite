require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// Real-time streak: returns 0 if lastWritingDate is stale (older than yesterday)
function liveStreak(user) {
  if (!user.lastWritingDate || !user.streak) return 0;
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  if (user.lastWritingDate === today || user.lastWritingDate === yesterday) return user.streak;
  return 0;
}

// Trust Railway's reverse proxy
app.set('trust proxy', 1);

// CORS — lock to your domain
const allowedOrigins = [
  'https://iwrite4.me',
  'https://www.iwrite4.me',
  'https://write4.me',
  'https://www.write4.me',
  'https://iwrite.up.railway.app'
];
if (process.env.NODE_ENV !== 'production') {
  allowedOrigins.push('http://localhost:3000', 'http://localhost:5173');
}
// Add Railway staging/public domain
if (process.env.RAILWAY_PUBLIC_DOMAIN) {
  allowedOrigins.push(`https://${process.env.RAILWAY_PUBLIC_DOMAIN}`);
}
// Add any Railway-provided URLs
if (process.env.RAILWAY_STATIC_URL) {
  allowedOrigins.push(`https://${process.env.RAILWAY_STATIC_URL}`);
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

// CRITICAL: Stripe webhook must be registered BEFORE apiLimiter and express.json()
// It needs raw body for signature verification and must not be rate-limited
const { stripeWebhookHandler } = require('./routes/stripe');
app.post('/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  stripeWebhookHandler
);

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
// Force no-cache on HTML/CSS/JS so deployments are instant
app.use((req, res, next) => {
  const url = req.url.split('?')[0];
  if (url.endsWith('.html') || url === '/' || url === '/app' || url === '/manual-login' || url.startsWith('/story/')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
  } else if (url.endsWith('.css') || url.endsWith('.js')) {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  }
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public')));

// Active users tracker (in-memory, 5-minute window)
const activeUsers = new Map(); // userId → { name, lastSeen }
app.set('activeUsers', activeUsers); // share with routes
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

// ===== MAINTENANCE MODE (in-memory) =====
const maintenanceState = {
  active: false,
  scheduledAt: null,  // ISO timestamp when maintenance should start
  startedAt: null,    // ISO timestamp when maintenance actually started
  message: 'Platform maintenance in progress. Please save your work.',
  countdownMinutes: 5
};
app.set('maintenanceState', maintenanceState);

// Public endpoint — polled by clients every 10s
app.get('/api/maintenance-status', (req, res) => {
  const ms = app.get('maintenanceState');
  if (!ms.active && !ms.scheduledAt) {
    return res.json({ active: false });
  }
  const now = Date.now();
  // Check if scheduled maintenance should auto-trigger
  if (ms.scheduledAt && !ms.active) {
    const triggerAt = new Date(ms.scheduledAt).getTime() - ms.countdownMinutes * 60 * 1000;
    if (now >= triggerAt) {
      ms.active = true;
      ms.startedAt = new Date().toISOString();
      ms.scheduledAt = null;
    }
  }
  if (!ms.active) {
    return res.json({ active: false, scheduled: ms.scheduledAt });
  }
  const elapsed = Math.floor((now - new Date(ms.startedAt).getTime()) / 1000);
  const countdownTotal = ms.countdownMinutes * 60;
  const remaining = Math.max(countdownTotal - elapsed, 0);
  res.json({
    active: true,
    message: ms.message,
    remaining,        // seconds until shutdown
    shutdownReady: remaining <= 0,
    startedAt: ms.startedAt
  });
});

// Admin endpoint — start/stop/schedule maintenance
app.post('/api/admin/maintenance', (req, res) => {
  // Inline auth check
  const { authenticate, requireAdmin } = require('./middleware/auth');
  authenticate(req, res, () => {
    requireAdmin(req, res, () => {
      const ms = app.get('maintenanceState');
      const { action, scheduledAt, message, countdownMinutes } = req.body;

      if (action === 'start') {
        ms.active = true;
        ms.startedAt = new Date().toISOString();
        ms.scheduledAt = null;
        if (message) ms.message = message;
        if (countdownMinutes) ms.countdownMinutes = countdownMinutes;
        return res.json({ ok: true, state: 'started', startedAt: ms.startedAt });
      }
      if (action === 'schedule') {
        ms.scheduledAt = scheduledAt;
        ms.active = false;
        ms.startedAt = null;
        if (message) ms.message = message;
        if (countdownMinutes) ms.countdownMinutes = countdownMinutes;
        return res.json({ ok: true, state: 'scheduled', scheduledAt: ms.scheduledAt });
      }
      if (action === 'cancel') {
        ms.active = false;
        ms.scheduledAt = null;
        ms.startedAt = null;
        return res.json({ ok: true, state: 'cancelled' });
      }
      res.status(400).json({ error: 'Invalid action. Use start, schedule, or cancel.' });
    });
  });
});

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

// Referral link — serve OG tags for social previews, then redirect browsers
app.get('/join/:code', async (req, res) => {
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  const isBot = /bot|crawler|spider|preview|telegram|whatsapp|slack|discord|facebook|twitter|linkedin|embedly|quora|pinterest/i.test(ua);

  if (!isBot) {
    return res.redirect(302, `/app?ref=${encodeURIComponent(req.params.code)}`);
  }

  // For bots/crawlers: serve HTML with OG meta for link preview
  const { findOne } = require('./utils/storage');
  const referrer = await findOne('users.json', u => u.referralCode === req.params.code);
  const name = referrer ? (referrer.name || '').split(' ')[0] : 'Someone';
  const streak = referrer ? (referrer.streak || 0) : 0;
  const words = referrer ? (referrer.totalWords || 0) : 0;
  const desc = `${name} invited you to iWrite4.me — a writing tool that keeps you focused. ${words > 0 ? `${words.toLocaleString()} words written${streak > 0 ? `, ${streak}-day streak` : ''}.` : 'If you stop typing, it deletes your work.'}`;
  const origin = `https://${req.get('host') || 'iwrite4.me'}`;

  res.send(`<!DOCTYPE html><html><head>
    <meta charset="UTF-8">
    <title>${name} invited you to iWrite4.me</title>
    <meta property="og:title" content="${name} invited you to iWrite4.me">
    <meta property="og:description" content="${desc}">
    <meta property="og:image" content="${origin}/og-image.png">
    <meta property="og:url" content="${origin}/join/${req.params.code}">
    <meta property="og:type" content="website">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${name} invited you to iWrite4.me">
    <meta name="twitter:description" content="${desc}">
    <meta name="twitter:image" content="${origin}/og-image.png">
    <meta http-equiv="refresh" content="0;url=/app?ref=${encodeURIComponent(req.params.code)}">
  </head><body></body></html>`);
});

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/documents', require('./routes/documents'));
app.use('/api/friends', require('./routes/friends'));
app.use('/api/stories', require('./routes/stories'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/share', require('./routes/share'));
app.use('/api/support', require('./routes/support'));
app.use('/api/duels', require('./routes/duels'));
app.use('/api/stripe', require('./routes/stripe').router);

const { findOne, findMany, insertOne, updateOne } = require('./utils/storage');
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
          id: u.id,
          name: u.name,
          username: u.username || null,
          totalWords: u.totalWords || 0,
          totalSessions: u.totalSessions || 0,
          xp: u.xp || 0,
          level: u.level || 0,
          streak: liveStreak(u),
          minutesWritten,
          avatar: u.avatar || null,
          avatarUpdatedAt: u.avatarUpdatedAt || null,
          plan: u.plan || 'free'
        };
      })
      .sort((a, b) => b.streak - a.streak || b.totalWords - a.totalWords)
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
app.get('/story/:id', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'story.html'));
});
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'privacy.html'));
});
app.get('/terms', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'terms.html'));
});

/// Public user lookup by username (for invite popup)
app.get('/api/users/lookup/:username', async (req, res) => {
  try {
    const { findOne } = require('./utils/storage');
    const user = await findOne('users.json', u => u.username && u.username.toLowerCase() === req.params.username.toLowerCase());
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ name: user.name, username: user.username });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// Invite route: /invite/:username → OG tags for bots, redirect for browsers
app.get('/invite/:username', async (req, res) => {
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  const isBot = /bot|crawler|spider|preview|telegram|whatsapp|slack|discord|facebook|twitter|linkedin|embedly|quora|pinterest/i.test(ua);
  const username = req.params.username;

  if (!isBot) {
    return res.redirect(302, `/app?invite=${encodeURIComponent(username)}&view=friends`);
  }

  // For bots/crawlers: serve HTML with OG meta for link preview
  const { findOne } = require('./utils/storage');
  const user = await findOne('users.json', u => u.username && u.username.toLowerCase() === username.toLowerCase());
  const name = user ? (user.name || username) : username;
  const streak = user ? liveStreak(user) : 0;
  const words = user ? (user.totalWords || 0) : 0;
  const level = user ? (user.level || 1) : 1;
  const sessions = user ? (user.totalSessions || 0) : 0;
  const desc = `${name} wants to be your writing buddy on iWrite4.me! ${words > 0 ? `${words.toLocaleString()} words written · Level ${level}${streak > 0 ? ` · ${streak}-day streak` : ''} · ${sessions} sessions.` : 'A distraction-free writing tool — if you stop typing, it deletes your work.'}`;
  const origin = `https://${req.get('host') || 'iwrite4.me'}`;

  res.send(`<!DOCTYPE html><html><head>
    <meta charset="UTF-8">
    <title>Write with ${name} on iWrite4.me</title>
    <meta property="og:title" content="Write with ${name} on iWrite4.me">
    <meta property="og:description" content="${desc}">
    <meta property="og:image" content="${origin}/og-image.png">
    <meta property="og:url" content="${origin}/invite/${encodeURIComponent(username)}">
    <meta property="og:type" content="website">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="Write with ${name} on iWrite4.me">
    <meta name="twitter:description" content="${desc}">
    <meta name="twitter:image" content="${origin}/og-image.png">
    <meta http-equiv="refresh" content="0;url=/app?invite=${encodeURIComponent(username)}&view=friends">
  </head><body></body></html>`);
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

    // Migrate: assign random usernames to existing users without one
    const allUsers = await findMany('users.json');
    const adjectives = ['swift', 'bright', 'quiet', 'bold', 'keen', 'wild', 'calm', 'warm', 'cool', 'free'];
    const nouns = ['writer', 'scribe', 'author', 'poet', 'muse', 'quill', 'ink', 'page', 'story', 'word'];
    let migrated = 0;
    for (const u of allUsers) {
      if (!u.username) {
        const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
        const noun = nouns[Math.floor(Math.random() * nouns.length)];
        const num = Math.floor(Math.random() * 9999);
        await updateOne('users.json', usr => usr.id === u.id, { username: `${adj}_${noun}_${num}` });
        migrated++;
      }
    }
    if (migrated > 0) console.log(`Assigned random usernames to ${migrated} existing users`);
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
