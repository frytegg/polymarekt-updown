/**
 * Crypto Pricer Arb - Arb Trader
 * Main trading logic: monitors prices and executes trades when edge is found
 */

import { Side } from '@polymarket/clob-client';
import { TradingService, OrderConfig } from './trading-service';
import { ArbConfig } from './config';
import { CryptoMarket, OrderBookState, Position, TradeSignal, BinancePrice, FairValue } from './types';
import { calculateFairValue, calculateEdge, formatFairValue } from './fair-value';
import { volatilityService } from './volatility-service';
import { ExecutionMetricsTracker, ExecutionStats, TradeMetric } from './execution-metrics';
import { PositionManager } from './position-manager';
import { StrikePriceService } from './strike-service';
import { divergenceTracker } from './divergence-tracker';
import { paperTracker, calculatePolymarketFee } from './paper-trading-tracker';
import { createLogger, rateLimitedLog, Logger } from './logger';

export class ArbTrader {
  // Position management (delegated)
  private positionManager: PositionManager;

  // Strike price management (delegated)
  private strikeService: StrikePriceService = new StrikePriceService();

  private lastBtcPrice: number = 0;
  private lastOrderBook: OrderBookState | null = null;
  private lastFairValue: FairValue | null = null;
  private market: CryptoMarket | null = null;
  private lastTradeTime: number = 0; // Cooldown between trades
  private tradeCooldownMs: number = 5000; // 5 seconds between trades
  private isTrading: boolean = false; // Lock to prevent concurrent trades
  private startupTime: number = Date.now(); // Startup cooldown anchor

  // Order tracking stats
  private orderStats = {
    success: 0,
    failed: 0,
    totalLatencyMs: 0,
  };

  // Logging
  private log: Logger = createLogger('ArbTrader');
  private lastLogTime: number = 0;
  private statusLogIntervalMs: number = 5000; // Status line interval (DEBUG)
  
  // Execution metrics tracking (for backtest calibration)
  private executionMetrics: ExecutionMetricsTracker = new ExecutionMetricsTracker();
  
  // Per-market trade tracking (for resolution stats)
  private currentMarketTrades: {
    side: 'YES' | 'NO';
    price: number;
    size: number;
    fairValue: number;
    expectedEdge: number;
    timestamp: number;
  }[] = [];

  constructor(
    private config: ArbConfig,
    private tradingService: TradingService
  ) {
    // Initialize position manager with limits from config
    this.positionManager = new PositionManager({
      maxOrderUsd: config.maxOrderUsd,
      maxPositionUsd: config.maxPositionUsd,
      maxTotalUsd: config.maxTotalUsd,
      minOrderUsd: config.minOrderUsd,
    });
  }

  /**
   * Set the active market to trade
   */
  setMarket(market: CryptoMarket): void {
    this.market = market;
    this.resetPosition();
    this.log = this.log.child({ marketId: market.conditionId.slice(0, 12) });
    this.log.info('market.set', { question: market.question.slice(0, 50) });
  }

  /**
   * Manually update the strike price (use when you see real "Price to Beat" on Polymarket)
   */
  setStrike(strikePrice: number): void {
    this.strikeService.setManualStrike(strikePrice);
  }

  /**
   * Get current strike
   */
  getStrike(): number {
    return this.strikeService.getStrike();
  }

  /**
   * Initialize volatility service - MUST be called before trading
   * Fetches historical data and starts the refresh loop
   */
  async initVol(): Promise<void> {
    await volatilityService.init();
    volatilityService.start();
  }

  /**
   * Stop volatility service (call on shutdown)
   */
  stopVol(): void {
    volatilityService.stop();
  }

  /**
   * Handle BTC price update from Binance
   */
  onBtcPriceUpdate(price: BinancePrice): void {
    this.lastBtcPrice = price.price;
    this.checkAndTrade();
  }

  /**
   * Handle orderbook update from Polymarket
   */
  onOrderBookUpdate(book: OrderBookState): void {
    this.lastOrderBook = book;
    this.checkAndTrade();
  }

  /**
   * Main trading logic - called on every price/book update
   */
  private async checkAndTrade(): Promise<void> {
    if (!this.market || !this.lastBtcPrice || !this.lastOrderBook) {
      return; // Not ready
    }

    // Startup cooldown: don't trade until oracle/orderbook data stabilizes
    // The static oracleAdjustment can be $50+ off from reality, creating phantom edges
    const now = Date.now();
    const startupElapsedSec = (now - this.startupTime) / 1000;
    if (startupElapsedSec < this.config.startupCooldownSec) {
      const remaining = Math.ceil(this.config.startupCooldownSec - startupElapsedSec);
      rateLimitedLog(this.log, 'info', 'warmup.cooldown', 30_000,
        'warmup.cooldown', { remainingSec: remaining });
      return;
    }

    // Check time remaining
    const secondsRemaining = (this.market.endDate.getTime() - now) / 1000;

    if (secondsRemaining <= this.config.stopBeforeEndSec) {
      // Too close to resolution - stop trading
      return;
    }

    // Staleness guard: skip trading if orderbook is older than 10 seconds
    const bookAge = now - this.lastOrderBook.timestamp;
    if (bookAge > 10_000) {
      return;
    }

    // Position limits are checked in calculateOrderSize (USD-based)

    // Check if market has started (strike becomes known at startTime)
    const marketStarted = this.market.startTime.getTime() <= now;
    
    if (!marketStarted) {
      const secsToStart = Math.ceil((this.market.startTime.getTime() - now) / 1000);
      rateLimitedLog(this.log, 'debug', 'warmup.market_start', 5_000,
        'warmup.awaiting_market_start', { secsToStart });
      return;
    }
    
    // Get strike price - MUST come from Polymarket API (no fallback!)
    let strikePrice = this.market.strikePrice;
    if (strikePrice <= 0) {
      if (!this.strikeService.hasStrike()) {
        // Try to fetch actual strike from Polymarket API
        await this.strikeService.fetchAndSetStrike(this.market, this.config.manualStrike);
      }
      strikePrice = this.strikeService.getStrike();
      
      // NO TRADING without the real strike price
      if (!strikePrice || strikePrice <= 0) {
        return; // Wait for Polymarket API to return the strike
      }
    }

    // Get volatility optimized for this time horizon
    const minutesRemaining = secondsRemaining / 60;
    const currentVol = volatilityService.getVolForHorizon(minutesRemaining);

    // Apply Binance→Chainlink oracle adjustment using adaptive EMA
    // EMA adjustment tracks real-time divergence (backtest shows 64% better P&L vs static)
    // Do NOT trade with static fallback — it creates false signals
    if (!divergenceTracker.hasReliableData()) {
      const stats = divergenceTracker.getStats();
      rateLimitedLog(this.log, 'info', 'warmup.ema', 30_000,
        'warmup.ema_not_ready', { points: stats.count, required: 30 });
      return;
    }
    const adjustment = divergenceTracker.getEmaAdjustment();
    const adjustedBtcPrice = this.lastBtcPrice + adjustment;

    // Calculate fair value with adjusted price
    const fairValue = calculateFairValue(
      adjustedBtcPrice,
      strikePrice,
      secondsRemaining,
      currentVol
    );
    this.lastFairValue = fairValue;

    // Calculate edges
    const edgeYes = calculateEdge(fairValue.pUp, this.lastOrderBook.yesAsk);
    const edgeNo = calculateEdge(fairValue.pDown, this.lastOrderBook.noAsk);

    // Log current state
    this.logState(fairValue, edgeYes, edgeNo, secondsRemaining, currentVol);

    // Check cooldown and lock (reuse `now` from above)
    if (this.isTrading) {
      return; // Lock held — trade.lock_acquired already logged
    }
    if (now - this.lastTradeTime < this.tradeCooldownMs) {
      // Don't log this every tick - too spammy
      return;
    }

    // Check for trade signals
    const signal = this.findBestSignal(fairValue, edgeYes, edgeNo);
    
    if (signal) {
      this.log.info('trade.signal', {
        side: signal.side,
        price: signal.marketPrice,
        size: signal.size,
        edge: +(signal.edge * 100).toFixed(1),
        fairValue: +(signal.fairValue * 100).toFixed(1),
      });
      this.executeTrade(signal);
    }
  }

  /**
   * Find the best trade signal (if any)
   */
  private findBestSignal(
    fairValue: FairValue,
    edgeYes: number,
    edgeNo: number
  ): TradeSignal | null {
    const minEdge = this.config.edgeMinimum;
    const maxPrice = this.config.maxBuyPrice;
    
    // Check YES side - only buy if price is cheap (below maxBuyPrice)
    if (edgeYes >= minEdge && this.lastOrderBook) {
      const yesAsk = this.lastOrderBook.yesAsk;
      if (yesAsk <= maxPrice) {
        const size = this.positionManager.calculateOrderSize(yesAsk);
        if (size > 0) {
          return {
            side: 'YES',
            edge: edgeYes,
            fairValue: fairValue.pUp,
            marketPrice: yesAsk,
            size,
          };
        }
      }
    }
    
    // Check NO side - only buy if price is cheap (below maxBuyPrice)
    if (edgeNo >= minEdge && this.lastOrderBook) {
      const noAsk = this.lastOrderBook.noAsk;
      if (noAsk <= maxPrice) {
        const size = this.positionManager.calculateOrderSize(noAsk);
        if (size > 0) {
          return {
            side: 'NO',
            edge: edgeNo,
            fairValue: fairValue.pDown,
            marketPrice: noAsk,
            size,
          };
        }
      }
    }
    
    return null;
  }

  /**
   * Execute a trade (or simulate in paper trading mode)
   */
  private async executeTrade(signal: TradeSignal): Promise<void> {
    if (!this.market || this.isTrading) return;

    // Set lock and capture signal timing
    this.isTrading = true;
    this.log.info('trade.lock_acquired', { side: signal.side });
    const signalTime = Date.now();
    const btcPriceAtSignal = this.lastBtcPrice;
    this.lastTradeTime = signalTime;

    const tokenId = signal.side === 'YES'
      ? this.market.tokenIds[0]
      : this.market.tokenIds[1];

    // Apply slippage to guarantee fill (buy slightly higher)
    const slippageMultiplier = 1 + (this.config.slippageBps / 10000);
    let priceWithSlippage = signal.marketPrice * slippageMultiplier;

    // Round to tick size (0.01) and cap at 0.99
    priceWithSlippage = Math.min(0.99, Math.round(priceWithSlippage * 100) / 100);

    // ==================== PAPER TRADING MODE ====================
    // Paper trading assumes 100% fill at slippage-adjusted price.
    // Live FAK orders may partially fill or fail entirely.
    // Paper results are intentionally optimistic for signal validation.
    if (this.config.paperTrading) {
      const fee = calculatePolymarketFee(signal.size, priceWithSlippage);
      const adjustment = divergenceTracker.getEmaAdjustment();

      // Get time remaining for this market
      const timeRemainingMs = this.market.endDate.getTime() - signalTime;

      paperTracker.recordTrade({
        timestamp: new Date(signalTime),
        marketId: this.market.conditionId,
        tokenId,
        side: signal.side,
        price: priceWithSlippage,
        size: signal.size,
        fairValue: signal.fairValue,
        edge: signal.edge,
        fee,
        adjustment,
        adjustmentMethod: 'ema',
        btcPrice: btcPriceAtSignal,
        strike: this.strikeService.getStrike() || this.market.strikePrice,
        timeRemainingMs,
        marketEndTime: this.market.endDate.getTime(),
      });

      // Record trade for resolution tracking (same as live)
      this.currentMarketTrades.push({
        side: signal.side,
        price: priceWithSlippage,
        size: signal.size,
        fairValue: signal.fairValue,
        expectedEdge: signal.fairValue - priceWithSlippage,
        timestamp: signalTime,
      });

      // Update position via PositionManager (simulated)
      this.positionManager.updatePosition(signal.side, signal.size, priceWithSlippage);

      const posState = this.positionManager.getState();
      this.log.info('trade.paper_filled', {
        side: signal.side, price: priceWithSlippage, size: signal.size,
        totalSpent: +posState.totalUsdSpent.toFixed(2),
        yesShares: posState.position.yesShares, noShares: posState.position.noShares,
      });

      // Release lock
      this.isTrading = false;
      this.log.info('trade.lock_released', { side: signal.side });
      return;
    }
    // ============================================================

    const orderConfig: OrderConfig = {
      tokenId,
      price: priceWithSlippage,
      size: signal.size,
      side: Side.BUY,
      tickSize: this.market.tickSize,
      negRisk: this.market.negRisk,
    };

    // OPTIMIZED: Log AFTER order placement to reduce latency
    // Store log data for after execution
    const logData = {
      size: signal.size,
      side: signal.side,
      priceWithSlippage,
      marketPrice: signal.marketPrice,
      slippagePct: this.config.slippageBps / 100,
      edge: signal.edge,
      fairValue: signal.fairValue,
    };

    try {
      // Use FAK (Fill and Kill) - fills what it can at best prices, cancels remainder
      // No resting orders left in the book, perfect for arb strategies
      // OPTIMIZED: Reduced timeout + direct call for minimum latency
      const timeoutMs = 5000; // Reduced from 10s
      const orderPromise = this.tradingService.placeOrderFAK(orderConfig);
      const timeoutPromise = new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error('Trade timeout (5s)')), timeoutMs)
      );
      
      const result = await Promise.race([orderPromise, timeoutPromise]);
      
      if (result?.error) {
        this.orderStats.failed++;
        const avgLatency = this.orderStats.success > 0
          ? Math.round(this.orderStats.totalLatencyMs / this.orderStats.success)
          : 0;
        this.log.warn('trade.rejected', {
          side: logData.side, price: logData.priceWithSlippage, size: logData.size,
          reason: result.error, successCount: this.orderStats.success,
          failCount: this.orderStats.failed, avgLatencyMs: avgLatency,
        });
      } else {
        // FAK order succeeded = filled what was available!
        const fillTime = Date.now();
        const btcPriceAtFill = this.lastBtcPrice;
        const latencyMs = fillTime - signalTime;
        
        // Track order stats
        this.orderStats.success++;
        this.orderStats.totalLatencyMs += latencyMs;
        const avgLatency = Math.round(this.orderStats.totalLatencyMs / this.orderStats.success);
        
        this.log.info('trade.filled', {
          side: logData.side, price: logData.priceWithSlippage, size: logData.size,
          edge: +(logData.edge * 100).toFixed(1), fairValue: +(logData.fairValue * 100).toFixed(1),
          latencyMs, successCount: this.orderStats.success,
          failCount: this.orderStats.failed, avgLatencyMs: avgLatency,
        });
        
        // Record execution metrics for backtest calibration
        this.executionMetrics.record(
          signal.side,
          signalTime,
          fillTime,
          signal.marketPrice,
          priceWithSlippage,
          signal.edge,
          signal.fairValue,
          btcPriceAtSignal,
          btcPriceAtFill
        );
        
        // Record trade for resolution tracking
        this.currentMarketTrades.push({
          side: signal.side,
          price: priceWithSlippage,
          size: signal.size,
          fairValue: signal.fairValue,
          expectedEdge: signal.fairValue - priceWithSlippage,
          timestamp: fillTime,
        });
        
        // Record fill in tracker (Telegram notifications + JSON persistence)
        const fee = calculatePolymarketFee(signal.size, priceWithSlippage);
        const adjustment = divergenceTracker.hasReliableData()
          ? divergenceTracker.getEmaAdjustment()
          : this.config.oracleAdjustment;
        const timeRemainingMs = this.market!.endDate.getTime() - fillTime;

        paperTracker.recordTrade({
          timestamp: new Date(fillTime),
          marketId: this.market!.conditionId,
          tokenId,
          side: signal.side,
          price: priceWithSlippage,
          size: signal.size,
          fairValue: signal.fairValue,
          edge: signal.edge,
          fee,
          adjustment,
          adjustmentMethod: 'ema',
          btcPrice: btcPriceAtFill,
          strike: this.strikeService.getStrike() || this.market!.strikePrice,
          timeRemainingMs,
          marketEndTime: this.market!.endDate.getTime(),
        });

        // Update position via PositionManager
        this.positionManager.updatePosition(signal.side, signal.size, priceWithSlippage);
      }
    } catch (error: any) {
      // Order placement failed - track it
      this.orderStats.failed++;
      const avgLatency = this.orderStats.success > 0
        ? Math.round(this.orderStats.totalLatencyMs / this.orderStats.success)
        : 0;

      const msg = error.message || '';
      const status = error.response?.status;
      let category = 'unknown';
      if (status === 403) category = 'cloudflare_blocked';
      else if (status === 429) category = 'rate_limited';
      else if (msg.includes('timeout')) category = 'timeout';
      else if (msg.includes('not enough') || msg.includes('insufficient')) category = 'insufficient_balance';

      this.log.error('trade.error', {
        category, side: signal.side, httpStatus: status,
        error: msg.slice(0, 120),
        successCount: this.orderStats.success,
        failCount: this.orderStats.failed, avgLatencyMs: avgLatency,
      });
    } finally {
      // Release lock
      this.isTrading = false;
      this.log.info('trade.lock_released', { side: signal.side });
    }
  }

  
  /**
   * Log current state (DEBUG level, throttled to statusLogIntervalMs)
   */
  private logState(
    fairValue: FairValue,
    edgeYes: number,
    edgeNo: number,
    secondsRemaining: number,
    currentVol: number
  ): void {
    if (!this.lastOrderBook || !this.market) return;
    if (!this.log.isEnabled('debug')) return;

    const now = Date.now();
    if (now - this.lastLogTime < this.statusLogIntervalMs) return;
    this.lastLogTime = now;

    const pnl = this.positionManager.calculatePnL(this.lastOrderBook);
    const strike = this.strikeService.getStrike() || this.market.strikePrice;
    const pos = this.positionManager.getPosition();

    this.log.debug('status.tick', {
      timeLeft: `${Math.floor(secondsRemaining / 60)}:${String(Math.floor(secondsRemaining % 60)).padStart(2, '0')}`,
      btc: +this.lastBtcPrice.toFixed(0),
      strike: +strike.toFixed(0),
      vol: +(currentVol * 100).toFixed(0),
      fairUp: +(fairValue.pUp * 100).toFixed(0),
      fairDown: +(fairValue.pDown * 100).toFixed(0),
      yesBid: +(this.lastOrderBook.yesBid * 100).toFixed(0),
      yesAsk: +(this.lastOrderBook.yesAsk * 100).toFixed(0),
      edgeYes: +(edgeYes * 100).toFixed(1),
      edgeNo: +(edgeNo * 100).toFixed(1),
      yesShares: pos.yesShares,
      noShares: pos.noShares,
      pnl: +pnl.toFixed(2),
    });
  }

  /**
   * Reset position for new market
   */
  private resetPosition(): void {
    this.positionManager.resetForNewMarket();
    this.strikeService.reset();
    this.lastTradeTime = 0;
    this.isTrading = false;
    this.currentMarketTrades = []; // Clear trades for new market
  }
  
  /**
   * Get and clear trades for the current market (for resolution tracking)
   */
  getAndClearCurrentMarketTrades(): {
    side: 'YES' | 'NO';
    price: number;
    size: number;
    fairValue: number;
    expectedEdge: number;
    timestamp: number;
  }[] {
    const trades = [...this.currentMarketTrades];
    // Don't clear here - will be cleared on resetPosition
    return trades;
  }

  /**
   * Get current stats
   */
  getStats(): {
    position: Position;
    tradeCount: number;
    lastBtcPrice: number;
    lastFairValue: FairValue | null;
    totalUsdSpent: number;
    yesCost: number;
    noCost: number;
    strike: number;
    executionStats: ExecutionStats | null;
    orderStats: { success: number; failed: number; avgLatencyMs: number };
  } {
    const posState = this.positionManager.getState();
    const costBasis = this.positionManager.getCostBasis();
    
    const avgLatencyMs = this.orderStats.success > 0 
      ? Math.round(this.orderStats.totalLatencyMs / this.orderStats.success) 
      : 0;
    
    return {
      position: posState.position,
      tradeCount: posState.tradeCount,
      lastBtcPrice: this.lastBtcPrice,
      lastFairValue: this.lastFairValue,
      totalUsdSpent: posState.totalUsdSpent,
      yesCost: costBasis.yes,
      noCost: costBasis.no,
      strike: this.strikeService.getStrike(),
      executionStats: this.executionMetrics.getStats(),
      orderStats: {
        success: this.orderStats.success,
        failed: this.orderStats.failed,
        avgLatencyMs,
      },
    };
  }

  /**
   * Check if we should stop trading this market
   */
  shouldStopTrading(): boolean {
    if (!this.market) return true;
    
    const now = Date.now();
    const secondsRemaining = (this.market.endDate.getTime() - now) / 1000;
    
    // Stop if too close to resolution
    if (secondsRemaining <= this.config.stopBeforeEndSec) {
      return true;
    }
    
    // Stop if global USD limit reached (hard stop)
    if (this.positionManager.isGlobalLimitReached()) {
      return true;
    }
    
    return false;
  }
  
  // ===========================================================================
  // EXECUTION METRICS (delegated to ExecutionMetricsTracker)
  // ===========================================================================

  /**
   * Log execution statistics
   */
  logExecutionStats(): void {
    this.executionMetrics.logStats();
  }

  /**
   * Get raw trade metrics (for analysis)
   */
  getTradeMetrics(): TradeMetric[] {
    return this.executionMetrics.getMetrics();
  }

  /**
   * Clear trade metrics
   */
  clearTradeMetrics(): void {
    this.executionMetrics.clear();
  }
}

