const express = require('express');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const { findOne, findMany } = require('../utils/storage');
const { hydrateStories } = require('./stories');

const router = express.Router();

function getOptionalViewer(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;
  try {
    return jwt.verify(token, process.env.JWT_SECRET || 'iwrite-dev-secret-change-in-production');
  } catch {
    return null;
  }
}

// GET /api/profiles/:username — public profile data
router.get('/:username', async (req, res) => {
  try {
    const user = await findOne('users.json', u => u.username && u.username.toLowerCase() === req.params.username.toLowerCase());
    if (!user) return res.status(404).json({ error: 'User not found' });

    const viewer = getOptionalViewer(req);
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));

    // Get published stories for this user
    const allStories = await findMany('stories.json', s => s.userId === user.id && s.status === 'published');
    const totalStories = allStories.length;

    // Sort newest first
    allStories.sort((a, b) => new Date(b.publishedAt || b.updatedAt || 0) - new Date(a.publishedAt || a.updatedAt || 0));

    // Paginate
    const paginatedStories = allStories.slice((page - 1) * limit, page * limit);

    // Hydrate with engagement data
    const stories = await hydrateStories(paginatedStories, viewer ? viewer.id : null);

    // Check follow/friend status
    const isFollowing = viewer ? (user.followers || []).includes(viewer.id) : false;
    const isFriend = viewer ? (user.friends || []).includes(viewer.id) : false;

    res.json({
      id: user.id,
      name: user.name,
      username: user.username,
      avatar: user.avatar || null,
      banner: user.banner || null,
      bio: user.bio || '',
      plan: user.plan || 'free',
      level: user.level || 0,
      xp: user.xp || 0,
      streak: user.streak || 0,
      longestStreak: user.longestStreak || 0,
      treeStage: user.treeStage || 0,
      totalWords: user.totalWords || 0,
      totalSessions: user.totalSessions || 0,
      achievements: user.achievements || [],
      createdAt: user.createdAt,
      followerCount: (user.followers || []).length,
      followingCount: (user.following || []).length,
      storyCount: totalStories,
      isFollowing,
      isFriend,
      isOwnProfile: viewer ? viewer.id === user.id : false,
      stories,
      pagination: { page, limit, total: totalStories, pages: Math.ceil(totalStories / limit) }
    });
  } catch (err) {
    console.error('Profile error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/profiles/:username/activity — writing history for heatmap (last 30 days)
router.get('/:username/activity', async (req, res) => {
  try {
    const user = await findOne('users.json', u => u.username && u.username.toLowerCase() === req.params.username.toLowerCase());
    if (!user) return res.status(404).json({ error: 'User not found' });

    const docs = await findMany('documents.json', d => d.userId === user.id);
    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Count sessions per day
    const dayCounts = {};
    for (const doc of docs) {
      const created = new Date(doc.createdAt);
      if (created < thirtyDaysAgo) continue;
      const dayKey = created.toISOString().slice(0, 10); // YYYY-MM-DD
      dayCounts[dayKey] = (dayCounts[dayKey] || 0) + 1;
    }

    // Build array for last 30 days
    const activity = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      activity.push({ date: key, sessionCount: dayCounts[key] || 0 });
    }

    res.json(activity);
  } catch (err) {
    console.error('Activity error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/profiles/:username/og-image — auto-generated social card
router.get('/:username/og-image', async (req, res) => {
  try {
    const user = await findOne('users.json', u => u.username && u.username.toLowerCase() === req.params.username.toLowerCase());
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Check cache
    const ogDir = path.join(__dirname, '../data/og-cards');
    if (!fs.existsSync(ogDir)) fs.mkdirSync(ogDir, { recursive: true });
    const cachePath = path.join(ogDir, `${user.id}.jpg`);
    const metaPath = path.join(ogDir, `${user.id}.json`);

    // Check if cached version is fresh
    const currentMeta = JSON.stringify({ avatar: user.avatarUpdatedAt, name: user.name, level: user.level, streak: user.streak, words: user.totalWords, stories: 0, plan: user.plan });
    if (fs.existsSync(cachePath) && fs.existsSync(metaPath)) {
      const savedMeta = fs.readFileSync(metaPath, 'utf8');
      if (savedMeta === currentMeta) {
        res.type('image/jpeg');
        return res.sendFile(cachePath);
      }
    }

    // Generate SVG card
    const name = (user.name || 'Writer').replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const username = (user.username || '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const isPro = user.plan === 'premium';
    const level = user.level || 0;
    const streak = user.streak || 0;
    const words = (user.totalWords || 0).toLocaleString();
    const sessions = user.totalSessions || 0;

    const svg = `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
      <rect width="1200" height="630" fill="#0a0a0a"/>
      <rect x="0" y="0" width="1200" height="4" fill="#4ade80"/>
      <text x="80" y="200" font-family="sans-serif" font-size="48" font-weight="800" fill="#ffffff">${name}</text>
      <text x="80" y="250" font-family="sans-serif" font-size="24" fill="rgba(255,255,255,0.5)">@${username}${isPro ? '  ★ PRO' : ''}</text>
      <text x="80" y="340" font-family="sans-serif" font-size="20" fill="rgba(255,255,255,0.58)">Level ${level}  ·  ${streak}-day streak  ·  ${words} words  ·  ${sessions} sessions</text>
      <text x="80" y="540" font-family="sans-serif" font-size="22" font-weight="700" fill="#4ade80">iWrite4.me</text>
      <text x="1120" y="540" font-family="sans-serif" font-size="16" fill="rgba(255,255,255,0.3)" text-anchor="end">Writer Profile</text>
    </svg>`;

    // Composite avatar if exists
    let image = sharp(Buffer.from(svg));
    const avatarPath = path.join(__dirname, '../data/avatars', `${user.id}.jpg`);
    if (fs.existsSync(avatarPath)) {
      const avatarBuf = await sharp(avatarPath).resize(120, 120).png().toBuffer();
      // Create circular mask
      const circleMask = Buffer.from(`<svg width="120" height="120"><circle cx="60" cy="60" r="60" fill="white"/></svg>`);
      const maskedAvatar = await sharp(avatarBuf).composite([{ input: circleMask, blend: 'dest-in' }]).png().toBuffer();
      image = sharp(Buffer.from(svg)).composite([{ input: maskedAvatar, top: 380, left: 80 }]);
    }

    const buffer = await image.jpeg({ quality: 80 }).toBuffer();
    fs.writeFileSync(cachePath, buffer);
    fs.writeFileSync(metaPath, currentMeta);

    res.type('image/jpeg');
    res.send(buffer);
  } catch (err) {
    console.error('OG image error:', err);
    res.status(500).json({ error: 'Failed to generate image' });
  }
});

module.exports = router;
