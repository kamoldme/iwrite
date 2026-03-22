const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const sharp = require('sharp');
const { findOne, insertOne, updateOne } = require('../utils/storage');
const { generateToken, authenticate, checkSubscriptionExpiry } = require('../middleware/auth');
const { logAction } = require('../utils/logger');
const { OAuth2Client } = require('google-auth-library');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Only images allowed'));
    cb(null, true);
  }
});

// Restricted words list for usernames and names
const RESTRICTED_WORDS = [
  'admin', 'administrator', 'moderator', 'mod', 'staff', 'support', 'system', 'official',
  'fuck', 'shit', 'ass', 'bitch', 'damn', 'dick', 'pussy', 'cock', 'cunt', 'bastard',
  'whore', 'slut', 'fag', 'faggot', 'nigger', 'nigga', 'retard', 'rape', 'rapist',
  'nazi', 'hitler', 'porn', 'sex', 'penis', 'vagina', 'anus', 'dildo', 'hentai',
  'kill', 'murder', 'suicide', 'terrorist', 'bomb', 'drug', 'cocaine', 'heroin',
  'asshole', 'motherfucker', 'wanker', 'twat', 'piss', 'bollocks', 'crap',
  'iwrite', 'iwrite4me', 'root', 'superuser', 'null', 'undefined'
];

function containsBadWord(str) {
  if (!str) return false;
  const lower = str.toLowerCase().replace(/[^a-z0-9]/g, '');
  return RESTRICTED_WORDS.some(w => lower.includes(w));
}

function validateUsername(username) {
  if (!username) return 'Username is required';
  if (username.length < 3) return 'Username must be at least 3 characters';
  if (username.length > 30) return 'Username must be at most 30 characters';
  if (!/^[a-zA-Z0-9_.-]+$/.test(username)) return 'Username can only contain letters, numbers, underscores, dots, and hyphens';
  if (containsBadWord(username)) return 'Username contains inappropriate content';
  return null;
}

function generateReferralCode() {
  // 8-char alphanumeric code
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function generateRandomUsername() {
  const adjectives = ['swift', 'bright', 'quiet', 'bold', 'keen', 'wild', 'calm', 'warm', 'cool', 'free'];
  const nouns = ['writer', 'scribe', 'author', 'poet', 'muse', 'quill', 'ink', 'page', 'story', 'word'];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const num = Math.floor(Math.random() * 9999);
  return `${adj}_${noun}_${num}`;
}

const router = express.Router();

router.post('/register', async (req, res) => {
  try {
    const { name, email, password, username } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    if (containsBadWord(name)) {
      return res.status(400).json({ error: 'Name contains inappropriate content' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const existing = await findOne('users.json', u => u.email === email);
    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    // Validate username if provided, otherwise generate one
    let finalUsername = username;
    if (finalUsername) {
      const usernameError = validateUsername(finalUsername);
      if (usernameError) return res.status(400).json({ error: usernameError });
      const usernameTaken = await findOne('users.json', u => u.username && u.username.toLowerCase() === finalUsername.toLowerCase());
      if (usernameTaken) return res.status(409).json({ error: 'Username is already taken' });
    } else {
      finalUsername = generateRandomUsername();
    }

    const hash = await bcrypt.hash(password, 12);
    const user = {
      id: uuid(),
      name,
      username: finalUsername,
      email,
      password: hash,
      role: 'user',
      plan: 'free',
      planDuration: null,
      planStartedAt: null,
      planExpiresAt: null,
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
      lastUsernameChange: null,
      referralCode: generateReferralCode(),
      referredBy: null,
      referralCount: 0,
      createdAt: new Date().toISOString()
    };

    // Handle referral — credit the referrer
    const { ref } = req.body;
    if (ref) {
      const referrer = await findOne('users.json', u => u.referralCode === ref);
      if (referrer && referrer.id !== user.id) {
        user.referredBy = ref;
        const newCount = (referrer.referralCount || 0) + 1;
        const updates = { referralCount: newCount };
        // Every 5 referrals → grant 1 month of Pro
        if (newCount % 5 === 0) {
          const now = new Date();
          const currentExpiry = referrer.planExpiresAt ? new Date(referrer.planExpiresAt) : now;
          const base = currentExpiry > now ? currentExpiry : now;
          updates.plan = 'premium';
          updates.planStartedAt = updates.planStartedAt || now.toISOString();
          updates.planExpiresAt = new Date(base.getTime() + 30 * 86400000).toISOString();
        }
        await updateOne('users.json', u => u.id === referrer.id, updates);
      }
    }

    await insertOne('users.json', user);
    logAction('user_registered', { name: user.name, email: user.email, referredBy: ref || null }, user.id);
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

    const user = await findOne('users.json', u => u.email === email);
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

router.get('/me', authenticate, checkSubscriptionExpiry, async (req, res) => {
  let user = await findOne('users.json', u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Real-time streak check — if lastWritingDate is older than yesterday, streak is broken
  if (user.lastWritingDate && user.streak > 0) {
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    if (user.lastWritingDate !== today && user.lastWritingDate !== yesterday) {
      // Streak broken — reset streak and tree
      user = await updateOne('users.json', u => u.id === req.user.id, {
        streak: 0,
        treeStage: 0
      });
    }
  }

  const { password: _, ...safeUser } = user;
  // If subscription just expired during this request, notify the frontend
  if (req.subscriptionExpired) {
    safeUser.subscriptionJustExpired = true;
  }
  res.json(safeUser);
});

router.patch('/me', authenticate, async (req, res) => {
  try {
    const user = await findOne('users.json', u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const updates = {};

    // Name update (always allowed)
    if (req.body.name !== undefined) {
      if (containsBadWord(req.body.name)) {
        return res.status(400).json({ error: 'Name contains inappropriate content' });
      }
      updates.name = req.body.name;
    }

    // Username update — Free: once per 30 days, Pro: 3 times per month
    if (req.body.username !== undefined) {
      const usernameError = validateUsername(req.body.username);
      if (usernameError) return res.status(400).json({ error: usernameError });

      const isPro = user.plan === 'premium';
      if (isPro) {
        // Pro: 3 changes per calendar month
        const currentMonth = new Date().toISOString().slice(0, 7);
        const changesThisMonth = (user.usernameChangesMonth === currentMonth) ? (user.usernameChangesCount || 0) : 0;
        if (changesThisMonth >= 3) {
          return res.status(400).json({ error: 'Username change limit reached (3/month for Pro)' });
        }
        updates.usernameChangesCount = changesThisMonth + 1;
        updates.usernameChangesMonth = currentMonth;
      } else {
        // Free: once per 30 days
        if (user.lastUsernameChange) {
          const lastChange = new Date(user.lastUsernameChange);
          const now = new Date();
          const diffDays = (now - lastChange) / (1000 * 60 * 60 * 24);
          if (diffDays < 30) {
            const daysLeft = Math.ceil(30 - diffDays);
            return res.status(400).json({ error: `You can change your username again in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}` });
          }
        }
      }

      // Check uniqueness
      const taken = await findOne('users.json', u => u.id !== req.user.id && u.username && u.username.toLowerCase() === req.body.username.toLowerCase());
      if (taken) return res.status(409).json({ error: 'Username is already taken' });

      updates.username = req.body.username;
      updates.lastUsernameChange = new Date().toISOString();
    }

    // Clear needsProfile flag
    if (req.body.needsProfile === false) {
      updates.needsProfile = false;
    }

    const updated = await updateOne('users.json', u => u.id === req.user.id, updates);
    const { password: _, ...safeUser } = updated;
    res.json(safeUser);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/change-password', authenticate, async (req, res) => {
  try {
    const user = await findOne('users.json', u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.provider === 'google') {
      return res.status(400).json({ error: 'Google accounts cannot change password' });
    }

    const { currentPassword, newPassword, confirmPassword } = req.body;
    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ error: 'All fields are required' });
    }

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
    await updateOne('users.json', u => u.id === req.user.id, { password: hash });

    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== GOOGLE OAUTH =====
router.post('/google', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) {
      return res.status(400).json({ error: 'Credential is required' });
    }

    // Verify the credential with Google
    const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID
    });
    const payload = ticket.getPayload();
    const googleId = payload.sub;
    const email = payload.email;
    const name = payload.name;

    // Find user by googleId first
    let user = await findOne('users.json', u => u.googleId === googleId);

    // If not found by googleId, try email
    if (!user) {
      user = await findOne('users.json', u => u.email === email);
      if (user && !user.googleId) {
        // Link Google to existing email account
        await updateOne('users.json', u => u.id === user.id, {
          googleId,
          provider: 'google'
        });
        user = await findOne('users.json', u => u.id === user.id);
      }
    }

    // If still not found, create new user
    let isNewUser = false;
    if (!user) {
      isNewUser = true;
      user = {
        id: uuid(),
        name,
        username: generateRandomUsername(),
        email,
        password: null,
        googleId,
        provider: 'google',
        role: 'user',
        plan: 'free',
        planDuration: null,
        planStartedAt: null,
        planExpiresAt: null,
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
        lastUsernameChange: null,
        referralCode: generateReferralCode(),
        referredBy: null,
        referralCount: 0,
        needsProfile: true,
        createdAt: new Date().toISOString()
      };

      // Handle referral — credit the referrer
      const { ref } = req.body;
      if (ref) {
        const referrer = await findOne('users.json', u => u.referralCode === ref);
        if (referrer && referrer.id !== user.id) {
          user.referredBy = ref;
          const newCount = (referrer.referralCount || 0) + 1;
          const updates = { referralCount: newCount };
          if (newCount % 5 === 0) {
            const now = new Date();
            const currentExpiry = referrer.planExpiresAt ? new Date(referrer.planExpiresAt) : now;
            const base = currentExpiry > now ? currentExpiry : now;
            updates.plan = 'premium';
            updates.planStartedAt = updates.planStartedAt || now.toISOString();
            updates.planExpiresAt = new Date(base.getTime() + 30 * 86400000).toISOString();
          }
          await updateOne('users.json', u => u.id === referrer.id, updates);
        }
      }

      await insertOne('users.json', user);
      logAction('user_registered_google', { name: user.name, email: user.email, referredBy: user.referredBy }, user.id);
    }

    const token = generateToken(user);
    const { password: _, ...safeUser } = user;
    res.json({ token, user: safeUser, isNewUser });
  } catch (err) {
    console.error('Google OAuth error:', err);
    res.status(401).json({ error: 'Google authentication failed' });
  }
});

router.post('/avatar', authenticate, upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const avatarsDir = path.join(__dirname, '../data/avatars');
    if (!fs.existsSync(avatarsDir)) fs.mkdirSync(avatarsDir, { recursive: true });

    const filepath = path.join(avatarsDir, `${req.user.id}.jpg`);

    await sharp(req.file.buffer)
      .resize(480, 480, { fit: 'cover', position: 'center' })
      .jpeg({ quality: 70 })
      .toFile(filepath);

    const avatarUrl = `/uploads/avatars/${req.user.id}.jpg`;
    const avatarUpdatedAt = Date.now();
    const updated = await updateOne('users.json', u => u.id === req.user.id, { avatar: avatarUrl, avatarUpdatedAt });
    const { password: _, ...safeUser } = updated;
    res.json(safeUser);
  } catch (err) {
    console.error('Avatar upload error:', err);
    res.status(500).json({ error: 'Failed to upload avatar' });
  }
});

router.delete('/avatar', authenticate, async (req, res) => {
  try {
    const filepath = path.join(__dirname, '../data/avatars', `${req.user.id}.jpg`);
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    const updated = await updateOne('users.json', u => u.id === req.user.id, { avatar: null, avatarUpdatedAt: null });
    const { password: _, ...safeUser } = updated;
    res.json(safeUser);
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove avatar' });
  }
});

// ===== REFERRAL =====
router.get('/referral', authenticate, async (req, res) => {
  try {
    let user = await findOne('users.json', u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Backfill referral code for existing users who don't have one
    if (!user.referralCode) {
      user = await updateOne('users.json', u => u.id === req.user.id, {
        referralCode: generateReferralCode(),
        referralCount: user.referralCount || 0,
        referredBy: user.referredBy || null
      });
    }

    // Find users who were referred by this user
    const { findMany } = require('../utils/storage');
    const referred = await findMany('users.json', u => u.referredBy === user.referralCode);
    const referredList = referred.map(u => ({
      name: (u.name || '').split(' ')[0],
      joinedAt: u.createdAt
    }));

    res.json({
      referralCode: user.referralCode,
      referralCount: user.referralCount || 0,
      referredUsers: referredList,
      nextRewardAt: Math.ceil(((user.referralCount || 0) + 1) / 5) * 5,
      progress: (user.referralCount || 0) % 5
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
