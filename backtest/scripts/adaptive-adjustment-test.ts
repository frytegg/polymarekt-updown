/**
 * Adaptive Divergence Adjustment Test
 *
 * Compares static vs adaptive adjustment methods on the full 30-day dataset.
 * Tests rolling mean, EMA, and median-based dynamic adjustments.
 */

import * as dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import * as path from 'path';
import { BinanceKline, BacktestConfig, HistoricalMarket, DeribitVolPoint, Trade, MarketResolution } from './types';
import { ChainlinkPricePoint } from './fetchers/chainlink-historical';
import { DivergenceCalculator, AdjustmentMethod } from './engine/adaptive-adjustment';
import { PolymarketMarketsFetcher, determineOutcome } from './fetchers/polymarket-markets';
import { PolymarketPricesFetcher } from './fetchers/polymarket-prices';
import { DeribitVolFetcher } from './fetchers/deribit-vol';
import { OrderMatcher } from './engine/order-matcher';
import { PositionTracker } from './engine/position-tracker';
import { calculateFairValue } from '../fair-value';

// =============================================================================
// TYPES
// =============================================================================

interface TestConfig {
  name: string;
  method: AdjustmentMethod;
  windowHours: number;
  staticValue?: number;
}

interface TestResult {
  config: TestConfig;
  pnl: number;
  trades: number;
  markets: number;
  winRate: number;
  yesTrades: number;
  noTrades: number;
  yesPnl: number;
  noPnl: number;
  sharpe: number;
  edgeCapture: number;
  losingDays: number;
  maxDrawdown: number;
  dailyPnL: Map<string, number>;
}

// =============================================================================
// DATA LOADING
// =============================================================================

function loadBinanceData(startTs: number, endTs: number): BinanceKline[] {
  const dataDir = path.join(__dirname, '../data/binance');
  const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.json'));

  for (const file of files) {
    const content = fs.readFileSync(path.join(dataDir, file), 'utf-8');
    const cached = JSON.parse(content);

    if (cached.metadata.startTs <= startTs && cached.metadata.endTs >= endTs) {
      return cached.data.filter((k: BinanceKline) =>
        k.timestamp >= startTs && k.timestamp <= endTs
      );
    }
  }

  // Try to find any file with our date range in filename
  const startDate = new Date(startTs).toISOString().split('T')[0];
  const endDate = new Date(endTs).toISOString().split('T')[0];
  const targetFile = `BTCUSDT_1m_${startDate}_${endDate}.json`;

  if (fs.existsSync(path.join(dataDir, targetFile))) {
    const content = fs.readFileSync(path.join(dataDir, targetFile), 'utf-8');
    const cached = JSON.parse(content);
    return cached.data;
  }

  throw new Error(`No Binance data found for ${startDate} to ${endDate}`);
}

function loadChainlinkData(startTs: number, endTs: number): ChainlinkPricePoint[] {
  const dataDir = path.join(__dirname, '../data/chainlink');
  const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.json'));

  for (const file of files) {
    const content = fs.readFileSync(path.join(dataDir, file), 'utf-8');
    const cached = JSON.parse(content);

    if (cached.metadata.startTs <= startTs && cached.metadata.endTs >= endTs) {
      return cached.data.filter((p: ChainlinkPricePoint) =>
        p.timestamp >= startTs && p.timestamp <= endTs
      );
    }
  }

  throw new Error('No Chainlink data found for date range');
}

// =============================================================================
// VOLATILITY CALCULATION
// =============================================================================

const VOL_BLEND_CONFIG = {
  realized1h: 0.70,
  realized4h: 0.20,
  implied: 0.10,
  window1h: 60,
  window4h: 240,
};

function calculateRealizedVol(klines: BinanceKline[], endIdx: number, windowSize: number): number {
  const startIdx = Math.max(0, endIdx - windowSize);
  const windowKlines = klines.slice(startIdx, endIdx);

  if (windowKlines.length < 2) return 0;

  const logReturns: number[] = [];
  for (let i = 1; i < windowKlines.length; i++) {
    const logReturn = Math.log(windowKlines[i].close / windowKlines[i - 1].close);
    logReturns.push(logReturn);
  }

  if (logReturns.length < 2) return 0;

  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance = logReturns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (logReturns.length - 1);
  const stdDev = Math.sqrt(variance);
  const minutesPerYear = 525600;

  return stdDev * Math.sqrt(minutesPerYear);
}

function getBlendedVol(klines: BinanceKline[], klineIdx: number, dvolVol: number): number {
  const realizedVol1h = calculateRealizedVol(klines, klineIdx + 1, VOL_BLEND_CONFIG.window1h);
  const realizedVol4h = calculateRealizedVol(klines, klineIdx + 1, VOL_BLEND_CONFIG.window4h);

  if (realizedVol1h === 0 && realizedVol4h === 0) {
    return dvolVol;
  }

  const vol1h = realizedVol1h > 0 ? realizedVol1h : realizedVol4h;
  const vol4h = realizedVol4h > 0 ? realizedVol4h : vol1h;

  const blendedVol =
    VOL_BLEND_CONFIG.realized1h * vol1h +
    VOL_BLEND_CONFIG.realized4h * vol4h +
    VOL_BLEND_CONFIG.implied * dvolVol;

  return Math.max(0.10, Math.min(3.00, blendedVol));
}

function getKlineIndex(klines: BinanceKline[], timestamp: number): number {
  if (klines.length === 0) return 0;

  let left = 0;
  let right = klines.length - 1;

  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (klines[mid].timestamp < timestamp) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }

  return Math.max(0, left - 1);
}

function getDvolAt(volPoints: DeribitVolPoint[], timestamp: number): number {
  if (volPoints.length === 0) return 0.50;

  let left = 0;
  let right = volPoints.length - 1;

  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (volPoints[mid].timestamp < timestamp) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }

  return volPoints[Math.max(0, left)].vol;
}

function getChainlinkPriceAt(prices: ChainlinkPricePoint[], timestamp: number): ChainlinkPricePoint | null {
  if (prices.length === 0) return null;

  let left = 0;
  let right = prices.length - 1;

  while (left < right) {
    const mid = Math.floor((left + right + 1) / 2);
    if (prices[mid].timestamp <= timestamp) {
      left = mid;
    } else {
      right = mid - 1;
    }
  }

  const point = prices[left];
  if (timestamp - point.timestamp > 120000) {
    return null;
  }

  return point;
}

// =============================================================================
// BACKTEST RUNNER
// =============================================================================

async function runBacktest(
  testConfig: TestConfig,
  startTs: number,
  endTs: number,
  binanceKlines: BinanceKline[],
  chainlinkPrices: ChainlinkPricePoint[],
  volPoints: DeribitVolPoint[],
  markets: HistoricalMarket[],
  divergenceCalc: DivergenceCalculator,
  pricesFetcher: PolymarketPricesFetcher
): Promise<TestResult> {
  const orderMatcher = new OrderMatcher({ spreadCents: 1 });
  const positionTracker = new PositionTracker();
  const minEdge = 0.10;
  const orderSize = 100;
  const maxPosition = 1000;

  const dailyPnL = new Map<string, number>();

  for (const market of markets) {
    if (!market.strikePrice || market.strikePrice <= 0) continue;

    // Fetch Polymarket prices
    let polyPrices;
    try {
      polyPrices = await pricesFetcher.fetchYesOnly(
        market.tokenIds[0],
        market.startTime,
        market.endTime
      );
    } catch {
      continue;
    }

    if (polyPrices.length === 0) continue;

    // Process each price point
    for (const polyPrice of polyPrices) {
      const ts = polyPrice.timestamp;
      if (ts < market.startTime || ts > market.endTime) continue;

      // Get kline at this timestamp
      const klineIdx = getKlineIndex(binanceKlines, ts);
      const kline = binanceKlines[klineIdx];
      if (!kline) continue;

      // Get dynamic adjustment based on method
      const adjustment = divergenceCalc.getAdjustment(
        ts,
        testConfig.method,
        testConfig.windowHours,
        testConfig.staticValue ?? 0
      );

      // Apply adjustment to Binance price
      const btcPrice = kline.close + adjustment;

      // Get volatility
      const dvolVol = getDvolAt(volPoints, ts);
      const vol = getBlendedVol(binanceKlines, klineIdx, dvolVol);

      const timeRemainingMs = market.endTime - ts;
      if (timeRemainingMs < 30000) continue;

      // Calculate fair value
      const fairValue = calculateFairValue(
        btcPrice,
        market.strikePrice,
        timeRemainingMs / 1000,
        vol
      );

      // Check YES opportunity
      const yesBuyPrice = polyPrice.price + 0.005; // 0.5¢ spread
      const yesEdge = fairValue.pUp - yesBuyPrice;

      if (yesEdge >= minEdge && positionTracker.canTrade(market.conditionId, 'YES', orderSize, maxPosition)) {
        const trade = orderMatcher.executeBuy(
          {
            timestamp: ts,
            marketId: market.conditionId,
            side: 'YES',
            fairValue: fairValue.pUp,
            marketPrice: polyPrice.price,
            edge: yesEdge,
            size: orderSize,
          },
          btcPrice,
          market.strikePrice,
          timeRemainingMs
        );
        positionTracker.recordTrade(trade);
      }

      // Check NO opportunity
      const noMid = 1 - polyPrice.price;
      const noBuyPrice = noMid + 0.005;
      const noEdge = fairValue.pDown - noBuyPrice;

      if (noEdge >= minEdge && positionTracker.canTrade(market.conditionId, 'NO', orderSize, maxPosition)) {
        const trade = orderMatcher.executeBuy(
          {
            timestamp: ts,
            marketId: market.conditionId,
            side: 'NO',
            fairValue: fairValue.pDown,
            marketPrice: noMid,
            edge: noEdge,
            size: orderSize,
          },
          btcPrice,
          market.strikePrice,
          timeRemainingMs
        );
        positionTracker.recordTrade(trade);
      }
    }

    // Resolve market using Chainlink
    const chainlinkPoint = getChainlinkPriceAt(chainlinkPrices, market.endTime);
    if (chainlinkPoint) {
      const outcome = determineOutcome(chainlinkPoint.price, market.strikePrice);
      positionTracker.resolve(market.conditionId, outcome, chainlinkPoint.price, market.strikePrice);
    }
  }

  // Calculate results
  const trades = positionTracker.getTrades();
  const resolutions = positionTracker.getResolutions();
  const totalPnL = positionTracker.getRealizedPnL();

  // Group P&L by day
  for (const resolution of resolutions) {
    const trade = trades.find(t => t.marketId === resolution.marketId);
    if (trade) {
      const dateStr = new Date(trade.timestamp).toISOString().split('T')[0];
      dailyPnL.set(dateStr, (dailyPnL.get(dateStr) ?? 0) + resolution.pnl);
    }
  }

  // Calculate stats
  const yesTrades = trades.filter(t => t.side === 'YES').length;
  const noTrades = trades.filter(t => t.side === 'NO').length;

  const yesResolutions = resolutions.filter(r => {
    const trade = trades.find(t => t.marketId === r.marketId);
    return trade && trade.side === 'YES';
  });
  const noResolutions = resolutions.filter(r => {
    const trade = trades.find(t => t.marketId === r.marketId);
    return trade && trade.side === 'NO';
  });

  const yesPnl = yesResolutions.reduce((s, r) => s + r.pnl, 0);
  const noPnl = noResolutions.reduce((s, r) => s + r.pnl, 0);

  // Win rate
  const winningTrades = trades.filter(t => {
    const resolution = resolutions.find(r => r.marketId === t.marketId);
    if (!resolution) return false;
    return (t.side === 'YES' && resolution.outcome === 'UP') ||
           (t.side === 'NO' && resolution.outcome === 'DOWN');
  });
  const winRate = trades.length > 0 ? winningTrades.length / trades.length : 0;

  // Edge capture
  const expectedPnL = trades.reduce((sum, t) => sum + t.edge * t.size, 0);
  const edgeCapture = expectedPnL > 0 ? totalPnL / expectedPnL : 0;

  // Sharpe ratio (per-market)
  const returns = resolutions.map(r => r.pnl);
  const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance = returns.length > 1
    ? returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length
    : 0;
  const stdDev = Math.sqrt(variance);
  const marketsPerYear = 35040;
  const sharpe = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(marketsPerYear) : 0;

  // Daily stats
  const dailyReturns = Array.from(dailyPnL.values());
  const losingDays = dailyReturns.filter(r => r < 0).length;

  // Max drawdown
  let maxPnL = 0;
  let maxDrawdown = 0;
  let cumPnL = 0;
  for (const r of resolutions) {
    cumPnL += r.pnl;
    maxPnL = Math.max(maxPnL, cumPnL);
    maxDrawdown = Math.max(maxDrawdown, maxPnL - cumPnL);
  }

  return {
    config: testConfig,
    pnl: totalPnL,
    trades: trades.length,
    markets: resolutions.length,
    winRate,
    yesTrades,
    noTrades,
    yesPnl,
    noPnl,
    sharpe,
    edgeCapture,
    losingDays,
    maxDrawdown,
    dailyPnL,
  };
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  console.log('═'.repeat(100));
  console.log('  🔬 ADAPTIVE DIVERGENCE ADJUSTMENT TEST');
  console.log('═'.repeat(100));

  // Full 30-day period
  const startDate = new Date('2026-01-03T00:00:00Z');
  const endDate = new Date('2026-02-02T23:59:59Z');
  const startTs = startDate.getTime();
  const endTs = endDate.getTime();

  console.log(`\n📅 Test Period: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]} (30 days)`);

  // Load data
  console.log('\n📡 Loading data...');

  const binanceKlines = loadBinanceData(startTs, endTs);
  console.log(`   Binance klines: ${binanceKlines.length}`);

  const chainlinkPrices = loadChainlinkData(startTs, endTs);
  console.log(`   Chainlink prices: ${chainlinkPrices.length}`);

  // Initialize divergence calculator
  const divergenceCalc = new DivergenceCalculator(binanceKlines, chainlinkPrices);

  // Print divergence statistics
  const divStats = divergenceCalc.getStats(startTs, endTs);
  console.log(`\n📊 Divergence Statistics (Binance - Chainlink):`);
  console.log(`   Count: ${divStats.count} aligned points`);
  console.log(`   Mean: $${divStats.mean.toFixed(2)}`);
  console.log(`   Median: $${divStats.median.toFixed(2)}`);
  console.log(`   Std Dev: $${divStats.stdDev.toFixed(2)}`);
  console.log(`   Range: $${divStats.min.toFixed(2)} to $${divStats.max.toFixed(2)}`);

  // Fetch markets and volatility
  console.log('\n📡 Fetching markets and volatility...');

  const marketsFetcher = new PolymarketMarketsFetcher();
  const pricesFetcher = new PolymarketPricesFetcher(1);
  const volFetcher = new DeribitVolFetcher('BTC', 60);

  const markets = await marketsFetcher.fetch(startTs, endTs);
  console.log(`   Markets: ${markets.length}`);

  const volPoints = await volFetcher.fetch(startTs, endTs);
  console.log(`   Volatility points: ${volPoints.length}`);

  // Define test configurations
  const testConfigs: TestConfig[] = [
    // Static baselines
    { name: 'Static -100', method: 'static', windowHours: 0, staticValue: -100 },
    { name: 'Static -120', method: 'static', windowHours: 0, staticValue: -120 },

    // Rolling Mean
    { name: 'Rolling Mean 1h', method: 'rolling-mean', windowHours: 1 },
    { name: 'Rolling Mean 2h', method: 'rolling-mean', windowHours: 2 },
    { name: 'Rolling Mean 4h', method: 'rolling-mean', windowHours: 4 },
    { name: 'Rolling Mean 8h', method: 'rolling-mean', windowHours: 8 },
    { name: 'Rolling Mean 24h', method: 'rolling-mean', windowHours: 24 },

    // EMA
    { name: 'EMA 2h', method: 'ema', windowHours: 2 },
    { name: 'EMA 4h', method: 'ema', windowHours: 4 },
    { name: 'EMA 8h', method: 'ema', windowHours: 8 },

    // Median
    { name: 'Median 4h', method: 'median', windowHours: 4 },
  ];

  // Run tests
  console.log(`\n🔄 Running ${testConfigs.length} test configurations...\n`);

  const results: TestResult[] = [];

  for (let i = 0; i < testConfigs.length; i++) {
    const config = testConfigs[i];
    process.stdout.write(`   [${i + 1}/${testConfigs.length}] ${config.name.padEnd(20)}... `);

    const result = await runBacktest(
      config,
      startTs,
      endTs,
      binanceKlines,
      chainlinkPrices,
      volPoints,
      markets,
      divergenceCalc,
      pricesFetcher
    );

    results.push(result);

    const pnlStr = result.pnl >= 0 ? `+$${result.pnl.toFixed(0)}` : `-$${Math.abs(result.pnl).toFixed(0)}`;
    console.log(`${pnlStr.padStart(8)} | ${result.trades} trades | Win: ${(result.winRate * 100).toFixed(1)}%`);
  }

  // Print results table
  console.log('\n' + '═'.repeat(140));
  console.log('  📊 COMPARISON RESULTS');
  console.log('═'.repeat(140));

  console.log('\n  | Method              | P&L        | Trades | Win%  | YES/NO       | YES P&L   | NO P&L    | Sharpe | EdgeCap | Losing Days | MaxDD    |');
  console.log('  |---------------------|------------|--------|-------|--------------|-----------|-----------|--------|---------|-------------|----------|');

  // Sort by P&L for display
  const sortedResults = [...results].sort((a, b) => b.pnl - a.pnl);

  for (const r of sortedResults) {
    const pnlStr = r.pnl >= 0 ? `+$${r.pnl.toFixed(0).padStart(6)}` : `-$${Math.abs(r.pnl).toFixed(0).padStart(6)}`;
    const yesPnlStr = r.yesPnl >= 0 ? `+$${r.yesPnl.toFixed(0).padStart(4)}` : `-$${Math.abs(r.yesPnl).toFixed(0).padStart(4)}`;
    const noPnlStr = r.noPnl >= 0 ? `+$${r.noPnl.toFixed(0).padStart(4)}` : `-$${Math.abs(r.noPnl).toFixed(0).padStart(4)}`;
    const yesNoStr = `${r.yesTrades}/${r.noTrades}`;
    const drawdownStr = r.maxDrawdown > 0 ? `-$${r.maxDrawdown.toFixed(0).padStart(5)}` : '$0'.padStart(7);

    const isTop3 = sortedResults.indexOf(r) < 3;
    const marker = isTop3 ? ['🥇', '🥈', '🥉'][sortedResults.indexOf(r)] : '  ';

    console.log(
      `${marker}| ${r.config.name.padEnd(19)} | ${pnlStr}   | ${r.trades.toString().padStart(6)} | ${(r.winRate * 100).toFixed(1).padStart(5)}% | ${yesNoStr.padStart(12)} | ${yesPnlStr}    | ${noPnlStr}    | ${r.sharpe.toFixed(1).padStart(6)} | ${(r.edgeCapture * 100).toFixed(0).padStart(6)}% | ${r.losingDays.toString().padStart(11)} | ${drawdownStr} |`
    );
  }

  console.log('  |---------------------|------------|--------|-------|--------------|-----------|-----------|--------|---------|-------------|----------|');

  // Analysis
  console.log('\n' + '═'.repeat(140));
  console.log('  📈 ANALYSIS');
  console.log('═'.repeat(140));

  const best = sortedResults[0];
  const bestSharpe = [...results].sort((a, b) => b.sharpe - a.sharpe)[0];
  const fewestLosingDays = [...results].sort((a, b) => a.losingDays - b.losingDays)[0];
  const mostBalanced = [...results].sort((a, b) => {
    const balanceA = Math.abs(a.yesTrades - a.noTrades) / Math.max(1, a.yesTrades + a.noTrades);
    const balanceB = Math.abs(b.yesTrades - b.noTrades) / Math.max(1, b.yesTrades + b.noTrades);
    return balanceA - balanceB;
  })[0];

  console.log(`\n  🏆 Best P&L: ${best.config.name}`);
  console.log(`     P&L: +$${best.pnl.toFixed(2)}`);
  console.log(`     Trades: ${best.trades}`);

  console.log(`\n  📐 Best Sharpe: ${bestSharpe.config.name}`);
  console.log(`     Sharpe: ${bestSharpe.sharpe.toFixed(2)}`);
  console.log(`     P&L: +$${bestSharpe.pnl.toFixed(2)}`);

  console.log(`\n  📅 Fewest Losing Days: ${fewestLosingDays.config.name}`);
  console.log(`     Losing Days: ${fewestLosingDays.losingDays}`);
  console.log(`     P&L: +$${fewestLosingDays.pnl.toFixed(2)}`);

  console.log(`\n  ⚖️ Most Balanced YES/NO: ${mostBalanced.config.name}`);
  console.log(`     YES: ${mostBalanced.yesTrades}, NO: ${mostBalanced.noTrades}`);
  console.log(`     P&L: +$${mostBalanced.pnl.toFixed(2)}`);

  // Static vs Adaptive comparison
  console.log('\n' + '═'.repeat(140));
  console.log('  🔍 STATIC vs ADAPTIVE COMPARISON');
  console.log('═'.repeat(140));

  const staticResults = results.filter(r => r.config.method === 'static');
  const adaptiveResults = results.filter(r => r.config.method !== 'static');

  const bestStatic = staticResults.sort((a, b) => b.pnl - a.pnl)[0];
  const bestAdaptive = adaptiveResults.sort((a, b) => b.pnl - a.pnl)[0];

  console.log(`\n  Best Static: ${bestStatic.config.name}`);
  console.log(`     P&L: +$${bestStatic.pnl.toFixed(2)}, Sharpe: ${bestStatic.sharpe.toFixed(2)}`);

  console.log(`\n  Best Adaptive: ${bestAdaptive.config.name}`);
  console.log(`     P&L: +$${bestAdaptive.pnl.toFixed(2)}, Sharpe: ${bestAdaptive.sharpe.toFixed(2)}`);

  const improvement = bestAdaptive.pnl - bestStatic.pnl;
  const improvementPct = bestStatic.pnl > 0 ? (improvement / bestStatic.pnl * 100) : 0;

  console.log(`\n  Improvement: ${improvement >= 0 ? '+' : ''}$${improvement.toFixed(2)} (${improvementPct >= 0 ? '+' : ''}${improvementPct.toFixed(1)}%)`);

  // Daily breakdown for top method
  console.log('\n' + '═'.repeat(140));
  console.log(`  📅 DAILY P&L BREAKDOWN: ${best.config.name}`);
  console.log('═'.repeat(140));

  const sortedDays = Array.from(best.dailyPnL.entries()).sort((a, b) => a[0].localeCompare(b[0]));

  console.log(`\n  | Date       |     P&L     |`);
  console.log(`  |------------|-------------|`);

  for (const [date, pnl] of sortedDays) {
    const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(0).padStart(6)}` : `-$${Math.abs(pnl).toFixed(0).padStart(6)}`;
    const marker = pnl < 0 ? '❌' : '✅';
    console.log(`${marker}| ${date} | ${pnlStr}   |`);
  }

  console.log(`  |------------|-------------|`);

  // Recommendation
  console.log('\n' + '═'.repeat(140));
  console.log('  ✅ RECOMMENDATION');
  console.log('═'.repeat(140));

  const recommendation = bestSharpe.sharpe > best.sharpe * 1.1
    ? bestSharpe.config.name
    : best.config.name;

  console.log(`\n  📌 Recommended Method: ${recommendation}`);
  console.log(`\n  Reasoning:`);

  if (bestAdaptive.pnl > bestStatic.pnl && bestAdaptive.sharpe >= bestStatic.sharpe * 0.95) {
    console.log(`     ✓ Adaptive methods outperform static adjustment`);
    console.log(`     ✓ ${bestAdaptive.config.name} provides +$${(bestAdaptive.pnl - bestStatic.pnl).toFixed(0)} over best static`);
  } else {
    console.log(`     ✓ Static adjustment remains competitive`);
    console.log(`     ✓ Simpler implementation with comparable results`);
  }

  if (best.losingDays === 0) {
    console.log(`     ✓ Zero losing days with ${best.config.name}`);
  } else {
    console.log(`     ✓ Only ${best.losingDays} losing day(s) over 30-day period`);
  }

  console.log('');
}

main().catch(console.error);
