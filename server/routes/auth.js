const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const { findOne, insertOne, updateOne } = require('../utils/storage');
const { generateToken, authenticate } = require('../middleware/auth');
const { logAction } = require('../utils/logger');

const router = express.Router();

router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const existing = findOne('users.json', u => u.email === email);
    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const hash = await bcrypt.hash(password, 12);
    const user = {
      id: uuid(),
      name,
      email,
      password: hash,
      role: 'user',
      plan: 'free',
      xp: 0,
      level: 0,
      streak: 0,
      longestStreak: 0,
      lastWritingDate: null,
      treeStage: 0,
      totalWords: 0,
      totalSessions: 0,
      achievements: [],
      friends: [],
      friendRequests: [],
      sentRequests: [],
      sharedTokens: [],
      createdAt: new Date().toISOString()
    };

    insertOne('users.json', user);
    logAction('user_registered', { name: user.name, email: user.email }, user.id);
    const token = generateToken(user);
    const { password: _, ...safeUser } = user;
    res.status(201).json({ token, user: safeUser });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = findOne('users.json', u => u.email === email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = generateToken(user);
    const { password: _, ...safeUser } = user;
    res.json({ token, user: safeUser });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/me', authenticate, (req, res) => {
  const user = findOne('users.json', u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { password: _, ...safeUser } = user;
  res.json(safeUser);
});

router.patch('/me', authenticate, (req, res) => {
  const { name } = req.body;
  const updated = updateOne('users.json', u => u.id === req.user.id, { name });
  if (!updated) return res.status(404).json({ error: 'User not found' });
  const { password: _, ...safeUser } = updated;
  res.json(safeUser);
});

router.post('/change-password', authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const user = findOne('users.json', u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: 'New passwords do not match' });
    }

    const hash = await bcrypt.hash(newPassword, 12);
    updateOne('users.json', u => u.id === req.user.id, { password: hash });

    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
