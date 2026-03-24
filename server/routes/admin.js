const express = require('express');
const { findMany, findOne, updateOne, deleteOne, insertOne, write } = require('../utils/storage');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { logAction } = require('../utils/logger');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');

// Streak → tree stage mapping (30 days = max)
const TREE_STAGE_THRESHOLDS = [0, 1, 3, 5, 8, 11, 14, 17, 20, 23, 27, 30];
function streakToTreeStage(streak) {
  for (let i = TREE_STAGE_THRESHOLDS.length - 1; i >= 0; i--) {
    if (streak >= TREE_STAGE_THRESHOLDS[i]) return i;
  }
  return 0;
}

const router = express.Router();
router.use(authenticate, requireAdmin);

// ===== STATS =====
router.get('/stats', async (req, res) => {
  const users = await findMany('users.json');
  const docs = await findMany('documents.json');
  const support = await findMany('support.json');
  const logs = await findMany('logs.json');
  // Get active users count from the in-memory tracker on the main app
  const activeUsersMap = req.app.get('activeUsers');
  const activeNow = activeUsersMap ? activeUsersMap.size : 0;

  res.json({
    activeNow,
    totalUsers: users.filter(u => u.role !== 'admin').length,
    totalDocuments: docs.length,
    activeDocuments: docs.filter(d => !d.deleted).length,
    abandonedDocuments: docs.filter(d => d.deletedBySystem).length,
    totalWords: users.reduce((sum, u) => sum + (u.totalWords || 0), 0),
    premiumUsers: users.filter(u => u.plan === 'premium').length,
    openTickets: support.filter(t => t.status === 'open').length,
    totalLogs: logs.length
  });
});

// ===== USERS =====
router.get('/users', async (req, res) => {
  const users = (await findMany('users.json')).map(({ password, ...u }) => u);
  const docs = await findMany('documents.json');
  const docCounts = {};
  docs.forEach(d => { docCounts[d.userId] = (docCounts[d.userId] || 0) + 1; });
  res.json(users.map(u => ({ ...u, docCount: docCounts[u.id] || 0 })));
});

router.get('/users/:id', async (req, res) => {
  const user = await findOne('users.json', u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { password, ...safeUser } = user;

  // Include user's documents and friends info
  const docs = await findMany('documents.json', d => d.userId === user.id);
  const friendsList = [];
  for (const fid of (user.friends || [])) {
    const f = await findOne('users.json', u => u.id === fid);
    if (f) friendsList.push({ id: f.id, name: f.name, email: f.email });
  }

  res.json({
    ...safeUser,
    documents: docs,
    friendsList: friendsList,
    totalDocuments: docs.length,
    activeDocuments: docs.filter(d => !d.deleted).length,
    abandonedDocuments: docs.filter(d => d.deletedBySystem).length
  });
});

// Get a user's community posts (stories) — drafts + published
router.get('/users/:id/stories', async (req, res) => {
  const user = await findOne('users.json', u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const stories = await findMany('stories.json', s => s.userId === user.id);
  const likes = await findMany('story-likes.json');
  const comments = await findMany('story-comments.json');

  const enriched = stories.map(story => {
    const likeCount = likes.filter(l => l.storyId === story.id).length;
    const commentCount = comments.filter(c => c.storyId === story.id && c.status === 'approved').length;
    return { ...story, likeCount, commentCount };
  }).sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));

  res.json(enriched);
});

router.patch('/users/:id', async (req, res) => {
  const allowedFields = ['name', 'username', 'email', 'role', 'plan', 'xp', 'level', 'streak', 'longestStreak', 'treeStage', 'totalWords', 'totalSessions', 'planDuration', 'planStartedAt', 'planExpiresAt'];
  const updates = {};
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  }

  if (req.body.password) {
    updates.password = bcrypt.hashSync(req.body.password, 12);
  }

  // Auto-sync treeStage when streak is changed
  if (updates.streak !== undefined && updates.treeStage === undefined) {
    updates.treeStage = streakToTreeStage(updates.streak);
    // Also update lastWritingDate to today so the streak doesn't immediately reset
    if (updates.streak > 0) {
      updates.lastWritingDate = new Date().toISOString().split('T')[0];
    }
  }

  const old = await findOne('users.json', u => u.id === req.params.id);
  if (!old) return res.status(404).json({ error: 'User not found' });

  // Update longestStreak if the new streak exceeds it
  if (updates.streak !== undefined && updates.streak > (old.longestStreak || 0)) {
    updates.longestStreak = updates.streak;
  }

  const updated = await updateOne('users.json', u => u.id === req.params.id, updates);
  const { password, ...safeUser } = updated;

  logAction('user_updated', { userId: req.params.id, changes: Object.keys(updates) }, req.user.id);
  res.json(safeUser);
});

// Recalculate XP from user's completed documents
router.post('/users/:id/recalc-xp', async (req, res) => {
  const user = await findOne('users.json', u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const docs = await findMany('documents.json', d => d.userId === req.params.id && !d.deleted);
  const completed = docs.filter(d => d.xpEarned > 0);

  // Sum XP from each session's xpEarned field
  const totalXP = completed.reduce((sum, d) => sum + (d.xpEarned || 0), 0);
  const totalWords = completed.reduce((sum, d) => sum + (d.wordCount || 0), 0);

  res.json({ xp: totalXP, sessions: completed.length, totalWords });
});

// Set subscription plan with duration
router.post('/users/:id/subscription', async (req, res) => {
  const user = await findOne('users.json', u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { duration, customExpiresAt } = req.body; // '1m', '3m', '6m', '12m', 'infinite', 'custom', 'free'
  const updates = {};

  if (duration === 'free') {
    // Downgrade to free
    updates.plan = 'free';
    updates.planDuration = null;
    updates.planStartedAt = null;
    updates.planExpiresAt = null;
    updates.planExpired = false;
  } else {
    updates.plan = 'premium';
    updates.planDuration = duration;
    updates.planStartedAt = new Date().toISOString();

    if (duration === 'infinite') {
      updates.planExpiresAt = 'infinite';
    } else if (duration === 'custom') {
      if (!customExpiresAt) return res.status(400).json({ error: 'Custom expiry date is required' });
      const expDate = new Date(customExpiresAt);
      if (isNaN(expDate.getTime()) || expDate <= new Date()) {
        return res.status(400).json({ error: 'Expiry date must be a valid future date' });
      }
      updates.planExpiresAt = expDate.toISOString();
    } else {
      const months = { '1m': 1, '3m': 3, '6m': 6, '12m': 12 };
      const m = months[duration];
      if (!m) return res.status(400).json({ error: 'Invalid duration. Use: 1m, 3m, 6m, 12m, infinite, custom, or free' });
      const expiresAt = new Date();
      expiresAt.setMonth(expiresAt.getMonth() + m);
      updates.planExpiresAt = expiresAt.toISOString();
    }
    updates.planExpired = false;
  }

  const updated = await updateOne('users.json', u => u.id === req.params.id, updates);
  const { password, ...safeUser } = updated;

  logAction('subscription_changed', {
    userId: req.params.id,
    duration,
    planExpiresAt: updates.planExpiresAt,
    changedBy: req.user.id
  }, req.user.id);

  res.json(safeUser);
});

router.delete('/users/:id', async (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete yourself' });
  }
  const user = await findOne('users.json', u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  await deleteOne('users.json', u => u.id === req.params.id);
  logAction('user_deleted', { userId: req.params.id, name: user.name, email: user.email }, req.user.id);
  res.json({ success: true });
});

// ===== DOCUMENTS =====
router.get('/documents', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(10, parseInt(req.query.limit) || 50));
  const search = (req.query.search || '').trim().toLowerCase();

  const allDocs = await findMany('documents.json');
  const users = await findMany('users.json');
  const userMap = {};
  users.forEach(u => { userMap[u.id] = u.name; });

  let docs = allDocs.map(d => ({
    ...d,
    ownerName: userMap[d.userId] || 'Unknown'
  })).sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));

  // Server-side filtering — supports structured filters (status=active, mode=dangerous, words>100) and plain text
  if (search) {
    const isStructured = /\w+\s*[=><!]+\s*\w+/.test(search);
    if (isStructured) {
      const parts = search.split(',').map(s => s.trim()).filter(Boolean);
      for (const part of parts) {
        const m = part.match(/^(\w+)\s*([=><!]+)\s*(.+)$/);
        if (m) {
          const col = m[1].toLowerCase();
          const op = m[2];
          const val = m[3].trim().toLowerCase();
          docs = docs.filter(d => {
            if (col === 'status') {
              const s = d.deletedBySystem ? 'lost' : d.deleted ? 'deleted' : (!d.duration || d.duration === 0) ? 'ongoing' : 'active';
              return s === val || s.includes(val);
            }
            if (col === 'mode') return (d.mode || 'normal').toLowerCase() === val;
            if (col === 'owner') return (d.ownerName || '').toLowerCase().includes(val);
            if (col === 'title') return (d.title || '').toLowerCase().includes(val);
            if (col === 'words' || col === 'wordcount') {
              const w = d.wordCount || 0;
              const n = parseInt(val);
              if (isNaN(n)) return true;
              if (op === '>') return w > n;
              if (op === '<') return w < n;
              if (op === '>=' || op === '=>') return w >= n;
              if (op === '<=' || op === '=<') return w <= n;
              return w === n;
            }
            if (col === 'date') return (d.updatedAt || '').toLowerCase().includes(val);
            return true;
          });
        }
      }
    } else {
      docs = docs.filter(d =>
        (d.title || '').toLowerCase().includes(search) ||
        (d.ownerName || '').toLowerCase().includes(search)
      );
    }
  }

  const total = docs.length;
  const totalPages = Math.ceil(total / limit);
  const offset = (page - 1) * limit;
  const paginated = docs.slice(offset, offset + limit);

  res.json({ items: paginated, page, totalPages, total, limit });
});

router.get('/documents/:id', async (req, res) => {
  const doc = await findOne('documents.json', d => d.id === req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  const owner = await findOne('users.json', u => u.id === doc.userId);
  res.json({ ...doc, ownerName: owner ? owner.name : 'Unknown' });
});

router.patch('/documents/:id', async (req, res) => {
  const allowedFields = ['title', 'content', 'deleted', 'deletedBySystem'];
  const updates = {};
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  }
  // If admin is setting deleted to true (deactivating), mark it
  if (req.body.deleted === true) {
    updates.deactivatedByAdmin = true;
    updates.deactivatedAt = new Date().toISOString();
  }
  // If admin is restoring (deleted = false), clear the admin flag
  if (req.body.deleted === false) {
    updates.deactivatedByAdmin = false;
  }
  updates.updatedAt = new Date().toISOString();

  const updated = await updateOne('documents.json', d => d.id === req.params.id, updates);
  if (!updated) return res.status(404).json({ error: 'Document not found' });

  logAction('document_updated', { docId: req.params.id, changes: Object.keys(updates) }, req.user.id);
  res.json(updated);
});

router.post('/documents/:id/restore', async (req, res) => {
  const updated = await updateOne('documents.json', d => d.id === req.params.id, {
    deleted: false,
    deletedBySystem: false,
    deactivatedByAdmin: false
  });
  if (!updated) return res.status(404).json({ error: 'Document not found' });

  logAction('document_restored', { docId: req.params.id, title: updated.title }, req.user.id);
  res.json(updated);
});

router.delete('/documents/:id', async (req, res) => {
  const doc = await findOne('documents.json', d => d.id === req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  await deleteOne('documents.json', d => d.id === req.params.id);
  logAction('document_permanently_deleted', { docId: req.params.id, title: doc.title }, req.user.id);
  res.json({ success: true });
});

// ===== LOST FILES (abandoned/failed docs with >30 words) =====
router.get('/lost-files', async (req, res) => {
  const docs = await findMany('documents.json', d => d.deletedBySystem && (d.wordCount || 0) > 30);
  const users = await findMany('users.json');
  const userMap = {};
  users.forEach(u => { userMap[u.id] = u.name; });

  res.json(docs.map(d => ({
    ...d,
    ownerName: userMap[d.userId] || 'Unknown',
    active: !d.deleted
  })).sort((a, b) => new Date(b.failedAt || b.updatedAt) - new Date(a.failedAt || a.updatedAt)));
});

router.post('/lost-files/:id/activate', async (req, res) => {
  const updated = await updateOne('documents.json', d => d.id === req.params.id, {
    deleted: false
  });
  if (!updated) return res.status(404).json({ error: 'Document not found' });

  logAction('lost_file_activated', { docId: req.params.id, title: updated.title, userId: updated.userId }, req.user.id);
  res.json(updated);
});

router.post('/lost-files/:id/deactivate', async (req, res) => {
  const updated = await updateOne('documents.json', d => d.id === req.params.id, {
    deleted: true
  });
  if (!updated) return res.status(404).json({ error: 'Document not found' });

  logAction('lost_file_deactivated', { docId: req.params.id, title: updated.title }, req.user.id);
  res.json(updated);
});

// ===== ACTIVITY LOGS =====
router.get('/logs', async (req, res) => {
  const logs = await findMany('logs.json');
  const users = await findMany('users.json');
  const userMap = {};
  users.forEach(u => { userMap[u.id] = u.name; });

  res.json(logs.filter(l => l.action !== 'pageview').map(l => ({
    ...l,
    userName: userMap[l.userId] || 'System'
  })).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 200));
});

router.delete('/logs', async (req, res) => {
  await write('logs.json', []);
  logAction('logs_cleared', {}, req.user.id);
  res.json({ success: true });
});

// ===== SUPPORT TICKETS =====
router.get('/support', async (req, res) => {
  const tickets = await findMany('support.json');
  const users = await findMany('users.json');
  const userMap = {};
  users.forEach(u => { userMap[u.id] = { name: u.name, email: u.email }; });

  res.json(tickets.map(t => ({
    ...t,
    userName: userMap[t.userId] ? userMap[t.userId].name : 'Unknown',
    userEmail: userMap[t.userId] ? userMap[t.userId].email : 'Unknown'
  })).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

router.patch('/support/:id', async (req, res) => {
  const { status, adminReply } = req.body;
  const updates = {};
  if (status) updates.status = status;
  if (adminReply) {
    updates.adminReply = adminReply;
    updates.repliedAt = new Date().toISOString();
  }
  updates.updatedAt = new Date().toISOString();

  const updated = await updateOne('support.json', t => t.id === req.params.id, updates);
  if (!updated) return res.status(404).json({ error: 'Ticket not found' });

  logAction('support_ticket_updated', { ticketId: req.params.id, status: updates.status }, req.user.id);
  res.json(updated);
});

router.delete('/support/:id', async (req, res) => {
  await deleteOne('support.json', t => t.id === req.params.id);
  res.json({ success: true });
});

// ===== DUELS =====
router.get('/duels', async (req, res) => {
  const duels = await findMany('duels.json');
  const users = await findMany('users.json');
  const getName = (id) => {
    const u = users.find(u => u.id === id);
    return u ? u.name : 'Unknown';
  };
  const enriched = duels.map(d => ({
    ...d,
    challengerName: getName(d.challengerId),
    opponentName: getName(d.opponentId)
  })).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(enriched);
});

// ===== COMMENTS (admin view) =====
router.get('/comments', async (req, res) => {
  const comments = await findMany('comments.json');
  res.json(comments.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

// ===== STORIES =====
router.get('/stories', async (req, res) => {
  const stories = await findMany('stories.json');
  const users = await findMany('users.json');
  const likes = await findMany('story-likes.json');
  const comments = await findMany('story-comments.json');
  const userMap = new Map(users.map(u => [u.id, u]));

  const enriched = stories.map(story => {
    const author = userMap.get(story.userId);
    const likeCount = likes.filter(l => l.storyId === story.id).length;
    const commentCount = comments.filter(c => c.storyId === story.id && c.status === 'approved').length;
    const pendingComments = comments.filter(c => c.storyId === story.id && c.status === 'pending').length;

    return {
      ...story,
      authorName: author ? author.name : 'Unknown',
      authorUsername: author ? (author.username || null) : null,
      likeCount,
      commentCount,
      pendingComments
    };
  }).sort((a, b) => new Date(b.submittedAt || b.updatedAt || b.createdAt) - new Date(a.submittedAt || a.updatedAt || a.createdAt));

  res.json(enriched);
});

router.patch('/stories/:id', async (req, res) => {
  const story = await findOne('stories.json', s => s.id === req.params.id);
  if (!story) return res.status(404).json({ error: 'Story not found' });

  const updates = {
    reviewedAt: new Date().toISOString()
  };

  if (req.body.status !== undefined) {
    const allowed = ['draft', 'pending_review', 'changes_requested', 'rejected', 'published', 'hidden'];
    if (!allowed.includes(req.body.status)) {
      return res.status(400).json({ error: 'Invalid story status' });
    }
    updates.status = req.body.status;
    if (req.body.status === 'published' && !story.publishedAt) {
      updates.publishedAt = new Date().toISOString();
    }
    if (req.body.status !== 'published' && req.body.status !== 'hidden') {
      updates.publishedAt = null;
    }
  }

  if (req.body.moderationNote !== undefined) updates.moderationNote = req.body.moderationNote;
  if (req.body.commentsLocked !== undefined) {
    updates.commentsLocked = !!req.body.commentsLocked;
    if (!req.body.commentsLocked && req.body.allowComments === undefined && story.allowComments === false) {
      updates.allowComments = true;
    }
  }
  if (req.body.allowComments !== undefined) updates.allowComments = !!req.body.allowComments;

  const updated = await updateOne('stories.json', s => s.id === req.params.id, updates);

  if (
    updated &&
    updates.status === 'changes_requested' &&
    updated.sourceDocumentId &&
    typeof updates.moderationNote === 'string' &&
    updates.moderationNote.trim()
  ) {
    await insertOne('comments.json', {
      id: uuid(),
      userId: req.user.id,
      author: 'iWrite Editorial',
      text: updates.moderationNote.trim(),
      highlightedText: null,
      startOffset: null,
      endOffset: null,
      status: 'pending',
      documentId: updated.sourceDocumentId,
      storyId: updated.id,
      source: 'story_moderation',
      createdAt: new Date().toISOString()
    });
  }

  res.json(updated);
});

router.delete('/stories/:id', async (req, res) => {
  const deleted = await deleteOne('stories.json', s => s.id === req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Story not found' });

  const storyComments = await findMany('story-comments.json', c => c.storyId === req.params.id);
  const storyLikes = await findMany('story-likes.json', l => l.storyId === req.params.id);
  for (const comment of storyComments) {
    await deleteOne('story-comments.json', c => c.id === comment.id);
  }
  for (const like of storyLikes) {
    await deleteOne('story-likes.json', l => l.id === like.id);
  }

  res.json({ success: true });
});

router.get('/story-comments', async (req, res) => {
  const storyComments = await findMany('story-comments.json');
  const stories = await findMany('stories.json');
  const users = await findMany('users.json');
  const storyMap = new Map(stories.map(s => [s.id, s]));
  const userMap = new Map(users.map(u => [u.id, u]));

  res.json(storyComments.map(comment => {
    const story = storyMap.get(comment.storyId);
    const author = userMap.get(comment.userId);
    return {
      ...comment,
      storyTitle: story ? story.title : 'Unknown story',
      storyStatus: story ? story.status : null,
      authorName: author ? author.name : comment.authorName || 'Unknown'
    };
  }).sort((a, b) => {
    if (a.status === 'pending' && b.status !== 'pending') return -1;
    if (a.status !== 'pending' && b.status === 'pending') return 1;
    return new Date(b.createdAt) - new Date(a.createdAt);
  }));
});

router.patch('/story-comments/:id', async (req, res) => {
  const status = req.body.status;
  if (!['approved', 'rejected', 'hidden', 'pending'].includes(status)) {
    return res.status(400).json({ error: 'Invalid comment status' });
  }

  const updated = await updateOne('story-comments.json', c => c.id === req.params.id, {
    status,
    moderatedAt: new Date().toISOString(),
    moderatedBy: req.user.id
  });
  if (!updated) return res.status(404).json({ error: 'Story comment not found' });

  res.json(updated);
});

// ===== STRIPE: SUBSCRIBER LIST =====
router.get('/subscribers', async (req, res) => {
  try {
    const users = await findMany('users.json');
    const subscribers = users
      .filter(u => u.plan === 'premium' || u.planPaymentFailed)
      .map(u => ({
        id: u.id,
        name: u.name,
        email: u.email,
        username: u.username || null,
        planSource: u.planSource || null,
        planDuration: u.planDuration || null,
        planStartedAt: u.planStartedAt || null,
        planExpiresAt: u.planExpiresAt || null,
        planPaymentFailed: u.planPaymentFailed || false,
        trialUsed: u.trialUsed || false,
        stripeCustomerId: u.stripeCustomerId || null,
        stripeSubscriptionId: u.stripeSubscriptionId || null,
        createdAt: u.createdAt
      }))
      .sort((a, b) => new Date(b.planStartedAt || b.createdAt) - new Date(a.planStartedAt || a.createdAt));

    res.json(subscribers);
  } catch (err) {
    console.error('Subscribers list error:', err);
    res.status(500).json({ error: 'Failed to load subscribers' });
  }
});

// ===== REFERRAL TRACTION =====
router.get('/referrals', async (req, res) => {
  try {
    const users = await findMany('users.json');

    // Build a map of referralCode → user for fast lookup
    const codeToUser = {};
    users.forEach(u => {
      if (u.referralCode) codeToUser[u.referralCode] = u;
    });

    // Find all users who have at least 1 referral
    const referrers = users
      .filter(u => (u.referralCount || 0) > 0)
      .map(u => {
        // Find all users referred by this person
        const referred = users
          .filter(r => r.referredBy === u.referralCode)
          .map(r => ({
            id: r.id,
            name: r.name,
            username: r.username || null,
            email: r.email,
            plan: r.plan || 'free',
            joinedAt: r.createdAt,
            totalWords: r.totalWords || 0,
            totalSessions: r.totalSessions || 0,
            streak: r.streak || 0
          }))
          .sort((a, b) => new Date(b.joinedAt) - new Date(a.joinedAt));

        return {
          id: u.id,
          name: u.name,
          username: u.username || null,
          email: u.email,
          plan: u.plan || 'free',
          referralCode: u.referralCode,
          referralCount: u.referralCount || 0,
          proRewardsEarned: Math.floor((u.referralCount || 0) / 5),
          referred
        };
      })
      .sort((a, b) => b.referralCount - a.referralCount);

    // Also get users who joined via referral but whose referrer has 0 count (edge case)
    const totalReferred = users.filter(u => u.referredBy).length;

    res.json({ referrers, totalReferred, totalReferrers: referrers.length });
  } catch (err) {
    console.error('Referrals error:', err);
    res.status(500).json({ error: 'Failed to load referral data' });
  }
});

// ===== STRIPE: PROMO CODE MANAGEMENT =====
// All promo codes live in Stripe — we're a thin wrapper around the Stripe API

router.get('/promo-codes', async (req, res) => {
  try {
    const Stripe = require('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    const promotionCodes = await stripe.promotionCodes.list({
      limit: 50,
      expand: ['data.coupon']
    });

    const codes = promotionCodes.data.map(pc => ({
      id: pc.id,
      code: pc.code,
      active: pc.active,
      couponId: pc.coupon.id,
      percentOff: pc.coupon.percent_off,
      amountOff: pc.coupon.amount_off,
      currency: pc.coupon.currency,
      duration: pc.coupon.duration,
      durationInMonths: pc.coupon.duration_in_months,
      timesRedeemed: pc.times_redeemed,
      maxRedemptions: pc.max_redemptions,
      expiresAt: pc.expires_at ? new Date(pc.expires_at * 1000).toISOString() : null,
      created: new Date(pc.created * 1000).toISOString()
    }));

    res.json(codes);
  } catch (err) {
    console.error('Promo codes list error:', err);
    res.status(500).json({ error: 'Failed to load promo codes' });
  }
});

router.post('/promo-codes', async (req, res) => {
  try {
    const Stripe = require('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    const { code, percentOff, duration, durationInMonths, maxRedemptions } = req.body;

    if (!code || !percentOff) {
      return res.status(400).json({ error: 'Code and percentOff are required' });
    }

    // Create a coupon first
    const couponConfig = {
      percent_off: parseFloat(percentOff),
      duration: duration || 'once'
    };
    if (duration === 'repeating' && durationInMonths) {
      couponConfig.duration_in_months = parseInt(durationInMonths);
    }

    const coupon = await stripe.coupons.create(couponConfig);

    // Then create a promotion code with the specified code string
    const promoConfig = {
      coupon: coupon.id,
      code: code.toUpperCase()
    };
    if (maxRedemptions) {
      promoConfig.max_redemptions = parseInt(maxRedemptions);
    }

    const promotionCode = await stripe.promotionCodes.create(promoConfig);

    logAction('promo_code_created', {
      code: promotionCode.code,
      percentOff,
      duration
    }, req.user.id);

    res.json({
      id: promotionCode.id,
      code: promotionCode.code,
      active: promotionCode.active,
      percentOff: coupon.percent_off
    });
  } catch (err) {
    console.error('Promo code create error:', err);
    res.status(500).json({ error: err.message || 'Failed to create promo code' });
  }
});

router.post('/promo-codes/:id/deactivate', async (req, res) => {
  try {
    const Stripe = require('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    const promotionCode = await stripe.promotionCodes.update(req.params.id, {
      active: false
    });

    logAction('promo_code_deactivated', {
      promoId: req.params.id,
      code: promotionCode.code
    }, req.user.id);

    res.json({ success: true, active: false });
  } catch (err) {
    console.error('Promo code deactivate error:', err);
    res.status(500).json({ error: 'Failed to deactivate promo code' });
  }
});

module.exports = router;
