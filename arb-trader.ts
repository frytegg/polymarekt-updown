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
  private startupCooldownLogged: boolean = false; // Avoid log spam
  
  // Order tracking stats
  private orderStats = {
    success: 0,
    failed: 0,
    totalLatencyMs: 0,
  };
  
  // Logging
  private lastLogTime: number = 0;
  
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
    console.log(`🎯 Trading market: ${market.question.slice(0, 50)}...`);
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
      if (!this.startupCooldownLogged || Math.floor(startupElapsedSec) % 30 === 0) {
        const remaining = Math.ceil(this.config.startupCooldownSec - startupElapsedSec);
        console.log(`[Warmup] Trading disabled for ${remaining}s (oracle/orderbook stabilizing)`);
        this.startupCooldownLogged = true;
      }
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
      // Market hasn't started yet - wait for strike to be determined
      const secsToStart = Math.ceil((this.market.startTime.getTime() - now) / 1000);
      // Log only once per second and only at certain intervals
      if (now - this.lastLogTime >= 1000 && secsToStart % 5 === 0) {
        this.lastLogTime = now;
        console.log(`⏳ Waiting ${secsToStart}s for market start (strike will be captured)...`);
      }
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
    // Falls back to static config.oracleAdjustment during warm-up period
    const adjustment = divergenceTracker.hasReliableData()
      ? divergenceTracker.getEmaAdjustment()
      : this.config.oracleAdjustment;
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
      console.log(`   ⏸️ Trade in progress, skipping...`);
      return;
    }
    if (now - this.lastTradeTime < this.tradeCooldownMs) {
      // Don't log this every tick - too spammy
      return;
    }

    // Check for trade signals
    const signal = this.findBestSignal(fairValue, edgeYes, edgeNo);
    
    if (signal) {
      console.log(`   ✨ SIGNAL FOUND: ${signal.side} @ ${(signal.marketPrice*100).toFixed(0)}¢ x${signal.size}`);
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
      const adjustment = divergenceTracker.hasReliableData()
        ? divergenceTracker.getEmaAdjustment()
        : this.config.oracleAdjustment;

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
        adjustmentMethod: divergenceTracker.hasReliableData() ? 'ema' : 'static',
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

      this.positionManager.logTotalSpent();
      this.positionManager.logPosition();

      // Release lock
      this.isTrading = false;
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
      
      // Log AFTER execution (non-blocking)
      console.log(`\n🚀 TRADE: BUY ${logData.size} ${logData.side} @ $${logData.priceWithSlippage.toFixed(2)} (ask: ${logData.marketPrice.toFixed(2)}, +${logData.slippagePct}% slip)`);
      console.log(`   📊 Edge: +${(logData.edge * 100).toFixed(1)}¢ | Fair: ${(logData.fairValue * 100).toFixed(1)}%`);
      
      if (result?.error) {
        this.orderStats.failed++;
        const avgLatency = this.orderStats.success > 0 
          ? Math.round(this.orderStats.totalLatencyMs / this.orderStats.success) 
          : 0;
        console.log(`   ❌ Order rejected: ${result.error} | Orders: ${this.orderStats.success}✅/${this.orderStats.failed}❌ | Avg: ${avgLatency}ms`);
      } else {
        // FAK order succeeded = filled what was available!
        const fillTime = Date.now();
        const btcPriceAtFill = this.lastBtcPrice;
        const latencyMs = fillTime - signalTime;
        
        // Track order stats
        this.orderStats.success++;
        this.orderStats.totalLatencyMs += latencyMs;
        const avgLatency = Math.round(this.orderStats.totalLatencyMs / this.orderStats.success);
        
        console.log(`   ✅ FILLED! (FAK) [${latencyMs}ms] | Orders: ${this.orderStats.success}✅/${this.orderStats.failed}❌ | Avg: ${avgLatency}ms`);
        
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
          adjustmentMethod: divergenceTracker.hasReliableData() ? 'ema' : 'static',
          btcPrice: btcPriceAtFill,
          strike: this.strikeService.getStrike() || this.market!.strikePrice,
          timeRemainingMs,
          marketEndTime: this.market!.endDate.getTime(),
        });

        // Update position via PositionManager
        this.positionManager.updatePosition(signal.side, signal.size, priceWithSlippage);

        this.positionManager.logTotalSpent();
        this.positionManager.logPosition();
      }
    } catch (error: any) {
      // Order placement failed - track it
      this.orderStats.failed++;
      const avgLatency = this.orderStats.success > 0 
        ? Math.round(this.orderStats.totalLatencyMs / this.orderStats.success) 
        : 0;
      const statsStr = `| Orders: ${this.orderStats.success}✅/${this.orderStats.failed}❌ | Avg: ${avgLatency}ms`;
      
      const msg = error.message || '';
      const status = error.response?.status;
      
      if (status === 403) {
        console.log(`   🚫 Cloudflare blocked (403) - wait or change IP ${statsStr}`);
      } else if (status === 429) {
        console.log(`   ⏳ Rate limited (429) - slowing down ${statsStr}`);
      } else if (msg.includes('timeout')) {
        console.log(`   ⏱️ ${msg} ${statsStr}`);
      } else if (msg.includes('not enough') || msg.includes('insufficient')) {
        console.log(`   💰 Insufficient balance ${statsStr}`);
      } else {
        console.log(`   ❌ Trade error: ${msg.slice(0, 50)} ${statsStr}`);
      }
    } finally {
      // Release lock
      this.isTrading = false;
    }
  }

  
  /**
   * Log current state in real-time (throttled to once per second)
   */
  private logState(
    fairValue: FairValue,
    edgeYes: number,
    edgeNo: number,
    secondsRemaining: number,
    currentVol: number
  ): void {
    if (!this.lastOrderBook || !this.market) return;
    
    // Throttle logging to once per second
    const now = Date.now();
    if (now - this.lastLogTime < 1000) return;
    this.lastLogTime = now;
    
    const timeStr = `${Math.floor(secondsRemaining / 60)}:${String(Math.floor(secondsRemaining % 60)).padStart(2, '0')}`;
    
    // Calculate P&L via PositionManager
    const pnl = this.positionManager.calculatePnL(this.lastOrderBook);
    const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
    const pnlColor = pnl >= 0 ? '🟢' : '🔴';
    
    // Strike vs current
    const strike = this.strikeService.getStrike() || this.market.strikePrice;
    const pctFromStrike = ((this.lastBtcPrice - strike) / strike * 100);
    const direction = pctFromStrike >= 0 ? '📈' : '📉';
    
    // Edge indicators
    const edgeYesStr = edgeYes > 0 ? `+${(edgeYes * 100).toFixed(1)}` : `${(edgeYes * 100).toFixed(1)}`;
    const edgeNoStr = edgeNo > 0 ? `+${(edgeNo * 100).toFixed(1)}` : `${(edgeNo * 100).toFixed(1)}`;
    const yesSignal = edgeYes >= this.config.edgeMinimum ? '🎯' : '  ';
    const noSignal = edgeNo >= this.config.edgeMinimum ? '🎯' : '  ';
    
    // Volatility display (annualized %)
    const volStr = `σ${(currentVol * 100).toFixed(0)}%`;
    
    // Get position for display
    const pos = this.positionManager.getPosition();
    
    // Clear line and print status
    console.log(
      `\r[${timeStr}] ` +
      `BTC: $${this.lastBtcPrice.toFixed(0)} ${direction}${pctFromStrike >= 0 ? '+' : ''}${pctFromStrike.toFixed(2)}% | ` +
      `${volStr} | ` +
      `Fair: ${(fairValue.pUp * 100).toFixed(0)}%UP/${(fairValue.pDown * 100).toFixed(0)}%DOWN | ` +
      `Book: ${(this.lastOrderBook.yesBid * 100).toFixed(0)}/${(this.lastOrderBook.yesAsk * 100).toFixed(0)}¢ | ` +
      `Edge: UP${edgeYesStr}¢${yesSignal} DOWN${edgeNoStr}¢${noSignal} | ` +
      `Pos: ${pos.yesShares}Y/${pos.noShares}N | ` +
      `${pnlColor} P&L: ${pnlStr}`
    );
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

