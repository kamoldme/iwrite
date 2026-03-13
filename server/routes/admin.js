const express = require('express');
const { findMany, findOne, updateOne, deleteOne, insertOne } = require('../utils/storage');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { logAction } = require('../utils/logger');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');

const router = express.Router();
router.use(authenticate, requireAdmin);

// ===== STATS =====
router.get('/stats', (req, res) => {
  const users = findMany('users.json');
  const docs = findMany('documents.json');
  const support = findMany('support.json');
  const logs = findMany('logs.json');
  res.json({
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
router.get('/users', (req, res) => {
  const users = findMany('users.json').map(({ password, ...u }) => u);
  res.json(users);
});

router.get('/users/:id', (req, res) => {
  const user = findOne('users.json', u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { password, ...safeUser } = user;

  // Include user's documents and friends info
  const docs = findMany('documents.json', d => d.userId === user.id);
  const friends = (user.friends || []).map(fid => {
    const f = findOne('users.json', u => u.id === fid);
    return f ? { id: f.id, name: f.name, email: f.email } : null;
  }).filter(Boolean);

  res.json({
    ...safeUser,
    documents: docs,
    friendsList: friends,
    totalDocuments: docs.length,
    activeDocuments: docs.filter(d => !d.deleted).length,
    abandonedDocuments: docs.filter(d => d.deletedBySystem).length
  });
});

router.patch('/users/:id', (req, res) => {
  const allowedFields = ['name', 'email', 'role', 'plan', 'xp', 'level', 'streak', 'longestStreak', 'treeStage', 'totalWords', 'totalSessions'];
  const updates = {};
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  }

  if (req.body.password) {
    updates.password = bcrypt.hashSync(req.body.password, 12);
  }

  const old = findOne('users.json', u => u.id === req.params.id);
  if (!old) return res.status(404).json({ error: 'User not found' });

  const updated = updateOne('users.json', u => u.id === req.params.id, updates);
  const { password, ...safeUser } = updated;

  logAction('user_updated', { userId: req.params.id, changes: Object.keys(updates) }, req.user.id);
  res.json(safeUser);
});

router.delete('/users/:id', (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete yourself' });
  }
  const user = findOne('users.json', u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  deleteOne('users.json', u => u.id === req.params.id);
  logAction('user_deleted', { userId: req.params.id, name: user.name, email: user.email }, req.user.id);
  res.json({ success: true });
});

// ===== DOCUMENTS =====
router.get('/documents', (req, res) => {
  const docs = findMany('documents.json');
  const users = findMany('users.json');
  const userMap = {};
  users.forEach(u => { userMap[u.id] = u.name; });

  res.json(docs.map(d => ({
    ...d,
    ownerName: userMap[d.userId] || 'Unknown'
  })).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)));
});

router.get('/documents/:id', (req, res) => {
  const doc = findOne('documents.json', d => d.id === req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  const owner = findOne('users.json', u => u.id === doc.userId);
  res.json({ ...doc, ownerName: owner ? owner.name : 'Unknown' });
});

router.patch('/documents/:id', (req, res) => {
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

  const updated = updateOne('documents.json', d => d.id === req.params.id, updates);
  if (!updated) return res.status(404).json({ error: 'Document not found' });

  logAction('document_updated', { docId: req.params.id, changes: Object.keys(updates) }, req.user.id);
  res.json(updated);
});

router.post('/documents/:id/restore', (req, res) => {
  const updated = updateOne('documents.json', d => d.id === req.params.id, {
    deleted: false,
    deletedBySystem: false
  });
  if (!updated) return res.status(404).json({ error: 'Document not found' });

  logAction('document_restored', { docId: req.params.id, title: updated.title }, req.user.id);
  res.json(updated);
});

router.delete('/documents/:id', (req, res) => {
  const doc = findOne('documents.json', d => d.id === req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  deleteOne('documents.json', d => d.id === req.params.id);
  logAction('document_permanently_deleted', { docId: req.params.id, title: doc.title }, req.user.id);
  res.json({ success: true });
});

// ===== LOST FILES (abandoned/failed docs with >30 words) =====
router.get('/lost-files', (req, res) => {
  const docs = findMany('documents.json', d => d.deletedBySystem && (d.wordCount || 0) > 30);
  const users = findMany('users.json');
  const userMap = {};
  users.forEach(u => { userMap[u.id] = u.name; });

  res.json(docs.map(d => ({
    ...d,
    ownerName: userMap[d.userId] || 'Unknown',
    active: !d.deleted
  })).sort((a, b) => new Date(b.failedAt || b.updatedAt) - new Date(a.failedAt || a.updatedAt)));
});

router.post('/lost-files/:id/activate', (req, res) => {
  const updated = updateOne('documents.json', d => d.id === req.params.id, {
    deleted: false
  });
  if (!updated) return res.status(404).json({ error: 'Document not found' });

  logAction('lost_file_activated', { docId: req.params.id, title: updated.title, userId: updated.userId }, req.user.id);
  res.json(updated);
});

router.post('/lost-files/:id/deactivate', (req, res) => {
  const updated = updateOne('documents.json', d => d.id === req.params.id, {
    deleted: true
  });
  if (!updated) return res.status(404).json({ error: 'Document not found' });

  logAction('lost_file_deactivated', { docId: req.params.id, title: updated.title }, req.user.id);
  res.json(updated);
});

// ===== ACTIVITY LOGS =====
router.get('/logs', (req, res) => {
  const logs = findMany('logs.json');
  const users = findMany('users.json');
  const userMap = {};
  users.forEach(u => { userMap[u.id] = u.name; });

  res.json(logs.map(l => ({
    ...l,
    userName: userMap[l.userId] || 'System'
  })).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 200));
});

router.delete('/logs', (req, res) => {
  const { write } = require('../utils/storage');
  write('logs.json', []);
  logAction('logs_cleared', {}, req.user.id);
  res.json({ success: true });
});

// ===== SUPPORT TICKETS =====
router.get('/support', (req, res) => {
  const tickets = findMany('support.json');
  const users = findMany('users.json');
  const userMap = {};
  users.forEach(u => { userMap[u.id] = { name: u.name, email: u.email }; });

  res.json(tickets.map(t => ({
    ...t,
    userName: userMap[t.userId] ? userMap[t.userId].name : 'Unknown',
    userEmail: userMap[t.userId] ? userMap[t.userId].email : 'Unknown'
  })).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

router.patch('/support/:id', (req, res) => {
  const { status, adminReply } = req.body;
  const updates = {};
  if (status) updates.status = status;
  if (adminReply) {
    updates.adminReply = adminReply;
    updates.repliedAt = new Date().toISOString();
  }
  updates.updatedAt = new Date().toISOString();

  const updated = updateOne('support.json', t => t.id === req.params.id, updates);
  if (!updated) return res.status(404).json({ error: 'Ticket not found' });

  logAction('support_ticket_updated', { ticketId: req.params.id, status: updates.status }, req.user.id);
  res.json(updated);
});

router.delete('/support/:id', (req, res) => {
  deleteOne('support.json', t => t.id === req.params.id);
  res.json({ success: true });
});

// ===== DUELS =====
router.get('/duels', (req, res) => {
  const docs = findMany('documents.json');
  // Duels are tracked as documents with duel-related fields
  // For now return duel placeholder — the system can be expanded when duels are fully implemented
  res.json([]);
});

// ===== COMMENTS (admin view) =====
router.get('/comments', (req, res) => {
  const comments = findMany('comments.json');
  res.json(comments.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

module.exports = router;
