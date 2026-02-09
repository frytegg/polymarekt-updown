#!/usr/bin/env npx ts-node
/**
 * Crypto Pricer Arb - Backtest Entry Point
 *
 * Usage:
 *   npx ts-node backtest/index.ts [options]
 *
 * Options:
 *   --days <n>         Number of days to backtest (default: 7)
 *   --spread <cents>   Spread in cents (default: 6)
 *   --edge <pct>       Minimum edge percent (default: 2)
 *   --size <n>         Order size in shares (default: 100)
 *   --max-pos <n>      Max position per market (default: 1000)
 *   --export           Export results to CSV/JSON
 *   --verbose          Show detailed logs
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { Simulator } from './engine/simulator';
import { BacktestConfig, BacktestMode, AdjustmentMethod } from './types';
import { calculateStatistics, printStatistics, printEdgeDistribution } from './output/statistics';
import { exportBacktestResult, printTradeLog, printResolutionLog } from './output/trade-log';
import { printPnLCurve, printDrawdownAnalysis, exportPnLCurveToCsv } from './output/pnl-curve';

// Parse command line arguments
function parseArgs(): {
    days: number;
    spread: number;
    edge: number;
    size: number;
    maxPos: number;
    lag: number;
    latencyMs: number;
    volMultiplier: number;
    mode: BacktestMode;
    export: boolean;
    verbose: boolean;
    sweep: boolean;
    sweepMin: number;
    sweepMax: number;
    sweepStep: number;
    useChainlink: boolean;
    adjustment: number;
    adjustmentMethod: AdjustmentMethod;
    adjustmentWindow: number;
    fees: boolean;
    cooldownMs: number;
    maxTrades: number;
    maxOrderUsd: number;
    maxPositionUsd: number;
} {
    const args = process.argv.slice(2);
    const result = {
        days: 7,
        spread: 6,
        edge: 2,
        size: 100,
        maxPos: 1000,
        lag: 0,
        latencyMs: 0,
        volMultiplier: 1.0,
        mode: 'normal' as BacktestMode,
        export: false,
        verbose: false,
        sweep: false,
        sweepMin: 0,
        sweepMax: 30,
        sweepStep: 2,
        useChainlink: false,
        adjustment: 0,
        adjustmentMethod: 'static' as AdjustmentMethod,
        adjustmentWindow: 2,
        fees: false,
        cooldownMs: 60000,
        maxTrades: 3,
        maxOrderUsd: Infinity,
        maxPositionUsd: Infinity,
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--days':
                result.days = parseInt(args[++i], 10) || 7;
                break;
            case '--spread':
                result.spread = parseFloat(args[++i]) || 1;
                break;
            case '--edge':
                result.edge = parseFloat(args[++i]) || 2;
                break;
            case '--size':
                result.size = parseInt(args[++i], 10) || 100;
                break;
            case '--max-pos':
                result.maxPos = parseInt(args[++i], 10) || 1000;
                break;
            case '--lag':
                result.lag = parseInt(args[++i], 10) || 0;
                break;
            case '--latency-ms':
                result.latencyMs = parseInt(args[++i], 10) || 0;
                break;
            case '--vol-mult':
                result.volMultiplier = parseFloat(args[++i]) || 1.0;
                break;
            case '--export':
                result.export = true;
                break;
            case '--verbose':
                result.verbose = true;
                break;
            case '--sweep':
                result.sweep = true;
                break;
            case '--sweep-min':
                result.sweepMin = parseFloat(args[++i]) || 0;
                break;
            case '--sweep-max':
                result.sweepMax = parseFloat(args[++i]) || 30;
                break;
            case '--sweep-step':
                result.sweepStep = parseFloat(args[++i]) || 2;
                break;
            case '--chainlink':
                result.useChainlink = true;
                break;
            case '--adjustment':
                result.adjustment = parseFloat(args[++i]) || 0;
                break;
            case '--adjustment-method':
                const method = args[++i] as AdjustmentMethod;
                if (['static', 'rolling-mean', 'ema', 'median'].includes(method)) {
                    result.adjustmentMethod = method;
                } else {
                    console.error(`Invalid adjustment method: ${method}. Use: static, rolling-mean, ema, median`);
                    process.exit(1);
                }
                break;
            case '--adjustment-window':
                result.adjustmentWindow = parseFloat(args[++i]) || 2;
                break;
            case '--conservative':
                result.mode = 'conservative';
                break;
            case '--normal':
                result.mode = 'normal';
                break;
            case '--fees':
                result.fees = true;
                break;
            case '--cooldown-ms':
                result.cooldownMs = parseInt(args[++i], 10) || 60000;
                break;
            case '--max-trades':
                result.maxTrades = parseInt(args[++i], 10) || 3;
                break;
            case '--max-order-usd':
                result.maxOrderUsd = parseFloat(args[++i]) || Infinity;
                break;
            case '--max-position-usd':
                result.maxPositionUsd = parseFloat(args[++i]) || Infinity;
                break;
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
Crypto Pricer Arb - Backtest

Usage: npx ts-node backtest/index.ts [options]

Options:
  --days <n>         Number of days to backtest (default: 7)
  --spread <cents>   Spread in cents to apply on trades (default: 6)
                     Buy price = mid + spread/2 (e.g., --spread 8 = buy at mid + 4¢)
  --edge <pct>       Minimum edge percentage to trade (default: 2)
  --size <n>         Order size in shares per trade (default: 100)
  --max-pos <n>      Maximum position per side per market (default: 1000)
  --lag <seconds>    Lag between BTC price and Polymarket execution (default: 0)
                     Simulates delay: see BTC at T-lag, trade Poly at T
  --latency-ms <ms>  Execution latency in milliseconds (default: 0)
                     Simulates delay: decide at T, execute at T+latency
  --vol-mult <x>     Volatility multiplier for short-term adjustment (default: 1.0)
                     Higher values = more conservative P(UP/DOWN) estimates
  --chainlink        Use Chainlink for fair value calculation (default: Binance)
                     Matches the oracle used for settlement
  --adjustment <$>   Binance→Chainlink price adjustment in USD (default: 0)
                     Set to -104 to correct for Chainlink being ~$104 lower than Binance
                     Only applies when using Binance (not --chainlink mode)
  --adjustment-method <method>
                     Method for calculating adjustment (default: static)
                     Options: static, rolling-mean, ema, median
                     - static: Use fixed --adjustment value
                     - rolling-mean: Rolling mean of Binance-Chainlink divergence
                     - ema: Exponential moving average of divergence
                     - median: Rolling median (robust to outliers)
  --adjustment-window <hours>
                     Rolling window size in hours for adaptive methods (default: 2)

  --normal           Normal mode (default): close price, no latency
  --conservative     Conservative mode: worst-case pricing (kline low/high), 200ms latency
                     Use this to simulate more realistic execution conditions

  --fees             Include Polymarket taker fees (15-min crypto markets)
                     Fee formula: shares × price × 0.25 × (price × (1 - price))²
                     Typical rates: 1.56% @ 50¢, 1.10% @ 30¢, 0.64% @ 80¢

  --cooldown-ms <ms> Minimum ms between trades per market+side (default: 60000)
                     Prevents unrealistic trade density (1 trade/tick at 60s intervals)
  --max-trades <n>   Maximum total trades per market across both sides (default: 3)
                     Mirrors real liquidity constraints
  --max-order-usd <$>  Maximum USD per order (default: unlimited)
  --max-position-usd <$> Maximum USD per market position (default: unlimited)

  --export           Export results to CSV/JSON files
  --verbose          Show detailed trade and resolution logs

  --sweep            Run edge sweep optimization (find optimal edge threshold)
  --sweep-min <pct>  Minimum edge to test (default: 0)
  --sweep-max <pct>  Maximum edge to test (default: 30)
  --sweep-step <pct> Step size for edge sweep (default: 2)

  --help, -h         Show this help message

Examples:
  npx ts-node backtest/index.ts --days 14 --spread 8 --edge 10 --lag 30
  npx ts-node backtest/index.ts --days 7 --spread 6 --edge 5 --lag 10 --size 10 --export --verbose
  npx ts-node backtest/index.ts --days 7 --sweep --sweep-min 0 --sweep-max 30 --sweep-step 2
  npx ts-node backtest/index.ts --days 14 --adjustment -104 --conservative
`);
}

// Sweep result for a single edge value
interface SweepResult {
    edge: number;
    pnl: number;
    trades: number;
    markets: number;
    winRate: number;
    avgEdge: number;
    sharpe: number;
    roi: number;
    totalFees: number;
}

async function runEdgeSweep(args: ReturnType<typeof parseArgs>): Promise<void> {
    console.log('\n' + '═'.repeat(70));
    console.log('  🎯 CRYPTO PRICER ARB - EDGE SWEEP OPTIMIZATION');
    console.log('═'.repeat(70));
    
    const now = new Date();
    const startDate = new Date(now.getTime() - args.days * 24 * 60 * 60 * 1000);
    
    console.log(`\n📋 Sweep Configuration:`);
    console.log(`   Mode:        ${args.mode.toUpperCase()}`);
    console.log(`   Period:      ${args.days} days`);
    console.log(`   Spread:      ${args.spread}¢`);
    console.log(`   Edge Range:  ${args.sweepMin}% → ${args.sweepMax}% (step: ${args.sweepStep}%)`);
    console.log(`   Order Size:  ${args.size} shares`);
    console.log(`   Lag:         ${args.lag}s`);
    console.log(`   Fees:        ${args.fees ? 'ENABLED' : 'DISABLED'}`);
    
    const results: SweepResult[] = [];
    const edgeValues: number[] = [];
    
    for (let edge = args.sweepMin; edge <= args.sweepMax; edge += args.sweepStep) {
        edgeValues.push(edge);
    }
    
    console.log(`\n🔄 Running ${edgeValues.length} backtests...\n`);
    
    for (let i = 0; i < edgeValues.length; i++) {
        const edge = edgeValues[i];
        process.stdout.write(`   [${i + 1}/${edgeValues.length}] Testing edge=${edge}%... `);
        
        const config: Partial<BacktestConfig> = {
            startDate,
            endDate: now,
            initialCapital: Infinity,
            spreadCents: args.spread,
            minEdge: edge / 100,
            orderSize: args.size,
            maxPositionPerMarket: args.maxPos,
            lagSeconds: args.lag,
            executionLatencyMs: args.latencyMs,
            volMultiplier: args.volMultiplier,
            mode: args.mode,
            useChainlinkForFairValue: args.useChainlink,
            binanceChainlinkAdjustment: args.adjustment,
            adjustmentMethod: args.adjustmentMethod,
            adjustmentWindowHours: args.adjustmentWindow,
            includeFees: args.fees,
            cooldownMs: args.cooldownMs,
            maxTradesPerMarket: args.maxTrades,
            maxOrderUsd: args.maxOrderUsd,
            maxPositionUsd: args.maxPositionUsd,
        };

        try {
            const simulator = new Simulator(config);
            const result = await simulator.run();
            const stats = calculateStatistics(result);
            
            results.push({
                edge,
                pnl: result.totalPnL,
                trades: result.totalTrades,
                markets: result.totalMarkets,
                winRate: stats.winRate,
                avgEdge: stats.avgEdgeAtTrade,
                sharpe: stats.sharpeRatio,
                roi: stats.avgRealizedEdge,
                totalFees: result.totalFeesPaid,
            });

            const pnlStr = result.totalPnL >= 0 ? `+$${result.totalPnL.toFixed(0)}` : `-$${Math.abs(result.totalPnL).toFixed(0)}`;
            const feeStr = result.totalFeesPaid > 0 ? `, fees: $${result.totalFeesPaid.toFixed(0)}` : '';
            console.log(`${pnlStr} (${result.totalTrades} trades, ${(stats.winRate * 100).toFixed(0)}% win${feeStr})`);
        } catch (err) {
            console.log(`ERROR`);
            results.push({
                edge,
                pnl: 0,
                trades: 0,
                markets: 0,
                winRate: 0,
                avgEdge: 0,
                sharpe: 0,
                roi: 0,
                totalFees: 0,
            });
        }
    }
    
    // Find optimal
    const sortedByPnl = [...results].sort((a, b) => b.pnl - a.pnl);
    const optimal = sortedByPnl[0];
    
    // Print results table
    console.log('\n' + '═'.repeat(90));
    console.log('  📊 SWEEP RESULTS');
    console.log('═'.repeat(90));
    console.log('\n  Edge%  │    P&L     │ Trades │ Markets │ Win% │ AvgEdge │ Sharpe │   ROI   │');
    console.log('  ───────┼────────────┼────────┼─────────┼──────┼─────────┼────────┼─────────┤');
    
    for (const r of results) {
        const isOptimal = r.edge === optimal.edge;
        const marker = isOptimal ? '🏆' : '  ';
        const pnlStr = r.pnl >= 0 ? `+$${r.pnl.toFixed(0).padStart(6)}` : `-$${Math.abs(r.pnl).toFixed(0).padStart(6)}`;
        
        console.log(
            `${marker}${r.edge.toString().padStart(4)}%  │ ${pnlStr} │ ${r.trades.toString().padStart(6)} │ ${r.markets.toString().padStart(7)} │ ` +
            `${(r.winRate * 100).toFixed(0).padStart(3)}% │ ${(r.avgEdge * 100).toFixed(1).padStart(5)}%  │ ${r.sharpe.toFixed(1).padStart(6)} │ ` +
            `${(r.roi * 100).toFixed(1).padStart(5)}%  │`
        );
    }
    
    console.log('  ───────┴────────────┴────────┴─────────┴──────┴─────────┴────────┴─────────┘\n');
    
    // Summary
    console.log('═'.repeat(90));
    console.log('  🏆 OPTIMAL EDGE THRESHOLD');
    console.log('═'.repeat(90));
    console.log(`\n   Edge:     ${optimal.edge}%`);
    console.log(`   P&L:      ${optimal.pnl >= 0 ? '+' : ''}$${optimal.pnl.toFixed(2)}`);
    console.log(`   Trades:   ${optimal.trades}`);
    console.log(`   Win Rate: ${(optimal.winRate * 100).toFixed(1)}%`);
    console.log(`   Sharpe:   ${optimal.sharpe.toFixed(2)}`);
    console.log(`   ROI:      ${(optimal.roi * 100).toFixed(2)}%\n`);
    
    // Show P&L curve ASCII
    console.log('  📈 P&L by Edge Threshold:\n');
    const maxPnl = Math.max(...results.map(r => r.pnl));
    const minPnl = Math.min(...results.map(r => r.pnl));
    const range = maxPnl - minPnl || 1;
    
    for (const r of results) {
        const normalized = (r.pnl - minPnl) / range;
        const barLen = Math.round(normalized * 40);
        const bar = '█'.repeat(barLen);
        const pnlStr = r.pnl >= 0 ? `+$${r.pnl.toFixed(0)}` : `-$${Math.abs(r.pnl).toFixed(0)}`;
        const marker = r.edge === optimal.edge ? '🏆' : '  ';
        console.log(`  ${marker}${r.edge.toString().padStart(3)}% │${bar.padEnd(40)} ${pnlStr}`);
    }
    console.log('');
}

async function main(): Promise<void> {
    // Parse arguments
    const args = parseArgs();
    
    // Run sweep mode if requested
    if (args.sweep) {
        await runEdgeSweep(args);
        return;
    }

    console.log('\n' + '═'.repeat(60));
    console.log('  🎯 CRYPTO PRICER ARB - BACKTEST');
    console.log('═'.repeat(60));

    // Build config
    const now = new Date();
    const startDate = new Date(now.getTime() - args.days * 24 * 60 * 60 * 1000);

    const config: Partial<BacktestConfig> = {
        startDate,
        endDate: now,
        initialCapital: Infinity, // Unlimited
        spreadCents: args.spread,
        minEdge: args.edge / 100, // Convert percentage to decimal
        orderSize: args.size,
        maxPositionPerMarket: args.maxPos,
        lagSeconds: args.lag,
        executionLatencyMs: args.latencyMs,
        useChainlinkForFairValue: args.useChainlink,
        volMultiplier: args.volMultiplier,
        mode: args.mode,
        binanceChainlinkAdjustment: args.adjustment,
        adjustmentMethod: args.adjustmentMethod,
        adjustmentWindowHours: args.adjustmentWindow,
        includeFees: args.fees,
        cooldownMs: args.cooldownMs,
        maxTradesPerMarket: args.maxTrades,
        maxOrderUsd: args.maxOrderUsd,
        maxPositionUsd: args.maxPositionUsd,
    };

    console.log('\n📋 Configuration:');
    console.log(`   Mode:        ${args.mode.toUpperCase()}`);
    console.log(`   Period:      ${args.days} days (${startDate.toLocaleDateString()} - ${now.toLocaleDateString()})`);
    console.log(`   Spread:      ${args.spread}¢ (buy at mid + ${args.spread / 2}¢)`);
    console.log(`   Min Edge:    ${args.edge}%`);
    console.log(`   Order Size:  ${args.size} shares`);
    console.log(`   Max Pos:     ${args.maxPos} shares per side`);
    console.log(`   Lag:         ${args.lag}s`);
    console.log(`   Latency:     ${args.latencyMs}ms${args.mode === 'conservative' ? ' (auto: 200ms)' : ''}`);
    console.log(`   Vol Mult:    ${args.volMultiplier}x`);
    console.log(`   FV Oracle:   ${args.useChainlink ? 'CHAINLINK' : 'BINANCE'}`);
    if (!args.useChainlink) {
        if (args.adjustmentMethod === 'static') {
            console.log(`   Adjustment:  STATIC ($${args.adjustment})`);
        } else {
            console.log(`   Adjustment:  ${args.adjustmentMethod.toUpperCase()} (${args.adjustmentWindow}h window, fallback: $${args.adjustment})`);
        }
    }
    console.log(`   Fees:        ${args.fees ? 'ENABLED (Polymarket taker fees)' : 'DISABLED'}`);

    // Create and run simulator
    const simulator = new Simulator(config);

    try {
        const result = await simulator.run();

        // Calculate statistics
        const stats = calculateStatistics(result);

        // Print results
        console.log('\n' + '═'.repeat(60));
        console.log('  📊 RESULTS');
        console.log('═'.repeat(60));

        // Summary statistics
        printStatistics(stats);

        // P&L curve
        if (result.pnlCurve.length > 0) {
            printPnLCurve(result.pnlCurve);
            printDrawdownAnalysis(result.pnlCurve);
        }

        // Edge distribution
        if (result.trades.length > 0) {
            printEdgeDistribution(result.trades);
        }

        // Verbose output
        if (args.verbose) {
            if (result.trades.length > 0) {
                printTradeLog(result.trades, 30);
            }
            if (result.resolutions.length > 0) {
                printResolutionLog(result.resolutions, 20);
            }
        }

        // Export results
        if (args.export) {
            console.log('\n📁 Exporting results...\n');
            const files = exportBacktestResult(result, 'backtest');
            exportPnLCurveToCsv(result.pnlCurve, 'backtest_pnl_curve.csv');

            console.log('\n📁 Exported files:');
            console.log(`   ${files.tradesJson}`);
            console.log(`   ${files.tradesCsv}`);
            console.log(`   ${files.resolutionsJson}`);
            console.log(`   ${files.resolutionsCsv}`);
            console.log(`   ${files.summaryJson}`);
        }

        // Final summary
        console.log('\n' + '═'.repeat(60));
        console.log('  📈 FINAL SUMMARY');
        console.log('═'.repeat(60));

        const pnlStr = result.totalPnL >= 0
            ? `🟢 +$${result.totalPnL.toFixed(2)}`
            : `🔴 -$${Math.abs(result.totalPnL).toFixed(2)}`;

        console.log(`\n   ${pnlStr} over ${result.totalMarkets} markets`);
        console.log(`   Win Rate: ${(stats.winRate * 100).toFixed(1)}% | Sharpe: ${stats.sharpeRatio.toFixed(2)}`);
        console.log(`   Avg Edge: ${(stats.avgEdgeAtTrade * 100).toFixed(2)}% | Edge Capture: ${(stats.edgeCapture * 100).toFixed(0)}%\n`);

    } catch (error: any) {
        console.error('\n❌ Backtest failed:', error.message);
        if (args.verbose) {
            console.error(error.stack);
        }
        process.exit(1);
    }
}

// Run
main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});

