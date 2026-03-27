const express = require('express');
const Stripe = require('stripe');
const { findOne, updateOne } = require('../utils/storage');
const { authenticate } = require('../middleware/auth');
const { logAction } = require('../utils/logger');

const router = express.Router();
let stripeClient = null;

const APP_URL = process.env.APP_URL || 'https://iwrite4.me';

// Map duration codes to Stripe Price IDs
const PRICE_MAP = {
  '1m': process.env.STRIPE_PRICE_1M,
  '3m': process.env.STRIPE_PRICE_3M,
  '6m': process.env.STRIPE_PRICE_6M
};

// Duration in days for planExpiresAt calculation
const DURATION_DAYS = {
  '1m': 30,
  '3m': 90,
  '6m': 180
};

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  if (!stripeClient) {
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-12-18.acacia' });
  }
  return stripeClient;
}

function requireStripe(res) {
  const stripe = getStripe();
  if (!stripe) {
    res.status(503).json({ error: 'Stripe billing is not configured right now.' });
    return null;
  }
  return stripe;
}

// ─────────────────────────────────────────────
// POST /api/stripe/create-checkout-session
// Creates a Stripe Checkout Session and returns the URL
// ─────────────────────────────────────────────
router.post('/create-checkout-session', authenticate, async (req, res) => {
  try {
    const stripe = requireStripe(res);
    if (!stripe) return;

    const { duration, trial } = req.body;

    if (!duration || !PRICE_MAP[duration]) {
      return res.status(400).json({ error: 'Invalid duration. Use 1m, 3m, or 6m.' });
    }

    const priceId = PRICE_MAP[duration];
    if (!priceId) {
      return res.status(500).json({ error: 'Stripe price not configured for this duration.' });
    }

    const user = await findOne('users.json', u => u.id === req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Trial guard: only allow if user has never used a trial
    if (trial && user.trialUsed) {
      return res.status(400).json({ error: 'You have already used your free trial.' });
    }

    // Build the checkout session config
    const sessionConfig = {
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${APP_URL}/app.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/app.html#upgrade`,
      allow_promotion_codes: true,
      metadata: {
        userId: user.id,
        duration
      },
      subscription_data: {
        metadata: {
          userId: user.id,
          duration
        }
      }
    };

    // If user already has a Stripe customer ID, reuse it
    if (user.stripeCustomerId) {
      sessionConfig.customer = user.stripeCustomerId;
    } else {
      sessionConfig.customer_email = user.email;
    }

    // Add trial period if requested
    if (trial) {
      sessionConfig.subscription_data.trial_period_days = 7;
    }

    const session = await stripe.checkout.sessions.create(sessionConfig);

    logAction('stripe_checkout_created', {
      duration,
      trial: !!trial,
      sessionId: session.id
    }, user.id);

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// ─────────────────────────────────────────────
// GET /api/stripe/verify-session
// Verifies payment on user return (handles race condition where
// user returns before webhook fires)
// ─────────────────────────────────────────────
router.get('/verify-session', authenticate, async (req, res) => {
  try {
    const stripe = requireStripe(res);
    if (!stripe) return;

    const { session_id } = req.query;
    if (!session_id) {
      return res.status(400).json({ error: 'Missing session_id' });
    }

    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ['subscription']
    });

    if (session.payment_status !== 'paid' && !session.subscription?.trial_end) {
      return res.json({ success: false, status: session.payment_status });
    }

    const userId = session.metadata?.userId;
    if (!userId || userId !== req.user.id) {
      return res.status(403).json({ error: 'Session does not belong to this user' });
    }

    const user = await findOne('users.json', u => u.id === userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Idempotency: if already processed, skip
    const subscriptionId = typeof session.subscription === 'string'
      ? session.subscription
      : session.subscription?.id;

    if (user.stripeSubscriptionId === subscriptionId) {
      return res.json({ success: true, plan: 'premium', alreadyProcessed: true });
    }

    // Apply the subscription
    const duration = session.metadata?.duration || '1m';
    const now = new Date();
    const subscription = typeof session.subscription === 'object'
      ? session.subscription
      : await stripe.subscriptions.retrieve(session.subscription);

    const isTrial = subscription.trial_end && subscription.trial_end > Math.floor(Date.now() / 1000);

    const updates = {
      plan: 'premium',
      planDuration: duration,
      planStartedAt: now.toISOString(),
      planExpiresAt: new Date(now.getTime() + DURATION_DAYS[duration] * 86400000).toISOString(),
      planSource: isTrial ? 'trial' : 'stripe',
      stripeCustomerId: session.customer,
      stripeSubscriptionId: subscriptionId,
      planPaymentFailed: false
    };

    if (isTrial) {
      updates.trialUsed = true;
    }

    await updateOne('users.json', u => u.id === userId, updates);

    logAction('stripe_payment_verified', {
      duration,
      source: updates.planSource,
      sessionId: session.id
    }, userId);

    res.json({ success: true, plan: 'premium', source: updates.planSource });
  } catch (err) {
    console.error('Stripe verify error:', err);
    res.status(500).json({ error: 'Failed to verify session' });
  }
});

// ─────────────────────────────────────────────
// POST /api/stripe/create-portal-session
// Creates a Stripe Customer Portal session for billing management
// ─────────────────────────────────────────────
router.post('/create-portal-session', authenticate, async (req, res) => {
  try {
    const stripe = requireStripe(res);
    if (!stripe) return;

    const user = await findOne('users.json', u => u.id === req.user.id);
    if (!user || !user.stripeCustomerId) {
      return res.status(400).json({ error: 'No Stripe billing account found' });
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${APP_URL}/app.html#upgrade`
    });

    res.json({ url: portalSession.url });
  } catch (err) {
    console.error('Stripe portal error:', err);
    res.status(500).json({ error: 'Failed to create billing portal session' });
  }
});

// ─────────────────────────────────────────────
// Webhook handler (exported separately — mounted
// BEFORE express.json() in index.js)
// ─────────────────────────────────────────────
async function stripeWebhookHandler(req, res) {
  const stripe = getStripe();
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'Stripe webhook is not configured right now.' });
  }

  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.metadata?.userId;
        if (!userId) {
          console.warn('Webhook: checkout.session.completed without userId metadata');
          break;
        }

        const user = await findOne('users.json', u => u.id === userId);
        if (!user) {
          console.warn(`Webhook: user not found: ${userId}`);
          break;
        }

        const subscriptionId = session.subscription;

        // Idempotency check
        if (user.stripeSubscriptionId === subscriptionId) {
          console.log(`Webhook: already processed subscription ${subscriptionId} for user ${userId}`);
          break;
        }

        // Retrieve subscription to check trial status
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const isTrial = subscription.trial_end && subscription.trial_end > Math.floor(Date.now() / 1000);
        const duration = session.metadata?.duration || '1m';
        const now = new Date();

        const updates = {
          plan: 'premium',
          planDuration: duration,
          planStartedAt: now.toISOString(),
          planExpiresAt: new Date(now.getTime() + DURATION_DAYS[duration] * 86400000).toISOString(),
          planSource: isTrial ? 'trial' : 'stripe',
          stripeCustomerId: session.customer,
          stripeSubscriptionId: subscriptionId,
          planPaymentFailed: false
        };

        if (isTrial) {
          updates.trialUsed = true;
        }

        await updateOne('users.json', u => u.id === userId, updates);

        logAction('stripe_subscription_created', {
          duration,
          source: updates.planSource,
          subscriptionId
        }, userId);

        break;
      }

      case 'invoice.paid': {
        const invoice = event.data.object;

        // Skip initial payment — already handled by checkout.session.completed
        if (invoice.billing_reason === 'subscription_create') {
          break;
        }

        // Handle renewals
        if (invoice.billing_reason === 'subscription_cycle') {
          const subscriptionId = invoice.subscription;
          const user = await findOne('users.json', u => u.stripeSubscriptionId === subscriptionId);
          if (!user) {
            console.warn(`Webhook: invoice.paid — no user found for subscription ${subscriptionId}`);
            break;
          }

          const duration = user.planDuration || '1m';
          const now = new Date();
          const currentExpiry = user.planExpiresAt ? new Date(user.planExpiresAt) : now;
          const base = currentExpiry > now ? currentExpiry : now;

          await updateOne('users.json', u => u.id === user.id, {
            planExpiresAt: new Date(base.getTime() + DURATION_DAYS[duration] * 86400000).toISOString(),
            planPaymentFailed: false,
            planSource: 'stripe'
          });

          logAction('stripe_subscription_renewed', {
            duration,
            subscriptionId
          }, user.id);
        }

        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const subscriptionId = invoice.subscription;
        const user = await findOne('users.json', u => u.stripeSubscriptionId === subscriptionId);

        if (user) {
          await updateOne('users.json', u => u.id === user.id, {
            planPaymentFailed: true
          });

          logAction('stripe_payment_failed', {
            subscriptionId,
            attemptCount: invoice.attempt_count
          }, user.id);
        }

        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const subscriptionId = subscription.id;
        const user = await findOne('users.json', u => u.stripeSubscriptionId === subscriptionId);

        if (user) {
          await updateOne('users.json', u => u.id === user.id, {
            plan: 'free',
            planSource: null,
            stripeSubscriptionId: null,
            planPaymentFailed: false,
            planExpired: true,
            planExpiredAt: new Date().toISOString()
          });

          logAction('stripe_subscription_cancelled', {
            subscriptionId
          }, user.id);
        }

        break;
      }

      default:
        // Unhandled event type — log but don't error
        console.log(`Unhandled Stripe event: ${event.type}`);
    }
  } catch (err) {
    // Log internal errors but return 200 to Stripe to prevent infinite retries
    console.error(`Webhook handler error for ${event.type}:`, err);
  }

  // Always return 200 to Stripe (except for signature failures handled above)
  res.json({ received: true });
}

module.exports = { router, stripeWebhookHandler };
