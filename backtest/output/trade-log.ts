/**
 * Trade Log Output
 * Exports trades to JSON and CSV formats
 */

import * as fs from 'fs';
import * as path from 'path';
import { Trade, MarketResolution, BacktestResult } from '../types';

const OUTPUT_DIR = path.join(__dirname, '../../data/output');

/**
 * Ensure output directory exists
 */
function ensureOutputDir(): void {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

/**
 * Export trades to JSON
 */
export function exportTradesToJson(trades: Trade[], filename: string = 'trades.json'): string {
  ensureOutputDir();
  
  const filepath = path.join(OUTPUT_DIR, filename);
  const content = JSON.stringify(trades, null, 2);
  
  fs.writeFileSync(filepath, content);
  console.log(`📄 Exported ${trades.length} trades to ${filename}`);
  
  return filepath;
}

/**
 * Export trades to CSV
 */
export function exportTradesToCsv(trades: Trade[], filename: string = 'trades.csv'): string {
  ensureOutputDir();
  
  const filepath = path.join(OUTPUT_DIR, filename);
  
  // CSV header
  const headers = [
    'id',
    'timestamp',
    'datetime',
    'marketId',
    'side',
    'action',
    'price',
    'size',
    'cost',
    'fairValue',
    'edge',
    'edgePct',
    'btcPrice',
    'strike',
    'timeRemainingMin',
  ];
  
  // CSV rows
  const rows = trades.map(t => [
    t.id,
    t.timestamp,
    new Date(t.timestamp).toISOString(),
    t.marketId.slice(0, 16), // Truncate for readability
    t.side,
    t.action,
    t.price.toFixed(4),
    t.size,
    t.cost.toFixed(4),
    t.fairValue.toFixed(4),
    t.edge.toFixed(4),
    (t.edge * 100).toFixed(2) + '%',
    t.btcPrice.toFixed(2),
    t.strike.toFixed(2),
    (t.timeRemainingMs / 60000).toFixed(1),
  ]);
  
  const csv = [
    headers.join(','),
    ...rows.map(r => r.join(',')),
  ].join('\n');
  
  fs.writeFileSync(filepath, csv);
  console.log(`📄 Exported ${trades.length} trades to ${filename}`);
  
  return filepath;
}

/**
 * Export market resolutions to JSON
 */
export function exportResolutionsToJson(
  resolutions: MarketResolution[],
  filename: string = 'resolutions.json'
): string {
  ensureOutputDir();
  
  const filepath = path.join(OUTPUT_DIR, filename);
  const content = JSON.stringify(resolutions, null, 2);
  
  fs.writeFileSync(filepath, content);
  console.log(`📄 Exported ${resolutions.length} resolutions to ${filename}`);
  
  return filepath;
}

/**
 * Export market resolutions to CSV
 */
export function exportResolutionsToCsv(
  resolutions: MarketResolution[],
  filename: string = 'resolutions.csv'
): string {
  ensureOutputDir();
  
  const filepath = path.join(OUTPUT_DIR, filename);
  
  // CSV header
  const headers = [
    'marketId',
    'outcome',
    'finalBtcPrice',
    'strikePrice',
    'priceDiff',
    'priceDiffPct',
    'yesShares',
    'noShares',
    'yesCost',
    'noCost',
    'totalCost',
    'yesPayout',
    'noPayout',
    'totalPayout',
    'pnl',
    'roi',
  ];
  
  // CSV rows
  const rows = resolutions.map(r => {
    const priceDiff = r.finalBtcPrice - r.strikePrice;
    const priceDiffPct = (priceDiff / r.strikePrice) * 100;
    const roi = r.totalCost > 0 ? (r.pnl / r.totalCost) * 100 : 0;
    
    return [
      r.marketId.slice(0, 16),
      r.outcome,
      r.finalBtcPrice.toFixed(2),
      r.strikePrice.toFixed(2),
      priceDiff.toFixed(2),
      priceDiffPct.toFixed(4) + '%',
      r.yesShares,
      r.noShares,
      r.yesCost.toFixed(4),
      r.noCost.toFixed(4),
      r.totalCost.toFixed(4),
      r.yesPayout.toFixed(4),
      r.noPayout.toFixed(4),
      r.totalPayout.toFixed(4),
      r.pnl.toFixed(4),
      roi.toFixed(2) + '%',
    ];
  });
  
  const csv = [
    headers.join(','),
    ...rows.map(r => r.join(',')),
  ].join('\n');
  
  fs.writeFileSync(filepath, csv);
  console.log(`📄 Exported ${resolutions.length} resolutions to ${filename}`);
  
  return filepath;
}

/**
 * Export full backtest result
 */
export function exportBacktestResult(
  result: BacktestResult,
  prefix: string = ''
): { tradesJson: string; tradesCsv: string; resolutionsJson: string; resolutionsCsv: string; summaryJson: string } {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filePrefix = prefix ? `${prefix}_${timestamp}` : timestamp;
  
  // Export trades
  const tradesJson = exportTradesToJson(result.trades, `${filePrefix}_trades.json`);
  const tradesCsv = exportTradesToCsv(result.trades, `${filePrefix}_trades.csv`);
  
  // Export resolutions
  const resolutionsJson = exportResolutionsToJson(result.resolutions, `${filePrefix}_resolutions.json`);
  const resolutionsCsv = exportResolutionsToCsv(result.resolutions, `${filePrefix}_resolutions.csv`);
  
  // Export summary
  const summary = {
    config: {
      startDate: result.config.startDate.toISOString(),
      endDate: result.config.endDate.toISOString(),
      initialCapital: result.config.initialCapital,
      spreadCents: result.config.spreadCents,
      minEdge: result.config.minEdge,
      orderSize: result.config.orderSize,
      maxPositionPerMarket: result.config.maxPositionPerMarket,
    },
    results: {
      totalMarkets: result.totalMarkets,
      totalTrades: result.totalTrades,
      totalPnL: result.totalPnL,
      totalVolume: result.totalVolume,
      winRate: result.winRate,
      marketWinRate: result.marketWinRate,
      avgEdge: result.avgEdge,
      realizedEdge: result.realizedEdge,
      sharpeRatio: result.sharpeRatio,
      maxDrawdown: result.maxDrawdown,
    },
    exportedAt: new Date().toISOString(),
  };
  
  ensureOutputDir();
  const summaryJson = path.join(OUTPUT_DIR, `${filePrefix}_summary.json`);
  fs.writeFileSync(summaryJson, JSON.stringify(summary, null, 2));
  console.log(`📄 Exported summary to ${filePrefix}_summary.json`);
  
  return {
    tradesJson,
    tradesCsv,
    resolutionsJson,
    resolutionsCsv,
    summaryJson,
  };
}

/**
 * Print trade log to console
 */
export function printTradeLog(trades: Trade[], limit: number = 20): void {
  console.log('\n📋 Trade Log (most recent):\n');
  console.log('─'.repeat(120));
  console.log(
    'Time'.padEnd(20) +
    'Side'.padEnd(6) +
    'Price'.padEnd(10) +
    'Size'.padEnd(8) +
    'Fair'.padEnd(10) +
    'Edge'.padEnd(10) +
    'BTC'.padEnd(12) +
    'Strike'.padEnd(12) +
    'Time Left'
  );
  console.log('─'.repeat(120));
  
  const recentTrades = trades.slice(-limit);
  
  for (const t of recentTrades) {
    const timeStr = new Date(t.timestamp).toISOString().slice(11, 19);
    const timeLeftMin = (t.timeRemainingMs / 60000).toFixed(1) + 'm';
    
    console.log(
      timeStr.padEnd(20) +
      t.side.padEnd(6) +
      `$${t.price.toFixed(2)}`.padEnd(10) +
      t.size.toString().padEnd(8) +
      `${(t.fairValue * 100).toFixed(1)}%`.padEnd(10) +
      `+${(t.edge * 100).toFixed(1)}%`.padEnd(10) +
      `$${t.btcPrice.toFixed(0)}`.padEnd(12) +
      `$${t.strike.toFixed(0)}`.padEnd(12) +
      timeLeftMin
    );
  }
  
  console.log('─'.repeat(120));
  
  if (trades.length > limit) {
    console.log(`... and ${trades.length - limit} more trades`);
  }
}

/**
 * Print resolution summary to console
 */
export function printResolutionLog(resolutions: MarketResolution[], limit: number = 10): void {
  console.log('\n📊 Resolution Log:\n');
  console.log('─'.repeat(100));
  console.log(
    'Market'.padEnd(20) +
    'Outcome'.padEnd(10) +
    'Final BTC'.padEnd(12) +
    'Strike'.padEnd(12) +
    'YES'.padEnd(8) +
    'NO'.padEnd(8) +
    'Cost'.padEnd(10) +
    'Payout'.padEnd(10) +
    'P&L'
  );
  console.log('─'.repeat(100));
  
  const recentResolutions = resolutions.slice(-limit);
  
  for (const r of recentResolutions) {
    const pnlStr = r.pnl >= 0 ? `+$${r.pnl.toFixed(2)}` : `-$${Math.abs(r.pnl).toFixed(2)}`;
    const pnlColor = r.pnl >= 0 ? '🟢' : '🔴';
    
    console.log(
      r.marketId.slice(0, 18).padEnd(20) +
      r.outcome.padEnd(10) +
      `$${r.finalBtcPrice.toFixed(0)}`.padEnd(12) +
      `$${r.strikePrice.toFixed(0)}`.padEnd(12) +
      r.yesShares.toString().padEnd(8) +
      r.noShares.toString().padEnd(8) +
      `$${r.totalCost.toFixed(2)}`.padEnd(10) +
      `$${r.totalPayout.toFixed(2)}`.padEnd(10) +
      `${pnlColor} ${pnlStr}`
    );
  }
  
  console.log('─'.repeat(100));
  
  if (resolutions.length > limit) {
    console.log(`... and ${resolutions.length - limit} more resolutions`);
  }
}




