const jwt = require('jsonwebtoken');
const { findOne, updateOne } = require('../utils/storage');
const { logAction } = require('../utils/logger');

const SECRET = process.env.JWT_SECRET || 'iwrite-dev-secret-change-in-production';

function generateToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    SECRET,
    { expiresIn: '7d' }
  );
}

function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const token = header.split(' ')[1];
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Check and auto-downgrade expired premium subscriptions
async function checkSubscriptionExpiry(req, res, next) {
  try {
    const user = await findOne('users.json', u => u.id === req.user.id);
    if (user && user.plan === 'premium' && user.planExpiresAt && user.planExpiresAt !== 'infinite') {
      const expiresAt = new Date(user.planExpiresAt);
      if (expiresAt < new Date()) {
        await updateOne('users.json', u => u.id === user.id, {
          plan: 'free',
          planExpired: true,
          planExpiredAt: new Date().toISOString()
        });
        logAction('subscription_expired', {
          userId: user.id,
          planDuration: user.planDuration,
          expiredAt: user.planExpiresAt
        }, 'system');
        // Set flag so frontend can show expiry toast
        req.subscriptionExpired = true;
      }
    }
  } catch { /* non-critical — don't block the request */ }
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

module.exports = { generateToken, authenticate, checkSubscriptionExpiry, requireAdmin, SECRET };
