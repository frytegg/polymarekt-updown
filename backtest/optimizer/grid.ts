/**
 * Parameter Grid — Types and generation for optimizer search space.
 *
 * Grid dimensions:
 *   - minEdge: 8 values [22, 24, 25, 26, 28, 30, 33, 36] (percentages)
 *   - kellyFraction: 5 values [0.10, 0.20, 0.30, 0.40, 0.50]
 *   Total: 40 cells
 *
 * Edge values are PERCENTAGES in the grid (e.g., 25 means 25%).
 * Converted to decimals (0.25) when passed to Simulator config.
 */

/** A single cell in the optimizer grid */
export interface GridCell {
    readonly minEdgePct: number;     // e.g., 25 means 25%
    readonly kellyFraction: number;  // e.g., 0.30
}

/** Default grid edge values (percentages) */
export const GRID_EDGE_VALUES: readonly number[] = [22, 24, 25, 26, 28, 30, 33, 36];

/** Default grid Kelly fraction values */
export const GRID_KELLY_VALUES: readonly number[] = [0.10, 0.20, 0.30, 0.40, 0.50];

/**
 * Generate the full parameter grid (cartesian product).
 *
 * @param edgeValues - Edge thresholds in percent (default: GRID_EDGE_VALUES)
 * @param kellyValues - Kelly fractions (default: GRID_KELLY_VALUES)
 * @returns Array of GridCell (length = edgeValues.length × kellyValues.length)
 */
export function generateGrid(
    edgeValues: readonly number[] = GRID_EDGE_VALUES,
    kellyValues: readonly number[] = GRID_KELLY_VALUES,
): GridCell[] {
    const cells: GridCell[] = [];
    for (const minEdgePct of edgeValues) {
        for (const kellyFraction of kellyValues) {
            cells.push({ minEdgePct, kellyFraction });
        }
    }
    return cells;
}

/**
 * Compute minimum bankroll for a grid cell.
 * Formula: ceil(0.50 / (kellyFraction × minEdge))
 * where minEdge is decimal (e.g., 0.25).
 */
export function minimumBankroll(cell: GridCell): number {
    const minEdgeDecimal = cell.minEdgePct / 100;
    return Math.ceil(0.50 / (cell.kellyFraction * minEdgeDecimal));
}

/** Human-readable label for a grid cell */
export function cellLabel(cell: GridCell): string {
    return `edge=${cell.minEdgePct}%_kelly=${cell.kellyFraction}`;
}
