const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
['users.json', 'documents.json', 'comments.json'].forEach(file => {
  const p = path.join(dataDir, file);
  if (!fs.existsSync(p)) fs.writeFileSync(p, '[]');
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/documents', require('./routes/documents'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/share', require('./routes/share'));

const { findMany } = require('./utils/storage');
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
        level: u.level || 1,
        streak: u.streak || 0,
        minutesWritten
      };
    })
    .sort((a, b) => b.totalWords - a.totalWords)
    .slice(0, 50)
    .map((entry, i) => ({ rank: i + 1, ...entry }));

  res.json(leaderboard);
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

app.listen(PORT, () => {
  console.log(`iWrite running at http://localhost:${PORT}`);
});
