#!/usr/bin/env npx ts-node
/**
 * Optimizer CLI Entry Point
 *
 * Usage:
 *   npx ts-node backtest/optimizer/index.ts [options]
 *
 * Options:
 *   --from <YYYY-MM-DD>       Start of full date range (default: 2025-10-15)
 *   --to <YYYY-MM-DD>         End of full date range (default: 2026-02-12)
 *   --initial-capital <$>     Starting capital (default: .env ARB_MAX_TOTAL_USD or 500)
 *   --train-ratio <0-1>       Train/test split ratio (default: 0.70)
 *   --top-n <n>               Number of gate survivors to stress test (default: 3)
 *   --help                    Show this help
 *
 * The optimizer:
 *   1. Loads data once via DataBundle
 *   2. Splits into train (70%) and test (30%) periods
 *   3. Runs 40-cell grid (8 edge × 5 kelly) on both periods
 *   4. Applies 6 hard gates to reject unreliable configs
 *   5. Stress-tests top survivors (3 scenarios)
 *   6. Scores and selects the winning config
 *   7. Outputs report to data/optimizer-report.{json,md}
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { DataBundle } from '../engine/data-bundle';
import { splitDateRange } from './train-test-split';
import { generateGrid } from './grid';
import { runGrid, RunnerBaseConfig } from './runner';
import { applyGates } from './hard-gates';
import { runStressTests } from './stress-test';
import { scoreAndRank, selectWinner, computeScore } from './scoring';
import { cellLabel } from './grid';
import {
    printGridSummary,
    printStressResults,
    printWinner,
    saveReport,
} from './report';

interface OptimizerArgs {
    from: string;
    to: string;
    initialCapital: number;
    trainRatio: number;
    topN: number;
}

function parseOptimizerArgs(): OptimizerArgs {
    const args = process.argv.slice(2);

    const envCapital = process.env.ARB_MAX_TOTAL_USD
        ? parseFloat(process.env.ARB_MAX_TOTAL_USD)
        : 500;

    const result: OptimizerArgs = {
        from: '2025-10-15',
        to: '2026-02-12',
        initialCapital: envCapital,
        trainRatio: 0.70,
        topN: 3,
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--from':
                result.from = args[++i];
                break;
            case '--to':
                result.to = args[++i];
                break;
            case '--initial-capital': {
                const val = parseFloat(args[++i]);
                if (!isNaN(val) && val > 0) result.initialCapital = val;
                break;
            }
            case '--train-ratio': {
                const val = parseFloat(args[++i]);
                if (!isNaN(val) && val > 0 && val < 1) result.trainRatio = val;
                break;
            }
            case '--top-n': {
                const val = parseInt(args[++i], 10);
                if (!isNaN(val) && val > 0) result.topN = val;
                break;
            }
            case '--help':
            case '-h':
                printHelp();
                process.exit(0);
        }
    }

    return result;
}

function printHelp(): void {
    console.log(`
Optimizer — Kelly MTM Sizing + Disciplined Train/Test

Usage: npx ts-node backtest/optimizer/index.ts [options]

Options:
  --from <YYYY-MM-DD>       Start date (default: 2025-10-15)
  --to <YYYY-MM-DD>         End date (default: 2026-02-12)
  --initial-capital <$>     Starting capital (default: .env ARB_MAX_TOTAL_USD or $500)
  --train-ratio <0-1>       Train/test split ratio (default: 0.70)
  --top-n <n>               Gate survivors to stress test (default: 3)
  --help                    Show this help

Grid: 8 edge values × 5 Kelly fractions = 40 cells
  Edge: [22, 24, 25, 26, 28, 30, 33, 36]%
  Kelly: [0.10, 0.20, 0.30, 0.40, 0.50]

Hard Gates:
  1. Min 30 trades on train
  2. Train P&L > 0
  3. Test P&L > 0
  4. |DD_test| ≤ 1.5 × |DD_train|
  5. Test Sharpe ≥ 0.5 × Train Sharpe
  6. |DD_test| ≤ 30% of capital

Stress Scenarios:
  - slippage 300bps
  - volMult 0.90
  - volMult 1.10

Score: Profit_test - 0.5 × |MaxDrawdown_test|

Output: data/optimizer-report.{json,md}
`);
}

async function main(): Promise<void> {
    const args = parseOptimizerArgs();
    const startDate = new Date(args.from);
    const endDate = new Date(args.to);

    console.log('\n' + '='.repeat(70));
    console.log('  OPTIMIZER — Kelly MTM Sizing + Disciplined Train/Test');
    console.log('='.repeat(70));

    // Step 1: Date split
    const split = splitDateRange(startDate, endDate, args.trainRatio);
    console.log(`\n  Date Range:  ${args.from} to ${args.to}`);
    console.log(`  Train:       ${split.trainStart.toISOString().split('T')[0]} to ${split.trainEnd.toISOString().split('T')[0]} (${split.trainDays} days)`);
    console.log(`  Test:        ${split.testStart.toISOString().split('T')[0]} to ${split.testEnd.toISOString().split('T')[0]} (${split.testDays} days)`);
    console.log(`  Capital:     $${args.initialCapital}`);

    // Step 2: Load data once
    console.log('\n  Loading data...');
    const bundle = await DataBundle.load(startDate, endDate);

    // Step 3: Generate grid
    const grid = generateGrid();
    console.log(`\n  Grid: ${grid.length} cells (${8} edge × ${5} kelly)`);

    // Step 4: Run grid
    const base: RunnerBaseConfig = {
        initialCapital: args.initialCapital,
        spreadCents: 6,
        slippageBps: 200,
        includeFees: true,
        mode: 'conservative',
    };

    console.log('  Running grid...\n');
    const results = await runGrid(grid, split, bundle, base, (completed, total, label) => {
        process.stdout.write(`\r  [${completed}/${total}] ${label}${''.padEnd(30)}`);
    });
    process.stdout.write('\r' + ' '.repeat(70) + '\r');
    console.log(`  Grid complete: ${results.length} cells evaluated.`);

    // Step 5: Apply hard gates
    const { survivors, rejects } = applyGates(results, args.initialCapital);

    // Print grid summary
    printGridSummary(results, rejects, survivors);

    if (survivors.length === 0) {
        console.log('\n  No cells passed hard gates. Report saved with null winner.');
        saveReport(split, results, survivors, rejects, [], [], null);
        return;
    }

    // Step 6: Stress test top N survivors (sorted by score)
    const sortedSurvivors = [...survivors].sort((a, b) => computeScore(b) - computeScore(a));
    const topN = sortedSurvivors.slice(0, args.topN);

    console.log(`\n  Stress testing top ${topN.length} survivors...`);
    const stressResults = await runStressTests(topN, split, bundle, base);

    printStressResults(stressResults);

    // Step 7: Score and select winner
    const ranked = scoreAndRank(stressResults, survivors);
    const winner = selectWinner(ranked);

    printWinner(winner, ranked);

    // Step 8: Save reports
    saveReport(split, results, survivors, rejects, stressResults, ranked, winner);

    if (winner) {
        console.log(`\n  Recommended .env settings:`);
        console.log(`    ARB_EDGE_MIN=${(winner.cell.cell.minEdgePct / 100).toFixed(2)}`);
        console.log(`    KELLY_FRACTION=${winner.cell.cell.kellyFraction}`);
        console.log(`    ARB_MAX_TOTAL_USD=${Math.max(args.initialCapital, winner.minimumBankroll)}`);
    }

    console.log('\n' + '='.repeat(70));
}

main().catch((err) => {
    console.error('Optimizer failed:', err);
    process.exit(1);
});
