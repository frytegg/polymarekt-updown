/**
 * Statistics Calculator
 * Generates comprehensive statistics from backtest results
 */

import { Trade, MarketResolution, BacktestResult, Statistics, PnLPoint } from '../types';

/**
 * Calculate full statistics from backtest result
 */
export function calculateStatistics(result: BacktestResult): Statistics {
  const { trades, resolutions, pnlCurve } = result;

  // Basic counts
  const totalTrades = trades.length;
  const totalMarkets = resolutions.length;

  // Winning/losing trades (based on resolution outcome)
  const tradeResults = trades.map(t => {
    const resolution = resolutions.find(r => r.marketId === t.marketId);
    if (!resolution) return { trade: t, won: false };
    
    const won = (t.side === 'YES' && resolution.outcome === 'UP') ||
                (t.side === 'NO' && resolution.outcome === 'DOWN');
    return { trade: t, won };
  });

  const winningTrades = tradeResults.filter(r => r.won).length;
  const losingTrades = totalTrades - winningTrades;
  const winRate = totalTrades > 0 ? winningTrades / totalTrades : 0;

  // Total P&L
  const totalPnL = resolutions.reduce((sum, r) => sum + r.pnl, 0);

  // By side
  const yesTrades = trades.filter(t => t.side === 'YES').length;
  const noTrades = trades.filter(t => t.side === 'NO').length;

  const yesPnL = resolutions.reduce((sum, r) => sum + r.yesPayout - r.yesCost, 0);
  const noPnL = resolutions.reduce((sum, r) => sum + r.noPayout - r.noCost, 0);

  // Edge analysis
  const avgEdgeAtTrade = totalTrades > 0
    ? trades.reduce((sum, t) => sum + t.edge, 0) / totalTrades
    : 0;

  // Total staked = sum of all trade costs
  const totalStaked = trades.reduce((sum, t) => sum + t.cost, 0);

  // Realized edge = actual ROI (P&L / total staked)
  const expectedPnL = trades.reduce((sum, t) => sum + t.edge * t.size, 0);
  const avgRealizedEdge = totalStaked > 0 ? totalPnL / totalStaked : 0;
  const edgeCapture = expectedPnL > 0 ? totalPnL / expectedPnL : 0;

  // Per-trade edge breakdown with realized returns
  const totalShares = trades.reduce((sum, t) => sum + t.size, 0);
  
  // Calculate per-trade realized returns
  // For each trade: expected = (fairValue - price), realized = (payout - price) where payout = 1 if won, 0 if lost
  const tradeReturns = tradeResults.map(({ trade, won }) => {
    const expectedEdge = trade.fairValue - trade.price;  // What we expected per share
    const payout = won ? 1 : 0;
    const realizedReturn = payout - trade.price;  // What we actually got per share
    return {
      trade,
      won,
      expectedEdge,
      realizedReturn,
      fairValue: trade.fairValue,
    };
  });

  // Average expected return per share (same as avgEdgeAtTrade but more explicit)
  const avgExpectedReturnPerShare = totalTrades > 0
    ? tradeReturns.reduce((sum, t) => sum + t.expectedEdge, 0) / totalTrades
    : 0;

  // Average realized return per share
  const avgRealizedReturnPerShare = totalTrades > 0
    ? tradeReturns.reduce((sum, t) => sum + t.realizedReturn, 0) / totalTrades
    : 0;

  // By outcome breakdown
  const winningTradeReturns = tradeReturns.filter(t => t.won);
  const losingTradeReturns = tradeReturns.filter(t => !t.won);

  const winningTradesAvgEdge = winningTradeReturns.length > 0
    ? winningTradeReturns.reduce((sum, t) => sum + t.expectedEdge, 0) / winningTradeReturns.length
    : 0;
  
  const winningTradesAvgReturn = winningTradeReturns.length > 0
    ? winningTradeReturns.reduce((sum, t) => sum + t.realizedReturn, 0) / winningTradeReturns.length
    : 0;

  const losingTradesAvgEdge = losingTradeReturns.length > 0
    ? losingTradeReturns.reduce((sum, t) => sum + t.expectedEdge, 0) / losingTradeReturns.length
    : 0;

  const losingTradesAvgReturn = losingTradeReturns.length > 0
    ? losingTradeReturns.reduce((sum, t) => sum + t.realizedReturn, 0) / losingTradeReturns.length
    : 0;

  // Model calibration - how confident were we?
  const avgFairValueOnWins = winningTradeReturns.length > 0
    ? winningTradeReturns.reduce((sum, t) => sum + t.fairValue, 0) / winningTradeReturns.length
    : 0;

  const avgFairValueOnLosses = losingTradeReturns.length > 0
    ? losingTradeReturns.reduce((sum, t) => sum + t.fairValue, 0) / losingTradeReturns.length
    : 0;

  // Risk metrics
  const sharpeRatio = calculateSharpeRatio(resolutions);
  const sortinoRatio = calculateSortinoRatio(resolutions);
  const { maxDrawdown, maxDrawdownDuration } = calculateDrawdownMetrics(pnlCurve);

  // Per market stats
  const profitableMarkets = resolutions.filter(r => r.pnl > 0).length;
  const unprofitableMarkets = resolutions.filter(r => r.pnl <= 0).length;
  const avgPnLPerMarket = totalMarkets > 0 ? totalPnL / totalMarkets : 0;
  const avgTradesPerMarket = totalMarkets > 0 ? totalTrades / totalMarkets : 0;

  return {
    totalPnL,
    totalTrades,
    totalMarkets,
    totalStaked,
    winningTrades,
    losingTrades,
    winRate,
    yesTrades,
    noTrades,
    yesPnL,
    noPnL,
    avgEdgeAtTrade,
    avgRealizedEdge,
    edgeCapture,
    // Per-trade edge breakdown
    avgExpectedReturnPerShare,
    avgRealizedReturnPerShare,
    // By outcome
    winningTradesAvgEdge,
    winningTradesAvgReturn,
    losingTradesAvgEdge,
    losingTradesAvgReturn,
    // Model calibration
    avgFairValueOnWins,
    avgFairValueOnLosses,
    // Risk metrics
    sharpeRatio,
    sortinoRatio,
    maxDrawdown,
    maxDrawdownDuration,
    avgPnLPerMarket,
    avgTradesPerMarket,
    profitableMarkets,
    unprofitableMarkets,
  };
}

/**
 * Calculate Sharpe ratio from market resolutions
 * Annualized based on 15-minute markets
 */
function calculateSharpeRatio(resolutions: MarketResolution[]): number {
  if (resolutions.length < 2) return 0;

  const returns = resolutions.map(r => r.pnl);
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return avgReturn > 0 ? Infinity : 0;

  // Annualize: ~35,040 15-minute periods per year
  const periodsPerYear = 35040;
  return (avgReturn / stdDev) * Math.sqrt(periodsPerYear);
}

/**
 * Calculate Sortino ratio (only penalizes downside volatility)
 */
function calculateSortinoRatio(resolutions: MarketResolution[]): number {
  if (resolutions.length < 2) return 0;

  const returns = resolutions.map(r => r.pnl);
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  
  // Only consider negative returns for downside deviation
  const negativeReturns = returns.filter(r => r < 0);
  if (negativeReturns.length === 0) return avgReturn > 0 ? Infinity : 0;

  const downsideVariance = negativeReturns.reduce((sum, r) => sum + Math.pow(r, 2), 0) / returns.length;
  const downsideDeviation = Math.sqrt(downsideVariance);

  if (downsideDeviation === 0) return avgReturn > 0 ? Infinity : 0;

  // Annualize
  const periodsPerYear = 35040;
  return (avgReturn / downsideDeviation) * Math.sqrt(periodsPerYear);
}

/**
 * Calculate maximum drawdown and duration
 */
function calculateDrawdownMetrics(pnlCurve: PnLPoint[]): { maxDrawdown: number; maxDrawdownDuration: number } {
  if (pnlCurve.length === 0) {
    return { maxDrawdown: 0, maxDrawdownDuration: 0 };
  }

  let maxPnL = 0;
  let maxDrawdown = 0;
  let maxDrawdownDuration = 0;
  let currentDrawdownStart = 0;
  let inDrawdown = false;

  for (let i = 0; i < pnlCurve.length; i++) {
    const point = pnlCurve[i];
    
    if (point.cumulativePnL > maxPnL) {
      // New high
      maxPnL = point.cumulativePnL;
      
      if (inDrawdown) {
        // End of drawdown
        const duration = point.timestamp - currentDrawdownStart;
        maxDrawdownDuration = Math.max(maxDrawdownDuration, duration);
        inDrawdown = false;
      }
    } else {
      // In drawdown
      const drawdown = maxPnL - point.cumulativePnL;
      maxDrawdown = Math.max(maxDrawdown, drawdown);
      
      if (!inDrawdown) {
        currentDrawdownStart = point.timestamp;
        inDrawdown = true;
      }
    }
  }

  // Check if still in drawdown at end
  if (inDrawdown && pnlCurve.length > 0) {
    const duration = pnlCurve[pnlCurve.length - 1].timestamp - currentDrawdownStart;
    maxDrawdownDuration = Math.max(maxDrawdownDuration, duration);
  }

  return { maxDrawdown, maxDrawdownDuration };
}

/**
 * Print statistics to console
 */
export function printStatistics(stats: Statistics): void {
  console.log('\n📊 Backtest Statistics\n');
  console.log('═'.repeat(60));
  
  // Overall Performance
  console.log('\n📈 Overall Performance');
  console.log('─'.repeat(60));
  const pnlStr = stats.totalPnL >= 0 ? `+$${stats.totalPnL.toFixed(2)}` : `-$${Math.abs(stats.totalPnL).toFixed(2)}`;
  const pnlEmoji = stats.totalPnL >= 0 ? '🟢' : '🔴';
  console.log(`${pnlEmoji} Total P&L:            ${pnlStr}`);
  console.log(`   Total Staked:         $${stats.totalStaked.toFixed(2)}`);
  console.log(`   Total Markets:        ${stats.totalMarkets}`);
  console.log(`   Total Trades:         ${stats.totalTrades}`);
  console.log(`   Win Rate:             ${(stats.winRate * 100).toFixed(1)}% (${stats.winningTrades}W / ${stats.losingTrades}L)`);
  
  // Per Market Stats
  console.log('\n📊 Per Market Stats');
  console.log('─'.repeat(60));
  console.log(`   Avg P&L per Market:   $${stats.avgPnLPerMarket.toFixed(4)}`);
  console.log(`   Avg Trades per Market: ${stats.avgTradesPerMarket.toFixed(1)}`);
  console.log(`   Profitable Markets:   ${stats.profitableMarkets} (${(stats.profitableMarkets / stats.totalMarkets * 100).toFixed(1)}%)`);
  console.log(`   Unprofitable Markets: ${stats.unprofitableMarkets}`);
  
  // By Side
  console.log('\n⬆️⬇️ By Side');
  console.log('─'.repeat(60));
  console.log(`   YES Trades:           ${stats.yesTrades} (P&L: $${stats.yesPnL.toFixed(2)})`);
  console.log(`   NO Trades:            ${stats.noTrades} (P&L: $${stats.noPnL.toFixed(2)})`);
  
  // Edge Analysis
  console.log('\n🎯 Edge Analysis');
  console.log('─'.repeat(60));
  console.log(`   Avg Edge at Trade:    ${(stats.avgEdgeAtTrade * 100).toFixed(2)}%`);
  console.log(`   ROI (P&L/Staked):     ${(stats.avgRealizedEdge * 100).toFixed(2)}%`);
  console.log(`   Edge Capture:         ${(stats.edgeCapture * 100).toFixed(1)}%`);
  
  // Per-trade breakdown
  console.log('\n💰 Per-Trade Returns (per share)');
  console.log('─'.repeat(60));
  console.log(`   Expected Return:      ${(stats.avgExpectedReturnPerShare * 100).toFixed(1)}¢`);
  console.log(`   Realized Return:      ${(stats.avgRealizedReturnPerShare * 100).toFixed(1)}¢`);
  
  // By outcome
  console.log('\n📊 By Outcome');
  console.log('─'.repeat(60));
  console.log(`   ✅ WINNING TRADES (${stats.winningTrades})`);
  console.log(`      Avg Expected Edge: ${(stats.winningTradesAvgEdge * 100).toFixed(1)}¢/share`);
  console.log(`      Avg Realized:      ${(stats.winningTradesAvgReturn * 100).toFixed(1)}¢/share`);
  console.log(`      Avg Fair Value:    ${(stats.avgFairValueOnWins * 100).toFixed(1)}%`);
  console.log(`   ❌ LOSING TRADES (${stats.losingTrades})`);
  console.log(`      Avg Expected Edge: ${(stats.losingTradesAvgEdge * 100).toFixed(1)}¢/share`);
  console.log(`      Avg Realized:      ${(stats.losingTradesAvgReturn * 100).toFixed(1)}¢/share`);
  console.log(`      Avg Fair Value:    ${(stats.avgFairValueOnLosses * 100).toFixed(1)}%`);
  
  // Risk Metrics
  console.log('\n⚠️ Risk Metrics');
  console.log('─'.repeat(60));
  console.log(`   Sharpe Ratio:         ${stats.sharpeRatio.toFixed(2)}`);
  console.log(`   Sortino Ratio:        ${stats.sortinoRatio.toFixed(2)}`);
  console.log(`   Max Drawdown:         $${stats.maxDrawdown.toFixed(2)}`);
  console.log(`   Max DD Duration:      ${(stats.maxDrawdownDuration / 60000).toFixed(0)} minutes`);
  
  console.log('\n' + '═'.repeat(60));
}

/**
 * Generate statistics summary as string
 */
export function formatStatisticsSummary(stats: Statistics): string {
  const lines = [
    `P&L: $${stats.totalPnL.toFixed(2)} | Staked: $${stats.totalStaked.toFixed(2)}`,
    `Markets: ${stats.totalMarkets} | Trades: ${stats.totalTrades}`,
    `Win Rate: ${(stats.winRate * 100).toFixed(1)}%`,
    `Sharpe: ${stats.sharpeRatio.toFixed(2)} | Max DD: $${stats.maxDrawdown.toFixed(2)}`,
    `Avg Edge: ${(stats.avgEdgeAtTrade * 100).toFixed(2)}% | ROI: ${(stats.avgRealizedEdge * 100).toFixed(2)}%`,
  ];
  return lines.join('\n');
}

/**
 * Calculate edge distribution buckets
 */
export function calculateEdgeDistribution(trades: Trade[]): Map<string, number> {
  const buckets = new Map<string, number>();
  
  // Initialize buckets
  const bucketLabels = ['0-1%', '1-2%', '2-3%', '3-4%', '4-5%', '5%+'];
  for (const label of bucketLabels) {
    buckets.set(label, 0);
  }
  
  for (const trade of trades) {
    const edgePct = trade.edge * 100;
    
    if (edgePct < 1) buckets.set('0-1%', (buckets.get('0-1%') || 0) + 1);
    else if (edgePct < 2) buckets.set('1-2%', (buckets.get('1-2%') || 0) + 1);
    else if (edgePct < 3) buckets.set('2-3%', (buckets.get('2-3%') || 0) + 1);
    else if (edgePct < 4) buckets.set('3-4%', (buckets.get('3-4%') || 0) + 1);
    else if (edgePct < 5) buckets.set('4-5%', (buckets.get('4-5%') || 0) + 1);
    else buckets.set('5%+', (buckets.get('5%+') || 0) + 1);
  }
  
  return buckets;
}

/**
 * Print edge distribution
 */
export function printEdgeDistribution(trades: Trade[]): void {
  const dist = calculateEdgeDistribution(trades);
  
  console.log('\n📊 Edge Distribution\n');
  console.log('─'.repeat(40));
  
  const entries = Array.from(dist.entries());
  for (const [label, count] of entries) {
    const pct = trades.length > 0 ? (count / trades.length * 100).toFixed(1) : '0.0';
    const bar = '█'.repeat(Math.round(count / trades.length * 30));
    console.log(`${label.padEnd(8)} ${count.toString().padStart(5)} (${pct.padStart(5)}%) ${bar}`);
  }
  
  console.log('─'.repeat(40));
}

