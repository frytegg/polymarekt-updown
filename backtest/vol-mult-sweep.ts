#!/usr/bin/env npx ts-node
/**
 * Volatility Multiplier Sweep
 * Tests different vol multipliers to find optimal setting
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { Simulator } from './engine/simulator';
import { BacktestConfig } from './types';
import { calculateStatistics } from './output/statistics';

interface SweepResult {
    volMult: number;
    pnl: number;
    trades: number;
    yesTrades: number;
    noTrades: number;
    winRate: number;
    avgEdge: number;
    edgeCapture: number;
    sharpe: number;
    roi: number;
}

async function runVolMultSweep(): Promise<void> {
    console.log('\n' + '═'.repeat(80));
    console.log('  🔬 VOLATILITY MULTIPLIER SWEEP');
    console.log('═'.repeat(80));

    // Configuration
    const days = 7;
    const spread = 4;      // 4¢ spread
    const edge = 10;       // 10% min edge
    const latencyMs = 200; // 200ms latency

    const now = new Date();
    const startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    console.log(`\n📋 Base Configuration:`);
    console.log(`   Period:      ${days} days`);
    console.log(`   Spread:      ${spread}¢`);
    console.log(`   Min Edge:    ${edge}%`);
    console.log(`   Latency:     ${latencyMs}ms`);

    // Vol multipliers to test
    const volMults = [1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0];

    console.log(`\n🔄 Testing ${volMults.length} vol multipliers: ${volMults.join(', ')}\n`);

    const results: SweepResult[] = [];

    for (let i = 0; i < volMults.length; i++) {
        const volMult = volMults[i];
        process.stdout.write(`   [${i + 1}/${volMults.length}] Vol mult=${volMult.toFixed(1)}x... `);

        const config: Partial<BacktestConfig> = {
            startDate,
            endDate: now,
            initialCapital: Infinity,
            spreadCents: spread,
            minEdge: edge / 100,
            orderSize: 100,
            maxPositionPerMarket: 1000,
            lagSeconds: 0,
            executionLatencyMs: latencyMs,
            volMultiplier: volMult,
            useChainlinkForFairValue: false,
        };

        try {
            const simulator = new Simulator(config);
            const result = await simulator.run();
            const stats = calculateStatistics(result);

            // Count YES vs NO trades
            const yesTrades = result.trades.filter(t => t.side === 'YES').length;
            const noTrades = result.trades.filter(t => t.side === 'NO').length;

            results.push({
                volMult,
                pnl: result.totalPnL,
                trades: result.totalTrades,
                yesTrades,
                noTrades,
                winRate: stats.winRate,
                avgEdge: stats.avgEdgeAtTrade,
                edgeCapture: stats.edgeCapture,
                sharpe: stats.sharpeRatio,
                roi: stats.avgRealizedEdge,
            });

            const pnlStr = result.totalPnL >= 0 ? `+$${result.totalPnL.toFixed(0)}` : `-$${Math.abs(result.totalPnL).toFixed(0)}`;
            console.log(`${pnlStr} (${result.totalTrades} trades: ${yesTrades}Y/${noTrades}N, ${(stats.winRate * 100).toFixed(0)}% win)`);
        } catch (err) {
            console.log(`ERROR`);
            results.push({
                volMult,
                pnl: 0,
                trades: 0,
                yesTrades: 0,
                noTrades: 0,
                winRate: 0,
                avgEdge: 0,
                edgeCapture: 0,
                sharpe: 0,
                roi: 0,
            });
        }
    }

    // Find optimal
    const sortedByPnl = [...results].sort((a, b) => b.pnl - a.pnl);
    const optimal = sortedByPnl[0];

    // Print results table
    console.log('\n' + '═'.repeat(100));
    console.log('  📊 SWEEP RESULTS');
    console.log('═'.repeat(100));
    console.log('\n  VolMult │     P&L     │ Trades │ YES/NO Split │ Win%  │ AvgEdge │ Capture │ Sharpe │   ROI   │');
    console.log('  ────────┼─────────────┼────────┼──────────────┼───────┼─────────┼─────────┼────────┼─────────┤');

    for (const r of results) {
        const isOptimal = r.volMult === optimal.volMult;
        const marker = isOptimal ? '🏆' : '  ';
        const pnlStr = r.pnl >= 0 ? `+$${r.pnl.toFixed(0).padStart(6)}` : `-$${Math.abs(r.pnl).toFixed(0).padStart(6)}`;
        const splitStr = `${r.yesTrades}/${r.noTrades}`;

        console.log(
            `${marker}${r.volMult.toFixed(1).padStart(5)}x  │ ${pnlStr} │ ${r.trades.toString().padStart(6)} │ ` +
            `${splitStr.padStart(12)} │ ${(r.winRate * 100).toFixed(0).padStart(4)}% │ ` +
            `${(r.avgEdge * 100).toFixed(1).padStart(5)}%  │ ${(r.edgeCapture * 100).toFixed(0).padStart(5)}%  │ ` +
            `${r.sharpe.toFixed(1).padStart(6)} │ ${(r.roi * 100).toFixed(1).padStart(5)}%  │`
        );
    }

    console.log('  ────────┴─────────────┴────────┴──────────────┴───────┴─────────┴─────────┴────────┴─────────┘\n');

    // Summary
    console.log('═'.repeat(100));
    console.log('  🏆 OPTIMAL VOL MULTIPLIER');
    console.log('═'.repeat(100));
    console.log(`\n   Vol Mult:     ${optimal.volMult}x`);
    console.log(`   P&L:          ${optimal.pnl >= 0 ? '+' : ''}$${optimal.pnl.toFixed(2)}`);
    console.log(`   Trades:       ${optimal.trades} (${optimal.yesTrades} YES / ${optimal.noTrades} NO)`);
    console.log(`   Win Rate:     ${(optimal.winRate * 100).toFixed(1)}%`);
    console.log(`   Edge Capture: ${(optimal.edgeCapture * 100).toFixed(0)}%`);
    console.log(`   Sharpe:       ${optimal.sharpe.toFixed(2)}`);
    console.log(`   ROI:          ${(optimal.roi * 100).toFixed(2)}%\n`);

    // P&L curve ASCII
    console.log('  📈 P&L by Vol Multiplier:\n');
    const maxPnl = Math.max(...results.map(r => r.pnl));
    const minPnl = Math.min(...results.map(r => r.pnl));
    const range = maxPnl - minPnl || 1;

    for (const r of results) {
        const normalized = (r.pnl - minPnl) / range;
        const barLen = Math.round(normalized * 40);
        const bar = '█'.repeat(barLen);
        const pnlStr = r.pnl >= 0 ? `+$${r.pnl.toFixed(0)}` : `-$${Math.abs(r.pnl).toFixed(0)}`;
        const marker = r.volMult === optimal.volMult ? '🏆' : '  ';
        console.log(`  ${marker}${r.volMult.toFixed(1)}x │${bar.padEnd(40)} ${pnlStr}`);
    }

    // YES/NO split visualization
    console.log('\n  📊 YES/NO Trade Split by Vol Multiplier:\n');
    for (const r of results) {
        const total = r.yesTrades + r.noTrades;
        if (total === 0) {
            console.log(`     ${r.volMult.toFixed(1)}x │ No trades`);
            continue;
        }
        const yesPct = r.yesTrades / total;
        const noPct = r.noTrades / total;
        const yesBar = '▓'.repeat(Math.round(yesPct * 30));
        const noBar = '░'.repeat(Math.round(noPct * 30));
        console.log(`     ${r.volMult.toFixed(1)}x │${yesBar}${noBar} YES:${(yesPct * 100).toFixed(0)}% NO:${(noPct * 100).toFixed(0)}%`);
    }

    console.log('\n');
}

// Run
runVolMultSweep().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
