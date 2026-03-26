const express = require('express');
const { v4: uuid } = require('uuid');
const { findOne, findMany, insertOne, updateOne } = require('../utils/storage');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// POST /api/follow/:id — follow a user
router.post('/:id', authenticate, async (req, res) => {
  try {
    const targetId = req.params.id;
    if (targetId === req.user.id) return res.status(400).json({ error: 'Cannot follow yourself' });

    const target = await findOne('users.json', u => u.id === targetId);
    if (!target) return res.status(404).json({ error: 'User not found' });

    const me = await findOne('users.json', u => u.id === req.user.id);
    if ((me.following || []).includes(targetId)) {
      return res.status(400).json({ error: 'Already following this user' });
    }

    // Update both users' arrays
    await updateOne('users.json', u => u.id === req.user.id, {
      following: [...(me.following || []), targetId]
    });
    await updateOne('users.json', u => u.id === targetId, {
      followers: [...(target.followers || []), req.user.id]
    });

    // Create notification for target
    await insertOne('notifications.json', {
      id: uuid(),
      userId: targetId,
      type: 'new_follower',
      fromUserId: req.user.id,
      fromUserName: me.name || me.username,
      text: `${me.name || me.username} started following you`,
      read: false,
      createdAt: new Date().toISOString()
    });

    res.json({
      success: true,
      followerCount: (target.followers || []).length + 1
    });
  } catch (err) {
    console.error('Follow error:', err);
    res.status(500).json({ error: 'Failed to follow user' });
  }
});

// DELETE /api/follow/:id — unfollow a user
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const targetId = req.params.id;
    const target = await findOne('users.json', u => u.id === targetId);
    if (!target) return res.status(404).json({ error: 'User not found' });

    const me = await findOne('users.json', u => u.id === req.user.id);
    if (!(me.following || []).includes(targetId)) {
      return res.status(400).json({ error: 'Not following this user' });
    }

    await updateOne('users.json', u => u.id === req.user.id, {
      following: (me.following || []).filter(id => id !== targetId)
    });
    await updateOne('users.json', u => u.id === targetId, {
      followers: (target.followers || []).filter(id => id !== req.user.id)
    });

    res.json({
      success: true,
      followerCount: Math.max(0, (target.followers || []).length - 1)
    });
  } catch (err) {
    console.error('Unfollow error:', err);
    res.status(500).json({ error: 'Failed to unfollow user' });
  }
});

// GET /api/follow/:id/followers — list followers
router.get('/:id/followers', async (req, res) => {
  try {
    const user = await findOne('users.json', u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const followerIds = user.followers || [];

    const allUsers = await findMany('users.json');
    const userMap = new Map(allUsers.map(u => [u.id, u]));

    const total = followerIds.length;
    const pageIds = followerIds.slice((page - 1) * limit, page * limit);
    const followers = pageIds.map(id => {
      const u = userMap.get(id);
      return u ? { id: u.id, name: u.name, username: u.username, avatar: u.avatar, plan: u.plan, level: u.level } : null;
    }).filter(Boolean);

    res.json({ followers, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/follow/:id/following — list following
router.get('/:id/following', async (req, res) => {
  try {
    const user = await findOne('users.json', u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const followingIds = user.following || [];

    const allUsers = await findMany('users.json');
    const userMap = new Map(allUsers.map(u => [u.id, u]));

    const total = followingIds.length;
    const pageIds = followingIds.slice((page - 1) * limit, page * limit);
    const following = pageIds.map(id => {
      const u = userMap.get(id);
      return u ? { id: u.id, name: u.name, username: u.username, avatar: u.avatar, plan: u.plan, level: u.level } : null;
    }).filter(Boolean);

    res.json({ following, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
