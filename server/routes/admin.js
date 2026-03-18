const express = require('express');
const { findMany, findOne, updateOne, deleteOne, insertOne, write } = require('../utils/storage');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { logAction } = require('../utils/logger');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');

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
  res.json(users);
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

router.patch('/users/:id', async (req, res) => {
  const allowedFields = ['name', 'email', 'role', 'plan', 'xp', 'level', 'streak', 'longestStreak', 'treeStage', 'totalWords', 'totalSessions'];
  const updates = {};
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  }

  if (req.body.password) {
    updates.password = bcrypt.hashSync(req.body.password, 12);
  }

  const old = await findOne('users.json', u => u.id === req.params.id);
  if (!old) return res.status(404).json({ error: 'User not found' });

  const updated = await updateOne('users.json', u => u.id === req.params.id, updates);
  const { password, ...safeUser } = updated;

  logAction('user_updated', { userId: req.params.id, changes: Object.keys(updates) }, req.user.id);
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
  const docs = await findMany('documents.json');
  const users = await findMany('users.json');
  const userMap = {};
  users.forEach(u => { userMap[u.id] = u.name; });

  res.json(docs.map(d => ({
    ...d,
    ownerName: userMap[d.userId] || 'Unknown'
  })).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)));
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

  res.json(logs.map(l => ({
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

module.exports = router;
