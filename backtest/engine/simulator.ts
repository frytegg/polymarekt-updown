/**
 * Backtest Simulator
 * Main engine that orchestrates the backtest
 */

import {
    BacktestConfig,
    BacktestMode,
    BacktestResult,
    HistoricalMarket,
    AlignedTick,
    TradeSignal,
    FairValue,
    BinanceKline,
    PolymarketPricePoint,
    DeribitVolPoint,
    AdjustmentMethod,
} from '../types';

import { BinanceHistoricalFetcher } from '../fetchers/binance-historical';
import { PolymarketMarketsFetcher, determineOutcome } from '../fetchers/polymarket-markets';
import { PolymarketPricesFetcher } from '../fetchers/polymarket-prices';
import { DeribitVolFetcher } from '../fetchers/deribit-vol';
import { ChainlinkHistoricalFetcher, ChainlinkPricePoint } from '../fetchers/chainlink-historical';
import { OrderMatcher } from './order-matcher';
import { PositionTracker } from './position-tracker';
import { BlackScholesStrategy } from '../../core/strategies';
import { DivergenceCalculator } from './divergence-calculator';
import { createLogger } from '../../core/logger';
import { calculateRealizedVol as coreCalculateRealizedVol } from '../../core/vol-calculator';
import { DataBundle } from './data-bundle';

const DEFAULT_CONFIG: BacktestConfig = {
    startDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // 7 days ago
    endDate: new Date(),
    initialCapital: Infinity, // Unlimited
    spreadCents: 6,           // 6¢ spread (3¢ per side, realistic for BTC Up/Down 15-min markets)
    minEdge: 0.02,            // 2% minimum edge
    orderSize: 100,           // 100 shares per order
    maxPositionPerMarket: 1000, // Max 1000 shares per side
    lagSeconds: 0,            // No lag by default
    executionLatencyMs: 0,    // No execution latency by default
    useChainlinkForFairValue: false, // Use Binance by default
    volMultiplier: 1.0,       // No vol adjustment by default
    mode: 'normal',           // Normal mode by default
    binanceChainlinkAdjustment: 0, // No adjustment by default (set to -104 for divergence correction)
    adjustmentMethod: 'static', // Static adjustment by default
    adjustmentWindowHours: 2,   // 2-hour rolling window for adaptive methods
    includeFees: true,        // Fees ON by default — matches live trading. Use --no-fees to disable.
    slippageBps: 200,         // 200 bps (2%) matching live ARB_SLIPPAGE_BPS default
    cooldownMs: 60000,        // 60s cooldown between trades per market+side (1 per tick)
    maxTradesPerMarket: 3,    // Max 3 trades per market (mirrors real liquidity constraints)
    maxOrderUsd: Infinity,    // No USD limit by default (use share-based limits)
    maxPositionUsd: Infinity, // No USD position limit by default
    silent: false,            // Print output by default (CLI behavior unchanged)
};

/**
 * Volatility blend weights for short-term options (< 30 min)
 * Same as live trading volatility-service.ts
 */
const VOL_BLEND_CONFIG = {
    realized1h: 0.70,   // 70% weight on 1h realized vol
    realized4h: 0.20,   // 20% weight on 4h realized vol
    implied: 0.10,      // 10% weight on DVOL implied vol
    
    // Window sizes in candles (1-min candles)
    window1h: 60,       // 60 candles = 1 hour
    window4h: 240,      // 240 candles = 4 hours
};

/**
 * Main Backtest Simulator
 */
export class Simulator {
    private config: BacktestConfig;
    private binanceFetcher: BinanceHistoricalFetcher;
    private marketsFetcher: PolymarketMarketsFetcher;
    private pricesFetcher: PolymarketPricesFetcher;
    private volFetcher: DeribitVolFetcher;
    private chainlinkFetcher: ChainlinkHistoricalFetcher;
    private orderMatcher: OrderMatcher;
    private positionTracker: PositionTracker;
    private currentKlines: BinanceKline[] = [];
    private strategy: BlackScholesStrategy;
    private divergenceCalculator: DivergenceCalculator | null = null;

    // Mode-derived settings
    private useWorstCasePricing: boolean = false;
    private effectiveLatencyMs: number = 0;

    // Trade cooldown and limit tracking (per market)
    private lastTradeTimestamp: Map<string, number> = new Map(); // key: marketId:side
    private marketTradeCount: Map<string, number> = new Map();   // key: marketId

    // Capital tracking (for finite capital mode)
    private availableCapital: number = Infinity;  // Remaining capital to deploy
    private deployedCapital: number = 0;          // Capital currently in open positions
    private peakDeployedCapital: number = 0;      // Maximum capital deployed at any point

    // Logging — structured logger for non-silenceable logs
    private logger = createLogger('Backtest:Simulator', { mode: 'backtest' });

    /** Console output, suppressed when config.silent is true */
    private log(message: string): void {
        if (!this.config.silent) {
            console.log(message);
        }
    }

    /** Console warn output, suppressed when config.silent is true */
    private warn(message: string): void {
        if (!this.config.silent) {
            console.warn(message);
        }
    }

    constructor(config: Partial<BacktestConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };

        // Initialize capital tracking
        this.availableCapital = this.config.initialCapital;
        this.deployedCapital = 0;
        this.peakDeployedCapital = 0;

        // Apply mode settings
        this.applyModeSettings();

        // Initialize pricing strategy (Black-Scholes)
        this.strategy = new BlackScholesStrategy();

        this.binanceFetcher = new BinanceHistoricalFetcher('BTCUSDT', '1m');
        this.marketsFetcher = new PolymarketMarketsFetcher();
        this.pricesFetcher = new PolymarketPricesFetcher(1); // 1 minute fidelity
        this.volFetcher = new DeribitVolFetcher('BTC', 60);  // 1 minute resolution
        this.chainlinkFetcher = new ChainlinkHistoricalFetcher();
        this.orderMatcher = new OrderMatcher({
            spreadCents: this.config.spreadCents,
            includeFees: this.config.includeFees,
            slippageBps: this.config.slippageBps,
        });
        this.positionTracker = new PositionTracker();
    }

    /**
     * Apply mode-specific settings
     * Conservative mode: worst-case pricing + 200ms latency
     * Normal mode: close price + no latency
     */
    private applyModeSettings(): void {
        if (this.config.mode === 'conservative') {
            this.useWorstCasePricing = true;
            // Use configured latency or default to 200ms in conservative mode
            this.effectiveLatencyMs = this.config.executionLatencyMs || 200;
        } else {
            // Normal mode: use close price, no worst-case
            this.useWorstCasePricing = false;
            this.effectiveLatencyMs = this.config.executionLatencyMs;
        }
    }

    /**
     * Run the backtest
     */
    async run(bundle?: DataBundle): Promise<BacktestResult> {
        this.log('\n🚀 Starting Backtest...\n');
        this.log(`📅 Period: ${this.config.startDate.toISOString()} to ${this.config.endDate.toISOString()}`);
        this.log(`💰 Capital: ${this.config.initialCapital === Infinity ? 'Unlimited' : `$${this.config.initialCapital}`}`);
        this.log(`📊 Spread: ${this.config.spreadCents}¢ | Min Edge: ${(this.config.minEdge * 100).toFixed(1)}%`);
        this.log(`📦 Order Size: ${this.config.orderSize} shares | Max Position: ${this.config.maxPositionPerMarket}`);
        this.log(`⏱️ Lag: ${this.config.lagSeconds}s (BTC price delay before Poly execution)`);
        this.log(`🔗 Fair Value Oracle: ${this.config.useChainlinkForFairValue ? 'CHAINLINK' : 'BINANCE'}`);
        if (!this.config.useChainlinkForFairValue) {
            if (this.config.adjustmentMethod === 'static') {
                this.log(`📐 Adjustment Method: STATIC ($${this.config.binanceChainlinkAdjustment})`);
            } else {
                this.log(`📐 Adjustment Method: ${this.config.adjustmentMethod.toUpperCase()} (${this.config.adjustmentWindowHours}h window, fallback: $${this.config.binanceChainlinkAdjustment})`);
            }
        }
        this.log(`🎛️ Mode: ${this.config.mode.toUpperCase()} (worst-case: ${this.useWorstCasePricing ? 'ON' : 'OFF'}, latency: ${this.effectiveLatencyMs}ms)`);
        this.log(`💸 Fees: ${this.config.includeFees ? 'ENABLED (Polymarket taker fees)' : 'DISABLED'}`);
        this.log(`📉 Slippage: ${this.config.slippageBps} bps${this.config.slippageBps === 0 ? ' ⚠️  Live trading uses 200 bps. Results may be overly optimistic.' : ''}`);
        this.log(`🔄 Cooldown: ${this.config.cooldownMs}ms | Max Trades/Market: ${this.config.maxTradesPerMarket}`);
        if (this.config.maxOrderUsd < Infinity || this.config.maxPositionUsd < Infinity) {
            this.log(`💵 USD Limits: Order=$${this.config.maxOrderUsd}, Position=$${this.config.maxPositionUsd}`);
        }
        this.log('');

        const startTs = this.config.startDate.getTime();
        const endTs = this.config.endDate.getTime();

        // Reset state
        this.positionTracker.reset();
        this.orderMatcher.reset();
        this.lastTradeTimestamp.clear();
        this.marketTradeCount.clear();

        // Reset capital tracking
        this.availableCapital = this.config.initialCapital;
        this.deployedCapital = 0;
        this.peakDeployedCapital = 0;

        // Load data: use pre-loaded DataBundle if provided, otherwise fetch from disk/API
        let markets: HistoricalMarket[];
        let btcKlines: BinanceKline[];
        let volPoints: DeribitVolPoint[];
        let chainlinkPrices: ChainlinkPricePoint[];

        if (bundle) {
            // Use pre-loaded data from DataBundle (sweep/optimizer mode)
            this.log('📦 Using pre-loaded DataBundle (shared data)');
            markets = bundle.data.markets;
            btcKlines = bundle.data.btcKlines;
            volPoints = bundle.data.volPoints;
            chainlinkPrices = bundle.data.chainlinkPrices;
            this.currentKlines = btcKlines;
            this.log(`   ${markets.length} markets, ${btcKlines.length} klines, ${volPoints.length} vol points, ${chainlinkPrices.length} Chainlink points\n`);
        } else {
            // Step 1: Fetch all historical markets
            this.log('📡 Step 1: Fetching historical markets...');
            markets = await this.marketsFetcher.fetch(startTs, endTs);
            this.log(`   Found ${markets.length} markets\n`);

            // Step 2: Fetch Binance klines for entire period
            this.log('📡 Step 2: Fetching Binance BTC prices...');
            btcKlines = await this.binanceFetcher.fetch(startTs, endTs);
            this.currentKlines = btcKlines;
            this.log(`   Loaded ${btcKlines.length} price points\n`);

            // Step 3: Fetch Deribit volatility for entire period
            this.log('📡 Step 3: Fetching Deribit DVOL...');
            volPoints = await this.volFetcher.fetch(startTs, endTs);
            this.log(`   Loaded ${volPoints.length} volatility points\n`);

            // Step 4: Fetch Chainlink prices for market resolution
            this.log('📡 Step 4: Fetching Chainlink oracle prices...');
            chainlinkPrices = await this.chainlinkFetcher.fetch(startTs, endTs);
            this.log(`   Loaded ${chainlinkPrices.length} Chainlink price points\n`);
        }

        if (markets.length === 0) {
            this.log('❌ No markets found in date range');
            return this.generateEmptyResult();
        }

        // Step 4b: Initialize DivergenceCalculator if using adaptive adjustment
        if (this.config.adjustmentMethod !== 'static' && !this.config.useChainlinkForFairValue) {
            this.log('📊 Initializing DivergenceCalculator for adaptive adjustment...');
            this.divergenceCalculator = new DivergenceCalculator(chainlinkPrices, btcKlines);
            this.log('');
        }

        // Step 5: Process each market
        this.log('⚙️ Step 5: Processing markets...\n');
        let processedMarkets = 0;

        for (const market of markets) {
            // Skip markets without strike price
            if (!market.strikePrice || market.strikePrice <= 0) {
                this.log(`   ⏭️ Skipping ${market.question.slice(0, 40)}... (no strike price)`);
                continue;
            }

            await this.processMarket(market, btcKlines, volPoints, chainlinkPrices);
            processedMarkets++;

            if (processedMarkets % 10 === 0) {
                this.log(`   Processed ${processedMarkets}/${markets.length} markets...`);
            }
        }

        this.log(`\n✅ Processed ${processedMarkets} markets\n`);

        // Generate results
        return this.generateResult();
    }

    /**
     * Process a single market
     */
    private async processMarket(
        market: HistoricalMarket,
        btcKlines: BinanceKline[],
        volPoints: DeribitVolPoint[],
        chainlinkPrices: ChainlinkPricePoint[]
    ): Promise<void> {
        // Fetch Polymarket prices for this market
        let polyPrices: PolymarketPricePoint[] = [];
        try {
            polyPrices = await this.pricesFetcher.fetchYesOnly(
                market.tokenIds[0], // YES token
                market.startTime,
                market.endTime
            );
        } catch {
            // Skip if no price data
            return;
        }

        if (polyPrices.length === 0) {
            return;
        }

        // Align ticks - use Polymarket price timestamps as base
        const ticks = this.alignTicks(
            market,
            btcKlines,
            polyPrices,
            volPoints,
            chainlinkPrices
        );

        if (ticks.length === 0) {
            return;
        }

        // Simulate trading for each tick
        for (const tick of ticks) {
            this.processTick(market, tick);
        }

        // Resolve market at end using Chainlink (matches Polymarket's oracle)
        const chainlinkPoint = this.chainlinkFetcher.getClosestPrice(market.endTime, 60000);
        const binancePrice = this.binanceFetcher.getPriceAt(market.endTime);

        let finalBtcPrice: number;
        if (chainlinkPoint) {
            finalBtcPrice = chainlinkPoint.price;

            // Log significant divergence (> $50 difference)
            if (binancePrice && Math.abs(chainlinkPoint.price - binancePrice) > 50) {
                this.log(`   ⚠️ Oracle divergence at ${new Date(market.endTime).toISOString()}: Chainlink=$${chainlinkPoint.price.toFixed(2)}, Binance=$${binancePrice.toFixed(2)}`);
            }
        } else {
            this.warn(`   ⚠️ No Chainlink price for ${new Date(market.endTime).toISOString()}, using Binance`);
            finalBtcPrice = binancePrice!;
        }

        const outcome = determineOutcome(finalBtcPrice, market.strikePrice);

        // Get position before resolution to track capital return
        const positionBeforeResolve = this.positionTracker.getPosition(market.conditionId);

        this.positionTracker.resolve(
            market.conditionId,
            outcome,
            finalBtcPrice,
            market.strikePrice,
            market.endTime
        );

        // Return capital to available pool (if initialCapital is finite)
        if (this.config.initialCapital !== Infinity && positionBeforeResolve) {
            const totalCost = positionBeforeResolve.yesCost + positionBeforeResolve.noCost;

            // Calculate payout based on outcome
            const yesPayout = outcome === 'UP' ? positionBeforeResolve.yesShares : 0;
            const noPayout = outcome === 'DOWN' ? positionBeforeResolve.noShares : 0;
            const totalPayout = yesPayout + noPayout;

            // Return capital: deployed capital is freed, and we add/subtract P&L
            this.deployedCapital -= totalCost;
            this.availableCapital += totalPayout;
        }
    }

    /**
     * Align data from different sources into unified ticks
     *
     * IMPORTANT: Polymarket prices-history API returns last-trade price, which
     * approximates the mid price. It is NOT the ask price. The actual ask you'd
     * pay is mid + spread/2. This gap is modeled by the OrderMatcher via the
     * `spreadCents` config parameter (default 6¢ = 3¢ per side). Use --spread
     * to adjust for different liquidity assumptions.
     *
     * With lag: We see BTC price at T-lag, then trade on Polymarket at T
     * This simulates the delay between seeing an opportunity and executing
     *
     * Volatility: Uses blended vol (70% realized 1h + 20% realized 4h + 10% DVOL)
     * Same as live trading for consistency
     */
    private alignTicks(
        market: HistoricalMarket,
        btcKlines: BinanceKline[],
        polyPrices: PolymarketPricePoint[],
        volPoints: DeribitVolPoint[],
        chainlinkPrices: ChainlinkPricePoint[]
    ): AlignedTick[] {
        const ticks: AlignedTick[] = [];
        const lagMs = this.config.lagSeconds * 1000;
        const useChainlink = this.config.useChainlinkForFairValue;

        // Use Polymarket price timestamps as base (they define when we EXECUTE)
        for (const polyPrice of polyPrices) {
            const ts = polyPrice.timestamp;

            // Skip if outside market period
            if (ts < market.startTime || ts > market.endTime) continue;

            // IMPORTANT: Get BTC price from BEFORE the Polymarket price (T - lag)
            // This simulates: "I see BTC move at T-lag, then I trade on Poly at T"
            const btcTimestamp = ts - lagMs;

            // Skip if BTC timestamp is before market start (not enough data)
            if (btcTimestamp < market.startTime - 60000) continue;

            // Get kline index for this timestamp (needed for volatility calc)
            const klineIdx = this.getKlineIndex(btcKlines, btcTimestamp);
            const kline = btcKlines[klineIdx];

            // Get BTC price - either from Chainlink or Binance based on config
            // Use kline OPEN price (not close) to avoid look-ahead bias.
            // The close is not known until the candle ends (up to 60s later).
            // In live trading, we use real-time tick prices, which are closest to the open
            // of the current forming candle.
            // See OPTIMIZER-READINESS-AUDIT.md §1.1 (B.1).
            let btcPrice: number | null = null;
            if (useChainlink) {
                // Use Chainlink price for fair value calculation
                const chainlinkPoint = this.getChainlinkPriceAt(chainlinkPrices, btcTimestamp);
                btcPrice = chainlinkPoint?.price ?? null;
            } else {
                // Use Binance kline OPEN price (causal — known at candle start)
                btcPrice = kline?.open ?? null;
                if (btcPrice !== null) {
                    // Get adjustment based on method
                    const adjustment = this.getAdjustmentAtTime(btcTimestamp);
                    btcPrice = btcPrice + adjustment;
                }
            }

            if (!btcPrice) continue;

            // Get DVOL at this timestamp
            const dvolVol = this.getDvolAt(volPoints, btcTimestamp);

            // Calculate blended volatility (realized + implied)
            // Always use Binance klines for realized vol calculation
            const vol = this.getBlendedVol(btcKlines, klineIdx, dvolVol);

            // Time remaining based on when we EXECUTE (T), not when we decide (T-lag)
            const timeRemainingMs = market.endTime - ts;

            // Previous completed kline (all fields known — used for conservative mode)
            const prevKline = klineIdx > 0 ? btcKlines[klineIdx - 1] : undefined;

            ticks.push({
                timestamp: ts,
                btcPrice,
                btcKline: kline,
                prevBtcKline: prevKline,
                polyMidYes: polyPrice.price,
                polyMidNo: 1 - polyPrice.price,
                vol,
                timeRemainingMs,
            });
        }

        return ticks;
    }

    /**
     * Get Chainlink price at or just before timestamp
     */
    private getChainlinkPriceAt(prices: ChainlinkPricePoint[], timestamp: number): ChainlinkPricePoint | null {
        if (prices.length === 0) return null;

        // Binary search for price at or just before timestamp
        let left = 0;
        let right = prices.length - 1;

        while (left < right) {
            const mid = Math.floor((left + right + 1) / 2);
            if (prices[mid].timestamp <= timestamp) {
                left = mid;
            } else {
                right = mid - 1;
            }
        }

        // Check if within 2 minutes (Chainlink updates less frequently)
        const point = prices[left];
        if (timestamp - point.timestamp > 120000) {
            return null;
        }

        return point;
    }

    /**
     * Get the adjustment to apply at a given timestamp
     * Uses DivergenceCalculator if available, otherwise static adjustment
     */
    private getAdjustmentAtTime(timestamp: number): number {
        if (this.config.adjustmentMethod === 'static' || !this.divergenceCalculator) {
            return this.config.binanceChainlinkAdjustment;
        }

        return this.divergenceCalculator.getAdjustment(
            timestamp,
            this.config.adjustmentMethod,
            this.config.adjustmentWindowHours,
            this.config.binanceChainlinkAdjustment
        );
    }

    /**
     * Process a single tick - check for trading opportunities
     */
    private processTick(market: HistoricalMarket, tick: AlignedTick): void {
        // Skip if too close to resolution (< 30 seconds)
        if (tick.timeRemainingMs < 30 * 1000) return;

        // Apply vol multiplier for short-term adjustment
        const adjustedVol = tick.vol * this.config.volMultiplier;

        // Calculate fair value with selected strategy
        const fairValue = this.strategy.calculateFairValue(
            tick.btcPrice,
            market.strikePrice,
            tick.timeRemainingMs / 1000, // Convert to seconds
            adjustedVol
        );

        // Check YES opportunity
        this.checkAndTrade(market, tick, fairValue, 'YES', tick.polyMidYes);

        // Check NO opportunity
        this.checkAndTrade(market, tick, fairValue, 'NO', tick.polyMidNo);
    }

    /**
     * Check if we should trade and execute if so
     * In conservative mode: uses worst-case BTC price from kline
     * In normal mode: uses close price
     * Applies execution latency based on mode
     */
    private checkAndTrade(
        market: HistoricalMarket,
        tick: AlignedTick,
        fairValue: FairValue,
        side: 'YES' | 'NO',
        midPrice: number
    ): void {
        // Get BTC price for fair value calculation
        // Conservative: pessimistic proxy from PREVIOUS completed kline (low for YES, high for NO)
        //   Using the previous kline avoids look-ahead bias — the current kline's low/high
        //   are not known until the candle closes. This changes semantics from "intrabar
        //   worst-case" to "previous-bar pessimistic proxy". See OPTIMIZER-READINESS-AUDIT.md §1.1.
        // Normal: open price (already adjusted in alignTicks — causal)
        let btcPriceForFV: number;
        if (this.useWorstCasePricing) {
            // Buying YES = betting BTC goes UP → worst case: BTC was at LOW (P(up) is lower)
            // Buying NO = betting BTC goes DOWN → worst case: BTC was at HIGH (P(down) is lower)
            // Use PREVIOUS completed kline (causal) — fall back to current kline's open if unavailable
            const worstCaseKline = tick.prevBtcKline;
            const rawPrice = worstCaseKline
                ? (side === 'YES' ? worstCaseKline.low : worstCaseKline.high)
                : (tick.btcKline?.open ?? tick.btcPrice);
            // Apply adjustment if using Binance (adaptive or static)
            if (!this.config.useChainlinkForFairValue) {
                const adjustment = this.getAdjustmentAtTime(tick.timestamp);
                btcPriceForFV = rawPrice + adjustment;
            } else {
                btcPriceForFV = rawPrice;
            }
        } else {
            // Normal mode: use open price (already adjusted in alignTicks — causal)
            btcPriceForFV = tick.btcPrice;
        }

        // Apply vol multiplier for short-term adjustment
        const adjustedVol = tick.vol * this.config.volMultiplier;

        // Recalculate fair value with selected BTC price and adjusted vol using strategy
        const recalcFV = this.strategy.calculateFairValue(
            btcPriceForFV,
            market.strikePrice,
            tick.timeRemainingMs / 1000,
            adjustedVol
        );

        const fv = side === 'YES' ? recalcFV.pUp : recalcFV.pDown;
        const buyPrice = this.orderMatcher.getBuyPrice(midPrice);
        const edge = fv - buyPrice;

        // Check if edge is sufficient
        if (edge < this.config.minEdge) return;

        // Check trade cooldown per market+side
        const cooldownKey = `${market.conditionId}:${side}`;
        const lastTradeTs = this.lastTradeTimestamp.get(cooldownKey) ?? 0;
        if (tick.timestamp - lastTradeTs < this.config.cooldownMs) return;

        // Check max trades per market (across both sides)
        const marketTradeCount = this.marketTradeCount.get(market.conditionId) ?? 0;
        if (marketTradeCount >= this.config.maxTradesPerMarket) return;

        // Check position limits (share-based)
        if (!this.positionTracker.canTrade(
            market.conditionId,
            side,
            this.config.orderSize,
            this.config.maxPositionPerMarket
        )) return;

        // Calculate execution timestamp with effective latency (mode-adjusted)
        const executionTs = tick.timestamp + this.effectiveLatencyMs;

        // Skip if execution would be too close to market end
        if (executionTs >= market.endTime - 30000) return;

        // Get BTC price at execution time (causal — same look-ahead-free logic as decision time)
        let execBtcPrice = btcPriceForFV;
        if (this.effectiveLatencyMs > 0 && this.currentKlines.length > 0) {
            const execKlineIdx = this.getKlineIndex(this.currentKlines, executionTs);
            const execKline = this.currentKlines[execKlineIdx];
            if (execKline) {
                let rawExecPrice: number;
                if (this.useWorstCasePricing) {
                    // Use PREVIOUS completed kline for conservative mode (causal)
                    const prevExecKline = execKlineIdx > 0 ? this.currentKlines[execKlineIdx - 1] : null;
                    rawExecPrice = prevExecKline
                        ? (side === 'YES' ? prevExecKline.low : prevExecKline.high)
                        : execKline.open;
                } else {
                    // Use kline open (causal — close is not known yet)
                    rawExecPrice = execKline.open;
                }
                // Apply adjustment if using Binance (adaptive or static)
                if (!this.config.useChainlinkForFairValue) {
                    const adjustment = this.getAdjustmentAtTime(executionTs);
                    execBtcPrice = rawExecPrice + adjustment;
                } else {
                    execBtcPrice = rawExecPrice;
                }
            }
        }

        // Time remaining from execution timestamp
        const execTimeRemainingMs = market.endTime - executionTs;

        // Calculate effective order size (respect USD limits if set)
        let effectiveSize = this.config.orderSize;
        if (this.config.maxOrderUsd < Infinity) {
            const maxSharesByUsd = Math.floor(this.config.maxOrderUsd / buyPrice);
            effectiveSize = Math.min(effectiveSize, maxSharesByUsd);
        }
        if (this.config.maxPositionUsd < Infinity) {
            const position = this.positionTracker.getPosition(market.conditionId);
            const currentShares = position
                ? (side === 'YES' ? position.yesShares : position.noShares)
                : 0;
            const currentPositionUsd = currentShares * buyPrice;
            const remainingUsd = this.config.maxPositionUsd - currentPositionUsd;
            const maxSharesByPosition = Math.floor(remainingUsd / buyPrice);
            effectiveSize = Math.min(effectiveSize, maxSharesByPosition);
        }
        if (effectiveSize <= 0) return;

        // Capital constraint: Check if we have enough capital (if initialCapital is finite)
        if (this.config.initialCapital !== Infinity) {
            const orderCostUsd = effectiveSize * buyPrice;

            if (orderCostUsd > this.availableCapital) {
                // Option: Reduce order size to fit available capital
                const affordableSize = Math.floor(this.availableCapital / buyPrice);

                if (affordableSize <= 0) {
                    // Can't afford any shares - skip trade
                    return;
                }

                // Use reduced size
                effectiveSize = affordableSize;
            }
        }

        // Create signal
        const signal: TradeSignal = {
            timestamp: executionTs,
            marketId: market.conditionId,
            side,
            fairValue: fv,
            marketPrice: midPrice,
            edge,
            size: effectiveSize,
        };

        // Execute trade - record execution-time BTC price
        const trade = this.orderMatcher.executeBuy(
            signal,
            execBtcPrice,
            market.strikePrice,
            execTimeRemainingMs
        );

        // Record trade
        this.positionTracker.recordTrade(trade);

        // Update capital tracking (if initialCapital is finite)
        if (this.config.initialCapital !== Infinity) {
            const orderCost = trade.totalCost;  // Includes fee
            this.availableCapital -= orderCost;
            this.deployedCapital += orderCost;
            this.peakDeployedCapital = Math.max(this.peakDeployedCapital, this.deployedCapital);
        }

        // Update cooldown and trade count tracking
        this.lastTradeTimestamp.set(cooldownKey, tick.timestamp);
        this.marketTradeCount.set(market.conditionId, marketTradeCount + 1);
    }

    /**
     * Get BTC price at timestamp from klines
     */
    private getBtcPriceAt(klines: BinanceKline[], timestamp: number): number | null {
        if (klines.length === 0) return null;
        const idx = this.getKlineIndex(klines, timestamp);
        return klines[idx].close;
    }

    /**
     * Get kline index for a given timestamp (binary search)
     * Returns the index of the kline at or just before the timestamp
     */
    private getKlineIndex(klines: BinanceKline[], timestamp: number): number {
        if (klines.length === 0) return 0;

        // Binary search
        let left = 0;
        let right = klines.length - 1;

        while (left < right) {
            const mid = Math.floor((left + right) / 2);
            if (klines[mid].timestamp < timestamp) {
                left = mid + 1;
            } else {
                right = mid;
            }
        }

        return Math.max(0, left - 1);
    }

    /**
     * Calculate realized volatility from klines using log returns
     * Delegates to core/vol-calculator for the calculation
     *
     * @param klines - Array of Binance klines
     * @param endIdx - End index (exclusive) - calculate vol using candles before this
     * @param windowSize - Number of candles to use (e.g., 60 for 1h, 240 for 4h)
     * @returns Annualized volatility as decimal (e.g., 0.50 for 50%)
     */
    private calculateRealizedVol(klines: BinanceKline[], endIdx: number, windowSize: number): number {
        // Get the window of klines ending at endIdx
        const startIdx = Math.max(0, endIdx - windowSize);
        const windowKlines = klines.slice(startIdx, endIdx);

        if (windowKlines.length < 2) return 0;

        // Extract close prices and delegate to core calculator
        const closes = windowKlines.map(k => k.close);
        return coreCalculateRealizedVol(closes, 1); // 1-minute intervals
    }

    /**
     * Calculate blended volatility for short-term options
     * Combines realized vol (1h, 4h) with implied vol (DVOL)
     * Same blend as live trading for consistency
     * 
     * @param klines - Binance klines
     * @param klineIdx - Current kline index
     * @param dvolVol - DVOL implied vol at this timestamp
     * @returns Blended annualized volatility
     */
    private getBlendedVol(
        klines: BinanceKline[],
        klineIdx: number,
        dvolVol: number
    ): number {
        // Exclude current kline from RV calculation to avoid look-ahead bias.
        // The current kline's close is not known yet — only completed candles are used.
        // See OPTIMIZER-READINESS-AUDIT.md §2.2 item 4, §4.4.
        const realizedVol1h = this.calculateRealizedVol(klines, klineIdx, VOL_BLEND_CONFIG.window1h);
        const realizedVol4h = this.calculateRealizedVol(klines, klineIdx, VOL_BLEND_CONFIG.window4h);

        // If we don't have enough data for realized vol, fall back to DVOL
        if (realizedVol1h === 0 && realizedVol4h === 0) {
            return dvolVol;
        }

        // Use 4h vol for 1h if we don't have enough 1h data
        const vol1h = realizedVol1h > 0 ? realizedVol1h : realizedVol4h;
        const vol4h = realizedVol4h > 0 ? realizedVol4h : vol1h;

        // Blend: 70% realized 1h + 20% realized 4h + 10% DVOL
        const blendedVol = 
            VOL_BLEND_CONFIG.realized1h * vol1h +
            VOL_BLEND_CONFIG.realized4h * vol4h +
            VOL_BLEND_CONFIG.implied * dvolVol;

        // Sanity check: vol should be between 10% and 300% annualized
        return Math.max(0.10, Math.min(3.00, blendedVol));
    }

    /**
     * Get DVOL at timestamp (implied volatility from Deribit)
     * Binary search returns DVOL at-or-before target timestamp (strictly causal).
     * Never returns a future DVOL point. Falls back to 50% if no causal data exists.
     */
    private getDvolAt(volPoints: DeribitVolPoint[], timestamp: number): number {
        if (volPoints.length === 0) return 0.50; // Default 50%

        // Binary search for first point at-or-after timestamp
        let left = 0;
        let right = volPoints.length - 1;

        while (left < right) {
            const mid = Math.floor((left + right) / 2);
            if (volPoints[mid].timestamp < timestamp) {
                left = mid + 1;
            } else {
                right = mid;
            }
        }

        let idx = left;

        // Ensure we never use future data: step back if the found point is after target
        if (volPoints[idx].timestamp > timestamp) {
            if (idx > 0) {
                idx--;
            } else {
                // First point is still in the future — no causal data available
                return 0.50; // Safe fallback
            }
        }

        return volPoints[idx].vol;
    }

    /**
     * Generate backtest result
     */
    private generateResult(): BacktestResult {
        const trades = this.positionTracker.getTrades();
        const resolutions = this.positionTracker.getResolutions();
        const pnlCurve = this.positionTracker.getPnLCurve();

        // Calculate statistics
        const totalPnL = this.positionTracker.getRealizedPnL();
        const totalVolume = trades.reduce((sum, t) => sum + Math.abs(t.cost), 0);

        // Fee statistics
        const totalFeesPaid = this.positionTracker.getTotalFeesPaid();
        const avgFeePerTrade = trades.length > 0 ? totalFeesPaid / trades.length : 0;
        const totalCostWithoutFees = trades.reduce((sum, t) => sum + Math.abs(t.cost), 0);
        const avgFeeRate = totalCostWithoutFees > 0 ? totalFeesPaid / totalCostWithoutFees : 0;

        // Win rate calculations
        const winningTrades = trades.filter(t => {
            // A trade is "winning" if the market resolved in favor of that side
            const resolution = resolutions.find(r => r.marketId === t.marketId);
            if (!resolution) return false;
            return (t.side === 'YES' && resolution.outcome === 'UP') ||
                (t.side === 'NO' && resolution.outcome === 'DOWN');
        });

        const winRate = trades.length > 0 ? winningTrades.length / trades.length : 0;

        const profitableMarkets = resolutions.filter(r => r.pnl > 0).length;
        const marketWinRate = resolutions.length > 0 ? profitableMarkets / resolutions.length : 0;

        // Average edge
        const avgEdge = trades.length > 0
            ? trades.reduce((sum, t) => sum + t.edge, 0) / trades.length
            : 0;

        // Realized edge = actual P&L / expected P&L based on edge
        const expectedPnL = trades.reduce((sum, t) => sum + t.edge * t.size, 0);
        const realizedEdge = expectedPnL > 0 ? totalPnL / expectedPnL : 0;

        // Sharpe ratio is calculated properly in statistics.ts using daily P&L
        const sharpeRatio = 0;

        // Max drawdown
        const maxDrawdown = this.calculateMaxDrawdown(pnlCurve);

        // Capital metrics
        const initialCapital = this.config.initialCapital;
        const finalCapital = initialCapital !== Infinity ? initialCapital + totalPnL : Infinity;
        const peakDeployedCapital = this.peakDeployedCapital;
        const capitalUtilization = initialCapital !== Infinity ? peakDeployedCapital / initialCapital : 0;

        return {
            config: this.config,
            totalMarkets: resolutions.length,
            totalTrades: trades.length,
            totalPnL,
            totalVolume,
            totalFeesPaid,
            avgFeePerTrade,
            avgFeeRate,
            winRate,
            marketWinRate,
            avgEdge,
            realizedEdge,
            sharpeRatio,
            maxDrawdown,
            initialCapital,
            finalCapital,
            peakDeployedCapital,
            capitalUtilization,
            trades,
            resolutions,
            pnlCurve,
        };
    }

    /**
     * Generate empty result when no data
     */
    private generateEmptyResult(): BacktestResult {
        return {
            config: this.config,
            totalMarkets: 0,
            totalTrades: 0,
            totalPnL: 0,
            totalVolume: 0,
            totalFeesPaid: 0,
            avgFeePerTrade: 0,
            avgFeeRate: 0,
            winRate: 0,
            marketWinRate: 0,
            avgEdge: 0,
            realizedEdge: 0,
            sharpeRatio: 0,
            maxDrawdown: 0,
            initialCapital: this.config.initialCapital,
            finalCapital: this.config.initialCapital,
            peakDeployedCapital: 0,
            capitalUtilization: 0,
            trades: [],
            resolutions: [],
            pnlCurve: [],
        };
    }

    /**
     * Calculate maximum drawdown from P&L curve
     */
    private calculateMaxDrawdown(pnlCurve: { cumulativePnL: number }[]): number {
        if (pnlCurve.length === 0) return 0;

        let maxPnL = 0;
        let maxDrawdown = 0;

        for (const point of pnlCurve) {
            maxPnL = Math.max(maxPnL, point.cumulativePnL);
            const drawdown = maxPnL - point.cumulativePnL;
            maxDrawdown = Math.max(maxDrawdown, drawdown);
        }

        return maxDrawdown;
    }

    /**
     * Get configuration
     */
    getConfig(): BacktestConfig {
        return { ...this.config };
    }

    /**
     * Update configuration
     */
    updateConfig(config: Partial<BacktestConfig>): void {
        this.config = { ...this.config, ...config };
        this.orderMatcher.updateConfig({
            spreadCents: this.config.spreadCents,
            includeFees: this.config.includeFees,
            slippageBps: this.config.slippageBps,
        });
    }
}

