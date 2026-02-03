/**
 * Out-of-Sample Validation Test
 * Tests the -$120 adjustment on an earlier period (Jan 18-25)
 * that was NOT used for parameter optimization
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { Simulator } from './engine/simulator';
import { BacktestConfig } from './types';
import { calculateStatistics } from './output/statistics';

async function main() {
  console.log('═'.repeat(80));
  console.log('  🔬 OUT-OF-SAMPLE VALIDATION TEST');
  console.log('═'.repeat(80));

  // Out-of-sample period: Jan 18-25 (BEFORE the Jan 26-Feb 2 optimization period)
  const startDate = new Date('2026-01-18T00:00:00Z');
  const endDate = new Date('2026-01-26T00:00:00Z');  // 8 days

  console.log(`\n📅 Test Period: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);
  console.log(`   This is BEFORE the optimization period (Jan 26 - Feb 2)`);
  console.log(`   Adjustment -$120 was optimized on later data`);

  const config: Partial<BacktestConfig> = {
    startDate,
    endDate,
    initialCapital: Infinity,
    spreadCents: 1,
    minEdge: 0.10,  // 10% edge threshold
    orderSize: 100,
    maxPositionPerMarket: 1000,
    useChainlinkForFairValue: false,
    mode: 'normal',
    binanceChainlinkAdjustment: -120,  // The adjustment we're validating
  };

  console.log(`\n⚙️ Configuration:`);
  console.log(`   Adjustment: $-120`);
  console.log(`   Min Edge: 10%`);
  console.log(`   Spread: 1¢`);

  console.log(`\n🔄 Running backtest...\n`);

  const simulator = new Simulator(config);
  const result = await simulator.run();
  const stats = calculateStatistics(result);

  // =========================================================================
  // DAILY P&L BREAKDOWN
  // =========================================================================

  console.log('\n' + '═'.repeat(80));
  console.log('  📊 DAILY P&L BREAKDOWN');
  console.log('═'.repeat(80));

  // Group by actual trade dates
  const dailyData: Map<string, {
    pnl: number;
    trades: number;
    markets: Set<string>;
    yesTrades: number;
    noTrades: number;
  }> = new Map();

  // Initialize with resolution P&L
  for (const resolution of result.resolutions) {
    const trade = result.trades.find(t => t.marketId === resolution.marketId);
    if (trade) {
      const dateStr = new Date(trade.timestamp).toISOString().split('T')[0];
      if (!dailyData.has(dateStr)) {
        dailyData.set(dateStr, { pnl: 0, trades: 0, markets: new Set(), yesTrades: 0, noTrades: 0 });
      }
      dailyData.get(dateStr)!.pnl += resolution.pnl;
    }
  }

  // Add trade counts
  for (const trade of result.trades) {
    const dateStr = new Date(trade.timestamp).toISOString().split('T')[0];
    if (!dailyData.has(dateStr)) {
      dailyData.set(dateStr, { pnl: 0, trades: 0, markets: new Set(), yesTrades: 0, noTrades: 0 });
    }
    const day = dailyData.get(dateStr)!;
    day.trades++;
    day.markets.add(trade.marketId);
    if (trade.side === 'YES') day.yesTrades++;
    else day.noTrades++;
  }

  // Sort and display
  const sortedDays = Array.from(dailyData.entries()).sort((a, b) => a[0].localeCompare(b[0]));

  console.log(`\n   | Date       |     P&L     | Trades | YES/NO  | Markets |`);
  console.log(`   |------------|-------------|--------|---------|---------|`);

  const dailyReturns: number[] = [];
  let losingDays = 0;
  let maxLoss = 0;
  let maxGain = 0;

  for (const [date, data] of sortedDays) {
    dailyReturns.push(data.pnl);

    if (data.pnl < 0) {
      losingDays++;
      maxLoss = Math.min(maxLoss, data.pnl);
    }
    if (data.pnl > maxGain) maxGain = data.pnl;

    const pnlStr = data.pnl >= 0
      ? `+$${data.pnl.toFixed(0).padStart(6)}`
      : `-$${Math.abs(data.pnl).toFixed(0).padStart(6)}`;
    const yesNo = `${data.yesTrades}/${data.noTrades}`;
    const marker = data.pnl < 0 ? '❌' : '✅';

    console.log(`${marker} | ${date} | ${pnlStr}   | ${data.trades.toString().padStart(6)} | ${yesNo.padStart(7)} | ${data.markets.size.toString().padStart(7)} |`);
  }

  console.log(`   |------------|-------------|--------|---------|---------|`);

  // =========================================================================
  // SUMMARY STATISTICS
  // =========================================================================

  console.log('\n' + '═'.repeat(80));
  console.log('  📈 OUT-OF-SAMPLE RESULTS');
  console.log('═'.repeat(80));

  const totalPnL = dailyReturns.reduce((a, b) => a + b, 0);
  const avgDailyPnL = totalPnL / dailyReturns.length;
  const dailyVariance = dailyReturns.reduce((sum, r) => sum + Math.pow(r - avgDailyPnL, 2), 0) / (dailyReturns.length - 1);
  const dailyStdDev = Math.sqrt(dailyVariance);
  const dailySharpe = avgDailyPnL / dailyStdDev;
  const annualizedSharpe = dailySharpe * Math.sqrt(252);

  console.log(`\n   📊 P&L Summary:`);
  console.log(`      Total P&L:        ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)}`);
  console.log(`      Avg Daily P&L:    ${avgDailyPnL >= 0 ? '+' : ''}$${avgDailyPnL.toFixed(2)}`);
  console.log(`      Daily Std Dev:    $${dailyStdDev.toFixed(2)}`);

  console.log(`\n   📅 Daily Performance:`);
  console.log(`      Days Tested:      ${dailyReturns.length}`);
  console.log(`      Winning Days:     ${dailyReturns.length - losingDays} (${((dailyReturns.length - losingDays) / dailyReturns.length * 100).toFixed(0)}%)`);
  console.log(`      Losing Days:      ${losingDays} (${(losingDays / dailyReturns.length * 100).toFixed(0)}%)`);
  console.log(`      Max Daily Gain:   +$${maxGain.toFixed(2)}`);
  console.log(`      Max Daily Loss:   ${maxLoss === 0 ? '$0' : `-$${Math.abs(maxLoss).toFixed(2)}`}`);

  console.log(`\n   📐 Sharpe Ratio:`);
  console.log(`      Daily Sharpe:     ${dailySharpe.toFixed(4)}`);
  console.log(`      Annualized (×√252): ${annualizedSharpe.toFixed(2)}`);

  console.log(`\n   🎯 Trade Breakdown:`);
  console.log(`      Total Trades:     ${result.totalTrades}`);
  console.log(`      Win Rate:         ${(stats.winRate * 100).toFixed(1)}%`);
  console.log(`      YES Trades:       ${stats.yesTrades} (${(stats.yesTrades / result.totalTrades * 100).toFixed(0)}%)`);
  console.log(`      NO Trades:        ${stats.noTrades} (${(stats.noTrades / result.totalTrades * 100).toFixed(0)}%)`);
  console.log(`      Edge Capture:     ${(stats.edgeCapture * 100).toFixed(0)}%`);

  // =========================================================================
  // COMPARISON WITH IN-SAMPLE
  // =========================================================================

  console.log('\n' + '═'.repeat(80));
  console.log('  🔍 COMPARISON: OUT-OF-SAMPLE vs IN-SAMPLE');
  console.log('═'.repeat(80));

  // In-sample values from the optimization (Jan 26 - Feb 2)
  const inSamplePnL = 23496;  // From the adjustment sweep
  const inSampleSharpe = 62.8;
  const inSampleWinRate = 53.7;
  const inSampleYesNo = '49% / 51%';

  console.log(`\n   | Metric           | In-Sample (Jan 26-Feb 2) | Out-of-Sample (Jan 18-25) |`);
  console.log(`   |------------------|--------------------------|---------------------------|`);
  console.log(`   | Total P&L        | +$${inSamplePnL.toFixed(0).padStart(20)} | ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(0).padStart(21)} |`);
  console.log(`   | Daily Sharpe     | ${(inSampleSharpe / 15.87).toFixed(2).padStart(24)} | ${dailySharpe.toFixed(2).padStart(25)} |`);
  console.log(`   | Annualized Sharpe| ${inSampleSharpe.toFixed(1).padStart(24)} | ${annualizedSharpe.toFixed(1).padStart(25)} |`);
  console.log(`   | Win Rate         | ${inSampleWinRate.toFixed(1).padStart(23)}% | ${(stats.winRate * 100).toFixed(1).padStart(24)}% |`);
  console.log(`   | YES/NO Split     | ${inSampleYesNo.padStart(24)} | ${stats.yesTrades}/${stats.noTrades} (${(stats.yesTrades / result.totalTrades * 100).toFixed(0)}%/${(stats.noTrades / result.totalTrades * 100).toFixed(0)}%) |`);

  // =========================================================================
  // VERDICT
  // =========================================================================

  console.log('\n' + '═'.repeat(80));
  console.log('  ✅ VALIDATION VERDICT');
  console.log('═'.repeat(80));

  const isValid = totalPnL > 0 && annualizedSharpe > 1 && losingDays < dailyReturns.length / 2;

  if (isValid) {
    console.log(`\n   ✅ OUT-OF-SAMPLE VALIDATION PASSED`);
    console.log(`\n   The -$120 adjustment works on unseen data:`);
    console.log(`   • Profitable: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(0)} over ${dailyReturns.length} days`);
    console.log(`   • Strong Sharpe: ${annualizedSharpe.toFixed(1)} (>1 is good, >3 is excellent)`);
    console.log(`   • ${losingDays === 0 ? 'No losing days!' : `Only ${losingDays} losing day(s)`}`);
  } else {
    console.log(`\n   ⚠️ OUT-OF-SAMPLE RESULTS MIXED`);
    if (totalPnL <= 0) console.log(`   • Warning: Negative total P&L`);
    if (annualizedSharpe <= 1) console.log(`   • Warning: Low Sharpe ratio`);
    if (losingDays >= dailyReturns.length / 2) console.log(`   • Warning: Too many losing days`);
  }

  console.log('');
}

main().catch(console.error);
