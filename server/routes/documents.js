const express = require('express');
const { v4: uuid } = require('uuid');
const { findOne, findMany, insertOne, updateOne, deleteOne } = require('../utils/storage');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.use(authenticate);

router.get('/', (req, res) => {
  const docs = findMany('documents.json', d => d.userId === req.user.id && !d.deleted);
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
    wordCount: (content || '').split(/\s+/).filter(Boolean).length,
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
    updates.wordCount = req.body.content.split(/\s+/).filter(Boolean).length;
  }
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

  let newStreak = user.streak;
  if (lastDate === today) {
    // already wrote today
  } else if (lastDate === yesterday) {
    newStreak += 1;
  } else {
    newStreak = 1;
  }

  const totalWords = (user.totalWords || 0) + (wordCount || 0);
  const treeStage = Math.min(10, Math.floor(totalWords / 500));

  const updatedUser = updateOne('users.json', u => u.id === req.user.id, {
    xp: user.xp + (xpEarned || 0),
    level: Math.floor((user.xp + (xpEarned || 0)) / 100) + 1,
    streak: newStreak,
    longestStreak: Math.max(user.longestStreak, newStreak),
    lastWritingDate: today,
    treeStage,
    totalWords,
    totalSessions: (user.totalSessions || 0) + 1
  });

  const { password: _, ...safeUser } = updatedUser;
  res.json({ document: findOne('documents.json', d => d.id === req.params.id), user: safeUser });
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

  updateOne('documents.json', d => d.id === req.params.id, {
    deletedBySystem: true,
    deleted: true,
    updatedAt: new Date().toISOString()
  });
  res.json({ success: true, message: 'Document lost due to tab abandonment' });
});

module.exports = router;
