/**
 * Sharpe Ratio Analysis
 * Compare current per-market Sharpe vs. proper daily annualized Sharpe
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { Simulator } from './engine/simulator';
import { BacktestConfig, MarketResolution } from './types';
import { calculateStatistics } from './output/statistics';

async function main() {
  console.log('═'.repeat(80));
  console.log('  📊 SHARPE RATIO ANALYSIS');
  console.log('═'.repeat(80));

  // Run backtest with optimal adjustment
  const now = new Date();
  const startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const config: Partial<BacktestConfig> = {
    startDate,
    endDate: now,
    initialCapital: Infinity,
    spreadCents: 1,
    minEdge: 0.10,
    orderSize: 100,
    maxPositionPerMarket: 1000,
    useChainlinkForFairValue: false,
    mode: 'normal',
    binanceChainlinkAdjustment: -120,  // Best Sharpe adjustment
  };

  console.log('\n🔄 Running backtest with adjustment=$-120...\n');

  const simulator = new Simulator(config);
  const result = await simulator.run();
  const stats = calculateStatistics(result);

  // =========================================================================
  // CURRENT SHARPE CALCULATION (Per-Market, Annualized)
  // =========================================================================

  console.log('\n' + '═'.repeat(80));
  console.log('  1. CURRENT SHARPE CALCULATION (Per-Market)');
  console.log('═'.repeat(80));

  const resolutions = result.resolutions;
  const marketReturns = resolutions.map(r => r.pnl);

  const avgMarketReturn = marketReturns.reduce((a, b) => a + b, 0) / marketReturns.length;
  const marketVariance = marketReturns.reduce((sum, r) => sum + Math.pow(r - avgMarketReturn, 2), 0) / marketReturns.length;
  const marketStdDev = Math.sqrt(marketVariance);

  const periodsPerYear = 35040;  // 15-min markets, 24/7/365
  const currentSharpe = (avgMarketReturn / marketStdDev) * Math.sqrt(periodsPerYear);

  console.log(`\n   Formula: Sharpe = (avgReturn / stdDev) × √periodsPerYear`);
  console.log(`   Where periodsPerYear = 35,040 (15-min markets, 24/7/365)`);
  console.log(`\n   Calculation:`);
  console.log(`     - Number of markets: ${resolutions.length}`);
  console.log(`     - Avg P&L per market: $${avgMarketReturn.toFixed(4)}`);
  console.log(`     - Std Dev of market P&L: $${marketStdDev.toFixed(4)}`);
  console.log(`     - Raw Sharpe (per-market): ${(avgMarketReturn / marketStdDev).toFixed(4)}`);
  console.log(`     - Annualization factor: √35040 = ${Math.sqrt(periodsPerYear).toFixed(2)}`);
  console.log(`     - Annualized Sharpe: ${currentSharpe.toFixed(2)}`);

  // =========================================================================
  // PROPER DAILY SHARPE CALCULATION
  // =========================================================================

  console.log('\n' + '═'.repeat(80));
  console.log('  2. PROPER DAILY SHARPE CALCULATION');
  console.log('═'.repeat(80));

  // Group resolutions by day
  const dailyPnL: Map<string, number> = new Map();

  for (const r of resolutions) {
    const date = new Date(r.marketId ? result.trades.find(t => t.marketId === r.marketId)?.timestamp || 0 : 0);
    // Use resolution data to group by day - approximate from market count
  }

  // Alternative: Calculate daily P&L from sequential resolution timestamps
  // Since we don't have timestamps on resolutions, estimate from market distribution

  // Sort resolutions and divide into 7 daily buckets
  const marketsPerDay = Math.ceil(resolutions.length / 7);
  const dailyReturns: number[] = [];

  for (let day = 0; day < 7; day++) {
    const startIdx = day * marketsPerDay;
    const endIdx = Math.min((day + 1) * marketsPerDay, resolutions.length);
    const dayResolutions = resolutions.slice(startIdx, endIdx);
    const dayPnL = dayResolutions.reduce((sum, r) => sum + r.pnl, 0);
    dailyReturns.push(dayPnL);
  }

  console.log(`\n   Daily P&L breakdown (estimated from market sequence):`);
  dailyReturns.forEach((pnl, i) => {
    const bar = pnl >= 0 ? '█'.repeat(Math.min(30, Math.round(pnl / 500))) : '';
    const negBar = pnl < 0 ? '▓'.repeat(Math.min(30, Math.round(Math.abs(pnl) / 500))) : '';
    console.log(`     Day ${i + 1}: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0).padStart(7)} ${bar}${negBar}`);
  });

  const avgDailyReturn = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const dailyVariance = dailyReturns.reduce((sum, r) => sum + Math.pow(r - avgDailyReturn, 2), 0) / (dailyReturns.length - 1);
  const dailyStdDev = Math.sqrt(dailyVariance);

  const tradingDaysPerYear = 252;  // Standard for financial Sharpe
  const dailySharpe = avgDailyReturn / dailyStdDev;
  const annualizedDailySharpe = dailySharpe * Math.sqrt(tradingDaysPerYear);

  console.log(`\n   Formula: Sharpe = (avgDailyReturn / dailyStdDev) × √252`);
  console.log(`\n   Calculation:`);
  console.log(`     - Number of days: ${dailyReturns.length}`);
  console.log(`     - Total P&L: $${dailyReturns.reduce((a, b) => a + b, 0).toFixed(2)}`);
  console.log(`     - Avg daily P&L: $${avgDailyReturn.toFixed(2)}`);
  console.log(`     - Daily Std Dev: $${dailyStdDev.toFixed(2)}`);
  console.log(`     - Daily Sharpe: ${dailySharpe.toFixed(4)}`);
  console.log(`     - Annualization factor: √252 = ${Math.sqrt(tradingDaysPerYear).toFixed(2)}`);
  console.log(`     - Annualized Daily Sharpe: ${annualizedDailySharpe.toFixed(2)}`);

  // =========================================================================
  // COMPARISON
  // =========================================================================

  console.log('\n' + '═'.repeat(80));
  console.log('  3. COMPARISON');
  console.log('═'.repeat(80));

  console.log(`\n   | Metric                    | Per-Market Sharpe | Daily Sharpe |`);
  console.log(`   |---------------------------|-------------------|--------------|`);
  console.log(`   | Raw (non-annualized)      | ${(avgMarketReturn / marketStdDev).toFixed(4).padStart(17)} | ${dailySharpe.toFixed(4).padStart(12)} |`);
  console.log(`   | Annualization factor      | ${Math.sqrt(periodsPerYear).toFixed(2).padStart(17)} | ${Math.sqrt(tradingDaysPerYear).toFixed(2).padStart(12)} |`);
  console.log(`   | Annualized Sharpe         | ${currentSharpe.toFixed(2).padStart(17)} | ${annualizedDailySharpe.toFixed(2).padStart(12)} |`);

  console.log(`\n   ⚠️  The per-market Sharpe is ${(currentSharpe / annualizedDailySharpe).toFixed(1)}× higher because:`);
  console.log(`       - It assumes 35,040 independent "bets" per year`);
  console.log(`       - Each 15-min market is treated as independent`);
  console.log(`       - But daily returns are correlated (same day, same BTC trend)`);

  console.log(`\n   ✅ STANDARD INTERPRETATION:`);
  console.log(`       - Daily Annualized Sharpe of ${annualizedDailySharpe.toFixed(2)} is ${
    annualizedDailySharpe > 3 ? 'EXCELLENT (>3)' :
    annualizedDailySharpe > 2 ? 'VERY GOOD (2-3)' :
    annualizedDailySharpe > 1 ? 'GOOD (1-2)' :
    annualizedDailySharpe > 0 ? 'POSITIVE (<1)' : 'NEGATIVE'
  }`);
  console.log(`       - Industry benchmark: Sharpe > 1 is considered good`);
  console.log(`       - Hedge funds target Sharpe 1.5-2.0`);

  // =========================================================================
  // DETAILED DAILY BREAKDOWN WITH TIMESTAMPS
  // =========================================================================

  console.log('\n' + '═'.repeat(80));
  console.log('  4. DETAILED DAILY P&L (from trade timestamps)');
  console.log('═'.repeat(80));

  // Group trades by actual day
  const tradesByDay: Map<string, { pnl: number; trades: number; markets: Set<string> }> = new Map();

  for (const trade of result.trades) {
    const dateStr = new Date(trade.timestamp).toISOString().split('T')[0];
    if (!tradesByDay.has(dateStr)) {
      tradesByDay.set(dateStr, { pnl: 0, trades: 0, markets: new Set() });
    }
    const day = tradesByDay.get(dateStr)!;
    day.trades++;
    day.markets.add(trade.marketId);
  }

  // Add resolution P&L to the day it resolved
  for (const resolution of resolutions) {
    // Find a trade in this market to get the approximate date
    const trade = result.trades.find(t => t.marketId === resolution.marketId);
    if (trade) {
      const dateStr = new Date(trade.timestamp).toISOString().split('T')[0];
      if (tradesByDay.has(dateStr)) {
        tradesByDay.get(dateStr)!.pnl += resolution.pnl;
      }
    }
  }

  // Sort by date and display
  const sortedDays = Array.from(tradesByDay.entries()).sort((a, b) => a[0].localeCompare(b[0]));

  console.log(`\n   | Date       | P&L        | Trades | Markets |`);
  console.log(`   |------------|------------|--------|---------|`);

  const actualDailyReturns: number[] = [];
  for (const [date, data] of sortedDays) {
    const pnlStr = data.pnl >= 0 ? `+$${data.pnl.toFixed(0).padStart(6)}` : `-$${Math.abs(data.pnl).toFixed(0).padStart(6)}`;
    console.log(`   | ${date} | ${pnlStr}  | ${data.trades.toString().padStart(6)} | ${data.markets.size.toString().padStart(7)} |`);
    actualDailyReturns.push(data.pnl);
  }

  // Recalculate with actual daily data
  if (actualDailyReturns.length >= 2) {
    const actualAvgDaily = actualDailyReturns.reduce((a, b) => a + b, 0) / actualDailyReturns.length;
    const actualDailyVar = actualDailyReturns.reduce((sum, r) => sum + Math.pow(r - actualAvgDaily, 2), 0) / (actualDailyReturns.length - 1);
    const actualDailyStd = Math.sqrt(actualDailyVar);
    const actualDailySharpe = actualAvgDaily / actualDailyStd;
    const actualAnnualizedSharpe = actualDailySharpe * Math.sqrt(252);

    console.log(`\n   Actual Daily Sharpe (from trade dates):`);
    console.log(`     - Avg daily P&L: $${actualAvgDaily.toFixed(2)}`);
    console.log(`     - Daily Std Dev: $${actualDailyStd.toFixed(2)}`);
    console.log(`     - Daily Sharpe: ${actualDailySharpe.toFixed(4)}`);
    console.log(`     - Annualized Sharpe: ${actualAnnualizedSharpe.toFixed(2)}`);
  }

  console.log('\n' + '═'.repeat(80));
  console.log('  SUMMARY');
  console.log('═'.repeat(80));
  console.log(`\n   Current Sharpe (per-market, reported): ${currentSharpe.toFixed(1)}`);
  console.log(`   Annualized Sharpe (daily, standard):   ${annualizedDailySharpe.toFixed(2)}`);
  console.log(`\n   The ${currentSharpe.toFixed(1)} Sharpe is inflated by ~${(currentSharpe / annualizedDailySharpe).toFixed(0)}×`);
  console.log(`   Real risk-adjusted performance is still strong but more modest.`);
  console.log('');
}

main().catch(console.error);
