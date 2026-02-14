/**
 * Scoring & Winner Selection — Rank stress-test survivors by score.
 *
 * Score formula: Profit_test - 0.5 × |MaxDrawdown_test|
 *
 * The winner is the cell with the highest score among stress-test survivors.
 * If no survivors remain after stress tests, falls back to the best gate
 * survivor (without stress requirement).
 */

import { StressResult } from './stress-test';
import { CellResult } from './runner';
import { cellLabel, minimumBankroll } from './grid';

/** Scored cell with all metadata */
export interface ScoredCell {
    readonly cell: CellResult;
    readonly score: number;
    readonly stressResult: StressResult | null;
    readonly label: string;
    readonly minimumBankroll: number;
}

/**
 * Compute score for a cell result.
 * score = Profit_test - 0.5 × |MaxDrawdown_test|
 */
export function computeScore(cr: CellResult): number {
    return cr.testStats.totalPnL - 0.5 * Math.abs(cr.testStats.maxDrawdown);
}

/**
 * Score and rank stress-test survivors, select winner.
 *
 * @param stressResults - Results from stress testing
 * @param gateSurvivors - All cells that passed hard gates (fallback pool)
 * @returns Sorted array of ScoredCell (best first), or empty if no viable cells
 */
export function scoreAndRank(
    stressResults: StressResult[],
    gateSurvivors: CellResult[],
): ScoredCell[] {
    // Primary pool: cells that passed all stress scenarios
    const stressSurvivors = stressResults.filter(sr => sr.allPassed);

    let pool: Array<{ cr: CellResult; stress: StressResult | null }>;

    if (stressSurvivors.length > 0) {
        pool = stressSurvivors.map(sr => ({ cr: sr.cell, stress: sr }));
    } else {
        // Fallback: use all gate survivors (without stress requirement)
        pool = gateSurvivors.map(cr => ({ cr, stress: null }));
    }

    if (pool.length === 0) {
        return [];
    }

    // Score and sort descending
    const scored: ScoredCell[] = pool.map(({ cr, stress }) => ({
        cell: cr,
        score: computeScore(cr),
        stressResult: stress,
        label: cellLabel(cr.cell),
        minimumBankroll: minimumBankroll(cr.cell),
    }));

    scored.sort((a, b) => b.score - a.score);

    return scored;
}

/**
 * Get the winning cell (highest score).
 * Returns null if no viable cells.
 */
export function selectWinner(ranked: ScoredCell[]): ScoredCell | null {
    return ranked.length > 0 ? ranked[0] : null;
}
