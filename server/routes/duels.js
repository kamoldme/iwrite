const express = require('express');
const { v4: uuid } = require('uuid');
const { findOne, findMany, insertOne, updateOne } = require('../utils/storage');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// Helper: complete a duel with a forfeit
function completeDuelWithForfeit(duelId, forfeiterId) {
  const duel = findOne('duels.json', d => d.id === duelId);
  if (!duel || duel.status !== 'active') return;
  const winnerId = duel.challengerId === forfeiterId ? duel.opponentId : duel.challengerId;
  updateOne('duels.json', d => d.id === duelId, {
    status: 'completed',
    forfeitedBy: forfeiterId,
    winnerId,
    endAt: new Date().toISOString()
  });
  try {
    const winner = findOne('users.json', u => u.id === winnerId);
    const loser = findOne('users.json', u => u.id === forfeiterId);
    if (winner && loser) {
      insertOne('activities.json', {
        id: uuid(),
        userId: winnerId,
        type: 'duel_won',
        data: { name: winner.name, opponentName: loser.name, forfeit: true },
        createdAt: new Date().toISOString()
      });
    }
  } catch {}
}

// Helper: complete a duel by word count (time expired)
// If forfeitedBy is set, forfeiter loses regardless of word count
function completeDuelByTime(duelId) {
  const duel = findOne('duels.json', d => d.id === duelId);
  if (!duel || duel.status !== 'active') return;
  let winnerId;
  if (duel.forfeitedBy) {
    // Forfeiter always loses
    winnerId = duel.forfeitedBy === duel.challengerId ? duel.opponentId : duel.challengerId;
  } else {
    winnerId = duel.challengerWords > duel.opponentWords ? duel.challengerId :
               duel.opponentWords > duel.challengerWords ? duel.opponentId : null;
  }
  updateOne('duels.json', d => d.id === duelId, {
    status: 'completed',
    winnerId,
    endAt: duel.endAt || new Date().toISOString()
  });
  if (winnerId) {
    try {
      const winner = findOne('users.json', u => u.id === winnerId);
      const loserId = winnerId === duel.challengerId ? duel.opponentId : duel.challengerId;
      const loser = findOne('users.json', u => u.id === loserId);
      if (winner && loser) {
        insertOne('activities.json', {
          id: uuid(),
          userId: winnerId,
          type: 'duel_won',
          data: { name: winner.name, opponentName: loser.name },
          createdAt: new Date().toISOString()
        });
      }
    } catch {}
  }
}

// Stale threshold: if a user hasn't polled in this many ms, they're gone
const STALE_POLL_MS = 15000; // 15 seconds (polls happen every 3s)

// Helper: auto-complete stale duels — called on key endpoints
function cleanupStaleDuels() {
  const now = Date.now();

  // 1. Active duels past endAt → complete by word count
  const expiredDuels = findMany('duels.json', d =>
    d.status === 'active' && d.endAt && new Date(d.endAt).getTime() <= now
  );
  for (const duel of expiredDuels) {
    completeDuelByTime(duel.id);
  }

  // 2. Active duels where user(s) stopped polling
  const activeDuels = findMany('duels.json', d => d.status === 'active');
  for (const duel of activeDuels) {
    const challengerGone = duel.challengerLastSeen && (now - new Date(duel.challengerLastSeen).getTime()) > STALE_POLL_MS;
    const opponentGone = duel.opponentLastSeen && (now - new Date(duel.opponentLastSeen).getTime()) > STALE_POLL_MS;

    if (duel.forfeitedBy) {
      // Someone already forfeited. Check if the remaining player also stopped polling.
      const remainingIsChallenger = duel.forfeitedBy !== duel.challengerId;
      const remainingGone = remainingIsChallenger ? challengerGone : opponentGone;
      if (remainingGone) {
        // Both gone now — complete the duel. Forfeiter loses.
        completeDuelWithForfeit(duel.id, duel.forfeitedBy);
      }
      // else: remaining player still active, duel continues
    } else if (challengerGone && opponentGone) {
      // Both gone, no one forfeited yet — whoever stopped polling first loses
      const challengerTime = new Date(duel.challengerLastSeen).getTime();
      const opponentTime = new Date(duel.opponentLastSeen).getTime();
      if (challengerTime < opponentTime) {
        completeDuelWithForfeit(duel.id, duel.challengerId);
      } else if (opponentTime < challengerTime) {
        completeDuelWithForfeit(duel.id, duel.opponentId);
      } else {
        completeDuelByTime(duel.id);
      }
    } else if (challengerGone) {
      // Only challenger gone — mark as forfeited but keep duel active
      const winnerId = duel.opponentId;
      updateOne('duels.json', d => d.id === duel.id, { forfeitedBy: duel.challengerId, winnerId });
    } else if (opponentGone) {
      // Only opponent gone — mark as forfeited but keep duel active
      const winnerId = duel.challengerId;
      updateOne('duels.json', d => d.id === duel.id, { forfeitedBy: duel.opponentId, winnerId });
    }
  }

  // 3. Stale countdown duels (startAt passed >2min ago)
  const staleCountdowns = findMany('duels.json', d =>
    d.status === 'countdown' && d.startAt && (now - new Date(d.startAt).getTime()) > 120000
  );
  for (const duel of staleCountdowns) {
    updateOne('duels.json', d => d.id === duel.id, {
      status: 'expired',
      endAt: new Date().toISOString()
    });
  }

  // 4. Expire pending duels older than 5 minutes
  const stalePending = findMany('duels.json', d =>
    d.status === 'pending' && (now - new Date(d.createdAt).getTime()) > 5 * 60 * 1000
  );
  for (const duel of stalePending) {
    updateOne('duels.json', d => d.id === duel.id, { status: 'expired' });
  }
}

// POST /challenge — create a new duel challenge
router.post('/challenge', (req, res) => {
  try {
    cleanupStaleDuels();
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
    cleanupStaleDuels();
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

// POST /:id/cancel — challenger cancels their own pending duel
router.post('/:id/cancel', (req, res) => {
  try {
    const duel = findOne('duels.json', d => d.id === req.params.id);
    if (!duel) return res.status(404).json({ error: 'Duel not found' });
    if (duel.challengerId !== req.user.id) return res.status(403).json({ error: 'Not your challenge' });
    if (duel.status !== 'pending' && duel.status !== 'countdown') return res.status(400).json({ error: 'Cannot cancel this duel' });

    updateOne('duels.json', d => d.id === req.params.id, { status: 'cancelled' });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /sent — outgoing pending duel challenges from current user
router.get('/sent', (req, res) => {
  try {
    const duels = findMany('duels.json', d => d.challengerId === req.user.id && d.status === 'pending');
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

// GET /:id/status — poll duel state (word counts, time remaining)
router.get('/:id/status', (req, res) => {
  try {
    const duel = findOne('duels.json', d => d.id === req.params.id);
    if (!duel) return res.status(404).json({ error: 'Duel not found' });
    if (duel.challengerId !== req.user.id && duel.opponentId !== req.user.id) {
      return res.status(403).json({ error: 'Not your duel' });
    }

    // Record last seen time for this user (used by cleanupStaleDuels)
    if (duel.status === 'active' || duel.status === 'countdown') {
      const seenUpdate = {};
      if (duel.challengerId === req.user.id) seenUpdate.challengerLastSeen = new Date().toISOString();
      else seenUpdate.opponentLastSeen = new Date().toISOString();
      updateOne('duels.json', d => d.id === req.params.id, seenUpdate);
    }

    // Clean up stale duels (including ones where users stopped polling)
    cleanupStaleDuels();

    // Re-read duel in case cleanup changed its status
    const freshDuel = findOne('duels.json', d => d.id === req.params.id);
    if (freshDuel && freshDuel.status === 'completed' && duel.status === 'active') {
      return res.json(freshDuel);
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

    // Auto-complete if time is up (uses shared helper which respects forfeitedBy)
    if (duel.status === 'active' && duel.endAt && new Date(duel.endAt) <= new Date()) {
      completeDuelByTime(req.params.id);
      const completed = findOne('duels.json', d => d.id === req.params.id);
      return res.json(completed);
    }

    // Re-read in case forfeitedBy was set by cleanup or other player
    const latestDuel = findOne('duels.json', d => d.id === req.params.id);
    res.json(latestDuel || duel);
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
      update.challengerLastSeen = new Date().toISOString();
    } else if (duel.opponentId === req.user.id) {
      update.opponentWords = wordCount || 0;
      update.opponentLastSeen = new Date().toISOString();
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

// POST /:id/add-time — either side can add extra time directly (no approval needed)
router.post('/:id/add-time', (req, res) => {
  try {
    const { minutes } = req.body;
    const duel = findOne('duels.json', d => d.id === req.params.id);
    if (!duel) return res.status(404).json({ error: 'Duel not found' });
    if (duel.challengerId !== req.user.id && duel.opponentId !== req.user.id) {
      return res.status(403).json({ error: 'Not your duel' });
    }
    if (duel.status !== 'active') return res.status(400).json({ error: 'Duel is not active' });

    const extraMinutes = Math.min(Math.max(parseInt(minutes) || 5, 1), 30);
    const addedMs = extraMinutes * 60 * 1000;
    const newEnd = new Date(new Date(duel.endAt).getTime() + addedMs).toISOString();
    const updated = updateOne('duels.json', d => d.id === req.params.id, { endAt: newEnd });
    res.json(updated);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /:id/forfeit — leaving = instant loss, other side wins
router.post('/:id/forfeit', (req, res) => {
  try {
    const duel = findOne('duels.json', d => d.id === req.params.id);
    if (!duel) return res.status(404).json({ error: 'Duel not found' });
    if (duel.challengerId !== req.user.id && duel.opponentId !== req.user.id) {
      return res.status(403).json({ error: 'Not your duel' });
    }
    if (duel.status !== 'active' && duel.status !== 'completed') {
      return res.status(400).json({ error: 'Duel is not active' });
    }
    // Already completed — no-op
    if (duel.status === 'completed') return res.json(duel);
    // Already forfeited by someone — no-op
    if (duel.forfeitedBy) return res.json(duel);

    // Mark forfeiter — but keep duel ACTIVE so the other person can keep writing
    const winnerId = duel.challengerId === req.user.id ? duel.opponentId : duel.challengerId;
    const updated = updateOne('duels.json', d => d.id === req.params.id, {
      forfeitedBy: req.user.id,
      winnerId
      // NOTE: status stays 'active', endAt stays the same — other player continues until timer
    });

    res.json(updated);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /:id/beacon-forfeit — sendBeacon-compatible forfeit (token in body, no auth header)
router.post('/:id/beacon-forfeit', (req, res) => {
  try {
    const jwt = require('jsonwebtoken');
    const { SECRET } = require('../middleware/auth');
    const { token } = req.body;
    if (!token) return res.status(401).json({ error: 'Token required' });

    let user;
    try { user = jwt.verify(token, SECRET); } catch { return res.status(401).json({ error: 'Invalid token' }); }

    const duel = findOne('duels.json', d => d.id === req.params.id);
    if (!duel) return res.status(404).json({ error: 'Duel not found' });
    if (duel.challengerId !== user.id && duel.opponentId !== user.id) {
      return res.status(403).json({ error: 'Not your duel' });
    }
    if (duel.status === 'completed') return res.json(duel);
    if (duel.status !== 'active') return res.status(400).json({ error: 'Duel is not active' });
    if (duel.forfeitedBy) return res.json(duel); // already forfeited

    // Mark forfeiter but keep duel active for the other player
    const winnerId = duel.challengerId === user.id ? duel.opponentId : duel.challengerId;
    const updated = updateOne('duels.json', d => d.id === req.params.id, {
      forfeitedBy: user.id,
      winnerId
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
    cleanupStaleDuels();
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
