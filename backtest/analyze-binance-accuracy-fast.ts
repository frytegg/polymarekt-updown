#!/usr/bin/env npx ts-node
/**
 * Binance vs Polymarket Settlement Accuracy Analysis
 *
 * Compares Binance price predictions at market end time against actual Polymarket settlements.
 * Uses trade data to calculate market end times, then compares Binance vs Chainlink predictions.
 */

import * as fs from 'fs';
import * as path from 'path';
import { BinanceKline, CachedData, MarketResolution, Trade } from './types';

interface MarketData {
  marketId: string;
  endTime: number;
  strikePrice: number;
}

interface MarketAnalysis {
  marketId: string;
  strikePrice: number;
  chainlinkPrice: number;
  binancePrice: number;
  binancePrediction: 'UP' | 'DOWN';
  actualOutcome: 'UP' | 'DOWN';
  binanceMargin: number;
  binanceCorrect: boolean;
  divergence: number;
}

interface MarginBucket {
  label: string;
  minMargin: number;
  maxMargin: number;
  prediction: 'UP' | 'DOWN';
  count: number;
  correct: number;
}

// Load all backtest data (trades and resolutions)
function loadBacktestData(): { markets: Map<string, MarketData>, resolutions: Map<string, MarketResolution> } {
  const dataDir = path.join(__dirname, '../data/output');
  if (!fs.existsSync(dataDir)) {
    console.log(`   Directory not found: ${dataDir}`);
    return { markets: new Map(), resolutions: new Map() };
  }

  const markets = new Map<string, MarketData>();
  const resolutions = new Map<string, MarketResolution>();

  // Load trades to get market end times
  const tradeFiles = fs.readdirSync(dataDir).filter(f => f.includes('_trades.json'));
  for (const file of tradeFiles) {
    try {
      const content = fs.readFileSync(path.join(dataDir, file), 'utf-8');
      const trades: Trade[] = JSON.parse(content);
      for (const t of trades) {
        // Calculate market end time from trade timestamp + time remaining
        const endTime = t.timestamp + t.timeRemainingMs;
        const existing = markets.get(t.marketId);
        if (!existing || Math.abs(existing.endTime - endTime) < 60000) {
          markets.set(t.marketId, {
            marketId: t.marketId,
            endTime,
            strikePrice: t.strike,
          });
        }
      }
      console.log(`   Loaded ${trades.length} trades from ${file}`);
    } catch (e: any) {
      console.log(`   Error loading ${file}: ${e.message}`);
    }
  }

  // Load resolutions for actual outcomes
  const resFiles = fs.readdirSync(dataDir).filter(f => f.includes('_resolutions.json'));
  for (const file of resFiles) {
    try {
      const content = fs.readFileSync(path.join(dataDir, file), 'utf-8');
      const resolutionList: MarketResolution[] = JSON.parse(content);
      for (const r of resolutionList) {
        if (r.outcome && r.strikePrice > 0) {
          resolutions.set(r.marketId, r);
        }
      }
      console.log(`   Loaded ${resolutionList.length} resolutions from ${file}`);
    } catch {}
  }

  return { markets, resolutions };
}

// Load all cached Binance klines
function loadBinanceKlines(): BinanceKline[] {
  const dataDir = path.join(__dirname, '../data/binance');
  if (!fs.existsSync(dataDir)) {
    console.log(`   Directory not found: ${dataDir}`);
    return [];
  }

  const files = fs.readdirSync(dataDir).filter(f => f.startsWith('BTCUSDT_1m_') && f.endsWith('.json'));
  const allKlines: Map<number, BinanceKline> = new Map();

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(dataDir, file), 'utf-8');
      const cached: CachedData<BinanceKline> = JSON.parse(content);
      for (const k of cached.data) {
        allKlines.set(k.timestamp, k);
      }
    } catch {}
  }

  return Array.from(allKlines.values()).sort((a, b) => a.timestamp - b.timestamp);
}

// Get Binance price at or just before timestamp (binary search)
function getBinancePriceAt(klines: BinanceKline[], timestamp: number): number | null {
  if (klines.length === 0) return null;

  let left = 0;
  let right = klines.length - 1;

  while (left < right) {
    const mid = Math.floor((left + right + 1) / 2);
    if (klines[mid].timestamp <= timestamp) {
      left = mid;
    } else {
      right = mid - 1;
    }
  }

  // Check if within 2 minutes
  if (Math.abs(klines[left].timestamp - timestamp) > 120000) {
    return null;
  }

  return klines[left].close;
}

function main(): void {
  console.log('\n' + '═'.repeat(70));
  console.log('  📊 BINANCE vs POLYMARKET SETTLEMENT ACCURACY ANALYSIS');
  console.log('═'.repeat(70));

  console.log('\n📡 Loading data...\n');

  const { markets, resolutions } = loadBacktestData();
  console.log(`   Unique markets with trades: ${markets.size}`);
  console.log(`   Unique resolutions: ${resolutions.size}`);

  const klines = loadBinanceKlines();
  console.log(`   Binance klines: ${klines.length}`);

  if (markets.size === 0 || klines.length === 0) {
    console.log('\n❌ No data found. Run a backtest first with --export flag.\n');
    return;
  }

  const minKlineTs = klines[0].timestamp;
  const maxKlineTs = klines[klines.length - 1].timestamp;
  console.log(`   Binance range: ${new Date(minKlineTs).toLocaleDateString()} to ${new Date(maxKlineTs).toLocaleDateString()}\n`);

  // Analyze each market
  const analyses: MarketAnalysis[] = [];
  let skipped = 0;

  for (const [marketId, market] of markets) {
    const resolution = resolutions.get(marketId);
    if (!resolution) {
      skipped++;
      continue;
    }

    // Get Binance price at market end time
    const binancePrice = getBinancePriceAt(klines, market.endTime);
    if (!binancePrice) {
      skipped++;
      continue;
    }

    const binancePrediction: 'UP' | 'DOWN' = binancePrice >= market.strikePrice ? 'UP' : 'DOWN';
    const actualOutcome = resolution.outcome;

    analyses.push({
      marketId,
      strikePrice: market.strikePrice,
      chainlinkPrice: resolution.finalBtcPrice,
      binancePrice,
      binancePrediction,
      actualOutcome,
      binanceMargin: binancePrice - market.strikePrice,
      binanceCorrect: binancePrediction === actualOutcome,
      divergence: binancePrice - resolution.finalBtcPrice,
    });
  }

  console.log(`✅ Analyzed ${analyses.length} markets (skipped ${skipped})\n`);

  if (analyses.length === 0) {
    console.log('❌ No matching data found.\n');
    return;
  }

  const total = analyses.length;

  // =========================================================================
  // OVERALL ACCURACY
  // =========================================================================

  console.log('═'.repeat(70));
  console.log('  📈 OVERALL BINANCE PREDICTION ACCURACY');
  console.log('═'.repeat(70));

  const correct = analyses.filter(a => a.binanceCorrect).length;
  const accuracy = correct / total;

  console.log(`\n   Total Markets:     ${total}`);
  console.log(`   Binance Correct:   ${correct} (${(accuracy * 100).toFixed(1)}%)`);
  console.log(`   Binance Wrong:     ${total - correct} (${((1 - accuracy) * 100).toFixed(1)}%)\n`);

  // =========================================================================
  // BY PREDICTION DIRECTION
  // =========================================================================

  console.log('═'.repeat(70));
  console.log('  📊 ACCURACY BY PREDICTION DIRECTION');
  console.log('═'.repeat(70));

  const binanceUp = analyses.filter(a => a.binancePrediction === 'UP');
  const binanceDown = analyses.filter(a => a.binancePrediction === 'DOWN');

  const upCorrect = binanceUp.filter(a => a.binanceCorrect).length;
  const downCorrect = binanceDown.filter(a => a.binanceCorrect).length;

  console.log('\n  Prediction       │ Count  │ Correct │ Accuracy');
  console.log('  ─────────────────┼────────┼─────────┼──────────');
  console.log(`  Binance says UP  │ ${binanceUp.length.toString().padStart(6)} │ ${upCorrect.toString().padStart(7)} │ ${binanceUp.length > 0 ? ((upCorrect / binanceUp.length) * 100).toFixed(1) : 'N/A'}%`);
  console.log(`  Binance says DOWN│ ${binanceDown.length.toString().padStart(6)} │ ${downCorrect.toString().padStart(7)} │ ${binanceDown.length > 0 ? ((downCorrect / binanceDown.length) * 100).toFixed(1) : 'N/A'}%`);
  console.log('  ─────────────────┴────────┴─────────┴──────────\n');

  // =========================================================================
  // BY MARGIN FROM STRIKE
  // =========================================================================

  console.log('═'.repeat(70));
  console.log('  📊 ACCURACY BY MARGIN FROM STRIKE');
  console.log('═'.repeat(70));
  console.log('  (How far Binance price was from strike at settlement time)\n');

  const buckets: MarginBucket[] = [
    { label: '$0-50 above', minMargin: 0, maxMargin: 50, prediction: 'UP', count: 0, correct: 0 },
    { label: '$50-100 above', minMargin: 50, maxMargin: 100, prediction: 'UP', count: 0, correct: 0 },
    { label: '$100-200 above', minMargin: 100, maxMargin: 200, prediction: 'UP', count: 0, correct: 0 },
    { label: '$200-500 above', minMargin: 200, maxMargin: 500, prediction: 'UP', count: 0, correct: 0 },
    { label: '$500+ above', minMargin: 500, maxMargin: Infinity, prediction: 'UP', count: 0, correct: 0 },
    { label: '$0-50 below', minMargin: 0, maxMargin: 50, prediction: 'DOWN', count: 0, correct: 0 },
    { label: '$50-100 below', minMargin: 50, maxMargin: 100, prediction: 'DOWN', count: 0, correct: 0 },
    { label: '$100-200 below', minMargin: 100, maxMargin: 200, prediction: 'DOWN', count: 0, correct: 0 },
    { label: '$200-500 below', minMargin: 200, maxMargin: 500, prediction: 'DOWN', count: 0, correct: 0 },
    { label: '$500+ below', minMargin: 500, maxMargin: Infinity, prediction: 'DOWN', count: 0, correct: 0 },
  ];

  for (const analysis of analyses) {
    const absMargin = Math.abs(analysis.binanceMargin);
    const direction: 'UP' | 'DOWN' = analysis.binanceMargin >= 0 ? 'UP' : 'DOWN';

    for (const bucket of buckets) {
      if (bucket.prediction === direction && absMargin >= bucket.minMargin && absMargin < bucket.maxMargin) {
        bucket.count++;
        if (analysis.binanceCorrect) bucket.correct++;
        break;
      }
    }
  }

  console.log('  Margin from Strike │ Binance Prediction │ Count │ Correct │ Accuracy');
  console.log('  ───────────────────┼────────────────────┼───────┼─────────┼──────────');

  for (const bucket of buckets) {
    const acc = bucket.count > 0 ? (bucket.correct / bucket.count * 100).toFixed(1) : 'N/A';
    const accStr = bucket.count > 0 ? `${acc}%` : 'N/A';
    console.log(
      `  ${bucket.label.padEnd(19)} │ ${bucket.prediction.padEnd(18)} │ ${bucket.count.toString().padStart(5)} │ ${bucket.correct.toString().padStart(7)} │ ${accStr.padStart(8)}`
    );
  }

  console.log('  ───────────────────┴────────────────────┴───────┴─────────┴──────────\n');

  // =========================================================================
  // DIVERGENCE ANALYSIS
  // =========================================================================

  console.log('═'.repeat(70));
  console.log('  📊 BINANCE vs CHAINLINK DIVERGENCE');
  console.log('═'.repeat(70));

  const divergences = analyses.map(a => a.divergence);
  const avgDivergence = divergences.reduce((a, b) => a + b, 0) / divergences.length;
  const absDivergences = divergences.map(d => Math.abs(d));
  const avgAbsDivergence = absDivergences.reduce((a, b) => a + b, 0) / absDivergences.length;
  const maxAbsDivergence = Math.max(...absDivergences);

  const div0_10 = absDivergences.filter(d => d < 10).length;
  const div10_25 = absDivergences.filter(d => d >= 10 && d < 25).length;
  const div25_50 = absDivergences.filter(d => d >= 25 && d < 50).length;
  const div50plus = absDivergences.filter(d => d >= 50).length;

  console.log(`\n   Mean Divergence:     $${avgDivergence.toFixed(2)} (Binance - Chainlink)`);
  console.log(`   Mean Abs Divergence: $${avgAbsDivergence.toFixed(2)}`);
  console.log(`   Max Abs Divergence:  $${maxAbsDivergence.toFixed(2)}`);

  console.log('\n   Divergence Distribution:');
  console.log(`     $0-10:   ${div0_10.toString().padStart(4)} (${(div0_10/total*100).toFixed(1)}%)`);
  console.log(`     $10-25:  ${div10_25.toString().padStart(4)} (${(div10_25/total*100).toFixed(1)}%)`);
  console.log(`     $25-50:  ${div25_50.toString().padStart(4)} (${(div25_50/total*100).toFixed(1)}%)`);
  console.log(`     $50+:    ${div50plus.toString().padStart(4)} (${(div50plus/total*100).toFixed(1)}%)\n`);

  // =========================================================================
  // FLIP ANALYSIS
  // =========================================================================

  console.log('═'.repeat(70));
  console.log('  ⚠️  FLIP ANALYSIS (Binance prediction != Actual outcome)');
  console.log('═'.repeat(70));

  const flips = analyses.filter(a => !a.binanceCorrect);
  console.log(`\n   Total Flips: ${flips.length} / ${total} (${(flips.length/total*100).toFixed(1)}%)\n`);

  if (flips.length > 0) {
    const flipMargins = flips.map(f => Math.abs(f.binanceMargin));
    const avgFlipMargin = flipMargins.reduce((a, b) => a + b, 0) / flipMargins.length;
    const maxFlipMargin = Math.max(...flipMargins);
    const minFlipMargin = Math.min(...flipMargins);

    console.log('   Binance margin on flipped markets:');
    console.log(`     Min:  $${minFlipMargin.toFixed(2)}`);
    console.log(`     Avg:  $${avgFlipMargin.toFixed(2)}`);
    console.log(`     Max:  $${maxFlipMargin.toFixed(2)}\n`);

    console.log('   Flips by Binance margin from strike:');
    const flipBuckets = [
      { range: '$0-10', min: 0, max: 10, count: 0 },
      { range: '$10-25', min: 10, max: 25, count: 0 },
      { range: '$25-50', min: 25, max: 50, count: 0 },
      { range: '$50-100', min: 50, max: 100, count: 0 },
      { range: '$100-200', min: 100, max: 200, count: 0 },
      { range: '$200+', min: 200, max: Infinity, count: 0 },
    ];

    for (const flip of flips) {
      const m = Math.abs(flip.binanceMargin);
      for (const b of flipBuckets) {
        if (m >= b.min && m < b.max) {
          b.count++;
          break;
        }
      }
    }

    for (const b of flipBuckets) {
      const pct = (b.count / total * 100).toFixed(2);
      console.log(`     ${b.range.padEnd(8)}: ${b.count.toString().padStart(4)} flips (${pct}% of all markets)`);
    }
  }

  // =========================================================================
  // MINIMUM SAFE MARGIN
  // =========================================================================

  console.log('\n' + '═'.repeat(70));
  console.log('  🎯 MINIMUM SAFE MARGIN RECOMMENDATION');
  console.log('═'.repeat(70));

  const sortedByMargin = [...analyses].sort((a, b) => Math.abs(b.binanceMargin) - Math.abs(a.binanceMargin));

  let cumulativeCorrect = 0;
  let threshold90 = 0;
  let threshold95 = 0;
  let threshold99 = 0;

  for (let i = 0; i < sortedByMargin.length; i++) {
    if (sortedByMargin[i].binanceCorrect) cumulativeCorrect++;
    const cumulativeAccuracy = cumulativeCorrect / (i + 1);
    const marginThreshold = Math.abs(sortedByMargin[i].binanceMargin);

    if (cumulativeAccuracy >= 0.90 && threshold90 === 0) {
      threshold90 = marginThreshold;
    }
    if (cumulativeAccuracy >= 0.95 && threshold95 === 0) {
      threshold95 = marginThreshold;
    }
    if (cumulativeAccuracy >= 0.99 && threshold99 === 0) {
      threshold99 = marginThreshold;
    }
  }

  console.log(`\n   For 90% accuracy: Trade only when |Binance - Strike| > $${threshold90.toFixed(0)}`);
  console.log(`   For 95% accuracy: Trade only when |Binance - Strike| > $${threshold95.toFixed(0)}`);
  console.log(`   For 99% accuracy: Trade only when |Binance - Strike| > $${threshold99.toFixed(0)}\n`);

  const marketsAbove90 = analyses.filter(a => Math.abs(a.binanceMargin) > threshold90).length;
  const marketsAbove95 = analyses.filter(a => Math.abs(a.binanceMargin) > threshold95).length;
  const marketsAbove99 = analyses.filter(a => Math.abs(a.binanceMargin) > threshold99).length;

  console.log(`   Markets at $${threshold90.toFixed(0)} threshold: ${marketsAbove90} (${(marketsAbove90/total*100).toFixed(1)}%)`);
  console.log(`   Markets at $${threshold95.toFixed(0)} threshold: ${marketsAbove95} (${(marketsAbove95/total*100).toFixed(1)}%)`);
  console.log(`   Markets at $${threshold99.toFixed(0)} threshold: ${marketsAbove99} (${(marketsAbove99/total*100).toFixed(1)}%)\n`);

  // =========================================================================
  // DETAILED MARGIN ACCURACY TABLE
  // =========================================================================

  console.log('═'.repeat(70));
  console.log('  📊 DETAILED MARGIN ACCURACY');
  console.log('═'.repeat(70));
  console.log('\n  Margin │ Count │ Correct │ Wrong │ Accuracy │ Cumul. Accuracy');
  console.log('  ───────┼───────┼─────────┼───────┼──────────┼─────────────────');

  const detailedBuckets = [
    { label: '$0-10', min: 0, max: 10 },
    { label: '$10-25', min: 10, max: 25 },
    { label: '$25-50', min: 25, max: 50 },
    { label: '$50-75', min: 50, max: 75 },
    { label: '$75-100', min: 75, max: 100 },
    { label: '$100-150', min: 100, max: 150 },
    { label: '$150-200', min: 150, max: 200 },
    { label: '$200-300', min: 200, max: 300 },
    { label: '$300-500', min: 300, max: 500 },
    { label: '$500+', min: 500, max: Infinity },
  ];

  let cumulativeCount = 0;
  let cumulativeCorrectCount = 0;

  for (const bucket of detailedBuckets) {
    const inBucket = analyses.filter(a => {
      const absMargin = Math.abs(a.binanceMargin);
      return absMargin >= bucket.min && absMargin < bucket.max;
    });
    const correctInBucket = inBucket.filter(a => a.binanceCorrect);

    cumulativeCount += inBucket.length;
    cumulativeCorrectCount += correctInBucket.length;

    const bucketAcc = inBucket.length > 0 ? (correctInBucket.length / inBucket.length * 100).toFixed(1) : 'N/A';
    const cumAcc = cumulativeCount > 0 ? (cumulativeCorrectCount / cumulativeCount * 100).toFixed(1) : 'N/A';

    console.log(
      `  ${bucket.label.padEnd(7)} │ ${inBucket.length.toString().padStart(5)} │ ${correctInBucket.length.toString().padStart(7)} │ ${(inBucket.length - correctInBucket.length).toString().padStart(5)} │ ${(bucketAcc + '%').padStart(8)} │ ${(cumAcc + '%').padStart(15)}`
    );
  }

  console.log('  ───────┴───────┴─────────┴───────┴──────────┴─────────────────\n');
  console.log('═'.repeat(70) + '\n');
}

main();
