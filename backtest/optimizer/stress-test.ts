/**
 * Stress Tests — Run top survivors under adverse conditions.
 *
 * Three scenarios:
 *   1. Slippage 300bps (vs normal 200bps)
 *   2. Low vol: volMult 0.90 (edge shrinks)
 *   3. High vol: volMult 1.10 (more noise)
 *
 * A cell passes stress if it remains profitable (P&L > 0) on the TEST period
 * under all three scenarios.
 */

import { Simulator } from '../engine/simulator';
import { DataBundle } from '../engine/data-bundle';
import { BacktestConfig, Statistics } from '../types';
import { calculateStatistics } from '../output/statistics';
import { CellResult } from './runner';
import { RunnerBaseConfig } from './runner';
import { DateSplit } from './train-test-split';

/** A single stress scenario */
export interface StressScenario {
    readonly name: string;
    readonly overrides: Partial<BacktestConfig>;
}

/** Result of stress testing a single cell */
export interface StressResult {
    readonly cell: CellResult;
    readonly scenarios: Array<{
        readonly scenario: StressScenario;
        readonly stats: Statistics;
        readonly passed: boolean;   // P&L > 0
    }>;
    readonly allPassed: boolean;
}

/** Default stress scenarios */
export const STRESS_SCENARIOS: StressScenario[] = [
    { name: 'slippage_300bps', overrides: { slippageBps: 300 } },
    { name: 'low_vol_0.90', overrides: { volMultiplier: 0.90 } },
    { name: 'high_vol_1.10', overrides: { volMultiplier: 1.10 } },
];

/**
 * Run stress tests on a set of surviving cells.
 *
 * @param survivors - Cells that passed hard gates
 * @param split - Date split (stress runs on test period only)
 * @param bundle - Pre-loaded DataBundle
 * @param base - Base config (non-grid-varied)
 * @param scenarios - Stress scenarios to apply (default: STRESS_SCENARIOS)
 * @returns Array of StressResult, one per survivor
 */
export async function runStressTests(
    survivors: CellResult[],
    split: DateSplit,
    bundle: DataBundle,
    base: RunnerBaseConfig,
    scenarios: StressScenario[] = STRESS_SCENARIOS,
): Promise<StressResult[]> {
    const results: StressResult[] = [];

    for (const cr of survivors) {
        const scenarioResults: StressResult['scenarios'] = [];

        for (const scenario of scenarios) {
            const config: Partial<BacktestConfig> = {
                startDate: split.testStart,
                endDate: split.testEnd,
                initialCapital: base.initialCapital,
                spreadCents: base.spreadCents,
                slippageBps: base.slippageBps,
                includeFees: base.includeFees,
                mode: base.mode,
                sizingMode: 'kelly',
                kellyFraction: cr.cell.kellyFraction,
                minEdge: cr.cell.minEdgePct / 100,
                orderSize: 100,
                silent: true,
                volMultiplier: base.volMultiplier ?? 1.0,
                useChainlinkForFairValue: base.useChainlinkForFairValue ?? false,
                adjustmentWindowHours: base.adjustmentWindowHours ?? 2,
                cooldownMs: base.cooldownMs ?? 60000,
                maxTradesPerMarket: base.maxTradesPerMarket ?? 3,
                maxOrderUsd: base.maxOrderUsd ?? Infinity,
                maxPositionUsd: base.maxPositionUsd ?? Infinity,
                // Apply stress overrides last (they take precedence)
                ...scenario.overrides,
            };

            const sim = new Simulator(config);
            const result = await sim.run(bundle);
            const stats = calculateStatistics(result);

            scenarioResults.push({
                scenario,
                stats,
                passed: stats.totalPnL > 0,
            });
        }

        const allPassed = scenarioResults.every(s => s.passed);
        results.push({ cell: cr, scenarios: scenarioResults, allPassed });
    }

    return results;
}
