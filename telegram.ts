/**
 * Telegram Notification Service v2
 * Clean notifications + bot commands (/live-trades, /past-trades)
 */

import TelegramBot from 'node-telegram-bot-api';
import { loadArbConfig, ArbConfig } from './config';
import { paperTracker, PaperTrade, PaperStats, ResolutionRecord } from './paper-trading-tracker';

let bot: TelegramBot | null = null;
let config: ArbConfig | null = null;

// =============================================================================
// INITIALIZATION
// =============================================================================

/**
 * Initialize Telegram bot with polling for commands
 */
export function initTelegram(): void {
  config = loadArbConfig();

  if (!config.telegramBotToken || !config.telegramChatId) {
    console.log('[Telegram] Not configured - notifications disabled');
    return;
  }

  // Enable polling to receive commands
  bot = new TelegramBot(config.telegramBotToken, { polling: true });
  console.log('[Telegram] Bot initialized with command support');

  // Register commands
  registerCommands();

  // Connect paper tracker callbacks
  connectPaperTrackerCallbacks();
}

/**
 * Check if Telegram is enabled
 */
export function isTelegramEnabled(): boolean {
  return !!(config?.telegramBotToken && config?.telegramChatId);
}

// =============================================================================
// BOT COMMANDS
// =============================================================================

function registerCommands(): void {
  if (!bot || !config) return;

  // /live - List active trades
  bot.onText(/\/live$/i, async (msg) => {
    if (msg.chat.id.toString() !== config!.telegramChatId) return;

    const positions = paperTracker.getPositions();

    if (positions.length === 0) {
      await sendMessage('📭 No active positions');
      return;
    }

    let message = `📊 <b>LIVE POSITIONS</b> (${positions.length})\n\n`;

    for (const pos of positions) {
      const timeLeft = Math.max(0, (pos.marketEndTime || 0) - Date.now());
      const timeLeftMin = Math.floor(timeLeft / 60000);
      const timeLeftSec = Math.floor((timeLeft % 60000) / 1000);

      // Calculate max profit/loss if not present (for old positions)
      const maxProfit = pos.maxProfit ?? (pos.shares - pos.totalCost - pos.totalFees);
      const maxLoss = pos.maxLoss ?? (pos.totalCost + pos.totalFees);
      const tradeIds = pos.tradeIds ?? [];

      message += `<b>${pos.side}</b> | ${pos.shares} shares @ ${(pos.avgPrice * 100).toFixed(1)}¢\n`;
      message += `   Cost: $${pos.totalCost.toFixed(2)} | Fee: $${pos.totalFees.toFixed(3)}\n`;
      message += `   Win: +$${maxProfit.toFixed(2)} | Lose: -$${maxLoss.toFixed(2)}\n`;
      if (tradeIds.length > 0) {
        message += `   Trades: #${tradeIds.join(', #')}\n`;
      }
      if (timeLeft > 0) {
        message += `   Resolves in: ${timeLeftMin}m ${timeLeftSec}s\n`;
      }
      message += '\n';
    }

    await sendMessage(message.trim());
  });

  // /past - List resolved trades
  bot.onText(/\/past$/i, async (msg) => {
    if (msg.chat.id.toString() !== config!.telegramChatId) return;

    const resolutions = paperTracker.getResolutions();

    if (resolutions.length === 0) {
      await sendMessage('📭 No resolved trades yet');
      return;
    }

    // Show last 10 resolutions
    const recent = resolutions.slice(-10);

    let message = `📜 <b>PAST TRADES</b> (last ${recent.length} of ${resolutions.length})\n\n`;

    for (const res of [...recent].reverse()) {
      const emoji = res.pnl >= 0 ? '✅' : '❌';
      const pnlSign = res.pnl >= 0 ? '+' : '';

      message += `${emoji} <b>#${res.id}</b> ${res.position.side} | ${res.position.shares} @ ${(res.position.avgPrice * 100).toFixed(1)}¢\n`;
      message += `   P&L: ${pnlSign}$${res.pnl.toFixed(2)} | Fees: $${res.position.totalFees.toFixed(3)}\n`;
      message += `   Outcome: BTC went ${res.outcome}\n\n`;
    }

    // Add summary
    const stats = paperTracker.getStats();
    const pnlSign = stats.realizedPnL >= 0 ? '+' : '';
    message += `<b>Total Realized P&L:</b> ${pnlSign}$${stats.realizedPnL.toFixed(2)}\n`;
    message += `<b>Win Rate:</b> ${(stats.winRate * 100).toFixed(1)}% (${stats.winCount}W / ${stats.lossCount}L)`;

    await sendMessage(message);
  });

  // /stats - Quick stats
  bot.onText(/\/stats$/i, async (msg) => {
    if (msg.chat.id.toString() !== config!.telegramChatId) return;
    await sendSummary();
  });

  // /help - Command list
  bot.onText(/\/help$/i, async (msg) => {
    if (msg.chat.id.toString() !== config!.telegramChatId) return;

    const message = `
🤖 <b>Paper Trading Bot Commands</b>

/live - Show active positions
/past - Show resolved trades
/stats - Quick summary
/help - This message
    `.trim();

    await sendMessage(message);
  });
}

// =============================================================================
// PAPER TRACKER CALLBACKS
// =============================================================================

function connectPaperTrackerCallbacks(): void {
  // Trade opened notification
  paperTracker.onTradeOpened = async (trade: PaperTrade) => {
    const emoji = trade.side === 'YES' ? '🟢' : '🔴';
    const adjMethod = trade.adjustmentMethod.toUpperCase();

    const message = `
${emoji} <b>TRADE #${trade.id} OPENED</b>

<b>Side:</b> ${trade.side}
<b>Price:</b> ${(trade.price * 100).toFixed(1)}¢ × ${trade.size} = $${trade.cost.toFixed(2)}
<b>Edge:</b> +${(trade.edge * 100).toFixed(1)}%
<b>Fee:</b> $${trade.fee.toFixed(3)}

<b>If WIN:</b> +$${trade.maxProfit.toFixed(2)}
<b>If LOSE:</b> -$${trade.maxLoss.toFixed(2)}

<b>BTC:</b> $${trade.btcPrice.toFixed(0)} | Strike: $${trade.strike.toFixed(0)}
<b>Adj:</b> $${trade.adjustment.toFixed(0)} (${adjMethod})
    `.trim();

    await sendMessage(message);
  };

  // Trade resolved notification
  paperTracker.onTradeResolved = async (trade: PaperTrade, resolution: ResolutionRecord) => {
    const isWin = trade.outcome === 'WIN';
    const emoji = isWin ? '✅' : '❌';
    const pnlSign = (trade.pnl ?? 0) >= 0 ? '+' : '';

    const message = `
${emoji} <b>TRADE #${trade.id} ${trade.outcome}</b>

<b>Position:</b> ${trade.side} @ ${(trade.price * 100).toFixed(1)}¢ × ${trade.size}
<b>Outcome:</b> BTC went ${resolution.outcome}
<b>P&L:</b> ${pnlSign}$${(trade.pnl ?? 0).toFixed(2)}
<b>Fee paid:</b> $${trade.fee.toFixed(3)}
    `.trim();

    await sendMessage(message);
  };

  // Summary callback
  paperTracker.onSummaryRequested = async (stats: PaperStats) => {
    await sendSummaryFromStats(stats);
  };
}

// =============================================================================
// SEND FUNCTIONS
// =============================================================================

async function sendMessage(message: string): Promise<void> {
  if (!bot || !config?.telegramChatId) return;

  try {
    await bot.sendMessage(config.telegramChatId, message, { parse_mode: 'HTML' });
  } catch (err: any) {
    console.log(`[Telegram] Error: ${err.message}`);
  }
}

/**
 * Send 15-minute summary
 */
async function sendSummary(): Promise<void> {
  const stats = paperTracker.getStats();
  await sendSummaryFromStats(stats);
}

async function sendSummaryFromStats(stats: PaperStats): Promise<void> {
  const pnlEmoji = stats.realizedPnL >= 0 ? '🟢' : '🔴';
  const pnlSign = stats.realizedPnL >= 0 ? '+' : '';

  let message = `
📊 <b>15-MIN SUMMARY</b>

<b>Trades:</b> ${stats.totalTrades} (${stats.openTrades} open, ${stats.resolvedTrades} resolved)
<b>Fees Paid:</b> $${stats.totalFeesPaid.toFixed(2)}

${pnlEmoji} <b>Realized P&L:</b> ${pnlSign}$${stats.realizedPnL.toFixed(2)}
<b>Win Rate:</b> ${(stats.winRate * 100).toFixed(1)}% (${stats.winCount}W / ${stats.lossCount}L)
<b>Avg Edge:</b> ${(stats.avgEdge * 100).toFixed(1)}%
  `.trim();

  if (stats.openPositions.length > 0) {
    message += `\n\n<b>--- Open Positions (${stats.openPositions.length}) ---</b>`;
    message += `\n<b>Capital at Risk:</b> $${stats.capitalAtRisk.toFixed(2)}`;
    message += `\n<b>Potential Profit:</b> +$${stats.potentialProfit.toFixed(2)}`;
    message += `\n<b>Potential Loss:</b> -$${stats.potentialLoss.toFixed(2)}`;
  }

  await sendMessage(message);
}

// =============================================================================
// PUBLIC NOTIFICATION FUNCTIONS (kept for compatibility)
// =============================================================================

export async function sendTelegramMessage(message: string): Promise<void> {
  await sendMessage(message);
}

export async function notifyStartup(): Promise<void> {
  if (!bot || !config?.telegramChatId) return;

  const mode = config.paperTrading ? '📝 PAPER' : '💰 LIVE';

  const message = `
🚀 <b>BOT STARTED</b>

<b>Mode:</b> ${mode}
<b>Min Edge:</b> ${(config.edgeMinimum * 100).toFixed(0)}%
<b>Max Order:</b> $${config.maxOrderUsd}
<b>Oracle Adj:</b> $${config.oracleAdjustment} (fallback)

Commands: /live /past /stats /help
  `.trim();

  await sendMessage(message);
}

export async function notifyShutdown(stats: {
  totalTrades: number;
  realizedPnL: number;
  runTimeMinutes: number;
}): Promise<void> {
  const pnlSign = stats.realizedPnL >= 0 ? '+' : '';
  const pnlEmoji = stats.realizedPnL >= 0 ? '🟢' : '🔴';

  const message = `
👋 <b>BOT STOPPED</b>

<b>Runtime:</b> ${stats.runTimeMinutes} minutes
<b>Total Trades:</b> ${stats.totalTrades}
${pnlEmoji} <b>Realized P&L:</b> ${pnlSign}$${stats.realizedPnL.toFixed(2)}
  `.trim();

  await sendMessage(message);
}

export async function notifyError(error: string, context?: string): Promise<void> {
  const contextStr = context ? `\n<b>Context:</b> ${context}` : '';
  await sendMessage(`⚠️ <b>ERROR</b>\n\n${error}${contextStr}`);
}

// Aliases for backwards compatibility
export const sendNotification = sendTelegramMessage;
export const notifyTrade = () => {}; // Now handled by callbacks
export const notifyResolution = () => {}; // Now handled by callbacks
export const notifySummary = () => {}; // Now handled by callbacks
export const notifyDailySummary = () => {}; // Now handled by callbacks

// =============================================================================
// CLEANUP
// =============================================================================

export function stopTelegram(): void {
  if (bot) {
    bot.stopPolling();
    bot = null;
  }
}
