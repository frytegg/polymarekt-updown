/**
 * Optimizer Report — Console output and JSON/Markdown report generation.
 *
 * Outputs:
 *   1. Console summary during run (grid progress, gate results, winner)
 *   2. data/optimizer-report.json — machine-readable results
 *   3. data/optimizer-report.md — human-readable Markdown summary
 */

import * as fs from 'fs';
import * as path from 'path';
import { CellResult } from './runner';
import { StressResult } from './stress-test';
import { ScoredCell } from './scoring';
import { GridCell, cellLabel, minimumBankroll } from './grid';
import { DateSplit } from './train-test-split';

/** Full optimizer result for serialization */
export interface OptimizerReport {
    readonly generatedAt: string;
    readonly dateRange: {
        readonly full: { start: string; end: string };
        readonly train: { start: string; end: string; days: number };
        readonly test: { start: string; end: string; days: number };
    };
    readonly gridSize: number;
    readonly gateSurvivors: number;
    readonly stressSurvivors: number;
    readonly winner: {
        readonly minEdgePct: number;
        readonly kellyFraction: number;
        readonly score: number;
        readonly trainPnL: number;
        readonly testPnL: number;
        readonly trainSharpe: number;
        readonly testSharpe: number;
        readonly trainMaxDD: number;
        readonly testMaxDD: number;
        readonly trainTrades: number;
        readonly testTrades: number;
        readonly minimumBankroll: number;
    } | null;
    readonly allCells: Array<{
        readonly minEdgePct: number;
        readonly kellyFraction: number;
        readonly trainPnL: number;
        readonly testPnL: number;
        readonly trainTrades: number;
        readonly testTrades: number;
        readonly gateResult: string;  // 'PASS' or rejection reason
    }>;
}

/**
 * Print the optimizer grid results to console.
 */
export function printGridSummary(
    results: CellResult[],
    rejects: Array<{ cell: CellResult; reason: string }>,
    survivors: CellResult[],
): void {
    console.log('\n' + '='.repeat(70));
    console.log('  GRID RESULTS');
    console.log('='.repeat(70));

    // Create a set of rejected cell labels for quick lookup
    const rejectMap = new Map<string, string>();
    for (const r of rejects) {
        rejectMap.set(cellLabel(r.cell.cell), r.reason);
    }

    console.log(`\n  ${'Cell'.padEnd(28)} ${'Train P&L'.padStart(12)} ${'Test P&L'.padStart(12)} ${'Trades'.padStart(8)} ${'Gate'.padStart(8)}`);
    console.log('  ' + '-'.repeat(68));

    for (const cr of results) {
        const label = cellLabel(cr.cell);
        const trainPnL = cr.trainStats.totalPnL;
        const testPnL = cr.testStats.totalPnL;
        const trades = cr.trainResult.totalTrades + cr.testResult.totalTrades;
        const rejection = rejectMap.get(label);
        const gate = rejection ? 'FAIL' : 'PASS';

        console.log(
            `  ${label.padEnd(28)} $${trainPnL.toFixed(2).padStart(11)} $${testPnL.toFixed(2).padStart(11)} ${String(trades).padStart(8)} ${gate.padStart(8)}`
        );
    }

    console.log(`\n  Survivors: ${survivors.length} / ${results.length}`);
}

/**
 * Print stress test results to console.
 */
export function printStressResults(stressResults: StressResult[]): void {
    if (stressResults.length === 0) return;

    console.log('\n' + '='.repeat(70));
    console.log('  STRESS TESTS');
    console.log('='.repeat(70));

    for (const sr of stressResults) {
        const label = cellLabel(sr.cell.cell);
        const status = sr.allPassed ? 'ALL PASS' : 'FAILED';
        console.log(`\n  ${label} — ${status}`);

        for (const s of sr.scenarios) {
            const mark = s.passed ? 'PASS' : 'FAIL';
            console.log(`    ${s.scenario.name.padEnd(20)} P&L=$${s.stats.totalPnL.toFixed(2).padStart(10)}  [${mark}]`);
        }
    }
}

/**
 * Print the winner to console.
 */
export function printWinner(winner: ScoredCell | null, ranked: ScoredCell[]): void {
    console.log('\n' + '='.repeat(70));
    console.log('  WINNER');
    console.log('='.repeat(70));

    if (!winner) {
        console.log('\n  No viable configuration found. All cells rejected.');
        return;
    }

    const cr = winner.cell;
    console.log(`\n  Config:       ${winner.label}`);
    console.log(`  Score:        ${winner.score.toFixed(2)}`);
    console.log(`  Min Bankroll: $${winner.minimumBankroll}`);
    console.log(`  Train P&L:    $${cr.trainStats.totalPnL.toFixed(2)} (${cr.trainResult.totalTrades} trades, Sharpe ${cr.trainStats.sharpeRatio.toFixed(2)})`);
    console.log(`  Test P&L:     $${cr.testStats.totalPnL.toFixed(2)} (${cr.testResult.totalTrades} trades, Sharpe ${cr.testStats.sharpeRatio.toFixed(2)})`);
    console.log(`  Train MaxDD:  $${cr.trainStats.maxDrawdown.toFixed(2)}`);
    console.log(`  Test MaxDD:   $${cr.testStats.maxDrawdown.toFixed(2)}`);

    if (ranked.length > 1) {
        console.log(`\n  Runner-ups:`);
        for (let i = 1; i < Math.min(ranked.length, 4); i++) {
            const r = ranked[i];
            console.log(`    #${i + 1} ${r.label} — score=${r.score.toFixed(2)}, test P&L=$${r.cell.testStats.totalPnL.toFixed(2)}`);
        }
    }
}

/**
 * Generate and save the full report (JSON + Markdown).
 */
export function saveReport(
    split: DateSplit,
    results: CellResult[],
    survivors: CellResult[],
    rejects: Array<{ cell: CellResult; reason: string }>,
    stressResults: StressResult[],
    ranked: ScoredCell[],
    winner: ScoredCell | null,
): void {
    const dataDir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    // Build reject map
    const rejectMap = new Map<string, string>();
    for (const r of rejects) {
        rejectMap.set(cellLabel(r.cell.cell), r.reason);
    }

    const report: OptimizerReport = {
        generatedAt: new Date().toISOString(),
        dateRange: {
            full: {
                start: split.trainStart.toISOString().split('T')[0],
                end: split.testEnd.toISOString().split('T')[0],
            },
            train: {
                start: split.trainStart.toISOString().split('T')[0],
                end: split.trainEnd.toISOString().split('T')[0],
                days: split.trainDays,
            },
            test: {
                start: split.testStart.toISOString().split('T')[0],
                end: split.testEnd.toISOString().split('T')[0],
                days: split.testDays,
            },
        },
        gridSize: results.length,
        gateSurvivors: survivors.length,
        stressSurvivors: stressResults.filter(sr => sr.allPassed).length,
        winner: winner ? {
            minEdgePct: winner.cell.cell.minEdgePct,
            kellyFraction: winner.cell.cell.kellyFraction,
            score: winner.score,
            trainPnL: winner.cell.trainStats.totalPnL,
            testPnL: winner.cell.testStats.totalPnL,
            trainSharpe: winner.cell.trainStats.sharpeRatio,
            testSharpe: winner.cell.testStats.sharpeRatio,
            trainMaxDD: winner.cell.trainStats.maxDrawdown,
            testMaxDD: winner.cell.testStats.maxDrawdown,
            trainTrades: winner.cell.trainResult.totalTrades,
            testTrades: winner.cell.testResult.totalTrades,
            minimumBankroll: winner.minimumBankroll,
        } : null,
        allCells: results.map(cr => {
            const label = cellLabel(cr.cell);
            const rejection = rejectMap.get(label);
            return {
                minEdgePct: cr.cell.minEdgePct,
                kellyFraction: cr.cell.kellyFraction,
                trainPnL: cr.trainStats.totalPnL,
                testPnL: cr.testStats.totalPnL,
                trainTrades: cr.trainResult.totalTrades,
                testTrades: cr.testResult.totalTrades,
                gateResult: rejection ?? 'PASS',
            };
        }),
    };

    // Write JSON
    const jsonPath = path.join(dataDir, 'optimizer-report.json');
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    console.log(`\n  Report saved: ${jsonPath}`);

    // Write Markdown
    const mdPath = path.join(dataDir, 'optimizer-report.md');
    fs.writeFileSync(mdPath, generateMarkdown(report, stressResults));
    console.log(`  Report saved: ${mdPath}`);
}

function generateMarkdown(report: OptimizerReport, stressResults: StressResult[]): string {
    const lines: string[] = [];
    lines.push('# Optimizer Report');
    lines.push(`Generated: ${report.generatedAt}`);
    lines.push('');
    lines.push('## Date Range');
    lines.push(`- Full: ${report.dateRange.full.start} to ${report.dateRange.full.end}`);
    lines.push(`- Train: ${report.dateRange.train.start} to ${report.dateRange.train.end} (${report.dateRange.train.days} days)`);
    lines.push(`- Test: ${report.dateRange.test.start} to ${report.dateRange.test.end} (${report.dateRange.test.days} days)`);
    lines.push('');
    lines.push('## Summary');
    lines.push(`- Grid size: ${report.gridSize} cells`);
    lines.push(`- Gate survivors: ${report.gateSurvivors}`);
    lines.push(`- Stress survivors: ${report.stressSurvivors}`);
    lines.push('');

    if (report.winner) {
        const w = report.winner;
        lines.push('## Winner');
        lines.push(`- **minEdge**: ${w.minEdgePct}%`);
        lines.push(`- **kellyFraction**: ${w.kellyFraction}`);
        lines.push(`- **Score**: ${w.score.toFixed(2)}`);
        lines.push(`- **Minimum bankroll**: $${w.minimumBankroll}`);
        lines.push('');
        lines.push('| Metric | Train | Test |');
        lines.push('|--------|-------|------|');
        lines.push(`| P&L | $${w.trainPnL.toFixed(2)} | $${w.testPnL.toFixed(2)} |`);
        lines.push(`| Trades | ${w.trainTrades} | ${w.testTrades} |`);
        lines.push(`| Sharpe | ${w.trainSharpe.toFixed(2)} | ${w.testSharpe.toFixed(2)} |`);
        lines.push(`| Max DD | $${w.trainMaxDD.toFixed(2)} | $${w.testMaxDD.toFixed(2)} |`);
    } else {
        lines.push('## Winner');
        lines.push('No viable configuration found.');
    }

    lines.push('');
    lines.push('## All Cells');
    lines.push('| Edge% | Kelly | Train P&L | Test P&L | Trades | Gate |');
    lines.push('|-------|-------|-----------|----------|--------|------|');
    for (const c of report.allCells) {
        lines.push(`| ${c.minEdgePct} | ${c.kellyFraction} | $${c.trainPnL.toFixed(2)} | $${c.testPnL.toFixed(2)} | ${c.trainTrades + c.testTrades} | ${c.gateResult} |`);
    }

    if (stressResults.length > 0) {
        lines.push('');
        lines.push('## Stress Tests');
        for (const sr of stressResults) {
            const label = cellLabel(sr.cell.cell);
            const status = sr.allPassed ? 'ALL PASS' : 'FAILED';
            lines.push(`\n### ${label} — ${status}`);
            lines.push('| Scenario | P&L | Result |');
            lines.push('|----------|-----|--------|');
            for (const s of sr.scenarios) {
                lines.push(`| ${s.scenario.name} | $${s.stats.totalPnL.toFixed(2)} | ${s.passed ? 'PASS' : 'FAIL'} |`);
            }
        }
    }

    lines.push('');
    return lines.join('\n');
}
