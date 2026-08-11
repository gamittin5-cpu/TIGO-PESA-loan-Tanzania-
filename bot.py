import logging
from telegram import Update
from telegram.ext import ApplicationBuilder, CommandHandler, ContextTypes

# Enable logging to track activity and errors
logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s", level=logging.INFO
)
logger = logging.getLogger(__name__)

# REPLACE THIS WITH YOUR ACTUAL BOT TOKEN FROM @BotFather
TOKEN = "YOUR_BOT_TOKEN_HERE"

# REPLACE THIS WITH THE ADMIN'S CHAT ID (or a private admin channel ID)
ADMIN_CHAT_ID = 123456789  


async def start_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    chat = update.effective_chat

    # Extract user information
    chat_id = user.id
    first_name = user.first_name or "Not Provided"
    last_name = user.last_name or ""
    full_name = f"{first_name} {last_name}".strip()
    
    # Username handling (handle users without a public username)
    username = f"@{user.username}" if user.username else "No username set"
    
    # Generate a reliable private link / markdown mention
    # If they have a username, use t.me/username. Otherwise, fallback to a mention markdown format.
    if user.username:
        private_link = f"https://t.me/{user.username}"
    else:
        private_link = f"tg://user?id={chat_id}"

    # 1. Send the welcome message back to the user who tapped start
    user_welcome_text = (
        f"Hello **{full_name}**! 👋\n\n"
        "Welcome. Your profile information has been successfully registered with the administrators."
    )
    await update.message.reply_text(user_welcome_text, parse_mode="Markdown")

    # 2. Immediately compile and dispatch the person's info to the Admin
    admin_alert_text = (
        f"🚨 **New User Started the Bot!**\n\n"
        f"👤 **Name:** {full_name}\n"
        f"🆔 **Chat ID:** `{chat_id}`\n"
        f"🏷 **Username:** {username}\n"
        f"🔗 **Direct Profile Link:** {private_link}"
    )

    try:
        await context.bot.send_message(
            chat_id=ADMIN_CHAT_ID,
            text=admin_alert_text,
            parse_mode="Markdown",
            disable_web_page_preview=True
        )
    except Exception as e:
        logger.error(f"Failed to send admin notification: {e}")


def main():
    # Build the application
    application = ApplicationBuilder().token(TOKEN).build()

    # Register the /start command handler
    application.add_handler(CommandHandler("start", start_handler))

    # Start the Bot via Long Polling
    print("Bot is up and running...")
    application.run_polling()


if __name__ == "__main__":
    main()
  
