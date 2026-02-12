/**
 * Crypto Pricer Arb - Entry Point
 * 
 * Arbitrage strategy exploiting lag between Binance (price discovery)
 * and Polymarket (retail sentiment) for BTC UP/DOWN markets.
 * 
 * Usage: npx ts-node crypto-pricer-arb/index.ts
 */

import * as dotenv from 'dotenv';
import { RealTimeDataClient } from '@polymarket/real-time-data-client';

import { loadArbConfig, validateArbConfig, logArbConfig, ArbConfig } from './core/config';
import { ITradingService } from './core/trading-interface';
import { BinanceWebSocket } from './live/binance-ws';
import { findCryptoMarkets, findNextMarket, logMarket } from './live/market-finder';
import { ArbTrader } from './live/arb-trader';
import { CryptoMarket, OrderBookState } from './core/types';
import { OrderbookService, getDefaultOrderBookState } from './live/orderbook-service';
import { ResolutionTracker } from './live/resolution-tracker';
import { TradingService } from './live/trading-service';
import { MockTradingService } from './paper/mock-trading-service';
import { divergenceTracker } from './live/divergence-tracker';
import { paperTracker } from './live/trade-persistence';
import { initTelegram, notifyStartup, notifyShutdown, isTelegramEnabled, stopTelegram } from './live/telegram';
import { RedemptionService } from './live/redemption-service';

dotenv.config();

class CryptoPricerArb {
  private config: ArbConfig;
  private binanceWs: BinanceWebSocket;
  private polymarketWs: RealTimeDataClient | null = null;
  private tradingService: ITradingService;
  private orderbookService: OrderbookService;
  private resolutionTracker: ResolutionTracker;
  private trader: ArbTrader;
  private currentMarket: CryptoMarket | null = null;
  private isRunning = false;
  private lastMarketSearch = 0;
  private marketSearchCooldown = 10000; // 10 seconds minimum between searches
  private divergenceStatusInterval: ReturnType<typeof setInterval> | null = null;
  private paperTradingSummaryInterval: ReturnType<typeof setInterval> | null = null;
  private startTime: number = 0; // Track startup time for runtime calculation
  private lastOrderBook: OrderBookState | null = null; // Persisted orderbook state

  constructor() {
    // Load and validate config
    this.config = loadArbConfig();
    validateArbConfig(this.config);

    // Initialize services
    // DEPENDENCY INJECTION: Single point where paper vs live mode is decided
    // After this, all code is mode-agnostic and works through the ITradingService interface
    this.tradingService = this.config.paperTrading
      ? new MockTradingService()
      : new TradingService();

    this.orderbookService = new OrderbookService(this.config.clobHost);
    this.resolutionTracker = new ResolutionTracker();

    // Initialize Binance WebSocket
    this.binanceWs = new BinanceWebSocket('btcusdt');

    // Initialize trader
    this.trader = new ArbTrader(this.config, this.tradingService);
  }

  async start(): Promise<void> {
    console.log('\n🎯 CRYPTO PRICER ARB - Starting...\n');
    logArbConfig(this.config);

    // Track start time for runtime calculation
    this.startTime = Date.now();

    // Positions from previous session are kept so checkAndResolveExpired() can
    // find and redeem them. The revert detection in redemption-service.ts handles
    // the case where positions were already redeemed manually.

    // Initialize Telegram notifications
    initTelegram();
    if (isTelegramEnabled()) {
      console.log('[System] Telegram notifications enabled');
    }

    // Initialize trading service
    await this.tradingService.initialize();

    // Initialize auto-redemption (live mode only)
    if (!this.config.paperTrading && this.config.privateKey && this.config.funderAddress) {
      const rpcUrl = process.env.RPC_URL || 'https://polygon.drpc.org';
      const redemptionService = new RedemptionService(
        this.config.privateKey,
        this.config.funderAddress,
        rpcUrl
      );
      paperTracker.onRedemptionNeeded = (conditionId: string, yesTokenId?: string, noTokenId?: string) => {
        console.log(`[Redemption] Triggered for ${conditionId.slice(0, 18)}... YES=${yesTokenId?.slice(0, 10)}... NO=${noTokenId?.slice(0, 10)}...`);
        redemptionService.redeemPositions(conditionId, yesTokenId, noTokenId).catch((err: any) => {
          console.log(`[Redemption] Async error: ${err.message?.slice(0, 80)}`);
        });
      };

      // Immediately check for unredeemed positions from previous session
      paperTracker.checkAndResolveExpired().catch((err: any) => {
        console.log(`[Redemption] Startup sweep error: ${err.message?.slice(0, 80)}`);
      });
    }

    // Initialize volatility service (fetches Binance klines + Deribit data, starts refresh loop)
    await this.trader.initVol();

    // Start divergence tracker for adaptive EMA adjustment (backtest: +64% P&L vs static)
    divergenceTracker.start();
    console.log('[System] Divergence tracker started (EMA 2h window, 30min half-life)');

    // Log divergence tracker status every 5 minutes
    this.divergenceStatusInterval = setInterval(() => {
      if (!divergenceTracker.hasReliableData()) {
        const stats = divergenceTracker.getStats();
        console.log(`[DivergenceTracker] Warming up... ${stats.count}/30 points`);
      } else {
        const stats = divergenceTracker.getStats();
        console.log(`[DivergenceTracker] Points: ${stats.count}, Mean: $${stats.mean.toFixed(0)}, EMA Adj: $${divergenceTracker.getEmaAdjustment().toFixed(0)}`);
      }
    }, 5 * 60 * 1000);

    // Print summary every 15 minutes
    if (this.config.paperTrading) {
      console.log('[System] Paper trading mode enabled - trades will be simulated');
    }
    this.paperTradingSummaryInterval = setInterval(() => {
      paperTracker.printSummary();
    }, 15 * 60 * 1000);

    // Find initial markets
    const markets = await findCryptoMarkets();

    if (markets.length === 0) {
      console.log('❌ No BTC UP/DOWN markets found. Waiting for markets...');
    } else {
      console.log(`Found ${markets.length} markets:`);
      markets.forEach(m => logMarket(m));
    }

    // Select first market
    this.currentMarket = findNextMarket(markets, this.config.stopBeforeEndSec);

    if (this.currentMarket) {
      this.trader.setMarket(this.currentMarket);
      logMarket(this.currentMarket);

      // Fetch initial orderbook
      await this.fetchInitialOrderbook();
    }

    // Start WebSocket connections
    this.startBinanceWs();
    await this.startPolymarketWs();

    this.isRunning = true;

    // Main loop - check for new markets periodically
    this.startMarketRefreshLoop();

    console.log('\n✅ Strategy running. Press Ctrl+C to stop.\n');

    // Send Telegram startup notification
    notifyStartup().catch(() => {});
  }

  private startBinanceWs(): void {
    this.binanceWs.onPrice((price) => {
      // Feed price to divergence tracker for adaptive adjustment
      divergenceTracker.updateBinancePrice(price.price);

      this.trader.onBtcPriceUpdate(price);

      // Only check market switch if we have a market that's expiring
      // Don't spam search when no market is set
      if (this.currentMarket && this.trader.shouldStopTrading()) {
        this.switchToNextMarket();
      }
    });

    this.binanceWs.connect();
  }

  private async startPolymarketWs(): Promise<void> {
    if (!this.currentMarket) return;

    console.log('🔌 Connecting to Polymarket WebSocket...');

    this.polymarketWs = new RealTimeDataClient({
      onConnect: (client) => {
        console.log('✅ Polymarket WS connected');
        this.subscribeToMarket();
      },
      onMessage: (client, message) => {
        this.handlePolymarketMessage(message);
      },
      onStatusChange: (status) => {
        console.log(`📊 Polymarket WS status: ${status}`);
      },
      autoReconnect: true,
      pingInterval: 30000,
    });

    this.polymarketWs.connect();
  }

  private subscribeToMarket(): void {
    if (!this.polymarketWs || !this.currentMarket) return;

    const tokenIds = this.currentMarket.tokenIds;

    // Try multiple subscription formats
    this.polymarketWs.subscribe({
      subscriptions: [
        // Format 1: clob_market price_change (like WebSocketMarketMaker)
        {
          topic: 'clob_market',
          type: 'price_change',
          filters: JSON.stringify({ asset_ids: tokenIds }),
        },
      ],
    });

    console.log(`📡 Subscribed to market tokens: ${tokenIds[0].slice(0, 10)}..., ${tokenIds[1].slice(0, 10)}...`);
  }

  private lastPriceChangeResync: number = 0; // Debounce REST resyncs to 1/sec

  private handlePolymarketMessage(message: any): void {
    try {
      if (!this.currentMarket) return;

      // Handle different message formats
      const { topic, type, payload } = message;

      // Format: clob_market / price_change
      // Treat as a "poke" — trigger REST resync instead of directly updating the book
      // price_change only gives last-trade price, which is not a reliable bid/ask
      if (topic === 'clob_market' && type === 'price_change') {
        const now = Date.now();
        if (now - this.lastPriceChangeResync > 1000) {
          this.lastPriceChangeResync = now;
          this.refreshOrderbookFromClob();
        }
        return;
      }

      // Format: token / orderbook_updates — merge deltas into persisted book
      if (topic === 'token' && type === 'orderbook_updates') {
        const { token_id, buy, sell } = payload;

        const isYes = token_id === this.currentMarket.tokenIds[0];
        const isNo = token_id === this.currentMarket.tokenIds[1];

        if (!isYes && !isNo) return;

        // CRITICAL: Sort orderbooks properly!
        const sortedBids = (buy || []).sort((a: any, b: any) => parseFloat(b.price) - parseFloat(a.price));
        const sortedAsks = (sell || []).sort((a: any, b: any) => parseFloat(a.price) - parseFloat(b.price));

        const bestBid = sortedBids[0]?.price ? parseFloat(sortedBids[0].price) : 0;
        const bestAsk = sortedAsks[0]?.price ? parseFloat(sortedAsks[0].price) : 1;
        const askSize = sortedAsks[0]?.size ? parseFloat(sortedAsks[0].size) : 0;

        const currentBook = this.getCurrentOrderBook();
        const updatedBook: OrderBookState = {
          ...currentBook,
          timestamp: Date.now(),
        };

        if (isYes) {
          updatedBook.yesBid = bestBid;
          updatedBook.yesAsk = bestAsk;
          updatedBook.yesAskSize = askSize;
        } else {
          updatedBook.noBid = bestBid;
          updatedBook.noAsk = bestAsk;
          updatedBook.noAskSize = askSize;
        }

        // Persist and forward
        this.lastOrderBook = updatedBook;
        this.trader.onOrderBookUpdate(updatedBook);
      }

    } catch (err) {
      // Ignore parse errors
    }
  }

  private getCurrentOrderBook(): OrderBookState {
    return this.lastOrderBook ?? getDefaultOrderBookState();
  }

  private async switchToNextMarket(): Promise<void> {
    // Rate limit market searches
    const now = Date.now();
    if (now - this.lastMarketSearch < this.marketSearchCooldown) {
      return;
    }
    this.lastMarketSearch = now;

    // Capture position for resolution tracking before switching
    if (this.currentMarket) {
      const stats = this.trader.getStats();
      // Only add if we have a position
      if (stats.position.yesShares > 0 || stats.position.noShares > 0) {
        // Get trades for this market
        const marketTrades = this.trader.getAndClearCurrentMarketTrades();

        // Paper trading resolution is handled by the periodic checkAndResolveExpired() interval

        this.resolutionTracker.addPendingResolution({
          conditionId: this.currentMarket.conditionId,
          question: this.currentMarket.question.slice(0, 50),
          yesShares: stats.position.yesShares,
          noShares: stats.position.noShares,
          yesCost: stats.yesCost,
          noCost: stats.noCost,
          strike: stats.strike,
          endTime: this.currentMarket.endDate.getTime(),
          trades: marketTrades,
        });
      }
    }

    console.log('\n🔄 Switching to next market...');

    // Find new markets
    const markets = await findCryptoMarkets();
    const nextMarket = findNextMarket(markets, this.config.stopBeforeEndSec);

    if (!nextMarket) {
      console.log('⏳ No active markets available. Will retry in 10s...\n');
      this.currentMarket = null;
      return;
    }

    // Don't switch if it's the same market
    if (this.currentMarket && nextMarket.conditionId === this.currentMarket.conditionId) {
      return;
    }

    this.currentMarket = nextMarket;
    this.lastOrderBook = null; // Reset orderbook state for new market
    this.trader.setMarket(nextMarket);
    logMarket(nextMarket);

    // Fetch initial orderbook via REST
    await this.fetchInitialOrderbook();

    // Resubscribe to new market via WS
    this.subscribeToMarket();
  }

  /**
   * Fetch initial orderbook from CLOB API (with proper sorting)
   */
  private async fetchInitialOrderbook(): Promise<void> {
    if (!this.currentMarket) return;

    try {
      const orderBook = await this.orderbookService.fetchAndLogOrderbook(
        this.currentMarket.tokenIds[0],
        this.currentMarket.tokenIds[1]
      );
      this.lastOrderBook = orderBook; // Persist authoritative REST snapshot
      this.trader.onOrderBookUpdate(orderBook);
    } catch (err: any) {
      console.log(`⚠️ Failed to fetch CLOB orderbook: ${err.message}`);
    }
  }

  private startMarketRefreshLoop(): void {
    // Check for new markets every 15 seconds
    setInterval(async () => {
      if (!this.isRunning) return;

      // Always try to find markets if we don't have one
      if (!this.currentMarket) {
        await this.switchToNextMarket();
        return;
      }

      // Check if current market is expiring
      if (this.trader.shouldStopTrading()) {
        await this.switchToNextMarket();
      }
    }, 15000);

    // Refresh orderbook prices every 2 seconds via CLOB API (properly sorted)
    setInterval(async () => {
      if (!this.isRunning || !this.currentMarket) return;
      await this.refreshOrderbookFromClob();
    }, 2000);

    // Check for resolutions every 30 seconds
    setInterval(() => this.resolutionTracker.checkResolutions(), 30000);

    // Check and resolve expired positions every 30 seconds
    setInterval(() => paperTracker.checkAndResolveExpired(), 30000);
  }

  /**
   * Refresh orderbook prices from CLOB API (with proper sorting)
   */
  private async refreshOrderbookFromClob(): Promise<void> {
    if (!this.currentMarket) return;

    const orderBook = await this.orderbookService.refreshOrderbook(
      this.currentMarket.tokenIds[0],
      this.currentMarket.tokenIds[1]
    );

    if (orderBook) {
      this.lastOrderBook = orderBook; // Persist authoritative REST snapshot
      this.trader.onOrderBookUpdate(orderBook);
    }
  }

  stop(): void {
    console.log('\n👋 Stopping strategy...\n');
    this.isRunning = false;

    // Stop volatility service refresh loop
    this.trader.stopVol();

    // Stop divergence tracker
    divergenceTracker.stop();
    if (this.divergenceStatusInterval) {
      clearInterval(this.divergenceStatusInterval);
      this.divergenceStatusInterval = null;
    }

    // Stop paper trading summary interval
    if (this.paperTradingSummaryInterval) {
      clearInterval(this.paperTradingSummaryInterval);
      this.paperTradingSummaryInterval = null;
    }

    this.binanceWs.disconnect();
    if (this.polymarketWs) {
      this.polymarketWs.disconnect();
    }

    // Log final stats
    const stats = this.trader.getStats();
    console.log('📊 Final Stats:');
    console.log(`   Trades: ${stats.tradeCount}`);
    console.log(`   Position: YES=${stats.position.yesShares} | NO=${stats.position.noShares}`);
    console.log(`   Total spent: $${stats.totalUsdSpent.toFixed(2)}`);
    console.log(`   Last BTC: $${stats.lastBtcPrice.toFixed(2)}`);
    console.log(`   Orders: ${stats.orderStats.success}✅ / ${stats.orderStats.failed}❌ | Avg latency: ${stats.orderStats.avgLatencyMs}ms`);

    // Log divergence tracker final stats
    const divStats = divergenceTracker.getStats();
    console.log(`   Divergence: ${divStats.count} points, Mean: $${divStats.mean.toFixed(0)}, EMA: $${divStats.ema.toFixed(0)}`);

    // Log final resolution stats
    if (this.resolutionTracker.getResolvedTradesCount() > 0) {
      this.resolutionTracker.logStats();
    }

    // Print final summary and send shutdown notification
    const paperStats = paperTracker.getStats();
    const runTimeMinutes = Math.round((Date.now() - this.startTime) / 60000);

    // Send Telegram shutdown notification (fire and forget)
    notifyShutdown({
      totalTrades: paperStats.totalTrades,
      realizedPnL: paperStats.realizedPnL,
      runTimeMinutes,
    }).catch(() => {});

    paperTracker.printSummary();

    // Stop Telegram bot polling
    stopTelegram();
  }
}

// Main
async function main() {
  const strategy = new CryptoPricerArb();

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    strategy.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    strategy.stop();
    process.exit(0);
  });

  await strategy.start();
}

main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});

