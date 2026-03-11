const express = require('express');
const { findMany, findOne, updateOne, deleteOne } = require('../utils/storage');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, requireAdmin);

router.get('/users', (req, res) => {
  const users = findMany('users.json').map(({ password, ...u }) => u);
  res.json(users);
});

router.get('/users/:id', (req, res) => {
  const user = findOne('users.json', u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { password, ...safeUser } = user;
  res.json(safeUser);
});

router.patch('/users/:id', (req, res) => {
  const { role, plan } = req.body;
  const updates = {};
  if (role) updates.role = role;
  if (plan) updates.plan = plan;
  const updated = updateOne('users.json', u => u.id === req.params.id, updates);
  if (!updated) return res.status(404).json({ error: 'User not found' });
  const { password, ...safeUser } = updated;
  res.json(safeUser);
});

router.delete('/users/:id', (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete yourself' });
  }
  deleteOne('users.json', u => u.id === req.params.id);
  res.json({ success: true });
});

router.get('/documents', (req, res) => {
  const docs = findMany('documents.json');
  res.json(docs.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)));
});

router.get('/documents/:id', (req, res) => {
  const doc = findOne('documents.json', d => d.id === req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  res.json(doc);
});

router.post('/documents/:id/restore', (req, res) => {
  const updated = updateOne('documents.json', d => d.id === req.params.id, {
    deleted: false,
    deletedBySystem: false
  });
  if (!updated) return res.status(404).json({ error: 'Document not found' });
  res.json(updated);
});

router.get('/stats', (req, res) => {
  const users = findMany('users.json');
  const docs = findMany('documents.json');
  res.json({
    totalUsers: users.length,
    totalDocuments: docs.length,
    activeDocuments: docs.filter(d => !d.deleted).length,
    abandonedDocuments: docs.filter(d => d.deletedBySystem).length,
    totalWords: users.reduce((sum, u) => sum + (u.totalWords || 0), 0),
    premiumUsers: users.filter(u => u.plan === 'premium').length
  });
});

module.exports = router;
