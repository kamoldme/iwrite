// Telegram Bot — Admin notifications for iWrite
// Sends real-time updates about registrations, subscriptions, moderation, etc.
// Requires env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_CHAT_ID

const TelegramBot = require('node-telegram-bot-api');

let bot = null;
let chatId = null;
let _activeUsers = null; // passed from index.js to avoid circular require

function init(activeUsersMap) {
  _activeUsers = activeUsersMap || null;
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
      bot.sendMessage(id, `Your chat ID is: <code>${id}</code>\n\nSet this as <code>TELEGRAM_ADMIN_CHAT_ID</code> in Railway env vars to receive admin notifications.`, { parse_mode: 'HTML' });
      if (!chatId) {
        chatId = id.toString();
        console.log(`[Telegram] Admin chat ID auto-set to ${chatId}`);
      }
    });

    // /status command — quick health check
    bot.onText(/\/status/, (msg) => {
      if (msg.chat.id.toString() !== chatId) return;
      bot.sendMessage(chatId, `✅ Bot is running\n📡 Chat ID: <code>${chatId}</code>\n⏰ ${new Date().toISOString()}`, { parse_mode: 'HTML' });
    });

    // Handle inline button callbacks (moderation approve/reject/view)
    bot.on('callback_query', async (query) => {
      if (!query.data) return;
      const [action, entityId] = query.data.split(':');
      if (!entityId || action === 'noop') return;

      try {
        const { findOne, updateOne } = require('./utils/storage');

        // VIEW full story content
        if (action === 'view') {
          const story = await findOne('stories.json', s => s.id === entityId);
          if (!story) {
            await bot.answerCallbackQuery(query.id, { text: 'Story not found' });
            return;
          }
          const fullText = (story.content || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ')
            .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
            .replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
          // Telegram max message is 4096 chars
          const chunks = [];
          for (let i = 0; i < fullText.length; i += 4000) {
            chunks.push(fullText.slice(i, i + 4000));
          }
          await bot.answerCallbackQuery(query.id, { text: 'Sending full story...' });
          for (const chunk of chunks) {
            await bot.sendMessage(query.message.chat.id, chunk, {
              reply_to_message_id: query.message.message_id
            });
          }
          return;
        }

        // Approve/Reject story
        const story = await findOne('stories.json', s => s.id === entityId);
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
          await updateOne('stories.json', s => s.id === entityId, {
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
          await updateOne('stories.json', s => s.id === entityId, {
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

    // Handle replies to support ticket messages — auto-reply on the platform
    bot.on('message', async (msg) => {
      if (!msg.reply_to_message || !msg.text || msg.chat.id.toString() !== chatId) return;
      // Check if the original message is a support ticket
      const origText = msg.reply_to_message.text || '';
      if (!origText.includes('New Support Ticket') && !origText.includes('🎫')) return;

      // Extract ticket info from the original message by matching the ticket ID stored in the message
      const ticketIdMatch = origText.match(/ticket:([a-f0-9-]+)/i);
      if (!ticketIdMatch) {
        // Fallback: find most recent open ticket from the mentioned user
        const usernameMatch = origText.match(/@(\S+)/);
        if (!usernameMatch) return;
        const { findOne, findMany, updateOne } = require('./utils/storage');
        const user = await findOne('users.json', u => u.username === usernameMatch[1]);
        if (!user) {
          bot.sendMessage(chatId, '⚠️ Could not find user', { reply_to_message_id: msg.message_id });
          return;
        }
        const tickets = await findMany('support.json', t => t.userId === user.id && t.status === 'open');
        if (!tickets.length) {
          bot.sendMessage(chatId, '⚠️ No open tickets from this user', { reply_to_message_id: msg.message_id });
          return;
        }
        // Match by subject in original message
        const subjectMatch = origText.match(/Subject:\s*(.+)/);
        let ticket = tickets[0]; // default to most recent
        if (subjectMatch) {
          const found = tickets.find(t => t.subject === subjectMatch[1].trim());
          if (found) ticket = found;
        }
        await updateOne('support.json', t => t.id === ticket.id, {
          adminReply: msg.text,
          repliedAt: new Date().toISOString(),
          status: 'replied',
          updatedAt: new Date().toISOString()
        });
        bot.sendMessage(chatId, `✅ Reply sent to @${esc(user.username)} on ticket "${esc(ticket.subject)}"`, {
          reply_to_message_id: msg.message_id,
          parse_mode: 'HTML'
        });
        return;
      }

      // Direct ticket ID match
      const { findOne, updateOne } = require('./utils/storage');
      const ticket = await findOne('support.json', t => t.id === ticketIdMatch[1]);
      if (!ticket) {
        bot.sendMessage(chatId, '⚠️ Ticket not found', { reply_to_message_id: msg.message_id });
        return;
      }
      await updateOne('support.json', t => t.id === ticket.id, {
        adminReply: msg.text,
        repliedAt: new Date().toISOString(),
        status: 'replied',
        updatedAt: new Date().toISOString()
      });
      const user = await findOne('users.json', u => u.id === ticket.userId);
      bot.sendMessage(chatId, `✅ Reply sent to @${esc(user ? user.username : '?')} on ticket "${esc(ticket.subject)}"`, {
        reply_to_message_id: msg.message_id,
        parse_mode: 'HTML'
      });
    });

    // Periodic stats card every 5 hours
    const FIVE_HOURS = 5 * 60 * 60 * 1000;
    setTimeout(() => sendStatsCard(), 10000); // first one 10s after boot
    setInterval(() => sendStatsCard(), FIVE_HOURS);

    // /stats command — manual stats card
    bot.onText(/\/stats/, (msg) => {
      if (msg.chat.id.toString() !== chatId) return;
      sendStatsCard();
    });

    console.log(`[Telegram] Bot started${chatId ? ` (admin: ${chatId})` : ' (no admin chat ID — send /start to the bot)'}`);
  } catch (err) {
    console.error('[Telegram] Failed to start bot:', err.message);
  }
}

async function sendStatsCard() {
  if (!bot || !chatId) return;
  try {
    const { findMany } = require('./utils/storage');
    const users = await findMany('users.json');
    const docs = await findMany('documents.json');

    const totalUsers = users.filter(u => u.role !== 'admin').length;
    const totalDocs = docs.length;
    const activeDocs = docs.filter(d => !d.deleted && d.status !== 'abandoned').length;
    const totalWords = users.reduce((sum, u) => sum + (u.totalWords || 0), 0);

    // Anti-gaming: cap credited time per session by words written (min 3 WPM)
    const MIN_WPM = 3;
    const effectiveMinutes = (d) => {
      const actualMin = (Number(d.duration) || 0) / 60;
      const wordCap = (d.wordCount || 0) / MIN_WPM;
      return Math.min(actualMin, wordCap);
    };
    const totalMinutes = Math.round(docs.reduce((sum, d) => sum + effectiveMinutes(d), 0));
    const totalHours = Math.floor(totalMinutes / 60);
    const remainingMins = totalMinutes % 60;

    // Get active users count (passed in during init to avoid circular require)
    let onlineNow = _activeUsers ? _activeUsers.size : 0;

    // Leaderboard — top 3 by streak, top 3 by time
    // Must match liveStreak() in index.js exactly
    const liveStreak = (u) => {
      if (!u.lastWritingDate || !u.streak) return 0;
      const today = new Date().toISOString().split('T')[0];
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      if (u.lastWritingDate === today || u.lastWritingDate === yesterday) return u.streak;
      return 0;
    };

    const byStreak = users
      .filter(u => u.role !== 'admin')
      .map(u => ({ name: u.name, username: u.username, streak: liveStreak(u), words: u.totalWords || 0 }))
      .sort((a, b) => b.streak - a.streak || b.words - a.words)
      .slice(0, 3);

    const byTime = users
      .filter(u => u.role !== 'admin')
      .map(u => {
        const userDocs = docs.filter(d => d.userId === u.id && !d.deleted && d.duration > 0);
        const mins = Math.round(userDocs.reduce((sum, d) => sum + effectiveMinutes(d), 0));
        return { name: u.name, username: u.username, minutes: mins, words: u.totalWords || 0 };
      })
      .sort((a, b) => b.minutes - a.minutes || b.words - a.words)
      .slice(0, 3);

    const medals = ['🥇', '🥈', '🥉'];

    const streakBoard = byStreak.map((u, i) =>
      `${medals[i]} ${esc(u.name)} (@${esc(u.username || '?')}) — ${u.streak} day streak`
    ).join('\n');

    const timeBoard = byTime.map((u, i) =>
      `${medals[i]} ${esc(u.name)} (@${esc(u.username || '?')}) — ${u.minutes} min`
    ).join('\n');

    const now = new Date().toLocaleString('en-US', { timeZone: 'Asia/Tashkent', dateStyle: 'medium', timeStyle: 'short' });

    send(
      `📊 <b>iWrite Stats Card</b>\n` +
      `${now}\n\n` +
      `🟢 Online: <b>${onlineNow}</b>\n` +
      `👤 Users: <b>${totalUsers.toLocaleString()}</b>\n` +
      `📄 Documents: <b>${totalDocs.toLocaleString()}</b>\n` +
      `📝 Active Docs: <b>${activeDocs.toLocaleString()}</b>\n` +
      `⏱ Total Time: <b>${totalHours}h ${remainingMins}m</b>\n` +
      `✍️ Total Words: <b>${totalWords.toLocaleString()}</b>\n\n` +
      `🔥 <b>Top 3 — Streaks</b>\n${streakBoard}\n\n` +
      `⏰ <b>Top 3 — Time Written</b>\n${timeBoard}`
    );
  } catch (err) {
    console.error('[Telegram] Stats card error:', err.message);
  }
}

// ===== NOTIFICATION HELPERS =====

function send(text, opts = {}) {
  if (!bot || !chatId) return;
  bot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true, ...opts }).catch(err => {
    console.error('[Telegram] Send error:', err.message);
  });
}

function esc(text) {
  return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ===== PUBLIC NOTIFICATION FUNCTIONS =====

function notifyUserRegistered(user, method) {
  const ref = user.referredBy ? `\n🔗 Referred by: ${esc(user.referredBy)}` : '';
  send(
    `👤 <b>New User Registered</b>\n\n` +
    `Name: ${esc(user.name)}\n` +
    `Email: ${esc(user.email)}\n` +
    `Username: @${esc(user.username)}\n` +
    `Method: ${method}${ref}\n` +
    `🕐 ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Tashkent' })}`
  );
}

function notifySessionCompleted(user, doc, stats) {
  const mode = doc.mode === 'dangerous' ? '🔴 Dangerous' : '🟢 Normal';
  const mins = Math.round((stats.duration || 0) / 60);
  send(
    `✅ <b>Session Completed</b>\n\n` +
    `Writer: ${esc(user.name)} (@${esc(user.username)})\n` +
    `Title: ${esc(doc.title || 'Untitled')}\n` +
    `Mode: ${mode}\n` +
    `Duration: ${mins} min\n` +
    `Words: ${stats.wordCount || 0}\n` +
    `XP: +${stats.xpEarned || 0}`
  );
}

function notifySessionFailed(user, doc, stats) {
  const mode = doc.mode === 'dangerous' ? '🔴 Dangerous' : '🟢 Normal';
  const reasonMap = { typing_stopped: '⌨️ Stopped typing', tab_left: '🚪 Left the tab' };
  const reasonText = reasonMap[stats.reason] || stats.reason || 'Unknown';
  send(
    `💀 <b>Session Failed</b>\n\n` +
    `Writer: ${esc(user.name)} (@${esc(user.username)})\n` +
    `Title: ${esc(doc.title || 'Untitled')}\n` +
    `Mode: ${mode}\n` +
    `Words: ${doc.wordCount || 0}\n` +
    `Reason: ${reasonText}`
  );
}

function notifySupportTicket(user, ticket) {
  const typeEmoji = { bug: '🐛', feedback: '💬', suggestion: '💡' };
  send(
    `🎫 <b>New Support Ticket</b>\n\n` +
    `From: ${esc(user.name)} (@${esc(user.username)})\n` +
    `Type: ${typeEmoji[ticket.type] || '📩'} ${esc(ticket.type)}\n` +
    `Subject: ${esc(ticket.subject)}\n` +
    `Message: ${esc((ticket.message || '').slice(0, 300))}${ticket.message && ticket.message.length > 300 ? '...' : ''}\n\n` +
    `<i>Reply to this message to respond to the user</i>\n` +
    `<code>ticket:${ticket.id}</code>`
  );
}

function notifyStripeSubscription(user, details) {
  const trial = details.isTrial ? ' (Trial)' : '';
  send(
    `💳 <b>New Subscription</b>${trial}\n\n` +
    `User: ${esc(user.name)} (@${esc(user.username)})\n` +
    `Email: ${esc(user.email)}\n` +
    `Duration: ${esc(details.duration)}\n` +
    `Expires: ${esc(details.expiresAt || 'N/A')}`
  );
}

function notifyStripeRenewal(user, details) {
  send(
    `🔄 <b>Subscription Renewed</b>\n\n` +
    `User: ${esc(user.name)} (@${esc(user.username)})\n` +
    `Duration: ${esc(details.duration)}\n` +
    `New expiry: ${esc(details.expiresAt || 'N/A')}`
  );
}

function notifyStripeFailed(user) {
  send(
    `⚠️ <b>Payment Failed</b>\n\n` +
    `User: ${esc(user.name)} (@${esc(user.username)})\n` +
    `Email: ${esc(user.email)}`
  );
}

function notifyStripeCancelled(user) {
  send(
    `🚫 <b>Subscription Cancelled</b>\n\n` +
    `User: ${esc(user.name)} (@${esc(user.username)})\n` +
    `Email: ${esc(user.email)}`
  );
}

function notifyReferral(newUser, referrer, referralCount) {
  const bonus = referralCount % 5 === 0 ? `\n🎉 <b>${esc(referrer.name)} earned FREE PRO</b> (${referralCount} referrals!)` : '';
  send(
    `🔗 <b>New Referral</b>\n\n` +
    `New user: ${esc(newUser.name)} (@${esc(newUser.username)})\n` +
    `Referred by: ${esc(referrer.name)} (@${esc(referrer.username)})\n` +
    `Total referrals: ${referralCount}${bonus}`
  );
}

function notifyStorySubmitted(user, story) {
  const preview = (story.content || '').replace(/<[^>]*>/g, '').slice(0, 200);
  send(
    `📖 <b>Story Submitted for Review</b>\n\n` +
    `Author: ${esc(user.name)} (@${esc(user.username)})\n` +
    `Title: ${esc(story.title)}\n` +
    `Words: ${story.wordCount || '?'}\n` +
    `Preview: ${esc(preview)}${preview.length >= 200 ? '...' : ''}`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📖 VIEW FULL', callback_data: `view:${story.id}` }
          ],
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
  notifySessionCompleted,
  notifySessionFailed,
  notifySupportTicket,
  notifyStripeSubscription,
  notifyStripeRenewal,
  notifyStripeFailed,
  notifyStripeCancelled,
  notifyReferral,
  notifyStorySubmitted
};
