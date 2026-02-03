#!/usr/bin/env npx ts-node
/**
 * Binance→Chainlink Adjustment Sweep
 *
 * Tests different adjustment values to find optimal divergence correction.
 * Compares P&L, win rate, and YES/NO balance across adjustment values.
 *
 * Usage:
 *   npx ts-node backtest/adjustment-sweep.ts [options]
 *
 * Options:
 *   --days <n>     Number of days (default: 7)
 *   --edge <pct>   Minimum edge (default: 10)
 *   --spread <c>   Spread in cents (default: 1)
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { Simulator } from './engine/simulator';
import { BacktestConfig, BacktestResult, Statistics } from './types';
import { calculateStatistics } from './output/statistics';

interface AdjustmentResult {
  adjustment: number;
  pnl: number;
  trades: number;
  markets: number;
  winRate: number;
  yesTrades: number;
  noTrades: number;
  yesPnl: number;
  noPnl: number;
  edgeCapture: number;
  sharpe: number;
}

function parseArgs(): {
  days: number;
  edge: number;
  spread: number;
  adjustments: number[];
} {
  const args = process.argv.slice(2);
  const result = {
    days: 7,
    edge: 10,
    spread: 1,
    adjustments: [] as number[],
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--days':
        result.days = parseInt(args[++i], 10) || 7;
        break;
      case '--edge':
        result.edge = parseFloat(args[++i]) || 10;
        break;
      case '--spread':
        result.spread = parseFloat(args[++i]) || 1;
        break;
      case '--adjustments':
        // Parse comma-separated list: -150,-175,-200
        result.adjustments = args[++i].split(',').map(s => parseFloat(s.trim()));
        break;
    }
  }

  // Default adjustments if not specified
  if (result.adjustments.length === 0) {
    result.adjustments = [0, -50, -75, -100, -104, -120, -150];
  }

  return result;
}

async function runWithAdjustment(
  startDate: Date,
  endDate: Date,
  edge: number,
  spread: number,
  adjustment: number
): Promise<{ result: BacktestResult; stats: Statistics }> {
  const config: Partial<BacktestConfig> = {
    startDate,
    endDate,
    initialCapital: Infinity,
    spreadCents: spread,
    minEdge: edge / 100,
    orderSize: 100,
    maxPositionPerMarket: 1000,
    lagSeconds: 0,
    executionLatencyMs: 0,
    useChainlinkForFairValue: false,  // Use Binance with adjustment
    volMultiplier: 1.0,
    mode: 'normal',
    binanceChainlinkAdjustment: adjustment,
  };

  const simulator = new Simulator(config);
  const result = await simulator.run();
  const stats = calculateStatistics(result);

  return { result, stats };
}

async function main(): Promise<void> {
  const args = parseArgs();

  console.log('\n' + '═'.repeat(100));
  console.log('  📐 BINANCE→CHAINLINK ADJUSTMENT SWEEP');
  console.log('═'.repeat(100));

  const now = new Date();
  const startDate = new Date(now.getTime() - args.days * 24 * 60 * 60 * 1000);

  console.log(`\n📋 Configuration:`);
  console.log(`   Period:     ${args.days} days`);
  console.log(`   Edge:       ${args.edge}%`);
  console.log(`   Spread:     ${args.spread}¢`);
  console.log(`   Oracle:     BINANCE (with adjustment)`);

  // Use adjustments from args
  const adjustments = args.adjustments;

  console.log(`\n🔄 Testing ${adjustments.length} adjustment values...\n`);

  const results: AdjustmentResult[] = [];

  for (let i = 0; i < adjustments.length; i++) {
    const adj = adjustments[i];
    const adjStr = adj === 0 ? '  0 (baseline)' : `${adj >= 0 ? '+' : ''}${adj}`.padStart(14);
    process.stdout.write(`   [${i + 1}/${adjustments.length}] Adjustment ${adjStr}... `);

    try {
      const { result, stats } = await runWithAdjustment(startDate, now, args.edge, args.spread, adj);

      results.push({
        adjustment: adj,
        pnl: result.totalPnL,
        trades: result.totalTrades,
        markets: result.totalMarkets,
        winRate: stats.winRate,
        yesTrades: stats.yesTrades,
        noTrades: stats.noTrades,
        yesPnl: stats.yesPnL,
        noPnl: stats.noPnL,
        edgeCapture: stats.edgeCapture,
        sharpe: stats.sharpeRatio,
      });

      const pnlStr = result.totalPnL >= 0 ? `+$${result.totalPnL.toFixed(0)}` : `-$${Math.abs(result.totalPnL).toFixed(0)}`;
      console.log(`${pnlStr.padStart(8)} | ${result.totalTrades} trades | YES: ${stats.yesTrades} NO: ${stats.noTrades}`);
    } catch (err: any) {
      console.log(`ERROR: ${err.message}`);
      results.push({
        adjustment: adj,
        pnl: 0,
        trades: 0,
        markets: 0,
        winRate: 0,
        yesTrades: 0,
        noTrades: 0,
        yesPnl: 0,
        noPnl: 0,
        edgeCapture: 0,
        sharpe: 0,
      });
    }
  }

  // Find optimal by P&L
  const sortedByPnl = [...results].sort((a, b) => b.pnl - a.pnl);
  const optimal = sortedByPnl[0];

  // Print results table
  console.log('\n' + '═'.repeat(120));
  console.log('  📊 ADJUSTMENT SWEEP RESULTS');
  console.log('═'.repeat(120));

  console.log('\n  Adjustment │      P&L     │ Trades │  Win%  │   YES Trades  │   NO Trades   │  YES P&L  │  NO P&L   │ EdgeCap │ Sharpe │');
  console.log('  ───────────┼──────────────┼────────┼────────┼───────────────┼───────────────┼───────────┼───────────┼─────────┼────────┤');

  for (const r of results) {
    const isOptimal = r.adjustment === optimal.adjustment;
    const marker = isOptimal ? '🏆' : '  ';
    const adjStr = r.adjustment === 0 ? '  0 (base)' : `$${r.adjustment >= 0 ? '+' : ''}${r.adjustment}`.padStart(10);
    const pnlStr = r.pnl >= 0 ? `+$${r.pnl.toFixed(0).padStart(6)}` : `-$${Math.abs(r.pnl).toFixed(0).padStart(6)}`;
    const yesPnlStr = r.yesPnl >= 0 ? `+$${r.yesPnl.toFixed(0).padStart(4)}` : `-$${Math.abs(r.yesPnl).toFixed(0).padStart(4)}`;
    const noPnlStr = r.noPnl >= 0 ? `+$${r.noPnl.toFixed(0).padStart(4)}` : `-$${Math.abs(r.noPnl).toFixed(0).padStart(4)}`;

    // Calculate YES/NO ratio
    const yesRatio = r.trades > 0 ? (r.yesTrades / r.trades * 100).toFixed(0) : '0';
    const noRatio = r.trades > 0 ? (r.noTrades / r.trades * 100).toFixed(0) : '0';

    console.log(
      `${marker}${adjStr} │ ${pnlStr}    │ ${r.trades.toString().padStart(6)} │ ${(r.winRate * 100).toFixed(1).padStart(5)}% │ ` +
      `${r.yesTrades.toString().padStart(5)} (${yesRatio}%)   │ ${r.noTrades.toString().padStart(5)} (${noRatio}%)   │ ` +
      `${yesPnlStr}   │ ${noPnlStr}   │ ${(r.edgeCapture * 100).toFixed(0).padStart(5)}%  │ ${r.sharpe.toFixed(1).padStart(5)}  │`
    );
  }
  console.log('  ───────────┴──────────────┴────────┴────────┴───────────────┴───────────────┴───────────┴───────────┴─────────┴────────┘\n');

  // Analysis
  console.log('═'.repeat(120));
  console.log('  📈 ANALYSIS');
  console.log('═'.repeat(120));

  // Optimal by P&L
  console.log(`\n  🏆 Optimal by P&L: $${optimal.adjustment}`);
  console.log(`     P&L: ${optimal.pnl >= 0 ? '+' : ''}$${optimal.pnl.toFixed(2)}`);
  console.log(`     Trades: ${optimal.trades} (YES: ${optimal.yesTrades}, NO: ${optimal.noTrades})`);
  console.log(`     Win Rate: ${(optimal.winRate * 100).toFixed(1)}%`);
  console.log(`     Edge Capture: ${(optimal.edgeCapture * 100).toFixed(0)}%`);

  // YES/NO balance analysis
  console.log(`\n  📊 YES/NO Balance Analysis:`);
  const baseline = results.find(r => r.adjustment === 0);
  if (baseline) {
    const baseYesRatio = baseline.trades > 0 ? baseline.yesTrades / baseline.trades : 0;
    console.log(`     Baseline (adj=0):   YES ${(baseYesRatio * 100).toFixed(0)}% / NO ${((1 - baseYesRatio) * 100).toFixed(0)}%`);
  }
  const optYesRatio = optimal.trades > 0 ? optimal.yesTrades / optimal.trades : 0;
  console.log(`     Optimal (adj=${optimal.adjustment}): YES ${(optYesRatio * 100).toFixed(0)}% / NO ${((1 - optYesRatio) * 100).toFixed(0)}%`);

  // P&L improvement
  if (baseline && baseline.pnl !== optimal.pnl) {
    const improvement = optimal.pnl - baseline.pnl;
    const pctImprovement = baseline.pnl !== 0 ? (improvement / Math.abs(baseline.pnl) * 100) : Infinity;
    console.log(`\n  💰 P&L Improvement from baseline:`);
    console.log(`     ${improvement >= 0 ? '+' : ''}$${improvement.toFixed(2)} (${pctImprovement >= 0 ? '+' : ''}${pctImprovement.toFixed(0)}%)`);
  }

  // Visual P&L chart
  console.log('\n  📈 P&L by Adjustment:\n');
  const maxPnl = Math.max(...results.map(r => r.pnl));
  const minPnl = Math.min(...results.map(r => r.pnl));
  const range = maxPnl - minPnl || 1;

  for (const r of results) {
    const normalized = (r.pnl - minPnl) / range;
    const barLen = Math.round(normalized * 40);
    const bar = '█'.repeat(barLen);
    const pnlStr = r.pnl >= 0 ? `+$${r.pnl.toFixed(0)}` : `-$${Math.abs(r.pnl).toFixed(0)}`;
    const marker = r.adjustment === optimal.adjustment ? '🏆' : '  ';
    const adjStr = r.adjustment === 0 ? '  0' : `${r.adjustment >= 0 ? '+' : ''}${r.adjustment}`;
    console.log(`  ${marker}$${adjStr.padStart(4)} │${bar.padEnd(40)} ${pnlStr}`);
  }

  console.log('\n' + '═'.repeat(120));
  console.log('  ✅ SWEEP COMPLETE');
  console.log('═'.repeat(120));

  // Recommendation
  console.log(`\n  📌 RECOMMENDATION:`);
  if (optimal.adjustment !== 0 && optimal.pnl > (baseline?.pnl ?? 0)) {
    console.log(`     Use --adjustment ${optimal.adjustment} for Binance-based fair value calculation.`);
    console.log(`     This corrects for Chainlink being ~$${Math.abs(optimal.adjustment)} lower than Binance.`);
  } else if (optimal.adjustment === 0) {
    console.log(`     No adjustment needed - baseline (adj=0) is optimal.`);
  } else {
    console.log(`     Consider using --chainlink mode directly instead of adjustment.`);
  }
  console.log('');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
