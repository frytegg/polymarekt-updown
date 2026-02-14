/**
 * Hard Gates — Reject unreliable optimizer configurations.
 *
 * A cell must pass ALL gates to survive. Gates are applied sequentially;
 * the first failure short-circuits and returns the rejection reason.
 *
 * Gates:
 *   1. Minimum 30 trades on train set (statistical significance)
 *   2. Train P&L > 0 (profitable in-sample)
 *   3. Test P&L > 0 (profitable out-of-sample)
 *   4. Drawdown stability: |DD_test| ≤ 1.5 × |DD_train|
 *   5. Consistency: test Sharpe ≥ 0.5 × train Sharpe (no Sharpe collapse)
 *   6. Max drawdown: |DD_test| ≤ 30% of initial capital
 */

import { CellResult } from './runner';

/** Result of gate evaluation */
export interface GateResult {
    readonly passed: boolean;
    readonly reason: string | null;  // null if passed, rejection reason if failed
}

/**
 * Evaluate all hard gates for a cell result.
 * Returns the first failure reason, or null if all gates pass.
 */
export function evaluateGates(
    cr: CellResult,
    initialCapital: number,
): GateResult {
    // Gate 1: Minimum trades on train set
    if (cr.trainResult.totalTrades < 30) {
        return {
            passed: false,
            reason: `Train trades ${cr.trainResult.totalTrades} < 30`,
        };
    }

    // Gate 2: Train P&L > 0
    if (cr.trainStats.totalPnL <= 0) {
        return {
            passed: false,
            reason: `Train P&L $${cr.trainStats.totalPnL.toFixed(2)} ≤ 0`,
        };
    }

    // Gate 3: Test P&L > 0
    if (cr.testStats.totalPnL <= 0) {
        return {
            passed: false,
            reason: `Test P&L $${cr.testStats.totalPnL.toFixed(2)} ≤ 0`,
        };
    }

    // Gate 4: Drawdown stability — |DD_test| ≤ 1.5 × |DD_train|
    const ddTrain = Math.abs(cr.trainStats.maxDrawdown);
    const ddTest = Math.abs(cr.testStats.maxDrawdown);
    if (ddTrain > 0 && ddTest > 1.5 * ddTrain) {
        return {
            passed: false,
            reason: `DD instability: test DD $${ddTest.toFixed(2)} > 1.5 × train DD $${ddTrain.toFixed(2)}`,
        };
    }

    // Gate 5: Consistency — test Sharpe ≥ 0.5 × train Sharpe
    // Only apply when train Sharpe is positive (meaningful comparison)
    if (cr.trainStats.sharpeRatio > 0 && cr.testStats.sharpeRatio < 0.5 * cr.trainStats.sharpeRatio) {
        return {
            passed: false,
            reason: `Sharpe collapse: test ${cr.testStats.sharpeRatio.toFixed(2)} < 0.5 × train ${cr.trainStats.sharpeRatio.toFixed(2)}`,
        };
    }

    // Gate 6: Max drawdown ≤ 30% of initial capital
    if (initialCapital !== Infinity && ddTest > 0.30 * initialCapital) {
        return {
            passed: false,
            reason: `Test DD $${ddTest.toFixed(2)} > 30% of capital $${initialCapital}`,
        };
    }

    return { passed: true, reason: null };
}

/**
 * Filter cell results through hard gates, returning survivors and rejects.
 */
export function applyGates(
    results: CellResult[],
    initialCapital: number,
): { survivors: CellResult[]; rejects: Array<{ cell: CellResult; reason: string }> } {
    const survivors: CellResult[] = [];
    const rejects: Array<{ cell: CellResult; reason: string }> = [];

    for (const cr of results) {
        const gate = evaluateGates(cr, initialCapital);
        if (gate.passed) {
            survivors.push(cr);
        } else {
            rejects.push({ cell: cr, reason: gate.reason! });
        }
    }

    return { survivors, rejects };
}
