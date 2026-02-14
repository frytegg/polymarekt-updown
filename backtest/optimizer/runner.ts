/**
 * Optimizer Runner — Executes grid cells on train/test splits.
 *
 * For each GridCell, runs two backtests (train and test period) using the
 * shared DataBundle, then collects results and statistics for downstream
 * filtering (hard gates) and scoring.
 */

import { Simulator } from '../engine/simulator';
import { DataBundle } from '../engine/data-bundle';
import { BacktestConfig, BacktestResult, Statistics } from '../types';
import { calculateStatistics } from '../output/statistics';
import { GridCell, cellLabel } from './grid';
import { DateSplit } from './train-test-split';

/** Result of running a single grid cell on both train and test periods */
export interface CellResult {
    readonly cell: GridCell;
    readonly trainResult: BacktestResult;
    readonly testResult: BacktestResult;
    readonly trainStats: Statistics;
    readonly testStats: Statistics;
}

/** Base config options passed through to every Simulator (not grid-varied) */
export interface RunnerBaseConfig {
    readonly initialCapital: number;
    readonly spreadCents: number;
    readonly slippageBps: number;
    readonly includeFees: boolean;
    readonly mode: BacktestConfig['mode'];
    readonly volMultiplier?: number;
    readonly useChainlinkForFairValue?: boolean;
    readonly adjustmentWindowHours?: number;
    readonly cooldownMs?: number;
    readonly maxTradesPerMarket?: number;
    readonly maxOrderUsd?: number;
    readonly maxPositionUsd?: number;
}

/**
 * Run a single grid cell on a single date range.
 */
async function runCell(
    cell: GridCell,
    startDate: Date,
    endDate: Date,
    bundle: DataBundle,
    base: RunnerBaseConfig,
): Promise<{ result: BacktestResult; stats: Statistics }> {
    const config: Partial<BacktestConfig> = {
        startDate,
        endDate,
        initialCapital: base.initialCapital,
        spreadCents: base.spreadCents,
        slippageBps: base.slippageBps,
        includeFees: base.includeFees,
        mode: base.mode,
        sizingMode: 'kelly',
        kellyFraction: cell.kellyFraction,
        minEdge: cell.minEdgePct / 100,  // Convert percentage to decimal
        orderSize: 100,  // Ignored by Kelly but required by type
        silent: true,
        volMultiplier: base.volMultiplier ?? 1.0,
        useChainlinkForFairValue: base.useChainlinkForFairValue ?? false,
        adjustmentWindowHours: base.adjustmentWindowHours ?? 2,
        cooldownMs: base.cooldownMs ?? 60000,
        maxTradesPerMarket: base.maxTradesPerMarket ?? 3,
        maxOrderUsd: base.maxOrderUsd ?? Infinity,
        maxPositionUsd: base.maxPositionUsd ?? Infinity,
    };

    const sim = new Simulator(config);
    const result = await sim.run(bundle);
    const stats = calculateStatistics(result);
    return { result, stats };
}

/**
 * Run the full grid across train and test periods.
 *
 * @param grid - Array of GridCell to evaluate
 * @param split - Train/test date ranges
 * @param bundle - Pre-loaded DataBundle (covers the full date range)
 * @param base - Base config options (non-grid-varied)
 * @param onProgress - Optional callback after each cell completes
 * @returns Array of CellResult (same order as input grid)
 */
export async function runGrid(
    grid: GridCell[],
    split: DateSplit,
    bundle: DataBundle,
    base: RunnerBaseConfig,
    onProgress?: (completed: number, total: number, label: string) => void,
): Promise<CellResult[]> {
    const results: CellResult[] = [];

    for (let i = 0; i < grid.length; i++) {
        const cell = grid[i];

        // Run train period
        const train = await runCell(cell, split.trainStart, split.trainEnd, bundle, base);

        // Run test period
        const test = await runCell(cell, split.testStart, split.testEnd, bundle, base);

        results.push({
            cell,
            trainResult: train.result,
            testResult: test.result,
            trainStats: train.stats,
            testStats: test.stats,
        });

        if (onProgress) {
            onProgress(i + 1, grid.length, cellLabel(cell));
        }
    }

    return results;
}
