// Telegram Bot — Admin notifications for iWrite
// Sends real-time updates about registrations, subscriptions, moderation, etc.
// Requires env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_CHAT_ID

const TelegramBot = require('node-telegram-bot-api');

let bot = null;
let chatId = null;

function init() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log('[Telegram] No TELEGRAM_BOT_TOKEN set — bot disabled');
    return;
  }

  try {
    bot = new TelegramBot(token, { polling: true });
    chatId = process.env.TELEGRAM_ADMIN_CHAT_ID || null;

    // /start command — reveals chat ID for setup
    bot.onText(/\/start/, (msg) => {
      const id = msg.chat.id;
      bot.sendMessage(id, `👋 Your chat ID is: \`${id}\`\n\nSet this as \`TELEGRAM_ADMIN_CHAT_ID\` in Railway env vars to receive admin notifications.`, { parse_mode: 'Markdown' });
      // Auto-set if not configured yet
      if (!chatId) {
        chatId = id.toString();
        console.log(`[Telegram] Admin chat ID auto-set to ${chatId}`);
      }
    });

    // /status command — quick health check
    bot.onText(/\/status/, (msg) => {
      if (msg.chat.id.toString() !== chatId) return;
      bot.sendMessage(chatId, `✅ Bot is running\n📡 Chat ID: \`${chatId}\`\n⏰ ${new Date().toISOString()}`, { parse_mode: 'Markdown' });
    });

    // Handle inline button callbacks (moderation approve/reject)
    bot.on('callback_query', async (query) => {
      if (!query.data) return;
      const [action, storyId] = query.data.split(':');
      if (!storyId) return;

      try {
        const { findOne, updateOne } = require('./utils/storage');
        const story = await findOne('stories.json', s => s.id === storyId);
        if (!story) {
          await bot.answerCallbackQuery(query.id, { text: 'Story not found' });
          return;
        }

        if (story.status !== 'pending_review') {
          await bot.answerCallbackQuery(query.id, { text: `Already ${story.status}` });
          return;
        }

        if (action === 'approve') {
          const now = new Date().toISOString();
          await updateOne('stories.json', s => s.id === storyId, {
            status: 'published',
            publishedAt: story.publishedAt || now,
            reviewedAt: now,
            moderatedBy: 'telegram'
          });
          await bot.answerCallbackQuery(query.id, { text: '✅ Published!' });
          await bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: '✅ APPROVED', callback_data: 'noop:0' }]] }, {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id
          });
        } else if (action === 'reject') {
          await updateOne('stories.json', s => s.id === storyId, {
            status: 'rejected',
            reviewedAt: new Date().toISOString(),
            moderatedBy: 'telegram'
          });
          await bot.answerCallbackQuery(query.id, { text: '❌ Rejected' });
          await bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: '❌ REJECTED', callback_data: 'noop:0' }]] }, {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id
          });
        }
      } catch (err) {
        console.error('[Telegram] Callback error:', err.message);
        await bot.answerCallbackQuery(query.id, { text: 'Error processing' }).catch(() => {});
      }
    });

    console.log(`[Telegram] Bot started${chatId ? ` (admin: ${chatId})` : ' (no admin chat ID — send /start to the bot)'}`);
  } catch (err) {
    console.error('[Telegram] Failed to start bot:', err.message);
  }
}

// ===== NOTIFICATION HELPERS =====

function send(text, opts = {}) {
  if (!bot || !chatId) return;
  bot.sendMessage(chatId, text, { parse_mode: 'Markdown', disable_web_page_preview: true, ...opts }).catch(err => {
    console.error('[Telegram] Send error:', err.message);
  });
}

function esc(text) {
  // Escape Markdown special characters
  return String(text || '').replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
}

// ===== PUBLIC NOTIFICATION FUNCTIONS =====

function notifyUserRegistered(user, method) {
  const ref = user.referredBy ? `\n🔗 Referred by: ${esc(user.referredBy)}` : '';
  send(
    `👤 *New User Registered*\n\n` +
    `Name: ${esc(user.name)}\n` +
    `Email: ${esc(user.email)}\n` +
    `Username: @${esc(user.username)}\n` +
    `Method: ${method}${ref}\n` +
    `🕐 ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Tashkent' })}`
  );
}

function notifyDocumentCreated(user, doc) {
  const mode = doc.mode === 'dangerous' ? '🔴 Dangerous' : '🟢 Normal';
  send(
    `📝 *New Document*\n\n` +
    `Writer: ${esc(user.name)} (@${esc(user.username)})\n` +
    `Title: ${esc(doc.title || 'Untitled')}\n` +
    `Mode: ${mode}\n` +
    `Duration: ${doc.duration || '?'} min`
  );
}

function notifySupportTicket(user, ticket) {
  const typeEmoji = { bug: '🐛', feedback: '💬', suggestion: '💡' };
  send(
    `🎫 *New Support Ticket*\n\n` +
    `From: ${esc(user.name)} (@${esc(user.username)})\n` +
    `Type: ${typeEmoji[ticket.type] || '📩'} ${esc(ticket.type)}\n` +
    `Subject: ${esc(ticket.subject)}\n` +
    `Message: ${esc((ticket.message || '').slice(0, 300))}${ticket.message && ticket.message.length > 300 ? '...' : ''}`
  );
}

function notifyStripeSubscription(user, details) {
  const trial = details.isTrial ? ' (Trial)' : '';
  send(
    `💳 *New Subscription*${trial}\n\n` +
    `User: ${esc(user.name)} (@${esc(user.username)})\n` +
    `Email: ${esc(user.email)}\n` +
    `Duration: ${esc(details.duration)}\n` +
    `Expires: ${esc(details.expiresAt || 'N/A')}`
  );
}

function notifyStripeRenewal(user, details) {
  send(
    `🔄 *Subscription Renewed*\n\n` +
    `User: ${esc(user.name)} (@${esc(user.username)})\n` +
    `Duration: ${esc(details.duration)}\n` +
    `New expiry: ${esc(details.expiresAt || 'N/A')}`
  );
}

function notifyStripeFailed(user) {
  send(
    `⚠️ *Payment Failed*\n\n` +
    `User: ${esc(user.name)} (@${esc(user.username)})\n` +
    `Email: ${esc(user.email)}`
  );
}

function notifyStripeCancelled(user) {
  send(
    `🚫 *Subscription Cancelled*\n\n` +
    `User: ${esc(user.name)} (@${esc(user.username)})\n` +
    `Email: ${esc(user.email)}`
  );
}

function notifyReferral(newUser, referrer, referralCount) {
  const bonus = referralCount % 5 === 0 ? `\n🎉 *${esc(referrer.name)} earned FREE PRO* (${referralCount} referrals!)` : '';
  send(
    `🔗 *New Referral*\n\n` +
    `New user: ${esc(newUser.name)} (@${esc(newUser.username)})\n` +
    `Referred by: ${esc(referrer.name)} (@${esc(referrer.username)})\n` +
    `Total referrals: ${referralCount}${bonus}`
  );
}

function notifyStorySubmitted(user, story) {
  const preview = (story.content || '').replace(/<[^>]*>/g, '').slice(0, 200);
  send(
    `📖 *Story Submitted for Review*\n\n` +
    `Author: ${esc(user.name)} (@${esc(user.username)})\n` +
    `Title: ${esc(story.title)}\n` +
    `Words: ${story.wordCount || '?'}\n` +
    `Preview: ${esc(preview)}${preview.length >= 200 ? '...' : ''}`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Approve', callback_data: `approve:${story.id}` },
            { text: '❌ Reject', callback_data: `reject:${story.id}` }
          ]
        ]
      }
    }
  );
}

module.exports = {
  init,
  notifyUserRegistered,
  notifyDocumentCreated,
  notifySupportTicket,
  notifyStripeSubscription,
  notifyStripeRenewal,
  notifyStripeFailed,
  notifyStripeCancelled,
  notifyReferral,
  notifyStorySubmitted
};
