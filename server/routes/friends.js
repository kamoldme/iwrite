const express = require('express');
const { findOne, findMany, updateOne } = require('../utils/storage');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const user = await findOne('users.json', u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const friendsList = [];
    for (const id of (user.friends || [])) {
      const f = await findOne('users.json', u => u.id === id);
      if (!f) continue;
      const { password: _, ...safe } = f;
      friendsList.push(safe);
    }
    res.json(friendsList);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/requests', async (req, res) => {
  try {
    const user = await findOne('users.json', u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const requests = [];
    for (const id of (user.friendRequests || [])) {
      const sender = await findOne('users.json', u => u.id === id);
      if (!sender) continue;
      const { password: _, ...safe } = sender;
      requests.push(safe);
    }
    res.json(requests);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/suggestions', async (req, res) => {
  try {
    const me = await findOne('users.json', u => u.id === req.user.id);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const myFriendIds = new Set(me.friends || []);
    const myRequests = new Set([...(me.sentRequests || []), ...(me.friendRequests || [])]);
    const suggestions = new Map();
    for (const friendId of myFriendIds) {
      const friend = await findOne('users.json', u => u.id === friendId);
      if (!friend) continue;
      for (const fofId of (friend.friends || [])) {
        if (fofId === me.id || myFriendIds.has(fofId) || myRequests.has(fofId)) continue;
        if (!suggestions.has(fofId)) {
          const fof = await findOne('users.json', u => u.id === fofId);
          if (!fof) continue;
          const { password: _, ...safe } = fof;
          suggestions.set(fofId, { ...safe, mutualCount: 1 });
        } else {
          suggestions.get(fofId).mutualCount++;
        }
      }
    }
    res.json(Array.from(suggestions.values()).sort((a, b) => b.mutualCount - a.mutualCount).slice(0, 10));
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/request', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const target = await findOne('users.json', u => u.email === email);
    if (!target) return res.status(404).json({ error: 'No user with that email found on iWrite4.me' });
    if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot add yourself' });
    const me = await findOne('users.json', u => u.id === req.user.id);
    if ((me.friends || []).includes(target.id)) return res.status(400).json({ error: 'Already friends' });
    if ((me.sentRequests || []).includes(target.id)) return res.status(400).json({ error: 'Request already sent' });
    if ((target.sentRequests || []).includes(me.id)) {
      await updateOne('users.json', u => u.id === me.id, {
        friends: [...(me.friends || []), target.id],
        friendRequests: (me.friendRequests || []).filter(id => id !== target.id)
      });
      await updateOne('users.json', u => u.id === target.id, {
        friends: [...(target.friends || []), me.id],
        sentRequests: (target.sentRequests || []).filter(id => id !== me.id)
      });
      return res.json({ message: 'You are now friends!', autoAccepted: true });
    }
    await updateOne('users.json', u => u.id === me.id, { sentRequests: [...(me.sentRequests || []), target.id] });
    await updateOne('users.json', u => u.id === target.id, { friendRequests: [...(target.friendRequests || []), me.id] });
    res.json({ message: 'Friend request sent!' });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/accept/:fromId', async (req, res) => {
  try {
    const { fromId } = req.params;
    const me = await findOne('users.json', u => u.id === req.user.id);
    const sender = await findOne('users.json', u => u.id === fromId);
    if (!me || !sender) return res.status(404).json({ error: 'User not found' });
    if (!(me.friendRequests || []).includes(fromId)) return res.status(400).json({ error: 'No request found' });
    await updateOne('users.json', u => u.id === me.id, {
      friends: [...(me.friends || []), fromId],
      friendRequests: (me.friendRequests || []).filter(id => id !== fromId)
    });
    await updateOne('users.json', u => u.id === sender.id, {
      friends: [...(sender.friends || []), me.id],
      sentRequests: (sender.sentRequests || []).filter(id => id !== me.id)
    });
    res.json({ message: 'Friend request accepted' });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/reject/:fromId', async (req, res) => {
  try {
    const { fromId } = req.params;
    const me = await findOne('users.json', u => u.id === req.user.id);
    const sender = await findOne('users.json', u => u.id === fromId);
    if (!me) return res.status(404).json({ error: 'User not found' });
    await updateOne('users.json', u => u.id === me.id, {
      friendRequests: (me.friendRequests || []).filter(id => id !== fromId)
    });
    if (sender) {
      await updateOne('users.json', u => u.id === sender.id, {
        sentRequests: (sender.sentRequests || []).filter(id => id !== me.id)
      });
    }
    res.json({ message: 'Request rejected' });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/:friendId', async (req, res) => {
  try {
    const { friendId } = req.params;
    const me = await findOne('users.json', u => u.id === req.user.id);
    const friend = await findOne('users.json', u => u.id === friendId);
    if (!me) return res.status(404).json({ error: 'User not found' });
    await updateOne('users.json', u => u.id === me.id, { friends: (me.friends || []).filter(id => id !== friendId) });
    if (friend) {
      await updateOne('users.json', u => u.id === friend.id, { friends: (friend.friends || []).filter(id => id !== me.id) });
    }
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// Activity feed — returns activities from friends
router.get('/feed', async (req, res) => {
  try {
    const user = await findOne('users.json', u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const friendIds = new Set(user.friends || []);
    if (friendIds.size === 0) return res.json([]);
    const allActivities = await findMany('activities.json', a => friendIds.has(a.userId));
    const sorted = allActivities.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 10);
    res.json(sorted);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
