const express = require('express');
const { v4: uuid } = require('uuid');
const { findOne, findMany, insertOne, updateOne, deleteOne } = require('../utils/storage');
const { authenticate } = require('../middleware/auth');
const { logAction } = require('../utils/logger');

// Streak → tree stage mapping (30 days = max)
const TREE_STAGE_THRESHOLDS = [0, 1, 3, 5, 8, 11, 14, 17, 20, 23, 27, 30];
function streakToTreeStage(streak) {
  for (let i = TREE_STAGE_THRESHOLDS.length - 1; i >= 0; i--) {
    if (streak >= TREE_STAGE_THRESHOLDS[i]) return i;
  }
  return 0;
}

// Activity generation for friends feed
const WORD_MILESTONES = [1000, 5000, 10000, 25000, 50000, 100000];
const STREAK_MILESTONES = [7, 14, 30, 50, 100];

async function generateActivities(userId, userName, prevUser, newUser, wordCount, durationSeconds) {
  const activities = [];
  const now = new Date().toISOString();
  const duration = Math.round((durationSeconds || 0) / 60); // Convert seconds to minutes

  // Long session (>20 min)
  if (duration && duration >= 20) {
    activities.push({ id: uuid(), userId, type: 'long_session', data: { name: userName, duration }, createdAt: now });
  }

  // Word milestones
  const prevWords = prevUser.totalWords || 0;
  const newWords = newUser.totalWords || 0;
  for (const milestone of WORD_MILESTONES) {
    if (prevWords < milestone && newWords >= milestone) {
      activities.push({ id: uuid(), userId, type: 'word_milestone', data: { name: userName, words: milestone }, createdAt: now });
    }
  }

  // Streak milestones
  const prevStreak = prevUser.streak || 0;
  const newStreak = newUser.streak || 0;
  for (const milestone of STREAK_MILESTONES) {
    if (prevStreak < milestone && newStreak >= milestone) {
      activities.push({ id: uuid(), userId, type: 'streak_milestone', data: { name: userName, streak: milestone }, createdAt: now });
    }
  }

  // Level up
  const prevLevel = calcLevel(prevUser.xp || 0);
  const newLevel = calcLevel(newUser.xp || 0);
  if (newLevel > prevLevel) {
    activities.push({ id: uuid(), userId, type: 'level_up', data: { name: userName, level: newLevel }, createdAt: now });
  }

  // Save activities
  for (const activity of activities) {
    await insertOne('activities.json', activity);
  }
}

function calcLevel(xp) {
  let level = 0;
  let xpUsed = 0;
  let threshold = 300;
  while (xp >= xpUsed + threshold) {
    xpUsed += threshold;
    level++;
    threshold = Math.round(threshold * 1.25);
  }
  return level;
}

const router = express.Router();

router.use(authenticate);

// ===== Writing heartbeat (editor pings every 5s while session is active) =====
router.post('/heartbeat', (req, res) => {
  const activeUsers = req.app.get('activeUsers');
  if (activeUsers && req.user) {
    const entry = activeUsers.get(req.user.id);
    if (entry) {
      entry.writingAt = Date.now();
    } else {
      activeUsers.set(req.user.id, { email: req.user.email, lastSeen: Date.now(), writingAt: Date.now() });
    }
  }
  res.json({ ok: true });
});

router.get('/', async (req, res) => {
  // Include system-deleted (failed) docs for history, admin-deactivated docs, but not manually deleted
  const docs = await findMany('documents.json', d => d.userId === req.user.id && (!d.deleted || d.deletedBySystem || d.deactivatedByAdmin));
  res.json(docs.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)));
});

router.post('/', async (req, res) => {
  const { title, content, mode, prompt } = req.body;

  // Monthly session limit (invisible): free 200/month, pro 300/month
  const user = await findOne('users.json', u => u.id === req.user.id);
  if (user) {
    const ms = req.app.get('maintenanceState');
    const maintenanceBypass = ms && ms.active;
    const isPro = user.plan === 'premium';
    const monthLimit = isPro ? 300 : 200;
    const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
    const sessionsThisMonth = (user.monthlySessionsMonth === currentMonth) ? (user.monthlySessions || 0) : 0;
    if (sessionsThisMonth >= monthLimit && !maintenanceBypass) {
      return res.status(429).json({ error: 'Monthly session limit reached. Please try again next month.' });
    }
    // Don't count against limit during maintenance
    if (!maintenanceBypass) {
      await updateOne('users.json', u => u.id === req.user.id, {
        monthlySessions: sessionsThisMonth + 1,
        monthlySessionsMonth: currentMonth
      });
    }
  }

  const doc = {
    id: uuid(),
    userId: req.user.id,
    title: title || 'Untitled',
    content: content || '',
    mode: mode || 'normal',
    prompt: prompt || '',
    wordCount: (content || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').trim().split(/\s+/).filter(Boolean).length,
    xpEarned: 0,
    duration: 0,
    shareLinks: [],
    deleted: false,
    deletedBySystem: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await insertOne('documents.json', doc);
  try {
    const user = await findOne('users.json', u => u.id === req.user.id);
    require('../telegram').notifyDocumentCreated(user || { name: 'Unknown', username: '?' }, doc);
  } catch {}
  res.status(201).json(doc);
});

router.get('/shared-with-me', async (req, res) => {
  const user = await findOne('users.json', u => u.id === req.user.id);
  const sharedTokens = user.sharedTokens || [];
  if (sharedTokens.length === 0) return res.json([]);

  const docs = await findMany('documents.json');
  const result = [];
  for (const entry of sharedTokens) {
    const doc = docs.find(d => !d.deleted && d.shareLinks && d.shareLinks.some(s => s.token === entry.token));
    if (doc) {
      result.push({
        id: doc.id,
        title: doc.title,
        wordCount: doc.wordCount || 0,
        updatedAt: doc.updatedAt,
        createdAt: doc.createdAt,
        permission: entry.permission,
        token: entry.token
      });
    }
  }
  res.json(result);
});

// ===== FOLDER MANAGEMENT ===== (must be before /:id routes)
router.get('/folders/list', async (req, res) => {
  const user = await findOne('users.json', u => u.id === req.user.id);
  res.json(user.folders || []);
});

router.post('/folders', async (req, res) => {
  const { name, parentFolder } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Folder name required' });
  const user = await findOne('users.json', u => u.id === req.user.id);
  const folders = user.folders || [];
  const folder = { id: uuid(), name: name.trim(), parentFolder: parentFolder || null, createdAt: new Date().toISOString() };
  folders.push(folder);
  await updateOne('users.json', u => u.id === req.user.id, { folders });
  res.status(201).json(folder);
});

router.patch('/folders/:folderId', async (req, res) => {
  const user = await findOne('users.json', u => u.id === req.user.id);
  const folders = user.folders || [];
  const folder = folders.find(f => f.id === req.params.folderId);
  if (!folder) return res.status(404).json({ error: 'Folder not found' });
  if (req.body.name !== undefined) folder.name = req.body.name.trim();
  if (req.body.parentFolder !== undefined) folder.parentFolder = req.body.parentFolder;
  await updateOne('users.json', u => u.id === req.user.id, { folders });
  res.json(folder);
});

router.delete('/folders/:folderId', async (req, res) => {
  const user = await findOne('users.json', u => u.id === req.user.id);
  let folders = user.folders || [];
  // Collect folder and all descendants
  const toDelete = new Set();
  const collect = (id) => {
    toDelete.add(id);
    folders.filter(f => f.parentFolder === id).forEach(f => collect(f.id));
  };
  collect(req.params.folderId);
  const parent = folders.find(f => f.id === req.params.folderId)?.parentFolder || null;
  folders = folders.filter(f => !toDelete.has(f.id));
  await updateOne('users.json', u => u.id === req.user.id, { folders });
  // Move docs from deleted folders to the parent folder
  const docs = await findMany('documents.json', d => d.userId === req.user.id && toDelete.has(d.folder));
  for (const d of docs) {
    await updateOne('documents.json', dd => dd.id === d.id, { folder: parent });
  }
  res.json({ success: true });
});

router.get('/:id', async (req, res) => {
  const doc = await findOne('documents.json', d => d.id === req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  const isOwner = doc.userId === req.user.id;
  const hasAccess = doc.shareLinks.some(
    s => s.userId === req.user.id || s.type === 'public'
  );
  if (!isOwner && !hasAccess) {
    return res.status(403).json({ error: 'Access denied' });
  }
  res.json(doc);
});

router.patch('/:id', async (req, res) => {
  const doc = await findOne('documents.json', d => d.id === req.params.id && d.userId === req.user.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  const updates = {};
  if (req.body.title !== undefined) updates.title = req.body.title;
  if (req.body.content !== undefined) {
    updates.content = req.body.content;
    updates.wordCount = req.body.content.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').trim().split(/\s+/).filter(Boolean).length;
  }
  if (req.body.folder !== undefined) updates.folder = req.body.folder;
  updates.updatedAt = new Date().toISOString();

  const updated = await updateOne('documents.json', d => d.id === req.params.id, updates);

  // Mark user as actively writing (for admin "Writing Now" tracker)
  const activeUsers = req.app.get('activeUsers');
  if (activeUsers && req.user) {
    const entry = activeUsers.get(req.user.id);
    if (entry) entry.writingAt = Date.now();
  }

  res.json(updated);
});

router.delete('/:id', async (req, res) => {
  const doc = await findOne('documents.json', d => d.id === req.params.id && d.userId === req.user.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  await updateOne('documents.json', d => d.id === req.params.id, { deleted: true });
  res.json({ success: true });
});

router.post('/:id/complete', async (req, res) => {
  const { wordCount, duration, xpEarned, earlyComplete } = req.body;
  const doc = await findOne('documents.json', d => d.id === req.params.id && d.userId === req.user.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  // Don't save empty sessions — delete the document entirely
  if (!wordCount || wordCount <= 0) {
    await deleteOne('documents.json', d => d.id === req.params.id);
    const { password: _, ...safeUser } = await findOne('users.json', u => u.id === req.user.id);
    return res.json({ document: null, user: safeUser });
  }

  // Track early completes (3/month free, 15/month pro) — bypass during maintenance
  if (earlyComplete) {
    const ms = req.app.get('maintenanceState');
    const maintenanceBypass = ms && ms.active;
    const user = await findOne('users.json', u => u.id === req.user.id);
    const currentMonth = new Date().toISOString().slice(0, 7);
    const usedThisMonth = (user.earlyCompletesMonth === currentMonth) ? (user.earlyCompletes || 0) : 0;
    const earlyLimit = user.plan === 'premium' ? 15 : 3;
    if (usedThisMonth >= earlyLimit && !maintenanceBypass) {
      return res.status(429).json({ error: `Early complete limit reached (${earlyLimit}/month)` });
    }
    // Don't count against limit during maintenance
    if (!maintenanceBypass) {
      await updateOne('users.json', u => u.id === req.user.id, {
        earlyCompletes: usedThisMonth + 1,
        earlyCompletesMonth: currentMonth
      });
    }
  }

  await updateOne('documents.json', d => d.id === req.params.id, {
    wordCount: wordCount || doc.wordCount,
    duration: duration || 0,
    xpEarned: xpEarned || 0,
    updatedAt: new Date().toISOString()
  });

  const user = await findOne('users.json', u => u.id === req.user.id);
  const today = new Date().toISOString().split('T')[0];
  const lastDate = user.lastWritingDate;
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  let newStreak;
  let newTreeStage;
  if (lastDate === today) {
    // already wrote today — no streak or tree change
    newStreak = user.streak;
    newTreeStage = streakToTreeStage(newStreak);
  } else if (lastDate === yesterday) {
    // streak continues
    newStreak = user.streak + 1;
    newTreeStage = streakToTreeStage(newStreak);
  } else {
    // streak broken — tree resets from the beginning
    newStreak = 1;
    newTreeStage = streakToTreeStage(1);
  }

  const totalWords = (user.totalWords || 0) + (wordCount || 0);

  const newXP = user.xp + (xpEarned || 0);
  const updatedUser = await updateOne('users.json', u => u.id === req.user.id, {
    xp: newXP,
    level: calcLevel(newXP),
    streak: newStreak,
    longestStreak: Math.max(user.longestStreak, newStreak),
    lastWritingDate: today,
    treeStage: newTreeStage,
    totalWords,
    totalSessions: (user.totalSessions || 0) + 1
  });

  // Generate activities for friends feed
  try {
    await generateActivities(req.user.id, user.name, user, { ...user, xp: newXP, totalWords, streak: newStreak }, wordCount, duration);
  } catch (e) { /* activity generation is non-critical */ }

  await logAction('session_completed', { docId: req.params.id, wordCount, duration, xpEarned }, req.user.id);
  const { password: _, ...safeUser } = updatedUser;
  res.json({ document: await findOne('documents.json', d => d.id === req.params.id), user: safeUser });
});

router.get('/:id/comments', async (req, res) => {
  const doc = await findOne('documents.json', d => d.id === req.params.id && d.userId === req.user.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  const comments = await findMany('comments.json', c => c.documentId === doc.id && c.status === 'pending');
  res.json(comments);
});

router.get('/:id/comments/history', async (req, res) => {
  const doc = await findOne('documents.json', d => d.id === req.params.id && d.userId === req.user.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  const comments = await findMany('comments.json', c => c.documentId === doc.id && c.status !== 'pending');
  res.json(comments.sort((a, b) => new Date(b.resolvedAt || b.createdAt) - new Date(a.resolvedAt || a.createdAt)));
});

router.post('/:id/share', async (req, res) => {
  const { type } = req.body;
  if (!['view', 'comment', 'edit'].includes(type)) {
    return res.status(400).json({ error: 'Invalid share type' });
  }

  const doc = await findOne('documents.json', d => d.id === req.params.id && d.userId === req.user.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  const shareLink = {
    id: uuid(),
    type,
    token: uuid().replace(/-/g, ''),
    createdAt: new Date().toISOString()
  };

  const links = [...doc.shareLinks, shareLink];
  await updateOne('documents.json', d => d.id === req.params.id, { shareLinks: links });
  res.json(shareLink);
});

router.post('/:id/abandon', async (req, res) => {
  const doc = await findOne('documents.json', d => d.id === req.params.id && d.userId === req.user.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  const { reason } = req.body; // 'typing_stopped' | 'tab_left'

  // If zero words written, just delete — no point saving
  if (!doc.wordCount || doc.wordCount <= 0) {
    await deleteOne('documents.json', d => d.id === req.params.id);
    return res.json({ success: true, message: 'Empty session removed' });
  }

  await updateOne('documents.json', d => d.id === req.params.id, {
    deletedBySystem: true,
    deleted: true,
    failReason: reason || 'unknown',
    failedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  await logAction('session_failed', { docId: req.params.id, reason: reason || 'unknown', title: doc.title, wordCount: doc.wordCount }, req.user.id);
  res.json({ success: true, message: 'Document lost' });
});

// Copy tracking — free: 3/month, pro: 15/month
router.post('/copy', authenticate, async (req, res) => {
  const user = await findOne('users.json', u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${now.getMonth()}`;
  let copyCount = user.copyCount || 0;
  const resetAt = user.copyCountResetAt || '';

  // Reset count if new month
  if (resetAt !== currentMonth) {
    copyCount = 0;
  }

  const limit = user.plan === 'premium' ? 15 : 3;
  const ms = req.app.get('maintenanceState');
  const maintenanceBypass = ms && ms.active;
  if (copyCount >= limit && !maintenanceBypass) {
    return res.json({ allowed: false, remaining: 0, limit });
  }

  // Don't count against limit during maintenance
  if (!maintenanceBypass) {
    copyCount++;
    await updateOne('users.json', u => u.id === req.user.id, {
      copyCount,
      copyCountResetAt: currentMonth
    });
  }

  res.json({ allowed: true, remaining: maintenanceBypass ? limit : Math.max(0, limit - copyCount), limit });
});

// Pin/unpin document (Pro only)
router.post('/:id/pin', async (req, res) => {
  const user = await findOne('users.json', u => u.id === req.user.id);
  if (!user || user.plan !== 'premium') {
    return res.status(403).json({ error: 'Pin is a Pro feature' });
  }
  const doc = await findOne('documents.json', d => d.id === req.params.id && d.userId === req.user.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  const pinned = !doc.pinned;
  await updateOne('documents.json', d => d.id === req.params.id, { pinned });
  res.json({ pinned });
});

// Export document to PDF (Pro only) — returns HTML for client-side PDF generation
router.get('/:id/export', async (req, res) => {
  const user = await findOne('users.json', u => u.id === req.user.id);
  if (!user || user.plan !== 'premium') {
    return res.status(403).json({ error: 'Export is a Pro feature' });
  }
  const doc = await findOne('documents.json', d => d.id === req.params.id && d.userId === req.user.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  res.json({ title: doc.title, content: doc.content, wordCount: doc.wordCount, createdAt: doc.createdAt });
});

// Session analytics (available to all users — Pro gets full insights)
router.get('/analytics/sessions', async (req, res) => {
  const user = await findOne('users.json', u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const isPro = user.plan === 'premium';
  const allDocs = await findMany('documents.json', d => d.userId === req.user.id);
  const docs = allDocs.filter(d => !d.deleted);
  const completed = docs.filter(d => d.xpEarned > 0);

  // ── Basic stats (all users) ──
  // Use user.totalSessions as source of truth (incremented on each completion)
  const totalSessions = user.totalSessions || completed.length;
  const totalWords = completed.reduce((s, d) => s + (d.wordCount || 0), 0);
  const totalWritingTime = docs.filter(d => d.duration > 0).reduce((s, d) => s + (Number(d.duration) || 0), 0);

  // ── Personal Records ──
  // Longest session (by duration)
  const longestSession = completed.reduce((best, d) => {
    if ((d.duration || 0) > (best.duration || 0)) return { duration: d.duration, words: d.wordCount || 0, date: d.createdAt };
    return best;
  }, { duration: 0, words: 0, date: null });

  // Most words in a single day
  const dailyWordTotals = {};
  completed.forEach(d => {
    const day = d.createdAt.split('T')[0];
    dailyWordTotals[day] = (dailyWordTotals[day] || 0) + (d.wordCount || 0);
  });
  let mostWordsDay = { words: 0, date: null };
  for (const [date, words] of Object.entries(dailyWordTotals)) {
    if (words > mostWordsDay.words) mostWordsDay = { words, date };
  }

  // Most words in a week (rolling 7-day window)
  const sortedDays = Object.entries(dailyWordTotals).sort((a, b) => a[0].localeCompare(b[0]));
  let mostWordsWeek = { words: 0, startDate: null, endDate: null };
  if (sortedDays.length > 0) {
    for (let i = 0; i < sortedDays.length; i++) {
      const windowStart = new Date(sortedDays[i][0]);
      const windowEnd = new Date(windowStart); windowEnd.setDate(windowEnd.getDate() + 6);
      const endStr = windowEnd.toISOString().split('T')[0];
      let weekWords = 0;
      for (let j = i; j < sortedDays.length && sortedDays[j][0] <= endStr; j++) {
        weekWords += sortedDays[j][1];
      }
      if (weekWords > mostWordsWeek.words) {
        mostWordsWeek = { words: weekWords, startDate: sortedDays[i][0], endDate: endStr };
      }
    }
  }

  // Best streak (from user record) — live check
  const bestStreak = { days: user.longestStreak || 0 };
  const _today = new Date().toISOString().split('T')[0];
  const _yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  const currentStreak = (user.lastWritingDate === _today || user.lastWritingDate === _yesterday) ? (user.streak || 0) : 0;

  const personalRecords = { longestSession, mostWordsDay, mostWordsWeek, bestStreak, currentStreak };

  // ── Writing Rhythm (Pro) ──
  let writingRhythm = null;
  if (isPro && completed.length > 0) {
    // Hour distribution
    const hourDist = new Array(24).fill(0);
    completed.forEach(d => { hourDist[new Date(d.createdAt).getHours()]++; });
    const bestHour = hourDist.indexOf(Math.max(...hourDist));

    // Day of week distribution
    const dayDist = new Array(7).fill(0);
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    completed.forEach(d => { dayDist[new Date(d.createdAt).getDay()]++; });
    const bestDayIdx = dayDist.indexOf(Math.max(...dayDist));
    const avgPerDay = totalSessions / 7;
    const bestDayPct = avgPerDay > 0 ? Math.round(((dayDist[bestDayIdx] / totalSessions) * 7 - 1) * 100) : 0;

    // Time of day classification: morning (5-11), afternoon (12-17), night (18-4)
    const morning = hourDist.slice(5, 12).reduce((a, b) => a + b, 0);
    const afternoon = hourDist.slice(12, 18).reduce((a, b) => a + b, 0);
    const night = hourDist.slice(18).reduce((a, b) => a + b, 0) + hourDist.slice(0, 5).reduce((a, b) => a + b, 0);
    const writerType = night >= morning && night >= afternoon ? 'Night Writer' :
      morning >= afternoon ? 'Early Bird' : 'Afternoon Author';

    // Average session length (seconds)
    const avgSessionLength = Math.round(totalWritingTime / totalSessions);

    // Average words per day (over active days) and per week (over active weeks)
    const activeDays = Object.keys(dailyWordTotals).length;
    const avgWordsPerDay = activeDays > 0 ? Math.round(totalWords / activeDays) : 0;

    // Active weeks count
    const weekSet = new Set();
    completed.forEach(d => {
      const dt = new Date(d.createdAt);
      const weekStart = new Date(dt); weekStart.setDate(dt.getDate() - dt.getDay());
      weekSet.add(weekStart.toISOString().split('T')[0]);
    });
    const avgWordsPerWeek = weekSet.size > 0 ? Math.round(totalWords / weekSet.size) : 0;

    // Normal vs dangerous mode split
    const normalCount = completed.filter(d => d.mode !== 'dangerous').length;
    const dangerCount = completed.filter(d => d.mode === 'dangerous').length;

    writingRhythm = {
      hourDistribution: hourDist, bestHour,
      dayDistribution: dayDist, bestDay: dayNames[bestDayIdx], bestDayPct,
      writerType, avgSessionLength, avgWordsPerDay, avgWordsPerWeek,
      modeSplit: { normal: normalCount, dangerous: dangerCount }
    };
  }

  // ── Monthly Comparison (Pro) ──
  let monthlyComparison = null;
  if (isPro && completed.length > 0) {
    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(thisMonthStart - 1);

    const thisMonth = completed.filter(d => new Date(d.createdAt) >= thisMonthStart);
    const lastMonth = completed.filter(d => {
      const dt = new Date(d.createdAt);
      return dt >= lastMonthStart && dt <= lastMonthEnd;
    });

    const tmWords = thisMonth.reduce((s, d) => s + (d.wordCount || 0), 0);
    const lmWords = lastMonth.reduce((s, d) => s + (d.wordCount || 0), 0);
    const tmSessions = thisMonth.length;
    const lmSessions = lastMonth.length;
    const tmTime = thisMonth.reduce((s, d) => s + (d.duration || 0), 0);
    const lmTime = lastMonth.reduce((s, d) => s + (d.duration || 0), 0);

    const pctChange = (curr, prev) => prev > 0 ? Math.round(((curr - prev) / prev) * 100) : (curr > 0 ? 100 : 0);

    monthlyComparison = {
      thisMonth: { words: tmWords, sessions: tmSessions, time: tmTime, name: thisMonthStart.toLocaleString('en', { month: 'long' }) },
      lastMonth: { words: lmWords, sessions: lmSessions, time: lmTime, name: lastMonthStart.toLocaleString('en', { month: 'long' }) },
      change: { words: pctChange(tmWords, lmWords), sessions: pctChange(tmSessions, lmSessions), time: pctChange(tmTime, lmTime) }
    };
  }

  // ── Danger Mode Report Card ──
  const dangerSessions = docs.filter(d => d.mode === 'dangerous');
  const dangerCompleted = dangerSessions.filter(d => d.xpEarned > 0);
  const dangerSurvivalRate = dangerSessions.length > 0 ? Math.round((dangerCompleted.length / dangerSessions.length) * 100) : null;

  // Trend: last 10 vs previous 10 dangerous sessions
  let dangerTrend = null;
  if (dangerSessions.length >= 5) {
    const sorted = [...dangerSessions].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const recent = sorted.slice(0, Math.min(10, Math.floor(sorted.length / 2)));
    const older = sorted.slice(recent.length, recent.length * 2);
    if (older.length > 0) {
      const recentRate = Math.round((recent.filter(d => d.xpEarned > 0).length / recent.length) * 100);
      const olderRate = Math.round((older.filter(d => d.xpEarned > 0).length / older.length) * 100);
      dangerTrend = recentRate - olderRate; // positive = improving
    }
  }

  // Average time before fail (failed dangerous sessions)
  const dangerFailed = dangerSessions.filter(d => !d.xpEarned || d.xpEarned === 0);
  const avgTimeBeforeFail = dangerFailed.length > 0
    ? Math.round(dangerFailed.reduce((s, d) => s + (d.duration || 0), 0) / dangerFailed.length)
    : null;

  const dangerReport = {
    survivalRate: dangerSurvivalRate, total: dangerSessions.length,
    completed: dangerCompleted.length, trend: dangerTrend, avgTimeBeforeFail
  };

  // ── Word Count Milestones ──
  const milestoneThresholds = [1000, 5000, 10000, 25000, 50000, 100000];
  const milestones = milestoneThresholds.map(t => ({
    target: t, unlocked: totalWords >= t, current: Math.min(totalWords, t)
  }));
  const nextMilestone = milestones.find(m => !m.unlocked) || null;

  // ── Daily Words (for chart, last 90 days) ──
  const dailyWords = {};
  const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000);
  completed.filter(d => new Date(d.createdAt) >= ninetyDaysAgo).forEach(d => {
    const day = d.createdAt.split('T')[0];
    dailyWords[day] = (dailyWords[day] || 0) + (d.wordCount || 0);
  });

  // ── Focus score ──
  const totalAttempts = docs.length;
  const focusScore = totalAttempts > 0 ? Math.round((completed.length / totalAttempts) * 100) : 0;

  // Sync corrected totalWords back to user profile if it drifted
  if (user.totalWords && Math.abs((user.totalWords || 0) - totalWords) > 100) {
    await updateOne('users.json', u => u.id === req.user.id, { totalWords });
  }

  res.json({
    isPro, totalSessions, totalWords, totalWritingTime, focusScore,
    personalRecords, writingRhythm, monthlyComparison,
    dangerReport, milestones, nextMilestone,
    dailyWords,
    // User fields for shareable card
    streak: currentStreak, longestStreak: user.longestStreak || 0,
    treeStage: user.treeStage || 0, level: user.level || 1, xp: user.xp || 0,
    username: user.username || user.name, displayName: user.name
  });
});

module.exports = router;
