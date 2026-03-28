const express = require('express');
const { findMany, insertOne, findOne } = require('../utils/storage');
const { authenticate } = require('../middleware/auth');
const { v4: uuid } = require('uuid');

const router = express.Router();
router.use(authenticate);

// Get user's own tickets
router.get('/', async (req, res) => {
  const tickets = await findMany('support.json', t => t.userId === req.user.id);
  res.json(tickets.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

// Submit a new ticket
router.post('/', async (req, res) => {
  const { subject, message, type } = req.body;
  if (!subject || !message) {
    return res.status(400).json({ error: 'Subject and message are required' });
  }

  const user = await findOne('users.json', u => u.id === req.user.id);
  const ticket = {
    id: uuid(),
    userId: req.user.id,
    subject,
    message,
    type: type || 'feedback', // feedback, bug, suggestion
    status: 'open',
    adminReply: null,
    repliedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  await insertOne('support.json', ticket);
  try { require('../telegram').notifySupportTicket(user || { name: 'Unknown', username: '?' }, ticket); } catch {}
  res.status(201).json(ticket);
});

module.exports = router;
