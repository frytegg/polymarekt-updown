#!/usr/bin/env npx ts-node
/**
 * Binance vs Polymarket Settlement Accuracy Analysis
 *
 * Compares Binance BTC price predictions against actual Polymarket outcomes
 * (which are settled using Chainlink oracle)
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { BinanceHistoricalFetcher } from './fetchers/binance-historical';
import { PolymarketMarketsFetcher } from './fetchers/polymarket-markets';
import { ChainlinkHistoricalFetcher } from './fetchers/chainlink-historical';

interface MarketAnalysis {
  marketId: string;
  endTime: number;
  strikePrice: number;
  binancePrice: number;
  chainlinkPrice: number;
  binancePrediction: 'UP' | 'DOWN';
  actualOutcome: 'UP' | 'DOWN';
  binanceMargin: number; // How far Binance was from strike (positive = above)
  chainlinkMargin: number;
  binanceCorrect: boolean;
  divergence: number; // Binance - Chainlink
}

interface MarginBucket {
  label: string;
  minMargin: number;
  maxMargin: number;
  prediction: 'UP' | 'DOWN';
  count: number;
  correct: number;
}

async function main(): Promise<void> {
  console.log('\n' + '═'.repeat(70));
  console.log('  📊 BINANCE vs POLYMARKET SETTLEMENT ACCURACY ANALYSIS');
  console.log('═'.repeat(70));

  // Parse days from command line (default 14)
  const days = parseInt(process.argv[2], 10) || 14;

  const now = new Date();
  const startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const startTs = startDate.getTime();
  const endTs = now.getTime();

  console.log(`\n📅 Period: ${startDate.toLocaleDateString()} to ${now.toLocaleDateString()} (${days} days)\n`);

  // Fetch data
  console.log('📡 Fetching data...\n');

  const marketsFetcher = new PolymarketMarketsFetcher();
  const binanceFetcher = new BinanceHistoricalFetcher('BTCUSDT', '1m');
  const chainlinkFetcher = new ChainlinkHistoricalFetcher();

  const markets = await marketsFetcher.fetch(startTs, endTs);
  console.log(`   Markets: ${markets.length}`);

  const binanceKlines = await binanceFetcher.fetch(startTs, endTs);
  console.log(`   Binance klines: ${binanceKlines.length}`);

  const chainlinkPrices = await chainlinkFetcher.fetch(startTs, endTs);
  console.log(`   Chainlink prices: ${chainlinkPrices.length}\n`);

  // Analyze each market
  const analyses: MarketAnalysis[] = [];

  for (const market of markets) {
    if (!market.strikePrice || market.strikePrice <= 0) continue;
    if (market.endTime > endTs) continue; // Skip unresolved markets

    // Get Binance price at market end
    const binancePrice = binanceFetcher.getPriceAt(market.endTime);
    if (!binancePrice) continue;

    // Get Chainlink price at market end
    const chainlinkPoint = chainlinkFetcher.getClosestPrice(market.endTime, 60000);
    if (!chainlinkPoint) continue;

    const chainlinkPrice = chainlinkPoint.price;

    // Predictions and outcomes
    const binancePrediction: 'UP' | 'DOWN' = binancePrice >= market.strikePrice ? 'UP' : 'DOWN';
    const actualOutcome: 'UP' | 'DOWN' = chainlinkPrice >= market.strikePrice ? 'UP' : 'DOWN';

    analyses.push({
      marketId: market.conditionId,
      endTime: market.endTime,
      strikePrice: market.strikePrice,
      binancePrice,
      chainlinkPrice,
      binancePrediction,
      actualOutcome,
      binanceMargin: binancePrice - market.strikePrice,
      chainlinkMargin: chainlinkPrice - market.strikePrice,
      binanceCorrect: binancePrediction === actualOutcome,
      divergence: binancePrice - chainlinkPrice,
    });
  }

  console.log(`✅ Analyzed ${analyses.length} resolved markets\n`);

  // =========================================================================
  // OVERALL ACCURACY
  // =========================================================================

  console.log('═'.repeat(70));
  console.log('  📈 OVERALL BINANCE PREDICTION ACCURACY');
  console.log('═'.repeat(70));

  const correct = analyses.filter(a => a.binanceCorrect).length;
  const total = analyses.length;
  const accuracy = total > 0 ? correct / total : 0;

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
      if (bucket.prediction === direction &&
          absMargin >= bucket.minMargin &&
          absMargin < bucket.maxMargin) {
        bucket.count++;
        if (analysis.binanceCorrect) bucket.correct++;
        break;
      }
    }
  }

  console.log('  Margin from Strike │ Binance Prediction │ Count │ Correct │ Accuracy');
  console.log('  ───────────────────┼────────────────────┼───────┼─────────┼──────────');

  for (const bucket of buckets) {
    const accuracy = bucket.count > 0 ? (bucket.correct / bucket.count * 100).toFixed(1) : 'N/A';
    const accuracyStr = bucket.count > 0 ? `${accuracy}%` : 'N/A';
    console.log(
      `  ${bucket.label.padEnd(19)} │ ${bucket.prediction.padEnd(18)} │ ${bucket.count.toString().padStart(5)} │ ${bucket.correct.toString().padStart(7)} │ ${accuracyStr.padStart(8)}`
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

  // Distribution of divergences
  const div0_10 = absDivergences.filter(d => d < 10).length;
  const div10_25 = absDivergences.filter(d => d >= 10 && d < 25).length;
  const div25_50 = absDivergences.filter(d => d >= 25 && d < 50).length;
  const div50_100 = absDivergences.filter(d => d >= 50 && d < 100).length;
  const div100plus = absDivergences.filter(d => d >= 100).length;

  console.log(`\n   Mean Divergence:     $${avgDivergence.toFixed(2)} (Binance - Chainlink)`);
  console.log(`   Mean Abs Divergence: $${avgAbsDivergence.toFixed(2)}`);
  console.log(`   Max Abs Divergence:  $${maxAbsDivergence.toFixed(2)}`);

  console.log('\n   Divergence Distribution:');
  console.log(`     $0-10:   ${div0_10.toString().padStart(4)} (${(div0_10/total*100).toFixed(1)}%)`);
  console.log(`     $10-25:  ${div10_25.toString().padStart(4)} (${(div10_25/total*100).toFixed(1)}%)`);
  console.log(`     $25-50:  ${div25_50.toString().padStart(4)} (${(div25_50/total*100).toFixed(1)}%)`);
  console.log(`     $50-100: ${div50_100.toString().padStart(4)} (${(div50_100/total*100).toFixed(1)}%)`);
  console.log(`     $100+:   ${div100plus.toString().padStart(4)} (${(div100plus/total*100).toFixed(1)}%)\n`);

  // =========================================================================
  // FLIP ANALYSIS (Binance wrong due to divergence)
  // =========================================================================

  console.log('═'.repeat(70));
  console.log('  ⚠️  FLIP ANALYSIS (Binance direction != Chainlink direction)');
  console.log('═'.repeat(70));

  // Cases where Binance and Chainlink gave different predictions
  const flips = analyses.filter(a => !a.binanceCorrect);

  console.log(`\n   Total Flips: ${flips.length} / ${total} (${(flips.length/total*100).toFixed(1)}%)\n`);

  if (flips.length > 0) {
    // Analyze margin on flips
    const flipMargins = flips.map(f => Math.abs(f.binanceMargin));
    const avgFlipMargin = flipMargins.reduce((a, b) => a + b, 0) / flipMargins.length;
    const maxFlipMargin = Math.max(...flipMargins);
    const minFlipMargin = Math.min(...flipMargins);

    console.log('   Binance margin on flipped markets:');
    console.log(`     Min:  $${minFlipMargin.toFixed(2)}`);
    console.log(`     Avg:  $${avgFlipMargin.toFixed(2)}`);
    console.log(`     Max:  $${maxFlipMargin.toFixed(2)}\n`);

    // Show how many flips by margin bucket
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
      const pct = total > 0 ? (b.count / total * 100).toFixed(2) : '0';
      console.log(`     ${b.range.padEnd(8)}: ${b.count.toString().padStart(4)} flips (${pct}% of all markets)`);
    }
  }

  // =========================================================================
  // MINIMUM SAFE MARGIN
  // =========================================================================

  console.log('\n' + '═'.repeat(70));
  console.log('  🎯 MINIMUM SAFE MARGIN RECOMMENDATION');
  console.log('═'.repeat(70));

  // Find minimum margin where accuracy is > 95%
  const sortedByMargin = [...analyses].sort((a, b) => Math.abs(b.binanceMargin) - Math.abs(a.binanceMargin));

  let cumulativeCorrect = 0;
  let threshold95 = 0;
  let threshold99 = 0;

  for (let i = 0; i < sortedByMargin.length; i++) {
    if (sortedByMargin[i].binanceCorrect) cumulativeCorrect++;
    const cumulativeAccuracy = cumulativeCorrect / (i + 1);
    const marginThreshold = Math.abs(sortedByMargin[i].binanceMargin);

    if (cumulativeAccuracy >= 0.95 && threshold95 === 0) {
      threshold95 = marginThreshold;
    }
    if (cumulativeAccuracy >= 0.99 && threshold99 === 0) {
      threshold99 = marginThreshold;
    }
  }

  console.log(`\n   For 95% accuracy: Trade only when |Binance - Strike| > $${threshold95.toFixed(0)}`);
  console.log(`   For 99% accuracy: Trade only when |Binance - Strike| > $${threshold99.toFixed(0)}\n`);

  // Count markets at each threshold
  const marketsAbove95 = analyses.filter(a => Math.abs(a.binanceMargin) > threshold95).length;
  const marketsAbove99 = analyses.filter(a => Math.abs(a.binanceMargin) > threshold99).length;

  console.log(`   Markets available at $${threshold95.toFixed(0)} threshold: ${marketsAbove95} (${(marketsAbove95/total*100).toFixed(1)}%)`);
  console.log(`   Markets available at $${threshold99.toFixed(0)} threshold: ${marketsAbove99} (${(marketsAbove99/total*100).toFixed(1)}%)\n`);

  console.log('═'.repeat(70) + '\n');
}

main().catch(console.error);
