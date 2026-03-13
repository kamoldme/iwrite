require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
['users.json', 'documents.json', 'comments.json', 'logs.json', 'support.json'].forEach(file => {
  const p = path.join(dataDir, file);
  if (!fs.existsSync(p)) fs.writeFileSync(p, '[]');
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/documents', require('./routes/documents'));
app.use('/api/friends', require('./routes/friends'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/share', require('./routes/share'));
app.use('/api/support', require('./routes/support'));

const { findOne, findMany, insertOne } = require('./utils/storage');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');

// Seed admin account
(async () => {
  const admin = findOne('users.json', u => u.email === 'admin@iwrite.app');
  if (!admin) {
    const hash = await bcrypt.hash('Admin1234', 12);
    insertOne('users.json', {
      id: uuid(),
      name: 'Admin',
      email: 'admin@iwrite.app',
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
})();
app.get('/api/auth/google-client-id', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID || '';
  if (!clientId) {
    return res.status(500).json({ error: 'Google Client ID not configured' });
  }
  res.json({ clientId });
});

app.get('/api/stats/public', (req, res) => {
  const users = findMany('users.json');
  const docs = findMany('documents.json');
  res.json({
    totalWords: users.reduce((sum, u) => sum + (u.totalWords || 0), 0),
    totalSessions: docs.filter(d => !d.deleted && d.duration > 0).length,
    totalWriters: users.filter(u => u.role !== 'admin').length
  });
});

app.get('/api/leaderboard', (req, res) => {
  try {
    const users = findMany('users.json');
    const docs = findMany('documents.json');

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
          minutesWritten
        };
      })
      .sort((a, b) => b.totalWords - a.totalWords)
      .slice(0, 50)
      .map((entry, i) => ({ rank: i + 1, ...entry }));

    res.json(leaderboard);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load leaderboard' });
  }
});

app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'app.html'));
});
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});
app.get('/shared/:token', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'shared.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`iWrite running on port ${PORT}`);
});
