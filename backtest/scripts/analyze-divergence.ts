/**
 * Binance vs Chainlink Divergence Analysis
 *
 * Analyzes the systematic differences between Binance and Chainlink price feeds
 * to determine if a stable adjustment can be applied for better fair value calculations.
 */

import * as fs from 'fs';
import * as path from 'path';
import { BinanceKline, CachedData } from './types';
import { ChainlinkPricePoint, getChainlinkPriceAt } from './fetchers/chainlink-historical';
import { getKlineAt } from './fetchers/binance-historical';

// =============================================================================
// CONFIGURATION
// =============================================================================

const DATA_DIR = path.join(__dirname, '../data');

// =============================================================================
// TYPES
// =============================================================================

interface DivergencePoint {
  timestamp: number;
  binancePrice: number;
  chainlinkPrice: number;
  divergence: number;           // Chainlink - Binance
  divergencePct: number;        // (Chainlink - Binance) / Binance * 100
  btcPriceLevel: number;        // For correlation analysis
  priceChange1h: number;        // 1h price momentum
  realizedVol1h: number;        // 1h realized vol
}

interface PeriodStats {
  label: string;
  count: number;
  meanDivergence: number;
  stdDev: number;
  min: number;
  max: number;
  median: number;
  p5: number;                   // 5th percentile
  p95: number;                  // 95th percentile
  meanDivergencePct: number;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function loadBinanceKlines(): BinanceKline[] {
  const files = fs.readdirSync(path.join(DATA_DIR, 'binance'))
    .filter(f => f.startsWith('BTCUSDT_1m_') && f.endsWith('.json'));

  // Find the most comprehensive file
  let bestFile = '';
  let maxCount = 0;

  for (const file of files) {
    const content = fs.readFileSync(path.join(DATA_DIR, 'binance', file), 'utf-8');
    const cached: CachedData<BinanceKline> = JSON.parse(content);
    if (cached.data.length > maxCount) {
      maxCount = cached.data.length;
      bestFile = file;
    }
  }

  console.log(`📦 Loading Binance data from ${bestFile} (${maxCount} klines)`);
  const content = fs.readFileSync(path.join(DATA_DIR, 'binance', bestFile), 'utf-8');
  const cached: CachedData<BinanceKline> = JSON.parse(content);
  return cached.data.sort((a, b) => a.timestamp - b.timestamp);
}

function loadChainlinkPrices(): ChainlinkPricePoint[] {
  const files = fs.readdirSync(path.join(DATA_DIR, 'chainlink'))
    .filter(f => f.startsWith('chainlink_BTC_') && f.endsWith('.json'));

  // Find the most comprehensive file
  let bestFile = '';
  let maxCount = 0;

  for (const file of files) {
    const content = fs.readFileSync(path.join(DATA_DIR, 'chainlink', file), 'utf-8');
    const cached: CachedData<ChainlinkPricePoint> = JSON.parse(content);
    if (cached.data.length > maxCount) {
      maxCount = cached.data.length;
      bestFile = file;
    }
  }

  console.log(`📦 Loading Chainlink data from ${bestFile} (${maxCount} price points)`);
  const content = fs.readFileSync(path.join(DATA_DIR, 'chainlink', bestFile), 'utf-8');
  const cached: CachedData<ChainlinkPricePoint> = JSON.parse(content);
  return cached.data.sort((a, b) => a.timestamp - b.timestamp);
}

function calculateRealizedVol(klines: BinanceKline[], endIdx: number, periodMinutes: number): number {
  const periods = periodMinutes;
  if (endIdx < periods) return 0;

  const returns: number[] = [];
  for (let i = endIdx - periods + 1; i <= endIdx; i++) {
    const ret = Math.log(klines[i].close / klines[i - 1].close);
    returns.push(ret);
  }

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length;
  const stdDev = Math.sqrt(variance);

  // Annualize: multiply by sqrt(minutes per year / period)
  // Minutes per year = 365.25 * 24 * 60 = 525,960
  const annualized = stdDev * Math.sqrt(525960);
  return annualized;
}

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (idx - lower) * (sorted[upper] - sorted[lower]);
}

function computeStats(points: DivergencePoint[], label: string): PeriodStats {
  const divergences = points.map(p => p.divergence);
  const divergencesPct = points.map(p => p.divergencePct);

  const mean = divergences.reduce((a, b) => a + b, 0) / divergences.length;
  const meanPct = divergencesPct.reduce((a, b) => a + b, 0) / divergencesPct.length;
  const variance = divergences.reduce((sum, d) => sum + (d - mean) ** 2, 0) / divergences.length;

  return {
    label,
    count: points.length,
    meanDivergence: mean,
    stdDev: Math.sqrt(variance),
    min: Math.min(...divergences),
    max: Math.max(...divergences),
    median: percentile(divergences, 50),
    p5: percentile(divergences, 5),
    p95: percentile(divergences, 95),
    meanDivergencePct: meanPct,
  };
}

function correlation(x: number[], y: number[]): number {
  const n = x.length;
  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;

  let num = 0;
  let denX = 0;
  let denY = 0;

  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }

  return num / Math.sqrt(denX * denY);
}

// =============================================================================
// MAIN ANALYSIS
// =============================================================================

async function main() {
  console.log('='.repeat(80));
  console.log('BINANCE VS CHAINLINK DIVERGENCE ANALYSIS');
  console.log('='.repeat(80));
  console.log();

  // Load data
  const binanceKlines = loadBinanceKlines();
  const chainlinkPrices = loadChainlinkPrices();

  console.log(`\nBinance time range: ${new Date(binanceKlines[0].timestamp).toISOString()} to ${new Date(binanceKlines[binanceKlines.length - 1].timestamp).toISOString()}`);
  console.log(`Chainlink time range: ${new Date(chainlinkPrices[0].timestamp).toISOString()} to ${new Date(chainlinkPrices[chainlinkPrices.length - 1].timestamp).toISOString()}`);

  // Find overlapping time range
  const startTime = Math.max(binanceKlines[0].timestamp, chainlinkPrices[0].timestamp);
  const endTime = Math.min(
    binanceKlines[binanceKlines.length - 1].timestamp,
    chainlinkPrices[chainlinkPrices.length - 1].timestamp
  );

  console.log(`\nOverlapping range: ${new Date(startTime).toISOString()} to ${new Date(endTime).toISOString()}`);

  // Sample at 1-minute intervals aligned with Binance klines
  const divergencePoints: DivergencePoint[] = [];

  // Create a map for faster Chainlink lookups
  const klineMap = new Map<number, BinanceKline>();
  for (const k of binanceKlines) {
    klineMap.set(k.timestamp, k);
  }

  let skippedNoChainlink = 0;
  let skippedNoBinance = 0;

  for (let i = 60; i < binanceKlines.length; i++) {  // Start at 60 for 1h lookback
    const kline = binanceKlines[i];

    if (kline.timestamp < startTime || kline.timestamp > endTime) continue;

    // Get Chainlink price at this timestamp
    const clPoint = getChainlinkPriceAt(chainlinkPrices, kline.timestamp);
    if (!clPoint) {
      skippedNoChainlink++;
      continue;
    }

    // Only use Chainlink prices within 60s of the timestamp
    const clAge = kline.timestamp - clPoint.timestamp;
    if (clAge > 60000) {
      skippedNoBinance++;
      continue;
    }

    const binancePrice = kline.close;
    const chainlinkPrice = clPoint.price;
    const divergence = chainlinkPrice - binancePrice;
    const divergencePct = (divergence / binancePrice) * 100;

    // Calculate 1h momentum
    const kline1hAgo = binanceKlines[i - 60];
    const priceChange1h = kline1hAgo ? (binancePrice - kline1hAgo.close) / kline1hAgo.close : 0;

    // Calculate 1h realized vol
    const realizedVol1h = calculateRealizedVol(binanceKlines, i, 60);

    divergencePoints.push({
      timestamp: kline.timestamp,
      binancePrice,
      chainlinkPrice,
      divergence,
      divergencePct,
      btcPriceLevel: binancePrice,
      priceChange1h,
      realizedVol1h,
    });
  }

  console.log(`\nCollected ${divergencePoints.length} divergence points`);
  console.log(`Skipped: ${skippedNoChainlink} (no Chainlink), ${skippedNoBinance} (Chainlink too stale)`);

  // ==========================================================================
  // OVERALL STATISTICS
  // ==========================================================================

  console.log('\n' + '='.repeat(80));
  console.log('1. OVERALL DIVERGENCE STATISTICS');
  console.log('='.repeat(80));

  const overallStats = computeStats(divergencePoints, 'Full Period');

  console.log(`\nMean divergence:     $${overallStats.meanDivergence.toFixed(2)} (${overallStats.meanDivergencePct.toFixed(4)}%)`);
  console.log(`Std deviation:       $${overallStats.stdDev.toFixed(2)}`);
  console.log(`Median:              $${overallStats.median.toFixed(2)}`);
  console.log(`Min:                 $${overallStats.min.toFixed(2)}`);
  console.log(`Max:                 $${overallStats.max.toFixed(2)}`);
  console.log(`5th percentile:      $${overallStats.p5.toFixed(2)}`);
  console.log(`95th percentile:     $${overallStats.p95.toFixed(2)}`);

  // ==========================================================================
  // TIME PERIOD ANALYSIS
  // ==========================================================================

  console.log('\n' + '='.repeat(80));
  console.log('2. STABILITY ACROSS TIME PERIODS');
  console.log('='.repeat(80));

  // Split into periods (roughly 3 periods)
  const totalDays = (endTime - startTime) / (24 * 60 * 60 * 1000);
  const periodDays = Math.ceil(totalDays / 3);

  const periods: DivergencePoint[][] = [[], [], []];
  for (const point of divergencePoints) {
    const daysSinceStart = (point.timestamp - startTime) / (24 * 60 * 60 * 1000);
    const periodIdx = Math.min(2, Math.floor(daysSinceStart / periodDays));
    periods[periodIdx].push(point);
  }

  const periodLabels = [
    `Days 1-${periodDays}`,
    `Days ${periodDays + 1}-${2 * periodDays}`,
    `Days ${2 * periodDays + 1}-${Math.ceil(totalDays)}`,
  ];

  const periodStats = periods.map((p, i) => computeStats(p, periodLabels[i]));

  // Print comparison table
  console.log('\n| Metric              | Full Period   | ' + periodLabels.join(' | ') + ' |');
  console.log('|---------------------|---------------|' + periodLabels.map(() => '---------------|').join(''));

  const formatStat = (val: number) => (val >= 0 ? '+' : '') + val.toFixed(2);

  console.log(`| Mean divergence ($) | ${formatStat(overallStats.meanDivergence).padStart(13)} | ${periodStats.map(s => formatStat(s.meanDivergence).padStart(13)).join(' | ')} |`);
  console.log(`| Std deviation ($)   | ${overallStats.stdDev.toFixed(2).padStart(13)} | ${periodStats.map(s => s.stdDev.toFixed(2).padStart(13)).join(' | ')} |`);
  console.log(`| Min ($)             | ${formatStat(overallStats.min).padStart(13)} | ${periodStats.map(s => formatStat(s.min).padStart(13)).join(' | ')} |`);
  console.log(`| Max ($)             | ${formatStat(overallStats.max).padStart(13)} | ${periodStats.map(s => formatStat(s.max).padStart(13)).join(' | ')} |`);
  console.log(`| Count               | ${overallStats.count.toString().padStart(13)} | ${periodStats.map(s => s.count.toString().padStart(13)).join(' | ')} |`);

  // Check stability
  const meanRange = Math.max(...periodStats.map(s => s.meanDivergence)) - Math.min(...periodStats.map(s => s.meanDivergence));
  const stdDevRange = Math.max(...periodStats.map(s => s.stdDev)) - Math.min(...periodStats.map(s => s.stdDev));

  console.log(`\nStability check:`);
  console.log(`  Mean divergence range across periods: $${meanRange.toFixed(2)}`);
  console.log(`  Std deviation range across periods:   $${stdDevRange.toFixed(2)}`);

  // ==========================================================================
  // CORRELATION ANALYSIS
  // ==========================================================================

  console.log('\n' + '='.repeat(80));
  console.log('3. CORRELATION ANALYSIS');
  console.log('='.repeat(80));

  const divergences = divergencePoints.map(p => p.divergence);
  const priceLevels = divergencePoints.map(p => p.btcPriceLevel);
  const momenta = divergencePoints.map(p => p.priceChange1h);
  const vols = divergencePoints.map(p => p.realizedVol1h);

  const corrWithPrice = correlation(divergences, priceLevels);
  const corrWithMomentum = correlation(divergences, momenta);
  const corrWithVol = correlation(divergences, vols);

  console.log(`\nCorrelation of divergence with:`);
  console.log(`  BTC price level:    ${corrWithPrice.toFixed(4)}`);
  console.log(`  1h price momentum:  ${corrWithMomentum.toFixed(4)}`);
  console.log(`  1h realized vol:    ${corrWithVol.toFixed(4)}`);

  // ==========================================================================
  // DIVERGENCE DISTRIBUTION
  // ==========================================================================

  console.log('\n' + '='.repeat(80));
  console.log('4. DIVERGENCE DISTRIBUTION');
  console.log('='.repeat(80));

  // Create histogram buckets
  const bucketSize = 20;  // $20 buckets
  const buckets = new Map<number, number>();

  for (const point of divergencePoints) {
    const bucket = Math.round(point.divergence / bucketSize) * bucketSize;
    buckets.set(bucket, (buckets.get(bucket) || 0) + 1);
  }

  // Sort and display
  const sortedBuckets = Array.from(buckets.entries()).sort((a, b) => a[0] - b[0]);
  const maxCount = Math.max(...sortedBuckets.map(([, count]) => count));

  console.log('\nHistogram ($20 buckets):');
  for (const [bucket, count] of sortedBuckets) {
    const barLength = Math.round((count / maxCount) * 40);
    const bar = '█'.repeat(barLength);
    const pct = ((count / divergencePoints.length) * 100).toFixed(1);
    console.log(`  ${(bucket >= 0 ? '+' : '') + bucket.toString().padStart(5)}: ${bar.padEnd(40)} ${count.toString().padStart(5)} (${pct.padStart(5)}%)`);
  }

  // ==========================================================================
  // DIRECTIONAL ANALYSIS
  // ==========================================================================

  console.log('\n' + '='.repeat(80));
  console.log('5. DIRECTIONAL ANALYSIS');
  console.log('='.repeat(80));

  const chainlinkHigher = divergencePoints.filter(p => p.divergence > 0);
  const chainlinkLower = divergencePoints.filter(p => p.divergence < 0);
  const equal = divergencePoints.filter(p => Math.abs(p.divergence) < 0.01);

  console.log(`\nChainlink > Binance: ${chainlinkHigher.length} (${(chainlinkHigher.length / divergencePoints.length * 100).toFixed(1)}%)`);
  console.log(`Chainlink < Binance: ${chainlinkLower.length} (${(chainlinkLower.length / divergencePoints.length * 100).toFixed(1)}%)`);
  console.log(`Approximately equal: ${equal.length} (${(equal.length / divergencePoints.length * 100).toFixed(1)}%)`);

  if (chainlinkHigher.length > 0) {
    const avgWhenHigher = chainlinkHigher.reduce((sum, p) => sum + p.divergence, 0) / chainlinkHigher.length;
    console.log(`\nWhen Chainlink > Binance, avg divergence: +$${avgWhenHigher.toFixed(2)}`);
  }

  if (chainlinkLower.length > 0) {
    const avgWhenLower = chainlinkLower.reduce((sum, p) => sum + p.divergence, 0) / chainlinkLower.length;
    console.log(`When Chainlink < Binance, avg divergence: $${avgWhenLower.toFixed(2)}`);
  }

  // ==========================================================================
  // MOMENTUM-BASED ANALYSIS
  // ==========================================================================

  console.log('\n' + '='.repeat(80));
  console.log('6. MOMENTUM-BASED ANALYSIS (Chainlink lag hypothesis)');
  console.log('='.repeat(80));

  const risingMarket = divergencePoints.filter(p => p.priceChange1h > 0.002);  // >0.2% 1h gain
  const fallingMarket = divergencePoints.filter(p => p.priceChange1h < -0.002); // >0.2% 1h loss
  const flatMarket = divergencePoints.filter(p => Math.abs(p.priceChange1h) <= 0.002);

  console.log(`\nRising market (>0.2%/1h): ${risingMarket.length} points`);
  if (risingMarket.length > 0) {
    const stats = computeStats(risingMarket, 'Rising');
    console.log(`  Mean divergence: $${stats.meanDivergence.toFixed(2)} (expect negative if Chainlink lags)`);
  }

  console.log(`\nFlat market (±0.2%/1h): ${flatMarket.length} points`);
  if (flatMarket.length > 0) {
    const stats = computeStats(flatMarket, 'Flat');
    console.log(`  Mean divergence: $${stats.meanDivergence.toFixed(2)}`);
  }

  console.log(`\nFalling market (<-0.2%/1h): ${fallingMarket.length} points`);
  if (fallingMarket.length > 0) {
    const stats = computeStats(fallingMarket, 'Falling');
    console.log(`  Mean divergence: $${stats.meanDivergence.toFixed(2)} (expect positive if Chainlink lags)`);
  }

  // ==========================================================================
  // RECOMMENDATIONS
  // ==========================================================================

  console.log('\n' + '='.repeat(80));
  console.log('7. RECOMMENDATIONS');
  console.log('='.repeat(80));

  const isStable = meanRange < 30 && stdDevRange < 30;
  const hasSignificantBias = Math.abs(overallStats.meanDivergence) > 10;

  if (isStable && hasSignificantBias) {
    console.log(`\n✅ Divergence appears STABLE across periods (range: $${meanRange.toFixed(2)})`);
    console.log(`✅ Systematic bias detected: Chainlink is ${overallStats.meanDivergence > 0 ? 'higher' : 'lower'} by ~$${Math.abs(overallStats.meanDivergence).toFixed(2)}`);
    console.log(`\n📊 RECOMMENDATION: Apply adjustment to Binance prices for fair value calculation:`);
    console.log(`   adjusted_binance_price = binance_price ${overallStats.meanDivergence > 0 ? '+' : ''} ${overallStats.meanDivergence.toFixed(2)}`);
  } else if (!isStable) {
    console.log(`\n⚠️ Divergence is NOT stable across periods (range: $${meanRange.toFixed(2)})`);
    console.log(`   Consider using Chainlink directly or a more sophisticated model.`);
  } else {
    console.log(`\n✅ No significant systematic bias detected (mean: $${overallStats.meanDivergence.toFixed(2)})`);
    console.log(`   Binance prices can be used directly for fair value calculation.`);
  }

  // Check if momentum-based adjustment would help
  if (Math.abs(corrWithMomentum) > 0.3) {
    console.log(`\n💡 Strong correlation with momentum (r=${corrWithMomentum.toFixed(3)}) suggests Chainlink lag.`);
    console.log(`   Consider momentum-adjusted correction for live trading.`);
  }

  console.log('\n' + '='.repeat(80));
  console.log('ANALYSIS COMPLETE');
  console.log('='.repeat(80));
}

main().catch(console.error);
