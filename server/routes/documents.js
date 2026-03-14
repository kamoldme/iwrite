const express = require('express');
const { v4: uuid } = require('uuid');
const { findOne, findMany, insertOne, updateOne, deleteOne } = require('../utils/storage');
const { authenticate } = require('../middleware/auth');
const { logAction } = require('../utils/logger');

// Activity generation for friends feed
const WORD_MILESTONES = [1000, 5000, 10000, 25000, 50000, 100000];
const STREAK_MILESTONES = [7, 14, 30, 50, 100];

function generateActivities(userId, userName, prevUser, newUser, wordCount, duration) {
  const activities = [];
  const now = new Date().toISOString();

  // Long session (>20 min)
  if (duration && duration >= 20) {
    activities.push({ id: uuid(), userId, type: 'long_session', data: { name: userName, duration: Math.round(duration) }, createdAt: now });
  }

  // Word milestones
  const prevWords = prevUser.totalWords || 0;
  const newWords = newUser.totalWords || 0;
  for (const milestone of WORD_MILESTONES) {
    if (prevWords < milestone && newWords >= milestone) {
      activities.push({ id: uuid(), userId, type: 'word_milestone', data: { name: userName, words: milestone }, createdAt: now });
    }
  }

  // Streak milestones
  const prevStreak = prevUser.streak || 0;
  const newStreak = newUser.streak || 0;
  for (const milestone of STREAK_MILESTONES) {
    if (prevStreak < milestone && newStreak >= milestone) {
      activities.push({ id: uuid(), userId, type: 'streak_milestone', data: { name: userName, streak: milestone }, createdAt: now });
    }
  }

  // Level up
  const prevLevel = calcLevel(prevUser.xp || 0);
  const newLevel = calcLevel(newUser.xp || 0);
  if (newLevel > prevLevel) {
    activities.push({ id: uuid(), userId, type: 'level_up', data: { name: userName, level: newLevel }, createdAt: now });
  }

  // Save activities
  for (const activity of activities) {
    insertOne('activities.json', activity);
  }
}

function calcLevel(xp) {
  let level = 0;
  let xpUsed = 0;
  let threshold = 300;
  while (xp >= xpUsed + threshold) {
    xpUsed += threshold;
    level++;
    threshold = Math.round(threshold * 1.25);
  }
  return level;
}

const router = express.Router();

router.use(authenticate);

router.get('/', (req, res) => {
  // Include system-deleted (failed) docs for history, admin-deactivated docs, but not manually deleted
  const docs = findMany('documents.json', d => d.userId === req.user.id && (!d.deleted || d.deletedBySystem || d.deactivatedByAdmin));
  res.json(docs.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)));
});

router.post('/', (req, res) => {
  const { title, content, mode } = req.body;
  const doc = {
    id: uuid(),
    userId: req.user.id,
    title: title || 'Untitled',
    content: content || '',
    mode: mode || 'normal',
    wordCount: (content || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').trim().split(/\s+/).filter(Boolean).length,
    xpEarned: 0,
    duration: 0,
    shareLinks: [],
    deleted: false,
    deletedBySystem: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  insertOne('documents.json', doc);
  res.status(201).json(doc);
});

router.get('/shared-with-me', (req, res) => {
  const user = findOne('users.json', u => u.id === req.user.id);
  const sharedTokens = user.sharedTokens || [];
  if (sharedTokens.length === 0) return res.json([]);

  const docs = findMany('documents.json');
  const result = [];
  for (const entry of sharedTokens) {
    const doc = docs.find(d => !d.deleted && d.shareLinks && d.shareLinks.some(s => s.token === entry.token));
    if (doc) {
      result.push({
        id: doc.id,
        title: doc.title,
        wordCount: doc.wordCount || 0,
        updatedAt: doc.updatedAt,
        createdAt: doc.createdAt,
        permission: entry.permission,
        token: entry.token
      });
    }
  }
  res.json(result);
});

// ===== FOLDER MANAGEMENT ===== (must be before /:id routes)
router.get('/folders/list', (req, res) => {
  const user = findOne('users.json', u => u.id === req.user.id);
  res.json(user.folders || []);
});

router.post('/folders', (req, res) => {
  const { name, parentFolder } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Folder name required' });
  const user = findOne('users.json', u => u.id === req.user.id);
  const folders = user.folders || [];
  const folder = { id: uuid(), name: name.trim(), parentFolder: parentFolder || null, createdAt: new Date().toISOString() };
  folders.push(folder);
  updateOne('users.json', u => u.id === req.user.id, { folders });
  res.status(201).json(folder);
});

router.patch('/folders/:folderId', (req, res) => {
  const user = findOne('users.json', u => u.id === req.user.id);
  const folders = user.folders || [];
  const folder = folders.find(f => f.id === req.params.folderId);
  if (!folder) return res.status(404).json({ error: 'Folder not found' });
  if (req.body.name !== undefined) folder.name = req.body.name.trim();
  if (req.body.parentFolder !== undefined) folder.parentFolder = req.body.parentFolder;
  updateOne('users.json', u => u.id === req.user.id, { folders });
  res.json(folder);
});

router.delete('/folders/:folderId', (req, res) => {
  const user = findOne('users.json', u => u.id === req.user.id);
  let folders = user.folders || [];
  // Collect folder and all descendants
  const toDelete = new Set();
  const collect = (id) => {
    toDelete.add(id);
    folders.filter(f => f.parentFolder === id).forEach(f => collect(f.id));
  };
  collect(req.params.folderId);
  const parent = folders.find(f => f.id === req.params.folderId)?.parentFolder || null;
  folders = folders.filter(f => !toDelete.has(f.id));
  updateOne('users.json', u => u.id === req.user.id, { folders });
  // Move docs from deleted folders to the parent folder
  const docs = findMany('documents.json', d => d.userId === req.user.id && toDelete.has(d.folder));
  docs.forEach(d => updateOne('documents.json', dd => dd.id === d.id, { folder: parent }));
  res.json({ success: true });
});

router.get('/:id', (req, res) => {
  const doc = findOne('documents.json', d => d.id === req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  const isOwner = doc.userId === req.user.id;
  const hasAccess = doc.shareLinks.some(
    s => s.userId === req.user.id || s.type === 'public'
  );
  if (!isOwner && !hasAccess) {
    return res.status(403).json({ error: 'Access denied' });
  }
  res.json(doc);
});

router.patch('/:id', (req, res) => {
  const doc = findOne('documents.json', d => d.id === req.params.id && d.userId === req.user.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  const updates = {};
  if (req.body.title !== undefined) updates.title = req.body.title;
  if (req.body.content !== undefined) {
    updates.content = req.body.content;
    updates.wordCount = req.body.content.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').trim().split(/\s+/).filter(Boolean).length;
  }
  if (req.body.folder !== undefined) updates.folder = req.body.folder;
  updates.updatedAt = new Date().toISOString();

  const updated = updateOne('documents.json', d => d.id === req.params.id, updates);
  res.json(updated);
});

router.delete('/:id', (req, res) => {
  const doc = findOne('documents.json', d => d.id === req.params.id && d.userId === req.user.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  updateOne('documents.json', d => d.id === req.params.id, { deleted: true });
  res.json({ success: true });
});

router.post('/:id/complete', (req, res) => {
  const { wordCount, duration, xpEarned } = req.body;
  const doc = findOne('documents.json', d => d.id === req.params.id && d.userId === req.user.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  // Don't count empty sessions — no XP, no streak, no stats
  if (!wordCount || wordCount <= 0) {
    const { password: _, ...safeUser } = findOne('users.json', u => u.id === req.user.id);
    return res.json({ document: doc, user: safeUser });
  }

  updateOne('documents.json', d => d.id === req.params.id, {
    wordCount: wordCount || doc.wordCount,
    duration: duration || 0,
    xpEarned: xpEarned || 0,
    updatedAt: new Date().toISOString()
  });

  const user = findOne('users.json', u => u.id === req.user.id);
  const today = new Date().toISOString().split('T')[0];
  const lastDate = user.lastWritingDate;
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  let newStreak;
  let newTreeStage;
  if (lastDate === today) {
    // already wrote today — no streak or tree change
    newStreak = user.streak;
    newTreeStage = user.treeStage || 0;
  } else if (lastDate === yesterday) {
    // streak continues — tree grows one stage
    newStreak = user.streak + 1;
    newTreeStage = Math.min(11, (user.treeStage || 0) + 1);
  } else {
    // streak broken — tree resets from the beginning
    newStreak = 1;
    newTreeStage = 1;
  }

  const totalWords = (user.totalWords || 0) + (wordCount || 0);

  const newXP = user.xp + (xpEarned || 0);
  const updatedUser = updateOne('users.json', u => u.id === req.user.id, {
    xp: newXP,
    level: calcLevel(newXP),
    streak: newStreak,
    longestStreak: Math.max(user.longestStreak, newStreak),
    lastWritingDate: today,
    treeStage: newTreeStage,
    totalWords,
    totalSessions: (user.totalSessions || 0) + 1
  });

  // Generate activities for friends feed
  try {
    generateActivities(req.user.id, user.name, user, { ...user, xp: newXP, totalWords, streak: newStreak }, wordCount, duration);
  } catch (e) { /* activity generation is non-critical */ }

  logAction('session_completed', { docId: req.params.id, wordCount, duration, xpEarned }, req.user.id);
  const { password: _, ...safeUser } = updatedUser;
  res.json({ document: findOne('documents.json', d => d.id === req.params.id), user: safeUser });
});

router.get('/:id/comments', (req, res) => {
  const doc = findOne('documents.json', d => d.id === req.params.id && d.userId === req.user.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  const comments = findMany('comments.json', c => c.documentId === doc.id && c.status === 'pending');
  res.json(comments);
});

router.get('/:id/comments/history', (req, res) => {
  const doc = findOne('documents.json', d => d.id === req.params.id && d.userId === req.user.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  const comments = findMany('comments.json', c => c.documentId === doc.id && c.status !== 'pending');
  res.json(comments.sort((a, b) => new Date(b.resolvedAt || b.createdAt) - new Date(a.resolvedAt || a.createdAt)));
});

router.post('/:id/share', (req, res) => {
  const { type } = req.body;
  if (!['view', 'comment', 'edit'].includes(type)) {
    return res.status(400).json({ error: 'Invalid share type' });
  }

  const doc = findOne('documents.json', d => d.id === req.params.id && d.userId === req.user.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  const shareLink = {
    id: uuid(),
    type,
    token: uuid().replace(/-/g, ''),
    createdAt: new Date().toISOString()
  };

  const links = [...doc.shareLinks, shareLink];
  updateOne('documents.json', d => d.id === req.params.id, { shareLinks: links });
  res.json(shareLink);
});

router.post('/:id/abandon', (req, res) => {
  const doc = findOne('documents.json', d => d.id === req.params.id && d.userId === req.user.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  const { reason } = req.body; // 'typing_stopped' | 'tab_left'
  updateOne('documents.json', d => d.id === req.params.id, {
    deletedBySystem: true,
    deleted: true,
    failReason: reason || 'unknown',
    failedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  logAction('session_failed', { docId: req.params.id, reason: reason || 'unknown', title: doc.title, wordCount: doc.wordCount }, req.user.id);
  res.json({ success: true, message: 'Document lost' });
});

module.exports = router;
