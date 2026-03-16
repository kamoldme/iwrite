const express = require('express');
const { findOne, findMany, updateOne } = require('../utils/storage');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

router.get('/', (req, res) => {
  try {
    const user = findOne('users.json', u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const friends = (user.friends || []).map(id => {
      const f = findOne('users.json', u => u.id === id);
      if (!f) return null;
      const { password: _, ...safe } = f;
      return safe;
    }).filter(Boolean);
    res.json(friends);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/requests', (req, res) => {
  try {
    const user = findOne('users.json', u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const requests = (user.friendRequests || []).map(id => {
      const sender = findOne('users.json', u => u.id === id);
      if (!sender) return null;
      const { password: _, ...safe } = sender;
      return safe;
    }).filter(Boolean);
    res.json(requests);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/suggestions', (req, res) => {
  try {
    const me = findOne('users.json', u => u.id === req.user.id);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const myFriendIds = new Set(me.friends || []);
    const myRequests = new Set([...(me.sentRequests || []), ...(me.friendRequests || [])]);
    const suggestions = new Map();
    myFriendIds.forEach(friendId => {
      const friend = findOne('users.json', u => u.id === friendId);
      if (!friend) return;
      (friend.friends || []).forEach(fofId => {
        if (fofId === me.id || myFriendIds.has(fofId) || myRequests.has(fofId)) return;
        if (!suggestions.has(fofId)) {
          const fof = findOne('users.json', u => u.id === fofId);
          if (!fof) return;
          const { password: _, ...safe } = fof;
          suggestions.set(fofId, { ...safe, mutualCount: 1 });
        } else {
          suggestions.get(fofId).mutualCount++;
        }
      });
    });
    res.json(Array.from(suggestions.values()).sort((a, b) => b.mutualCount - a.mutualCount).slice(0, 10));
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/request', (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const target = findOne('users.json', u => u.email === email);
    if (!target) return res.status(404).json({ error: 'No user with that email found on iWrite' });
    if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot add yourself' });
    const me = findOne('users.json', u => u.id === req.user.id);
    if ((me.friends || []).includes(target.id)) return res.status(400).json({ error: 'Already friends' });
    if ((me.sentRequests || []).includes(target.id)) return res.status(400).json({ error: 'Request already sent' });
    if ((target.sentRequests || []).includes(me.id)) {
      updateOne('users.json', u => u.id === me.id, {
        friends: [...(me.friends || []), target.id],
        friendRequests: (me.friendRequests || []).filter(id => id !== target.id)
      });
      updateOne('users.json', u => u.id === target.id, {
        friends: [...(target.friends || []), me.id],
        sentRequests: (target.sentRequests || []).filter(id => id !== me.id)
      });
      return res.json({ message: 'You are now friends!', autoAccepted: true });
    }
    updateOne('users.json', u => u.id === me.id, { sentRequests: [...(me.sentRequests || []), target.id] });
    updateOne('users.json', u => u.id === target.id, { friendRequests: [...(target.friendRequests || []), me.id] });
    res.json({ message: 'Friend request sent!' });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/accept/:fromId', (req, res) => {
  try {
    const { fromId } = req.params;
    const me = findOne('users.json', u => u.id === req.user.id);
    const sender = findOne('users.json', u => u.id === fromId);
    if (!me || !sender) return res.status(404).json({ error: 'User not found' });
    if (!(me.friendRequests || []).includes(fromId)) return res.status(400).json({ error: 'No request found' });
    updateOne('users.json', u => u.id === me.id, {
      friends: [...(me.friends || []), fromId],
      friendRequests: (me.friendRequests || []).filter(id => id !== fromId)
    });
    updateOne('users.json', u => u.id === sender.id, {
      friends: [...(sender.friends || []), me.id],
      sentRequests: (sender.sentRequests || []).filter(id => id !== me.id)
    });
    res.json({ message: 'Friend request accepted' });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/reject/:fromId', (req, res) => {
  try {
    const { fromId } = req.params;
    const me = findOne('users.json', u => u.id === req.user.id);
    const sender = findOne('users.json', u => u.id === fromId);
    if (!me) return res.status(404).json({ error: 'User not found' });
    updateOne('users.json', u => u.id === me.id, {
      friendRequests: (me.friendRequests || []).filter(id => id !== fromId)
    });
    if (sender) {
      updateOne('users.json', u => u.id === sender.id, {
        sentRequests: (sender.sentRequests || []).filter(id => id !== me.id)
      });
    }
    res.json({ message: 'Request rejected' });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/:friendId', (req, res) => {
  try {
    const { friendId } = req.params;
    const me = findOne('users.json', u => u.id === req.user.id);
    const friend = findOne('users.json', u => u.id === friendId);
    if (!me) return res.status(404).json({ error: 'User not found' });
    updateOne('users.json', u => u.id === me.id, { friends: (me.friends || []).filter(id => id !== friendId) });
    if (friend) {
      updateOne('users.json', u => u.id === friend.id, { friends: (friend.friends || []).filter(id => id !== me.id) });
    }
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// Activity feed — returns activities from friends
router.get('/feed', (req, res) => {
  try {
    const user = findOne('users.json', u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const friendIds = new Set(user.friends || []);
    if (friendIds.size === 0) return res.json([]);
    const allActivities = findMany('activities.json', a => friendIds.has(a.userId));
    const sorted = allActivities.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 10);
    res.json(sorted);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
