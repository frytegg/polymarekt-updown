#!/usr/bin/env npx ts-node
/**
 * Crypto Pricer Arb - Backtest Entry Point
 *
 * CHANGELOG (2026-02-12):
 * =======================
 * Added explicit date range support to enable backtesting with cached data:
 *   - NEW: --from <YYYY-MM-DD>  Explicit start date
 *   - NEW: --to <YYYY-MM-DD>    Explicit end date
 *   - NEW: --cache-info         Show cached data files
 *   - FIX: Date resolution priority (explicit > relative > default)
 *   - FIX: Cache-aware warnings before API fetch
 *   - BACKWARD COMPATIBLE: --days N still works exactly as before (to=now)
 *
 * Date Resolution Priority:
 *   1. --from X --to Y          → Use exact dates
 *   2. --from X --days N        → to = from + N days
 *   3. --to Y --days N          → from = to - N days
 *   4. --days N (default)       → from = now - N, to = now (ORIGINAL BEHAVIOR)
 *
 * Usage:
 *   npx ts-node backtest/index.ts [options]
 *
 * Options:
 *   See --help for full list (26 arguments total, all functional)
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { Simulator } from './engine/simulator';
import { BacktestConfig, BacktestMode, AdjustmentMethod } from './types';
import { calculateStatistics, printStatistics, printEdgeDistribution } from './output/statistics';
import { exportBacktestResult, printTradeLog, printResolutionLog } from './output/trade-log';
import { printPnLCurve, printDrawdownAnalysis, exportPnLCurveToCsv } from './output/pnl-curve';
import { createLogger } from '../core/logger';

const log = createLogger('Backtest:CLI', { mode: 'backtest' });

// Parse command line arguments
function parseArgs(): {
    days: number;
    from?: string;
    to?: string;
    spread: number;
    edge: number;
    edgeSource: 'cli' | 'env' | 'default';
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
    slippageBps: number;
    cooldownMs: number;
    maxTrades: number;
    maxOrderUsd: number;
    maxOrderUsdSource: 'cli' | 'env' | 'default';
    maxPositionUsd: number;
    maxPositionUsdSource: 'cli' | 'env' | 'default';
    initialCapital: number;
    initialCapitalSource: 'cli' | 'env' | 'default';
    cacheInfo: boolean;
} {
    const args = process.argv.slice(2);

    // Read .env values as defaults (CLI flags will override)
    // Priority: CLI > .env > hardcoded default
    const envDefaults = {
        edge: process.env.ARB_EDGE_MIN
            ? parseFloat(process.env.ARB_EDGE_MIN) * 100  // 0.2 → 20%
            : 2,
        maxOrderUsd: process.env.ARB_MAX_ORDER_USD
            ? parseFloat(process.env.ARB_MAX_ORDER_USD)
            : Infinity,
        maxPositionUsd: process.env.ARB_MAX_POSITION_USD
            ? parseFloat(process.env.ARB_MAX_POSITION_USD)
            : Infinity,
        initialCapital: process.env.ARB_MAX_TOTAL_USD
            ? parseFloat(process.env.ARB_MAX_TOTAL_USD)
            : Infinity,
        slippageBps: process.env.ARB_SLIPPAGE_BPS
            ? parseInt(process.env.ARB_SLIPPAGE_BPS, 10)
            : 200,
    };

    const result = {
        days: 7,
        from: undefined as string | undefined,
        to: undefined as string | undefined,
        spread: 6,
        edge: envDefaults.edge,
        edgeSource: (process.env.ARB_EDGE_MIN ? 'env' : 'default') as 'cli' | 'env' | 'default',
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
        fees: true,   // Fees ON by default — matches live trading
        slippageBps: envDefaults.slippageBps,
        cooldownMs: 60000,
        maxTrades: 3,
        maxOrderUsd: envDefaults.maxOrderUsd,
        maxOrderUsdSource: (process.env.ARB_MAX_ORDER_USD ? 'env' : 'default') as 'cli' | 'env' | 'default',
        maxPositionUsd: envDefaults.maxPositionUsd,
        maxPositionUsdSource: (process.env.ARB_MAX_POSITION_USD ? 'env' : 'default') as 'cli' | 'env' | 'default',
        initialCapital: envDefaults.initialCapital,
        initialCapitalSource: (process.env.ARB_MAX_TOTAL_USD ? 'env' : 'default') as 'cli' | 'env' | 'default',
        cacheInfo: false,
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--days':
                result.days = parseInt(args[++i], 10) || 7;
                break;
            case '--from':
                result.from = args[++i];
                break;
            case '--to':
                result.to = args[++i];
                break;
            case '--spread':
                result.spread = parseFloat(args[++i]) || 1;
                break;
            case '--edge':
                result.edge = parseFloat(args[++i]) || 2;
                result.edgeSource = 'cli';
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
                result.fees = true;  // Already default, kept for backward compat
                break;
            case '--no-fees':
                result.fees = false;
                break;
            case '--slippage': {
                const parsedSlippage = parseInt(args[++i], 10);
                result.slippageBps = isNaN(parsedSlippage) ? 200 : parsedSlippage;
                break;
            }
            case '--cooldown-ms':
                result.cooldownMs = parseInt(args[++i], 10) || 60000;
                break;
            case '--max-trades':
                result.maxTrades = parseInt(args[++i], 10) || 3;
                break;
            case '--max-order-usd':
                result.maxOrderUsd = parseFloat(args[++i]) || Infinity;
                result.maxOrderUsdSource = 'cli';
                break;
            case '--max-position-usd':
                result.maxPositionUsd = parseFloat(args[++i]) || Infinity;
                result.maxPositionUsdSource = 'cli';
                break;
            case '--initial-capital':
                result.initialCapital = parseFloat(args[++i]) || Infinity;
                result.initialCapitalSource = 'cli';
                break;
            case '--cache-info':
                result.cacheInfo = true;
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
  Date Range (pick one approach):
  --days <n>         Number of days back from now (default: 7)
                     Sets: startDate = now - days, endDate = now
  --from <YYYY-MM-DD> Explicit start date (e.g., 2025-01-15)
  --to <YYYY-MM-DD>  Explicit end date (e.g., 2025-01-22)
                     Combine: --from X --to Y (explicit range)
                              --from X --days N (from + N days)
                              --days N (backward compatible, now - N)
  --cache-info       Show cached data files and exit

  Trading Parameters:
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
  --no-fees          Disable fees (fees are ON by default)

  --slippage <bps>   Execution slippage in basis points (default: 200, from .env ARB_SLIPPAGE_BPS)
                     Live trading uses 200 bps (2%). Set to 0 for optimistic simulation.

  --cooldown-ms <ms> Minimum ms between trades per market+side (default: 60000)
                     Prevents unrealistic trade density (1 trade/tick at 60s intervals)
  --max-trades <n>   Maximum total trades per market across both sides (default: 3)
                     Mirrors real liquidity constraints

  Capital & Risk Management:
  --initial-capital <$>  Starting capital in USD (default: .env ARB_MAX_TOTAL_USD or unlimited)
                         Enables: ROI %, drawdown %, capital utilization metrics
                         Set to simulate realistic returns on your actual bankroll
  --max-order-usd <$>    Max USD per order (default: .env ARB_MAX_ORDER_USD or unlimited)
  --max-position-usd <$> Max USD per market (default: .env ARB_MAX_POSITION_USD or unlimited)

  Note: Risk parameters default to your .env config if present.
        CLI flags always override .env values.
        --edge also reads from .env ARB_EDGE_MIN (converted from decimal to %).

  --export           Export results to CSV/JSON files
  --verbose          Show detailed trade and resolution logs

  --sweep            Run edge sweep optimization (find optimal edge threshold)
  --sweep-min <pct>  Minimum edge to test (default: 0)
  --sweep-max <pct>  Maximum edge to test (default: 30)
  --sweep-step <pct> Step size for edge sweep (default: 2)

  --help, -h         Show this help message

Examples:
  # Relative date (backward compatible)
  npx ts-node backtest/index.ts --days 14 --spread 8 --edge 10 --lag 30

  # Explicit date range (use cached data)
  npx ts-node backtest/index.ts --from 2025-01-15 --to 2025-01-22 --spread 6 --edge 5

  # Backtest with your live risk params (reads from .env)
  npx ts-node backtest/index.ts --from 2026-01-06 --to 2026-01-30

  # Override capital for what-if analysis
  npx ts-node backtest/index.ts --from 2026-01-06 --to 2026-01-30 --initial-capital 500

  # Show what's cached locally
  npx ts-node backtest/index.ts --cache-info

  # Sweep with realistic capital
  npx ts-node backtest/index.ts --from 2026-01-06 --to 2026-01-30 --initial-capital 100 --sweep

  # Conservative mode with adjustment
  npx ts-node backtest/index.ts --days 14 --adjustment -104 --conservative
`);
}

/**
 * Resolve start and end dates with priority:
 * 1. Explicit: --from X --to Y (highest priority)
 * 2. Relative from explicit: --from X --days N → to = from + N days
 * 3. Relative to now (backward compat): --days N → from = now - N, to = now
 *
 * BACKWARD COMPATIBILITY TEST CASES:
 * ===================================
 * All pre-existing CLI patterns must continue to work exactly as before.
 *
 * Test 1: Default behavior (no date args)
 *   Command: npx ts-node backtest/index.ts
 *   Expected: startDate = now - 7 days, endDate = now
 *   Priority: 4 (default)
 *
 * Test 2: Relative from now (original --days behavior)
 *   Command: npx ts-node backtest/index.ts --days 14
 *   Expected: startDate = now - 14 days, endDate = now
 *   Priority: 4 (backward compatible)
 *   CRITICAL: This MUST work exactly as before for all existing scripts
 *
 * Test 3: Combined with other args (original usage pattern)
 *   Command: npx ts-node backtest/index.ts --days 7 --spread 8 --edge 10
 *   Expected: startDate = now - 7 days, endDate = now, spread=8, edge=10
 *   Priority: 4 + other args
 *   CRITICAL: All existing command lines must work unchanged
 *
 * NEW FUNCTIONALITY TEST CASES:
 * ==============================
 * Test 4: Explicit date range (NEW)
 *   Command: npx ts-node backtest/index.ts --from 2025-01-15 --to 2025-01-22
 *   Expected: startDate = 2025-01-15, endDate = 2025-01-22
 *   Priority: 1 (explicit)
 *
 * Test 5: Relative from explicit start (NEW)
 *   Command: npx ts-node backtest/index.ts --from 2025-01-15 --days 7
 *   Expected: startDate = 2025-01-15, endDate = 2025-01-22 (from + 7 days)
 *   Priority: 2 (relative from explicit)
 *
 * Test 6: Relative to explicit end (NEW)
 *   Command: npx ts-node backtest/index.ts --to 2025-01-22 --days 7
 *   Expected: startDate = 2025-01-15 (to - 7 days), endDate = 2025-01-22
 *   Priority: 3 (relative to explicit)
 *
 * Test 7: Cache info command (NEW)
 *   Command: npx ts-node backtest/index.ts --cache-info
 *   Expected: Lists cached files in data/ and exits (no backtest run)
 *
 * ERROR CASES:
 * ============
 * Test 8: Invalid date format
 *   Command: npx ts-node backtest/index.ts --from 2025-13-45
 *   Expected: Error message + exit(1)
 *
 * Test 9: End before start
 *   Command: npx ts-node backtest/index.ts --from 2025-01-22 --to 2025-01-15
 *   Expected: Error message + exit(1)
 */
function resolveDates(args: ReturnType<typeof parseArgs>): { startDate: Date; endDate: Date } {
    const now = new Date();

    // Priority 1: Explicit --from and --to
    if (args.from && args.to) {
        const startDate = new Date(args.from);
        const endDate = new Date(args.to);

        if (isNaN(startDate.getTime())) {
            console.error(`❌ Invalid --from date: ${args.from}. Use YYYY-MM-DD format.`);
            process.exit(1);
        }
        if (isNaN(endDate.getTime())) {
            console.error(`❌ Invalid --to date: ${args.to}. Use YYYY-MM-DD format.`);
            process.exit(1);
        }
        if (endDate <= startDate) {
            console.error(`❌ --to date must be after --from date.`);
            process.exit(1);
        }

        return { startDate, endDate };
    }

    // Priority 2: --from with --days (relative from explicit start)
    if (args.from) {
        const startDate = new Date(args.from);

        if (isNaN(startDate.getTime())) {
            console.error(`❌ Invalid --from date: ${args.from}. Use YYYY-MM-DD format.`);
            process.exit(1);
        }

        const endDate = new Date(startDate.getTime() + args.days * 24 * 60 * 60 * 1000);
        return { startDate, endDate };
    }

    // Priority 3: --to with --days (relative to explicit end)
    if (args.to) {
        const endDate = new Date(args.to);

        if (isNaN(endDate.getTime())) {
            console.error(`❌ Invalid --to date: ${args.to}. Use YYYY-MM-DD format.`);
            process.exit(1);
        }

        const startDate = new Date(endDate.getTime() - args.days * 24 * 60 * 60 * 1000);
        return { startDate, endDate };
    }

    // Priority 4 (default): --days relative to now (backward compatible)
    const startDate = new Date(now.getTime() - args.days * 24 * 60 * 60 * 1000);
    const endDate = now;

    return { startDate, endDate };
}

/**
 * Check if cache exists for date range and warn if missing
 * Returns true if all expected cache files exist
 */
async function checkCacheAvailability(startDate: Date, endDate: Date): Promise<boolean> {
    const fs = await import('fs/promises');
    const path = await import('path');
    const dataDir = path.join(__dirname, '../data');

    const startStr = startDate.toISOString().split('T')[0];
    const endStr = endDate.toISOString().split('T')[0];

    const sources = ['binance', 'chainlink', 'deribit'];
    const missingCaches: string[] = [];

    for (const source of sources) {
        const sourceDir = path.join(dataDir, source);

        try {
            const files = await fs.readdir(sourceDir);

            // Check if any cache file covers this date range (or subset)
            // Cache files are named: {source}_{symbol}_{startDate}_{endDate}.json
            const hasMatchingCache = files.some(file => {
                const match = file.match(/(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.json$/);
                if (!match) return false;

                const cacheStart = match[1];
                const cacheEnd = match[2];

                // Check if cache covers the requested range
                return cacheStart <= startStr && cacheEnd >= endStr;
            });

            if (!hasMatchingCache) {
                missingCaches.push(source);
            }
        } catch {
            missingCaches.push(source);
        }
    }

    if (missingCaches.length > 0) {
        console.log(`\n⚠️  Cache Warning:`);
        console.log(`   Missing cache for: ${missingCaches.join(', ')}`);
        console.log(`   Date range: ${startStr} → ${endStr}`);
        console.log(`   Will fetch from API (may take several minutes)\n`);
        return false;
    }

    return true;
}

/**
 * Print cached data files and exit
 * Scans data/ subdirectories and lists available date ranges per source
 */
async function printCacheInfo(): Promise<void> {
    console.log('\n' + '═'.repeat(60));
    console.log('  📦 CACHED DATA FILES');
    console.log('═'.repeat(60) + '\n');

    const fs = await import('fs/promises');
    const path = await import('path');
    const dataDir = path.join(__dirname, '../data');

    try {
        // Check if data/ directory exists
        await fs.access(dataDir);
    } catch {
        console.log('❌ No data/ directory found');
        console.log(`   Expected at: ${dataDir}\n`);
        process.exit(0);
    }

    const sources = ['binance', 'chainlink', 'polymarket', 'deribit'];
    let totalFiles = 0;

    for (const source of sources) {
        const sourceDir = path.join(dataDir, source);

        try {
            const files = await fs.readdir(sourceDir);
            const jsonFiles = files.filter(f => f.endsWith('.json'));

            if (jsonFiles.length === 0) {
                console.log(`📁 ${source.toUpperCase()}/`);
                console.log(`   No cached files\n`);
                continue;
            }

            console.log(`📁 ${source.toUpperCase()}/ (${jsonFiles.length} file${jsonFiles.length > 1 ? 's' : ''})`);

            // Parse and display date ranges
            const cacheEntries: Array<{ file: string; start: string; end: string }> = [];

            for (const file of jsonFiles) {
                // Parse filename: {source}_{symbol}_{startDate}_{endDate}.json
                // OR: {source}_{startDate}_{endDate}.json (for chainlink)
                const match = file.match(/(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.json$/);
                if (match) {
                    cacheEntries.push({
                        file,
                        start: match[1],
                        end: match[2],
                    });
                }
            }

            // Sort by start date
            cacheEntries.sort((a, b) => a.start.localeCompare(b.start));

            for (const entry of cacheEntries) {
                console.log(`   ${entry.start} → ${entry.end}  ${entry.file}`);
            }

            if (cacheEntries.length < jsonFiles.length) {
                const unmatched = jsonFiles.length - cacheEntries.length;
                console.log(`   (${unmatched} file${unmatched > 1 ? 's' : ''} with non-standard naming)`);
            }

            console.log('');
            totalFiles += jsonFiles.length;
        } catch {
            console.log(`📁 ${source.toUpperCase()}/`);
            console.log(`   Directory not found\n`);
        }
    }

    if (totalFiles === 0) {
        console.log('💡 No cached data found. Run a backtest to generate cache files.\n');
    } else {
        console.log(`📊 Total: ${totalFiles} cached file${totalFiles > 1 ? 's' : ''}\n`);
        console.log('💡 Use --from <date> --to <date> to rerun backtests with cached data\n');
    }

    process.exit(0);
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

    // Resolve dates with priority: explicit > relative > default
    const { startDate, endDate } = resolveDates(args);

    // Helper function to format source attribution
    const formatSource = (source: 'cli' | 'env' | 'default'): string => {
        if (source === 'cli') return '(from CLI)';
        if (source === 'env') return '(from .env)';
        return '';
    };

    console.log(`\n📋 Sweep Configuration:`);
    console.log(`   Mode:        ${args.mode.toUpperCase()}`);
    console.log(`   Period:      ${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()}`);
    console.log(`   Spread:      ${args.spread}¢`);
    console.log(`   Edge Range:  ${args.sweepMin}% → ${args.sweepMax}% (step: ${args.sweepStep}%)`);
    console.log(`   Order Size:  ${args.size} shares`);
    console.log(`   Lag:         ${args.lag}s`);
    console.log(`   Fees:        ${args.fees ? 'ENABLED' : 'DISABLED'}`);
    console.log(`   Slippage:    ${args.slippageBps} bps`);

    // Capital & Risk Management (show if not defaults)
    const showCapitalSection = args.maxOrderUsd !== Infinity || args.maxPositionUsd !== Infinity || args.initialCapital !== Infinity;
    if (showCapitalSection) {
        if (args.maxOrderUsd !== Infinity) {
            console.log(`   Max Order:   $${args.maxOrderUsd.toFixed(2)} ${formatSource(args.maxOrderUsdSource)}`);
        }
        if (args.maxPositionUsd !== Infinity) {
            console.log(`   Max Position: $${args.maxPositionUsd.toFixed(2)} ${formatSource(args.maxPositionUsdSource)}`);
        }
        if (args.initialCapital !== Infinity) {
            console.log(`   Capital:     $${args.initialCapital.toFixed(2)} ${formatSource(args.initialCapitalSource)}`);
        }
    }
    
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
            endDate,
            initialCapital: args.initialCapital, // From .env ARB_MAX_TOTAL_USD or CLI
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
            slippageBps: args.slippageBps,
            cooldownMs: args.cooldownMs,
            maxTradesPerMarket: args.maxTrades,
            maxOrderUsd: args.maxOrderUsd,
            maxPositionUsd: args.maxPositionUsd,
        };

        try {
            const simulator = new Simulator(config);
            const result = await simulator.run();
            const stats = calculateStatistics(result);
            
            // Calculate ROI: use capital-based if finite, otherwise share-based
            const roi = result.initialCapital !== Infinity
                ? result.totalPnL / result.initialCapital
                : stats.avgRealizedEdge;

            results.push({
                edge,
                pnl: result.totalPnL,
                trades: result.totalTrades,
                markets: result.totalMarkets,
                winRate: stats.winRate,
                avgEdge: stats.avgEdgeAtTrade,
                sharpe: stats.sharpeRatio,
                roi,
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

    // Handle --cache-info (exits after printing)
    if (args.cacheInfo) {
        await printCacheInfo();
        return;
    }

    // Run sweep mode if requested
    if (args.sweep) {
        await runEdgeSweep(args);
        return;
    }

    console.log('\n' + '═'.repeat(60));
    console.log('  🎯 CRYPTO PRICER ARB - BACKTEST');
    console.log('═'.repeat(60));

    // Resolve dates with priority: explicit > relative > default
    const { startDate, endDate } = resolveDates(args);

    const config: Partial<BacktestConfig> = {
        startDate,
        endDate,
        initialCapital: args.initialCapital, // From .env ARB_MAX_TOTAL_USD or CLI
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
        slippageBps: args.slippageBps,
        cooldownMs: args.cooldownMs,
        maxTradesPerMarket: args.maxTrades,
        maxOrderUsd: args.maxOrderUsd,
        maxPositionUsd: args.maxPositionUsd,
    };

    // Helper function to format source attribution
    const formatSource = (source: 'cli' | 'env' | 'default'): string => {
        if (source === 'cli') return '(from CLI)';
        if (source === 'env') return '(from .env)';
        return '';
    };

    console.log('\n📋 Configuration:');
    console.log(`   Mode:        ${args.mode.toUpperCase()}`);
    console.log(`   Period:      ${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()}`);
    console.log(`   Spread:      ${args.spread}¢ (buy at mid + ${args.spread / 2}¢)`);
    console.log(`   Min Edge:    ${args.edge}% ${formatSource(args.edgeSource)}`);
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
    console.log(`   Slippage:    ${args.slippageBps} bps${args.slippageBps === 0 ? ' ⚠️  Live uses 200 bps' : ''}`);

    // Capital & Risk Management (show only if not using default values)
    const showCapitalSection = args.maxOrderUsd !== Infinity || args.maxPositionUsd !== Infinity || args.initialCapital !== Infinity;
    if (showCapitalSection) {
        console.log('\n   Capital & Risk:');
        if (args.maxOrderUsd !== Infinity) {
            console.log(`   Max Order:   $${args.maxOrderUsd.toFixed(2)} ${formatSource(args.maxOrderUsdSource)}`);
        }
        if (args.maxPositionUsd !== Infinity) {
            console.log(`   Max Position: $${args.maxPositionUsd.toFixed(2)} ${formatSource(args.maxPositionUsdSource)}`);
        }
        if (args.initialCapital !== Infinity) {
            console.log(`   Capital:     $${args.initialCapital.toFixed(2)} ${formatSource(args.initialCapitalSource)}`);
        }
    }

    // Check cache availability and warn if missing (non-blocking)
    await checkCacheAvailability(startDate, endDate);

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

        // Capital metrics (only if initialCapital is finite)
        if (result.initialCapital !== Infinity) {
            console.log('\n💰 Capital Metrics');
            console.log('─'.repeat(60));
            const roi = (result.totalPnL / result.initialCapital) * 100;
            const roiStr = roi >= 0 ? `+${roi.toFixed(1)}%` : `${roi.toFixed(1)}%`;
            const roiEmoji = roi >= 0 ? '🟢' : '🔴';
            console.log(`${roiEmoji} ROI:                  ${roiStr}`);
            console.log(`   Initial Capital:      $${result.initialCapital.toFixed(2)}`);
            console.log(`   Final Capital:        $${result.finalCapital.toFixed(2)}`);
            console.log(`   Peak Deployed:        $${result.peakDeployedCapital.toFixed(2)} (${(result.capitalUtilization * 100).toFixed(1)}% utilization)`);

            if (result.initialCapital > 0) {
                const maxDDPct = (result.maxDrawdown / result.initialCapital) * 100;
                console.log(`   Max Drawdown:         $${result.maxDrawdown.toFixed(2)} (${maxDDPct.toFixed(1)}% of capital)`);
            }
        }

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

