/**
 * Backtest Simulator
 * Main engine that orchestrates the backtest
 */

import {
    BacktestConfig,
    BacktestResult,
    HistoricalMarket,
    AlignedTick,
    TradeSignal,
    FairValue,
    BinanceKline,
    PolymarketPricePoint,
    DeribitVolPoint,
} from '../types';

import { BinanceHistoricalFetcher } from '../fetchers/binance-historical';
import { PolymarketMarketsFetcher, determineOutcome } from '../fetchers/polymarket-markets';
import { PolymarketPricesFetcher } from '../fetchers/polymarket-prices';
import { DeribitVolFetcher } from '../fetchers/deribit-vol';
import { ChainlinkHistoricalFetcher } from '../fetchers/chainlink-historical';
import { OrderMatcher } from './order-matcher';
import { PositionTracker } from './position-tracker';
import { calculateFairValue } from '../../fair-value';

const DEFAULT_CONFIG: BacktestConfig = {
    startDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // 7 days ago
    endDate: new Date(),
    initialCapital: Infinity, // Unlimited
    spreadCents: 1,           // 1¢ spread
    minEdge: 0.02,            // 2% minimum edge
    orderSize: 100,           // 100 shares per order
    maxPositionPerMarket: 1000, // Max 1000 shares per side
    lagSeconds: 0,            // No lag by default
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

    constructor(config: Partial<BacktestConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };

        this.binanceFetcher = new BinanceHistoricalFetcher('BTCUSDT', '1m');
        this.marketsFetcher = new PolymarketMarketsFetcher();
        this.pricesFetcher = new PolymarketPricesFetcher(1); // 1 minute fidelity
        this.volFetcher = new DeribitVolFetcher('BTC', 60);  // 1 minute resolution
        this.chainlinkFetcher = new ChainlinkHistoricalFetcher();
        this.orderMatcher = new OrderMatcher({ spreadCents: this.config.spreadCents });
        this.positionTracker = new PositionTracker();
    }

    /**
     * Run the backtest
     */
    async run(): Promise<BacktestResult> {
        console.log('\n🚀 Starting Backtest...\n');
        console.log(`📅 Period: ${this.config.startDate.toISOString()} to ${this.config.endDate.toISOString()}`);
        console.log(`💰 Capital: ${this.config.initialCapital === Infinity ? 'Unlimited' : `$${this.config.initialCapital}`}`);
        console.log(`📊 Spread: ${this.config.spreadCents}¢ | Min Edge: ${(this.config.minEdge * 100).toFixed(1)}%`);
        console.log(`📦 Order Size: ${this.config.orderSize} shares | Max Position: ${this.config.maxPositionPerMarket}`);
        console.log(`⏱️ Lag: ${this.config.lagSeconds}s (BTC price delay before Poly execution)\n`);

        const startTs = this.config.startDate.getTime();
        const endTs = this.config.endDate.getTime();

        // Reset state
        this.positionTracker.reset();
        this.orderMatcher.reset();

        // Step 1: Fetch all historical markets
        console.log('📡 Step 1: Fetching historical markets...');
        const markets = await this.marketsFetcher.fetch(startTs, endTs);
        console.log(`   Found ${markets.length} markets\n`);

        if (markets.length === 0) {
            console.log('❌ No markets found in date range');
            return this.generateEmptyResult();
        }

        // Step 2: Fetch Binance klines for entire period
        console.log('📡 Step 2: Fetching Binance BTC prices...');
        const btcKlines = await this.binanceFetcher.fetch(startTs, endTs);
        console.log(`   Loaded ${btcKlines.length} price points\n`);

        // Step 3: Fetch Deribit volatility for entire period
        console.log('📡 Step 3: Fetching Deribit DVOL...');
        const volPoints = await this.volFetcher.fetch(startTs, endTs);
        console.log(`   Loaded ${volPoints.length} volatility points\n`);

        // Step 4: Fetch Chainlink prices for market resolution
        console.log('📡 Step 4: Fetching Chainlink oracle prices...');
        const chainlinkPrices = await this.chainlinkFetcher.fetch(startTs, endTs);
        console.log(`   Loaded ${chainlinkPrices.length} Chainlink price points\n`);

        // Step 5: Process each market
        console.log('⚙️ Step 5: Processing markets...\n');
        let processedMarkets = 0;

        for (const market of markets) {
            // Skip markets without strike price
            if (!market.strikePrice || market.strikePrice <= 0) {
                console.log(`   ⏭️ Skipping ${market.question.slice(0, 40)}... (no strike price)`);
                continue;
            }

            await this.processMarket(market, btcKlines, volPoints);
            processedMarkets++;

            if (processedMarkets % 10 === 0) {
                console.log(`   Processed ${processedMarkets}/${markets.length} markets...`);
            }
        }

        console.log(`\n✅ Processed ${processedMarkets} markets\n`);

        // Generate results
        return this.generateResult();
    }

    /**
     * Process a single market
     */
    private async processMarket(
        market: HistoricalMarket,
        btcKlines: BinanceKline[],
        volPoints: DeribitVolPoint[]
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
            volPoints
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
                console.log(`   ⚠️ Oracle divergence at ${new Date(market.endTime).toISOString()}: Chainlink=$${chainlinkPoint.price.toFixed(2)}, Binance=$${binancePrice.toFixed(2)}`);
            }
        } else {
            console.warn(`   ⚠️ No Chainlink price for ${new Date(market.endTime).toISOString()}, using Binance`);
            finalBtcPrice = binancePrice!;
        }

        const outcome = determineOutcome(finalBtcPrice, market.strikePrice);

        this.positionTracker.resolve(
            market.conditionId,
            outcome,
            finalBtcPrice,
            market.strikePrice
        );
    }

    /**
     * Align data from different sources into unified ticks
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
        volPoints: DeribitVolPoint[]
    ): AlignedTick[] {
        const ticks: AlignedTick[] = [];
        const lagMs = this.config.lagSeconds * 1000;

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

            // Get kline index for this timestamp
            const klineIdx = this.getKlineIndex(btcKlines, btcTimestamp);
            const kline = btcKlines[klineIdx];
            const btcPrice = kline?.close;
            if (!btcPrice) continue;

            // Get DVOL at this timestamp
            const dvolVol = this.getDvolAt(volPoints, btcTimestamp);

            // Calculate blended volatility (realized + implied)
            // Same blend as live trading: 70% realized 1h + 20% realized 4h + 10% DVOL
            const vol = this.getBlendedVol(btcKlines, klineIdx, dvolVol);

            // Time remaining based on when we EXECUTE (T), not when we decide (T-lag)
            const timeRemainingMs = market.endTime - ts;

            ticks.push({
                timestamp: ts,
                btcPrice,
                btcKline: kline,
                polyMidYes: polyPrice.price,
                polyMidNo: 1 - polyPrice.price,
                vol,
                timeRemainingMs,
            });
        }

        return ticks;
    }

    /**
     * Process a single tick - check for trading opportunities
     */
    private processTick(market: HistoricalMarket, tick: AlignedTick): void {
        // Skip if too close to resolution (< 30 seconds)
        if (tick.timeRemainingMs < 30 * 1000) return;

        // Calculate fair value
        const fairValue = calculateFairValue(
            tick.btcPrice,
            market.strikePrice,
            tick.timeRemainingMs / 1000, // Convert to seconds
            tick.vol
        );

        // Check YES opportunity
        this.checkAndTrade(market, tick, fairValue, 'YES', tick.polyMidYes);

        // Check NO opportunity
        this.checkAndTrade(market, tick, fairValue, 'NO', tick.polyMidNo);
    }

    /**
     * Check if we should trade and execute if so
     * Uses worst-case BTC price from kline for conservative edge calculation
     */
    private checkAndTrade(
        market: HistoricalMarket,
        tick: AlignedTick,
        fairValue: FairValue,
        side: 'YES' | 'NO',
        midPrice: number
    ): void {
        // Get worst-case BTC price for this side
        // Buying YES = betting BTC goes UP → worst case: BTC was at LOW (P(up) is lower)
        // Buying NO = betting BTC goes DOWN → worst case: BTC was at HIGH (P(down) is lower)
        let worstCaseBtc: number;
        if (side === 'YES') {
            worstCaseBtc = tick.btcKline?.low ?? tick.btcPrice;
        } else {
            worstCaseBtc = tick.btcKline?.high ?? tick.btcPrice;
        }

        // Recalculate fair value with worst-case BTC price
        const worstCaseFV = calculateFairValue(
            worstCaseBtc,
            market.strikePrice,
            tick.timeRemainingMs / 1000,
            tick.vol
        );

        const fv = side === 'YES' ? worstCaseFV.pUp : worstCaseFV.pDown;
        const buyPrice = this.orderMatcher.getBuyPrice(midPrice);
        const edge = fv - buyPrice;

        // Check if edge is sufficient
        if (edge < this.config.minEdge) return;

        // Check position limits
        if (!this.positionTracker.canTrade(
            market.conditionId,
            side,
            this.config.orderSize,
            this.config.maxPositionPerMarket
        )) return;

        // Create signal
        const signal: TradeSignal = {
            timestamp: tick.timestamp,
            marketId: market.conditionId,
            side,
            fairValue: fv,
            marketPrice: midPrice,
            edge,
            size: this.config.orderSize,
        };

        // Execute trade - record worst-case BTC price
        const trade = this.orderMatcher.executeBuy(
            signal,
            worstCaseBtc,
            market.strikePrice,
            tick.timeRemainingMs
        );

        // Record trade
        this.positionTracker.recordTrade(trade);
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
     * Same logic as volatility-service.ts for consistency
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

        // Calculate log returns (close to close)
        const logReturns: number[] = [];
        for (let i = 1; i < windowKlines.length; i++) {
            const logReturn = Math.log(windowKlines[i].close / windowKlines[i - 1].close);
            logReturns.push(logReturn);
        }

        if (logReturns.length < 2) return 0;

        // Standard deviation of log returns
        const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
        const variance = logReturns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (logReturns.length - 1);
        const stdDev = Math.sqrt(variance);

        // Annualize: assuming 1-minute intervals
        // Minutes per year = 365 * 24 * 60 = 525,600
        const minutesPerYear = 525600;
        const annualizedVol = stdDev * Math.sqrt(minutesPerYear);

        return annualizedVol;
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
        // Calculate realized vol on 1h and 4h windows
        const realizedVol1h = this.calculateRealizedVol(klines, klineIdx + 1, VOL_BLEND_CONFIG.window1h);
        const realizedVol4h = this.calculateRealizedVol(klines, klineIdx + 1, VOL_BLEND_CONFIG.window4h);

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
     */
    private getDvolAt(volPoints: DeribitVolPoint[], timestamp: number): number {
        if (volPoints.length === 0) return 0.50; // Default 50%

        // Binary search
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

        const idx = Math.max(0, left);
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

        // Sharpe ratio (simplified - daily returns would be better)
        const sharpeRatio = this.calculateSharpeRatio(resolutions);

        // Max drawdown
        const maxDrawdown = this.calculateMaxDrawdown(pnlCurve);

        return {
            config: this.config,
            totalMarkets: resolutions.length,
            totalTrades: trades.length,
            totalPnL,
            totalVolume,
            winRate,
            marketWinRate,
            avgEdge,
            realizedEdge,
            sharpeRatio,
            maxDrawdown,
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
            winRate: 0,
            marketWinRate: 0,
            avgEdge: 0,
            realizedEdge: 0,
            sharpeRatio: 0,
            maxDrawdown: 0,
            trades: [],
            resolutions: [],
            pnlCurve: [],
        };
    }

    /**
     * Calculate Sharpe ratio from market resolutions
     */
    private calculateSharpeRatio(resolutions: { pnl: number }[]): number {
        if (resolutions.length < 2) return 0;

        const returns = resolutions.map(r => r.pnl);
        const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;

        const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
        const stdDev = Math.sqrt(variance);

        if (stdDev === 0) return 0;

        // Annualize (assuming 15-min markets, ~35,040 per year)
        const marketsPerYear = 35040;
        return (avgReturn / stdDev) * Math.sqrt(marketsPerYear);
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
        this.orderMatcher.updateConfig({ spreadCents: this.config.spreadCents });
    }
}

