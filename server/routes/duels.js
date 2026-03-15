const express = require('express');
const { v4: uuid } = require('uuid');
const { findOne, findMany, insertOne, updateOne } = require('../utils/storage');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// POST /challenge — create a new duel challenge
router.post('/challenge', (req, res) => {
  try {
    const { friendId, duration } = req.body;
    if (!friendId || !duration) return res.status(400).json({ error: 'friendId and duration are required' });

    const me = findOne('users.json', u => u.id === req.user.id);
    const friend = findOne('users.json', u => u.id === friendId);
    if (!me || !friend) return res.status(404).json({ error: 'User not found' });
    if (!(me.friends || []).includes(friendId)) return res.status(400).json({ error: 'You can only challenge friends' });

    // Check for existing active duel between these users
    const existing = findOne('duels.json', d =>
      (d.status === 'pending' || d.status === 'accepted' || d.status === 'countdown' || d.status === 'active') &&
      ((d.challengerId === me.id && d.opponentId === friendId) || (d.challengerId === friendId && d.opponentId === me.id))
    );
    if (existing) return res.status(400).json({ error: 'An active duel already exists with this friend' });

    const duel = {
      id: uuid(),
      challengerId: me.id,
      challengerName: me.name,
      opponentId: friendId,
      opponentName: friend.name,
      duration: Math.min(Math.max(parseInt(duration), 1), 60), // 1-60 minutes
      status: 'pending',
      createdAt: new Date().toISOString(),
      acceptedAt: null,
      startAt: null,
      endAt: null,
      challengerWords: 0,
      opponentWords: 0,
      challengerDocId: null,
      opponentDocId: null,
      winnerId: null
    };

    insertOne('duels.json', duel);
    res.json(duel);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /requests — incoming duel requests for current user
router.get('/requests', (req, res) => {
  try {
    const duels = findMany('duels.json', d => d.opponentId === req.user.id && d.status === 'pending');
    // Auto-expire duels older than 24h
    const now = Date.now();
    const valid = [];
    for (const d of duels) {
      if (now - new Date(d.createdAt).getTime() > 24 * 60 * 60 * 1000) {
        updateOne('duels.json', x => x.id === d.id, { status: 'expired' });
      } else {
        valid.push(d);
      }
    }
    res.json(valid);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /:id/accept — accept a duel challenge
router.post('/:id/accept', (req, res) => {
  try {
    const duel = findOne('duels.json', d => d.id === req.params.id);
    if (!duel) return res.status(404).json({ error: 'Duel not found' });
    if (duel.opponentId !== req.user.id) return res.status(403).json({ error: 'Not your challenge' });
    if (duel.status !== 'pending') return res.status(400).json({ error: 'Duel is no longer pending' });

    const startAt = new Date(Date.now() + 60 * 1000).toISOString(); // 60s countdown
    const updated = updateOne('duels.json', d => d.id === req.params.id, {
      status: 'countdown',
      acceptedAt: new Date().toISOString(),
      startAt
    });
    res.json(updated);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /:id/decline — decline a duel challenge
router.post('/:id/decline', (req, res) => {
  try {
    const duel = findOne('duels.json', d => d.id === req.params.id);
    if (!duel) return res.status(404).json({ error: 'Duel not found' });
    if (duel.opponentId !== req.user.id) return res.status(403).json({ error: 'Not your challenge' });
    if (duel.status !== 'pending') return res.status(400).json({ error: 'Duel is no longer pending' });

    updateOne('duels.json', d => d.id === req.params.id, { status: 'declined' });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /:id/status — poll duel state (word counts, time remaining)
router.get('/:id/status', (req, res) => {
  try {
    const duel = findOne('duels.json', d => d.id === req.params.id);
    if (!duel) return res.status(404).json({ error: 'Duel not found' });
    if (duel.challengerId !== req.user.id && duel.opponentId !== req.user.id) {
      return res.status(403).json({ error: 'Not your duel' });
    }

    // Auto-transition from countdown to active
    if (duel.status === 'countdown' && duel.startAt && new Date(duel.startAt) <= new Date()) {
      const endAt = new Date(new Date(duel.startAt).getTime() + duel.duration * 60 * 1000).toISOString();
      const updated = updateOne('duels.json', d => d.id === req.params.id, {
        status: 'active',
        endAt
      });
      return res.json(updated);
    }

    // Auto-complete if time is up
    if (duel.status === 'active' && duel.endAt && new Date(duel.endAt) <= new Date()) {
      const winnerId = duel.challengerWords > duel.opponentWords ? duel.challengerId :
                       duel.opponentWords > duel.challengerWords ? duel.opponentId : null;
      const updated = updateOne('duels.json', d => d.id === req.params.id, {
        status: 'completed',
        winnerId
      });

      // Generate duel_won activity
      if (winnerId) {
        const winner = findOne('users.json', u => u.id === winnerId);
        const loserId = winnerId === duel.challengerId ? duel.opponentId : duel.challengerId;
        const loser = findOne('users.json', u => u.id === loserId);
        if (winner && loser) {
          insertOne('activities.json', {
            id: uuid(),
            userId: winnerId,
            type: 'duel_won',
            data: {
              name: winner.name,
              opponentName: loser.name,
              winnerWords: winnerId === duel.challengerId ? duel.challengerWords : duel.opponentWords,
              loserWords: winnerId === duel.challengerId ? duel.opponentWords : duel.challengerWords
            },
            createdAt: new Date().toISOString()
          });
        }
      }

      return res.json(updated);
    }

    res.json(duel);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /:id/update — submit current word count during active duel
router.post('/:id/update', (req, res) => {
  try {
    const { wordCount } = req.body;
    const duel = findOne('duels.json', d => d.id === req.params.id);
    if (!duel) return res.status(404).json({ error: 'Duel not found' });
    if (duel.status !== 'active') return res.status(400).json({ error: 'Duel is not active' });

    const update = {};
    if (duel.challengerId === req.user.id) {
      update.challengerWords = wordCount || 0;
    } else if (duel.opponentId === req.user.id) {
      update.opponentWords = wordCount || 0;
    } else {
      return res.status(403).json({ error: 'Not your duel' });
    }

    const updated = updateOne('duels.json', d => d.id === req.params.id, update);
    res.json(updated);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /:id/complete — submit final word count and determine winner
router.post('/:id/complete', (req, res) => {
  try {
    const { wordCount } = req.body;
    const duel = findOne('duels.json', d => d.id === req.params.id);
    if (!duel) return res.status(404).json({ error: 'Duel not found' });
    if (duel.status !== 'active' && duel.status !== 'completed') {
      return res.status(400).json({ error: 'Duel cannot be completed' });
    }

    // Update final word count
    const update = {};
    if (duel.challengerId === req.user.id) {
      update.challengerWords = wordCount || duel.challengerWords;
    } else if (duel.opponentId === req.user.id) {
      update.opponentWords = wordCount || duel.opponentWords;
    } else {
      return res.status(403).json({ error: 'Not your duel' });
    }

    // Re-read to get latest state
    const latest = updateOne('duels.json', d => d.id === req.params.id, update);
    const cw = latest.challengerWords || 0;
    const ow = latest.opponentWords || 0;
    const winnerId = cw > ow ? latest.challengerId : ow > cw ? latest.opponentId : null;

    const completed = updateOne('duels.json', d => d.id === req.params.id, {
      status: 'completed',
      winnerId
    });

    res.json(completed);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /:id/ready — signal ready to skip countdown
router.post('/:id/ready', (req, res) => {
  try {
    const duel = findOne('duels.json', d => d.id === req.params.id);
    if (!duel) return res.status(404).json({ error: 'Duel not found' });
    if (duel.challengerId !== req.user.id && duel.opponentId !== req.user.id) {
      return res.status(403).json({ error: 'Not your duel' });
    }
    if (duel.status !== 'countdown') return res.status(400).json({ error: 'Duel is not in countdown' });

    const field = duel.challengerId === req.user.id ? 'challengerReady' : 'opponentReady';
    const update = { [field]: true };

    // If both ready, start immediately
    const otherReady = duel.challengerId === req.user.id ? duel.opponentReady : duel.challengerReady;
    if (otherReady) {
      const now = new Date();
      update.startAt = now.toISOString();
      update.status = 'active';
      update.endAt = new Date(now.getTime() + duel.duration * 60 * 1000).toISOString();
    }

    const updated = updateOne('duels.json', d => d.id === req.params.id, update);
    res.json(updated);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /:id/forfeit — signal that user left the duel (doesn't end it)
router.post('/:id/forfeit', (req, res) => {
  try {
    const duel = findOne('duels.json', d => d.id === req.params.id);
    if (!duel) return res.status(404).json({ error: 'Duel not found' });
    if (duel.challengerId !== req.user.id && duel.opponentId !== req.user.id) {
      return res.status(403).json({ error: 'Not your duel' });
    }
    if (duel.status !== 'active') return res.status(400).json({ error: 'Duel is not active' });

    const updated = updateOne('duels.json', d => d.id === req.params.id, {
      forfeitedBy: req.user.id
    });
    res.json(updated);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /:id/set-doc — associate a document with a duel participant
router.post('/:id/set-doc', (req, res) => {
  try {
    const { docId } = req.body;
    const duel = findOne('duels.json', d => d.id === req.params.id);
    if (!duel) return res.status(404).json({ error: 'Duel not found' });

    const update = {};
    if (duel.challengerId === req.user.id) update.challengerDocId = docId;
    else if (duel.opponentId === req.user.id) update.opponentDocId = docId;
    else return res.status(403).json({ error: 'Not your duel' });

    const updated = updateOne('duels.json', d => d.id === req.params.id, update);
    res.json(updated);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /history — completed duels for current user
router.get('/history', (req, res) => {
  try {
    const duels = findMany('duels.json', d =>
      d.status === 'completed' &&
      (d.challengerId === req.user.id || d.opponentId === req.user.id)
    );
    res.json(duels.sort((a, b) => new Date(b.endAt || b.createdAt) - new Date(a.endAt || a.createdAt)).slice(0, 20));
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /active — active/pending/countdown duels for current user
router.get('/active', (req, res) => {
  try {
    const duels = findMany('duels.json', d =>
      ['pending', 'accepted', 'countdown', 'active'].includes(d.status) &&
      (d.challengerId === req.user.id || d.opponentId === req.user.id)
    );
    res.json(duels);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
