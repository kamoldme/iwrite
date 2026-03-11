const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

async function seed() {
  const hash = await bcrypt.hash('admin123', 12);
  const admin = {
    id: uuid(),
    name: 'Admin',
    email: 'admin@iwrite.app',
    password: hash,
    role: 'admin',
    plan: 'premium',
    xp: 0,
    level: 1,
    streak: 0,
    longestStreak: 0,
    lastWritingDate: null,
    treeStage: 0,
    totalWords: 0,
    totalSessions: 0,
    achievements: [],
    createdAt: new Date().toISOString()
  };

  fs.writeFileSync(path.join(dataDir, 'users.json'), JSON.stringify([admin], null, 2));
  fs.writeFileSync(path.join(dataDir, 'documents.json'), '[]');
  fs.writeFileSync(path.join(dataDir, 'comments.json'), '[]');

  console.log('Database seeded.');
  console.log('Admin: admin@iwrite.app / admin123');
}

seed();
