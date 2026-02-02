/**
 * Time-Series Divergence Analysis with Rolling Windows
 * Shows how divergence evolves over time
 */

import * as fs from 'fs';
import * as path from 'path';
import { BinanceKline, CachedData } from './types';
import { ChainlinkPricePoint, getChainlinkPriceAt } from './fetchers/chainlink-historical';

const DATA_DIR = path.join(__dirname, '../data');

interface TimeSlice {
  timestamp: number;
  divergence: number;
  rolling1hMean: number;
  rolling4hMean: number;
  btcPrice: number;
}

function loadData() {
  // Load Binance
  const binanceFiles = fs.readdirSync(path.join(DATA_DIR, 'binance'))
    .filter(f => f.startsWith('BTCUSDT_1m_') && f.endsWith('.json'));
  let binanceKlines: BinanceKline[] = [];
  let maxCount = 0;
  for (const file of binanceFiles) {
    const content = fs.readFileSync(path.join(DATA_DIR, 'binance', file), 'utf-8');
    const cached: CachedData<BinanceKline> = JSON.parse(content);
    if (cached.data.length > maxCount) {
      maxCount = cached.data.length;
      binanceKlines = cached.data;
    }
  }

  // Load Chainlink
  const clFiles = fs.readdirSync(path.join(DATA_DIR, 'chainlink'))
    .filter(f => f.startsWith('chainlink_BTC_') && f.endsWith('.json'));
  let chainlinkPrices: ChainlinkPricePoint[] = [];
  maxCount = 0;
  for (const file of clFiles) {
    const content = fs.readFileSync(path.join(DATA_DIR, 'chainlink', file), 'utf-8');
    const cached: CachedData<ChainlinkPricePoint> = JSON.parse(content);
    if (cached.data.length > maxCount) {
      maxCount = cached.data.length;
      chainlinkPrices = cached.data;
    }
  }

  return { binanceKlines, chainlinkPrices };
}

function rollingMean(arr: number[], windowSize: number): number {
  if (arr.length < windowSize) return arr.reduce((a, b) => a + b, 0) / arr.length;
  const window = arr.slice(-windowSize);
  return window.reduce((a, b) => a + b, 0) / windowSize;
}

async function main() {
  console.log('='.repeat(80));
  console.log('TIME-SERIES DIVERGENCE ANALYSIS');
  console.log('='.repeat(80));

  const { binanceKlines, chainlinkPrices } = loadData();

  // Collect divergences
  const divergences: number[] = [];
  const timestamps: number[] = [];
  const btcPrices: number[] = [];

  for (const kline of binanceKlines) {
    const clPoint = getChainlinkPriceAt(chainlinkPrices, kline.timestamp);
    if (!clPoint || kline.timestamp - clPoint.timestamp > 60000) continue;

    const div = clPoint.price - kline.close;
    divergences.push(div);
    timestamps.push(kline.timestamp);
    btcPrices.push(kline.close);
  }

  // Sample every hour for display
  const hourlySlices: TimeSlice[] = [];
  for (let i = 240; i < divergences.length; i += 60) {  // Every hour, after 4h warmup
    hourlySlices.push({
      timestamp: timestamps[i],
      divergence: divergences[i],
      rolling1hMean: rollingMean(divergences.slice(0, i + 1), 60),
      rolling4hMean: rollingMean(divergences.slice(0, i + 1), 240),
      btcPrice: btcPrices[i],
    });
  }

  // Print time series
  console.log('\nHourly Divergence Time Series (rolling means):');
  console.log('-'.repeat(100));
  console.log('| Date/Time              | BTC Price  | Spot Div    | 1h Mean     | 4h Mean     | Visual |');
  console.log('-'.repeat(100));

  for (const slice of hourlySlices) {
    const date = new Date(slice.timestamp).toISOString().replace('T', ' ').slice(0, 19);
    const btc = slice.btcPrice.toFixed(0).padStart(9);
    const div = (slice.divergence >= 0 ? '+' : '') + slice.divergence.toFixed(0).padStart(4);
    const m1h = (slice.rolling1hMean >= 0 ? '+' : '') + slice.rolling1hMean.toFixed(0).padStart(4);
    const m4h = (slice.rolling4hMean >= 0 ? '+' : '') + slice.rolling4hMean.toFixed(0).padStart(4);

    // Visual bar showing divergence
    const barValue = Math.max(-200, Math.min(0, slice.rolling4hMean));
    const barLen = Math.abs(Math.round(barValue / 10));
    const bar = '█'.repeat(barLen);

    console.log(`| ${date} | $${btc} | $${div.padStart(7)} | $${m1h.padStart(7)} | $${m4h.padStart(7)} | ${bar.padEnd(20)} |`);
  }
  console.log('-'.repeat(100));

  // Check for regime changes
  console.log('\n' + '='.repeat(80));
  console.log('REGIME ANALYSIS (detecting shifts in divergence pattern)');
  console.log('='.repeat(80));

  // Split into 6-hour windows and check mean
  const windowSize = 360;  // 6 hours in minutes
  const windows: { start: string; end: string; mean: number; std: number }[] = [];

  for (let i = 0; i < divergences.length - windowSize; i += windowSize) {
    const window = divergences.slice(i, i + windowSize);
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    const variance = window.reduce((sum, d) => sum + (d - mean) ** 2, 0) / window.length;
    const std = Math.sqrt(variance);

    windows.push({
      start: new Date(timestamps[i]).toISOString().slice(0, 16),
      end: new Date(timestamps[i + windowSize - 1]).toISOString().slice(0, 16),
      mean,
      std,
    });
  }

  console.log('\n6-Hour Window Analysis:');
  console.log('| Period                              | Mean Div    | Std Dev    |');
  console.log('|-------------------------------------|-------------|------------|');
  for (const w of windows) {
    const mean = (w.mean >= 0 ? '+' : '') + w.mean.toFixed(1);
    console.log(`| ${w.start} to ${w.end.slice(11)} | $${mean.padStart(9)} | $${w.std.toFixed(1).padStart(8)} |`);
  }

  // Detect outlier windows (where mean is significantly different)
  const overallMean = divergences.reduce((a, b) => a + b, 0) / divergences.length;
  const outlierThreshold = 50;  // $50 from overall mean
  const outliers = windows.filter(w => Math.abs(w.mean - overallMean) > outlierThreshold);

  if (outliers.length > 0) {
    console.log(`\n⚠️ Found ${outliers.length} outlier periods (>${outlierThreshold}$ from overall mean $${overallMean.toFixed(0)}):`);
    for (const o of outliers) {
      console.log(`   ${o.start}: mean $${o.mean.toFixed(0)} (${(o.mean - overallMean).toFixed(0)} from avg)`);
    }
  } else {
    console.log(`\n✅ No significant regime changes detected (all within $${outlierThreshold} of mean)`);
  }

  // Summary recommendation
  console.log('\n' + '='.repeat(80));
  console.log('FINAL SUMMARY');
  console.log('='.repeat(80));

  const overallStd = Math.sqrt(divergences.reduce((sum, d) => sum + (d - overallMean) ** 2, 0) / divergences.length);

  console.log(`\nOverall divergence: Chainlink is $${Math.abs(overallMean).toFixed(0)} LOWER than Binance`);
  console.log(`Standard deviation: $${overallStd.toFixed(0)}`);
  console.log(`\nFor fair value calculation adjustment:`);
  console.log(`   adjusted_binance_price = binance_price - ${Math.abs(overallMean).toFixed(0)}`);
  console.log(`\nOr equivalently, expect Chainlink settlement to be ~$${Math.abs(overallMean).toFixed(0)} lower than Binance spot.`);
  console.log(`This should be factored into edge calculations when comparing fair value to market price.`);

  // Impact analysis
  console.log('\n' + '='.repeat(80));
  console.log('IMPACT ON FAIR VALUE');
  console.log('='.repeat(80));

  console.log(`\nWith BTC at ~$100,000 and 15-min market:
   - $100 divergence = 0.1% of BTC price
   - For strike at current price, this shifts d₂ by ~0.1 / (σ√T)
   - With σ=60% annual and T=15min (0.000029y), σ√T ≈ 0.010
   - d₂ shift ≈ 0.001 / 0.010 = 0.1
   - N(d₂) shift ≈ 0.04 (4% probability shift!)

This is MATERIAL for fair value calculation.

Recommendation: Either:
1. Use Chainlink directly for fair value (already done in useChainlinkForFairValue mode)
2. Apply -$104 adjustment to Binance price when calculating fair value
3. Model divergence as additional uncertainty in fair value`);
}

main().catch(console.error);
