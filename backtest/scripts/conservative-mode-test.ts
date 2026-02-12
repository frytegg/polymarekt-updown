/**
 * Conservative Mode Test
 *
 * Tests Rolling Mean 2h adaptive adjustment with conservative settings:
 * - Worst-case kline pricing (low for YES, high for NO)
 * - 200ms execution latency
 *
 * Compares to normal mode to show impact of execution friction.
 */

import * as dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import * as path from 'path';
import { BinanceKline, DeribitVolPoint, HistoricalMarket, PolymarketPricePoint } from './types';
import { ChainlinkPricePoint } from './fetchers/chainlink-historical';
import { DivergenceCalculator } from './engine/adaptive-adjustment';
import { PolymarketMarketsFetcher, determineOutcome } from './fetchers/polymarket-markets';
import { PolymarketPricesFetcher } from './fetchers/polymarket-prices';
import { DeribitVolFetcher } from './fetchers/deribit-vol';
import { OrderMatcher } from './engine/order-matcher';
import { PositionTracker } from './engine/position-tracker';
import { calculateFairValue } from '../core/fair-value';

// =============================================================================
// TYPES
// =============================================================================

interface ModeConfig {
  name: string;
  useWorstCase: boolean;
  latencyMs: number;
}

interface TestResult {
  mode: string;
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
  avgDailyPnl: number;
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

  throw new Error('No Binance data found for date range');
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
  modeConfig: ModeConfig,
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
    let polyPrices: PolymarketPricePoint[];
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

      // Get dynamic adjustment using Rolling Mean 2h
      const adjustment = divergenceCalc.getAdjustment(ts, 'rolling-mean', 2, 0);

      // Get volatility
      const dvolVol = getDvolAt(volPoints, ts);
      const vol = getBlendedVol(binanceKlines, klineIdx, dvolVol);

      // Calculate execution timestamp with latency
      const executionTs = ts + modeConfig.latencyMs;

      // Skip if execution would be too close to market end
      if (executionTs >= market.endTime - 30000) continue;

      // Get execution kline (for latency simulation)
      const execKlineIdx = modeConfig.latencyMs > 0
        ? getKlineIndex(binanceKlines, executionTs)
        : klineIdx;
      const execKline = binanceKlines[execKlineIdx] || kline;

      const timeRemainingMs = market.endTime - executionTs;
      if (timeRemainingMs < 30000) continue;

      // Check YES opportunity
      {
        // Get BTC price for fair value calculation
        let btcPriceForFV: number;
        if (modeConfig.useWorstCase) {
          // Worst case for YES: BTC was at LOW (lower P(up))
          btcPriceForFV = execKline.low + adjustment;
        } else {
          btcPriceForFV = execKline.close + adjustment;
        }

        const fairValue = calculateFairValue(
          btcPriceForFV,
          market.strikePrice,
          timeRemainingMs / 1000,
          vol
        );

        const yesBuyPrice = polyPrice.price + 0.005;
        const yesEdge = fairValue.pUp - yesBuyPrice;

        if (yesEdge >= minEdge && positionTracker.canTrade(market.conditionId, 'YES', orderSize, maxPosition)) {
          const trade = orderMatcher.executeBuy(
            {
              timestamp: executionTs,
              marketId: market.conditionId,
              side: 'YES',
              fairValue: fairValue.pUp,
              marketPrice: polyPrice.price,
              edge: yesEdge,
              size: orderSize,
            },
            btcPriceForFV,
            market.strikePrice,
            timeRemainingMs
          );
          positionTracker.recordTrade(trade);
        }
      }

      // Check NO opportunity
      {
        let btcPriceForFV: number;
        if (modeConfig.useWorstCase) {
          // Worst case for NO: BTC was at HIGH (lower P(down))
          btcPriceForFV = execKline.high + adjustment;
        } else {
          btcPriceForFV = execKline.close + adjustment;
        }

        const fairValue = calculateFairValue(
          btcPriceForFV,
          market.strikePrice,
          timeRemainingMs / 1000,
          vol
        );

        const noMid = 1 - polyPrice.price;
        const noBuyPrice = noMid + 0.005;
        const noEdge = fairValue.pDown - noBuyPrice;

        if (noEdge >= minEdge && positionTracker.canTrade(market.conditionId, 'NO', orderSize, maxPosition)) {
          const trade = orderMatcher.executeBuy(
            {
              timestamp: executionTs,
              marketId: market.conditionId,
              side: 'NO',
              fairValue: fairValue.pDown,
              marketPrice: noMid,
              edge: noEdge,
              size: orderSize,
            },
            btcPriceForFV,
            market.strikePrice,
            timeRemainingMs
          );
          positionTracker.recordTrade(trade);
        }
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

  // Sharpe ratio
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
  const avgDailyPnl = dailyReturns.length > 0
    ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length
    : 0;

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
    mode: modeConfig.name,
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
    avgDailyPnl,
    dailyPnL,
  };
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  console.log('═'.repeat(100));
  console.log('  🔬 CONSERVATIVE MODE TEST: Rolling Mean 2h Adaptive Adjustment');
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

  // Fetch markets and volatility
  console.log('\n📡 Fetching markets and volatility...');

  const marketsFetcher = new PolymarketMarketsFetcher();
  const pricesFetcher = new PolymarketPricesFetcher(1);
  const volFetcher = new DeribitVolFetcher('BTC', 60);

  const markets = await marketsFetcher.fetch(startTs, endTs);
  console.log(`   Markets: ${markets.length}`);

  const volPoints = await volFetcher.fetch(startTs, endTs);
  console.log(`   Volatility points: ${volPoints.length}`);

  // Define mode configurations
  const modes: ModeConfig[] = [
    { name: 'Normal', useWorstCase: false, latencyMs: 0 },
    { name: 'Conservative', useWorstCase: true, latencyMs: 200 },
  ];

  console.log('\n' + '═'.repeat(100));
  console.log('  ⚙️ TEST CONFIGURATIONS');
  console.log('═'.repeat(100));

  console.log(`
   Adaptive Adjustment: Rolling Mean 2h
   Min Edge: 10%
   Order Size: 100 shares
   Spread: 1¢

   | Mode         | Worst-Case Pricing | Execution Latency |
   |--------------|--------------------|--------------------|
   | Normal       | OFF (close price)  | 0ms                |
   | Conservative | ON (low/high)      | 200ms              |
`);

  // Run tests
  console.log('═'.repeat(100));
  console.log('  🔄 RUNNING TESTS');
  console.log('═'.repeat(100));

  const results: TestResult[] = [];

  for (const mode of modes) {
    console.log(`\n   Running ${mode.name} mode...`);

    const result = await runBacktest(
      mode,
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
    console.log(`   ✅ ${mode.name}: ${pnlStr} | ${result.trades} trades | Win: ${(result.winRate * 100).toFixed(1)}%`);
  }

  // Print results
  const normalResult = results.find(r => r.mode === 'Normal')!;
  const conservativeResult = results.find(r => r.mode === 'Conservative')!;

  console.log('\n' + '═'.repeat(100));
  console.log('  📊 RESULTS COMPARISON');
  console.log('═'.repeat(100));

  console.log(`
   | Metric              | Normal Mode        | Conservative Mode  | Difference        |
   |---------------------|--------------------|--------------------|-------------------|`);

  const pnlDiff = conservativeResult.pnl - normalResult.pnl;
  const pnlDiffPct = (pnlDiff / normalResult.pnl * 100);
  console.log(`   | P&L                 | +$${normalResult.pnl.toFixed(0).padStart(14)} | +$${conservativeResult.pnl.toFixed(0).padStart(14)} | ${pnlDiff >= 0 ? '+' : ''}$${pnlDiff.toFixed(0).padStart(6)} (${pnlDiffPct >= 0 ? '+' : ''}${pnlDiffPct.toFixed(1)}%) |`);

  console.log(`   | Trades              | ${normalResult.trades.toString().padStart(18)} | ${conservativeResult.trades.toString().padStart(18)} | ${(conservativeResult.trades - normalResult.trades >= 0 ? '+' : '')}${(conservativeResult.trades - normalResult.trades).toString().padStart(6)}        |`);

  console.log(`   | Win Rate            | ${(normalResult.winRate * 100).toFixed(1).padStart(17)}% | ${(conservativeResult.winRate * 100).toFixed(1).padStart(17)}% | ${((conservativeResult.winRate - normalResult.winRate) * 100) >= 0 ? '+' : ''}${((conservativeResult.winRate - normalResult.winRate) * 100).toFixed(1).padStart(5)}pp       |`);

  console.log(`   | YES/NO Trades       | ${normalResult.yesTrades}/${normalResult.noTrades}`.padEnd(38) + ` | ${conservativeResult.yesTrades}/${conservativeResult.noTrades}`.padEnd(20) + ` |                   |`);

  console.log(`   | YES P&L             | +$${normalResult.yesPnl.toFixed(0).padStart(14)} | +$${conservativeResult.yesPnl.toFixed(0).padStart(14)} |                   |`);
  console.log(`   | NO P&L              | +$${normalResult.noPnl.toFixed(0).padStart(14)} | +$${conservativeResult.noPnl.toFixed(0).padStart(14)} |                   |`);

  console.log(`   | Sharpe Ratio        | ${normalResult.sharpe.toFixed(1).padStart(18)} | ${conservativeResult.sharpe.toFixed(1).padStart(18)} | ${(conservativeResult.sharpe - normalResult.sharpe >= 0 ? '+' : '')}${(conservativeResult.sharpe - normalResult.sharpe).toFixed(1).padStart(6)}        |`);

  console.log(`   | Edge Capture        | ${(normalResult.edgeCapture * 100).toFixed(0).padStart(17)}% | ${(conservativeResult.edgeCapture * 100).toFixed(0).padStart(17)}% | ${((conservativeResult.edgeCapture - normalResult.edgeCapture) * 100) >= 0 ? '+' : ''}${((conservativeResult.edgeCapture - normalResult.edgeCapture) * 100).toFixed(0).padStart(5)}pp       |`);

  console.log(`   | Losing Days         | ${normalResult.losingDays.toString().padStart(18)} | ${conservativeResult.losingDays.toString().padStart(18)} | ${(conservativeResult.losingDays - normalResult.losingDays >= 0 ? '+' : '')}${(conservativeResult.losingDays - normalResult.losingDays).toString().padStart(6)}        |`);

  console.log(`   | Max Drawdown        | -$${normalResult.maxDrawdown.toFixed(0).padStart(14)} | -$${conservativeResult.maxDrawdown.toFixed(0).padStart(14)} |                   |`);

  console.log(`   | Avg Daily P&L       | +$${normalResult.avgDailyPnl.toFixed(0).padStart(14)} | +$${conservativeResult.avgDailyPnl.toFixed(0).padStart(14)} |                   |`);

  console.log(`   |---------------------|--------------------|--------------------|-------------------|`);

  // Daily breakdown for conservative mode
  console.log('\n' + '═'.repeat(100));
  console.log('  📅 CONSERVATIVE MODE: DAILY P&L BREAKDOWN');
  console.log('═'.repeat(100));

  const sortedDays = Array.from(conservativeResult.dailyPnL.entries()).sort((a, b) => a[0].localeCompare(b[0]));

  console.log(`\n   | Date       | Normal P&L  | Cons. P&L   | Difference |`);
  console.log(`   |------------|-------------|-------------|------------|`);

  let totalNormalPnl = 0;
  let totalConsPnl = 0;

  for (const [date] of sortedDays) {
    const normalDayPnl = normalResult.dailyPnL.get(date) ?? 0;
    const consDayPnl = conservativeResult.dailyPnL.get(date) ?? 0;
    const diff = consDayPnl - normalDayPnl;

    totalNormalPnl += normalDayPnl;
    totalConsPnl += consDayPnl;

    const normalStr = normalDayPnl >= 0 ? `+$${normalDayPnl.toFixed(0).padStart(5)}` : `-$${Math.abs(normalDayPnl).toFixed(0).padStart(5)}`;
    const consStr = consDayPnl >= 0 ? `+$${consDayPnl.toFixed(0).padStart(5)}` : `-$${Math.abs(consDayPnl).toFixed(0).padStart(5)}`;
    const diffStr = diff >= 0 ? `+$${diff.toFixed(0).padStart(4)}` : `-$${Math.abs(diff).toFixed(0).padStart(4)}`;
    const marker = consDayPnl < 0 ? '❌' : '✅';

    console.log(`${marker} | ${date} | ${normalStr}     | ${consStr}     | ${diffStr}     |`);
  }

  console.log(`   |------------|-------------|-------------|------------|`);
  console.log(`   | TOTAL      | +$${totalNormalPnl.toFixed(0).padStart(5)}     | +$${totalConsPnl.toFixed(0).padStart(5)}     | ${(totalConsPnl - totalNormalPnl) >= 0 ? '+' : ''}$${(totalConsPnl - totalNormalPnl).toFixed(0).padStart(4)}     |`);

  // Summary
  console.log('\n' + '═'.repeat(100));
  console.log('  ✅ SUMMARY: REALISTIC LIVE TRADING PERFORMANCE');
  console.log('═'.repeat(100));

  const degradation = Math.abs(pnlDiffPct);
  const retainedPct = 100 - degradation;

  console.log(`
   📈 Conservative Mode Results (Realistic Live Trading):

      P&L:           +$${conservativeResult.pnl.toFixed(2)}
      Win Rate:      ${(conservativeResult.winRate * 100).toFixed(1)}%
      Losing Days:   ${conservativeResult.losingDays}
      Sharpe Ratio:  ${conservativeResult.sharpe.toFixed(1)}
      Edge Capture:  ${(conservativeResult.edgeCapture * 100).toFixed(0)}%
      Max Drawdown:  -$${conservativeResult.maxDrawdown.toFixed(2)}

   📊 Impact of Execution Friction:

      P&L Retained:  ${retainedPct.toFixed(1)}% of normal mode
      P&L Lost:      ${degradation.toFixed(1)}% to worst-case pricing + latency
      Trade Count:   ${(conservativeResult.trades / normalResult.trades * 100).toFixed(0)}% of normal (higher edge threshold)

   🎯 Key Insights:

      ${conservativeResult.losingDays === 0
        ? '✓ Zero losing days - strategy is robust even with execution friction'
        : `⚠️ ${conservativeResult.losingDays} losing day(s) - execution friction impacts some days`}
      ${conservativeResult.winRate >= 0.55
        ? '✓ Win rate above 55% - maintains strong edge'
        : '⚠️ Win rate degraded - consider tighter edge threshold'}
      ${conservativeResult.sharpe >= 50
        ? '✓ Sharpe ratio excellent - risk-adjusted returns remain strong'
        : '⚠️ Sharpe ratio reduced - more volatile returns'}
      ${retainedPct >= 80
        ? '✓ Retains 80%+ of P&L - execution model is efficient'
        : '⚠️ Significant P&L loss - may need to optimize execution'}
`);

  console.log('');
}

main().catch(console.error);
