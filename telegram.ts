/**
 * Simple Telegram notifier for market resolutions
 */

import TelegramBot from 'node-telegram-bot-api';

let bot: TelegramBot | null = null;
const chatId = process.env.TELEGRAM_CHAT_ID;

// Initialize bot lazily
function getBot(): TelegramBot | null {
  if (!bot && process.env.TELEGRAM_BOT_TOKEN && chatId) {
    bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
  }
  return bot;
}

export async function sendNotification(message: string): Promise<void> {
  const b = getBot();
  if (!b || !chatId) return;
  
  try {
    await b.sendMessage(chatId, message);
  } catch (err: any) {
    console.log(`⚠️ Telegram error: ${err.message}`);
  }
}

