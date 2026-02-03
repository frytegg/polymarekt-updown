 Polymarket BTC Up/Down Trading System - Complete Overview

  1. Data Flow & Fetching

  Data Sources & Resolution
  ┌────────────┬──────────────────────────┬────────────────┬──────────────────┐
  │   Source   │        Data Type         │   Resolution   │  Cache Location  │
  ├────────────┼──────────────────────────┼────────────────┼──────────────────┤
  │ Binance    │ BTC/USDT klines          │ 1-minute       │ data/binance/    │
  ├────────────┼──────────────────────────┼────────────────┼──────────────────┤
  │ Chainlink  │ BTC/USD oracle (Polygon) │ ~20-60 seconds │ data/chainlink/  │
  ├────────────┼──────────────────────────┼────────────────┼──────────────────┤
  │ Polymarket │ Market prices (YES/NO)   │ 1-minute       │ data/polymarket/ │
  ├────────────┼──────────────────────────┼────────────────┼──────────────────┤
  │ Deribit    │ DVOL implied vol         │ 1-minute       │ data/deribit/    │
  └────────────┴──────────────────────────┴────────────────┴──────────────────┘
  Caching System

  All fetchers use the same pattern:

  // From backtest/fetchers/binance-historical.ts:182-292
  function loadFromCache(symbol, interval, startTime, endTime): BinanceKline[] | null {
    // 1. Check exact match
    // 2. Check overlapping files
    // 3. Try merging multiple cache files
    return cached.data.filter(k => k.timestamp >= startTime && k.timestamp <= endTime);
  }

  Cache files are JSON with metadata:
  interface CachedData<T> {
    metadata: {
      source: 'binance' | 'polymarket' | 'deribit' | 'chainlink';
      startTs: number;
      endTs: number;
      fetchedAt: number;
    };
    data: T[];
  }

  Data Synchronization

  The simulator aligns data from all sources at Polymarket price timestamps (the execution time):

  // From backtest/engine/simulator.ts:269-336
  private alignTicks(market, btcKlines, polyPrices, volPoints, chainlinkPrices): AlignedTick[] {
    // Use Polymarket price timestamps as base (they define when we EXECUTE)
    for (const polyPrice of polyPrices) {
      const ts = polyPrice.timestamp;

      // Get BTC price from BEFORE the Polymarket price (T - lag)
      // This simulates: "I see BTC move at T-lag, then I trade on Poly at T"
      const btcTimestamp = ts - lagMs;

      // Get kline index for volatility calc
      const klineIdx = this.getKlineIndex(btcKlines, btcTimestamp);

      // Get blended volatility
      const vol = this.getBlendedVol(btcKlines, klineIdx, dvolVol);

      ticks.push({ timestamp: ts, btcPrice, polyMidYes, vol, timeRemainingMs });
    }
  }

  ---
  2. Market Structure

  Polymarket 15-Minute BTC Markets

  Each market is a binary option:
  - Question: "Will BTC be above $X at [time]?"
  - Strike Price: BTC price at market start (captured from Polymarket API)
  - Duration: 15 minutes
  - Settlement: Chainlink oracle determines outcome

  // From backtest/types.ts:31-43
  export interface HistoricalMarket {
    conditionId: string;         // Unique market ID
    tokenIds: [string, string];  // [YES token, NO token]
    outcomes: [string, string];  // ["Up", "Down"]
    strikePrice: number;         // BTC price at start
    startTime: number;           // Unix ms - market opens
    endTime: number;             // Unix ms - resolution time
    resolved: boolean;
    outcome?: 'UP' | 'DOWN';
  }

  Market Discovery

  Markets are fetched from Polymarket's Gamma API by series:

  // From backtest/fetchers/polymarket-markets.ts:68-162
  const CRYPTO_SERIES = ['btc-up-or-down-15m'];

  // Fetch series → filter by date → fetch event details → extract strike price
  const seriesResponse = await axios.get(`${GAMMA_API_URL}/series`, { params: { slug: seriesSlug } });
  const events = seriesData[0].events.filter(e => eventEnd >= startTime && eventEnd <= endTime);

  Strike price comes from Polymarket's crypto API:
  // From backtest/fetchers/polymarket-markets.ts:231-249
  async function fetchStrikePrice(market): Promise<number | null> {
    const url =
  `https://polymarket.com/api/crypto/crypto-price?symbol=BTC&eventStartTime=${startTime}&variant=fifteen&endDate=${endTime}`;
    const response = await axios.get(url);
    return response.data.openPrice;  // This is the "Price to Beat"
  }

  ---
  3. Oracle & Settlement

  The Oracle Mismatch Problem

  Problem: Polymarket settles using Chainlink oracle, but for real-time pricing we use Binance (faster, more liquid). These prices diverge
   by ~$50-$150.

  Timeline:
    T=0     : Market starts, Strike = Chainlink price at T=0
    T=1-14m : Trade using Binance for fair value (fast updates)
    T=15m   : Settlement using Chainlink price at T=15m

  If Binance shows $88,000 but Chainlink shows $87,896:
    - Model thinks "BTC is $100 above strike, P(UP) = 65%"
    - But settlement will use Chainlink: P(UP) might only be 52%

  Solution: Self-Calibrated Adjustment

  The adjustment sweep (backtest/adjustment-sweep.ts) finds the optimal correction:

  // From backtest/adjustment-sweep.ts:71-76
  // Default adjustments to test
  result.adjustments = [0, -50, -75, -100, -104, -120, -150];

  // Apply adjustment to Binance price before fair value calculation
  // From backtest/engine/simulator.ts:306-309
  btcPrice = kline.close;  // Binance price
  if (this.config.binanceChainlinkAdjustment !== 0) {
    btcPrice = btcPrice + this.config.binanceChainlinkAdjustment;  // e.g., -104
  }

  The sweep found --adjustment -104 as optimal, meaning Chainlink is typically ~$104 below Binance.

  Settlement Logic

  // From backtest/fetchers/polymarket-markets.ts:255-260
  export function determineOutcome(finalBtcPrice: number, strikePrice: number): 'UP' | 'DOWN' {
    return finalBtcPrice > strikePrice ? 'UP' : 'DOWN';
  }

  // From backtest/engine/position-tracker.ts:77-111
  resolve(marketId, outcome, finalBtcPrice, strikePrice): MarketResolution {
    // YES pays $1 if UP, $0 if DOWN
    // NO pays $1 if DOWN, $0 if UP
    const yesPayout = position.yesShares * (outcome === 'UP' ? 1 : 0);
    const noPayout = position.noShares * (outcome === 'DOWN' ? 1 : 0);
    const pnl = (yesPayout + noPayout) - (position.yesCost + position.noCost);
  }

  ---
  4. Fair Value Calculation (Black-Scholes)

  Complete Flow: BTC Price → Trade Decision

  1. GET BTC PRICE (Binance + adjustment)
     btcPrice = binanceClose + (-104)  // Adjust for Chainlink divergence

  2. GET VOLATILITY (blended)
     vol = 0.70 * realizedVol1h + 0.20 * realizedVol4h + 0.10 * dvolImplied

  3. CALCULATE FAIR VALUE (Black-Scholes with adjustments)
     τ = secondsRemaining / (365 * 24 * 3600)  // Time in years
     σ_eff = applyVolSmile(baseVol, currentPrice, strikePrice, σ√τ)
     d₂ = [ln(S/K) + (r - σ²/2)τ] / (σ√τ)    // Drift-corrected
     d₂ = applyKurtosisAdjustment(d₂)         // Fat tails
     P(UP) = Φ(d₂)                             // Normal CDF

  4. CALCULATE EDGE
     buyPrice = midPrice + spread/2
     edge = fairValue - buyPrice

  5. TRADE DECISION
     if (edge >= minEdge && canTrade) → BUY

  Key Black-Scholes Code

  // From strategies/black-scholes.ts:101-176
  calculateFairValue(currentPrice, strikePrice, secondsRemaining, annualizedVol, applyAdjustments): FairValue {
    const tau = secondsRemaining / SECONDS_PER_YEAR;
    let effectiveVol = annualizedVol;

    // 1. Apply volatility smile (OTM options have higher IV)
    if (applyAdjustments) {
      effectiveVol = this.applyVolSmile(effectiveVol, currentPrice, strikePrice, baseSigmaT);
    }

    const sigmaT = effectiveVol * Math.sqrt(tau);

    // 2. Drift correction (Itô's lemma): d₂ = [ln(S/K) + (r - σ²/2)τ] / (σ√τ)
    const r = BS_PARAMS.RISK_FREE_RATE;  // = 0
    const driftTerm = (r - (effectiveVol ** 2) / 2) * tau;
    let d = (Math.log(currentPrice / strikePrice) + driftTerm) / sigmaT;

    // 3. Fat tails adjustment (kurtosis)
    if (applyAdjustments && Math.abs(d) > BS_PARAMS.KURTOSIS_THRESHOLD) {
      const sign = d > 0 ? 1 : -1;
      const excess = Math.abs(d) - BS_PARAMS.KURTOSIS_THRESHOLD;
      d = sign * (BS_PARAMS.KURTOSIS_THRESHOLD + excess / BS_PARAMS.KURTOSIS_FACTOR);
    }

    // 4. P(UP) = Φ(d₂)
    const pUp = this.normalCDF(d);
    return { pUp, pDown: 1 - pUp, d, sigmaT };
  }

  Volatility Blending

  // From volatility-service.ts:354-392
  getVolForHorizon(horizonMinutes: number): number {
    const implied = this.shortTermIV ?? this.dvolImplied;

    // Ultra short-term (< 30 min) - realized volatility dominates
    if (horizonMinutes <= 30) {
      const blended = 0.70 * this.realizedVol1h    // 70% recent action
                    + 0.20 * this.realizedVol4h    // 20% stability context
                    + 0.10 * implied;               // 10% market signal
      return Math.max(0.10, Math.min(3.00, blended));
    }
    // ... longer horizons use more implied vol
  }

  Realized vol calculation (from Binance 1-min klines):
  // From volatility-service.ts:213-236
  private calculateRealizedVol(klines: Kline[]): number {
    // Log returns: r_i = ln(close_i / close_{i-1})
    const logReturns = klines.map((k, i) => i > 0 ? Math.log(k.close / klines[i-1].close) : 0);

    // Standard deviation
    const mean = logReturns.reduce((a, b) => a + b) / logReturns.length;
    const variance = logReturns.reduce((sum, r) => sum + (r - mean)**2, 0) / (logReturns.length - 1);
    const stdDev = Math.sqrt(variance);

    // Annualize (1-min intervals → 525,600 per year)
    return stdDev * Math.sqrt(525600);
  }

  ---
  5. Trade Execution

  Order Matching

  // From backtest/engine/order-matcher.ts:39-49
  getBuyPrice(midPrice: number): number {
    const spreadDecimal = this.config.spreadCents / 100;  // e.g., 1¢ = 0.01
    let buyPrice = (midPrice + spreadDecimal / 2);        // Buy at mid + half spread
    return Math.round(buyPrice * 100) / 100;              // Round to 1¢
  }

  Normal vs Conservative Mode
  ┌──────────────┬─────────────────────────────┬─────────┬──────────────────────┐
  │     Mode     │       BTC Price Used        │ Latency │       Use Case       │
  ├──────────────┼─────────────────────────────┼─────────┼──────────────────────┤
  │ Normal       │ Kline close                 │ 0ms     │ Optimistic baseline  │
  ├──────────────┼─────────────────────────────┼─────────┼──────────────────────┤
  │ Conservative │ Kline low (YES) / high (NO) │ 200ms   │ Realistic worst-case │
  └──────────────┴─────────────────────────────┴─────────┴──────────────────────┘
  // From backtest/engine/simulator.ts:102-112
  private applyModeSettings(): void {
    if (this.config.mode === 'conservative') {
      this.useWorstCasePricing = true;
      this.effectiveLatencyMs = this.config.executionLatencyMs || 200;
    } else {
      this.useWorstCasePricing = false;
      this.effectiveLatencyMs = this.config.executionLatencyMs;
    }
  }

  // From backtest/engine/simulator.ts:408-421
  // Buying YES = betting BTC goes UP → worst case: BTC was at LOW (P(up) is lower)
  // Buying NO = betting BTC goes DOWN → worst case: BTC was at HIGH (P(down) is lower)
  btcPriceForFV = side === 'YES' ? kline.low : kline.high;

  Position Tracking & Limits

  // From backtest/engine/position-tracker.ts:200-212
  canTrade(marketId, side, size, maxPositionPerMarket): boolean {
    const position = this.positions.get(marketId);
    if (!position) return size <= maxPositionPerMarket;
    const currentShares = side === 'YES' ? position.yesShares : position.noShares;
    return currentShares + size <= maxPositionPerMarket;
  }

  ---
  6. File Structure Analysis

  Core Files (Keep As-Is)

  ✅ strategies/
     ├── types.ts           # PricingStrategy interface, FairValue type
     ├── black-scholes.ts   # BS implementation (178 lines)
     ├── ljd.ts             # LJD implementation (277 lines) - can simplify/remove
     └── index.ts           # Factory (96 lines)

  ✅ backtest/
     ├── types.ts           # All type definitions (307 lines)
     ├── index.ts           # CLI entry point (510 lines)
     ├── engine/
     │   ├── simulator.ts   # Main backtest engine (765 lines)
     │   ├── order-matcher.ts   # Trade execution (189 lines)
     │   └── position-tracker.ts # Position management (262 lines)
     ├── fetchers/
     │   ├── binance-historical.ts   # BTC klines (399 lines)
     │   ├── chainlink-historical.ts # Oracle prices (674 lines)
     │   ├── polymarket-markets.ts   # Market discovery (429 lines)
     │   ├── polymarket-prices.ts    # YES/NO prices
     │   └── deribit-vol.ts          # DVOL fetcher
     └── output/
         ├── statistics.ts   # Stats calculation
         ├── trade-log.ts    # Export functions
         └── pnl-curve.ts    # P&L visualization

  ✅ Live Trading (Root)
     ├── volatility-service.ts  # Live vol calculation (432 lines)
     ├── config.ts              # Trading config (89 lines)
     └── fair-value.ts          # Backward compat shim (96 lines)

  Cleanup Candidates (Dead/Redundant Code)

  ❓ backtest/
     ├── diagnose-fair-value.ts      # One-off diagnostic (can keep for debugging)
     ├── analyze-binance-accuracy.ts # Analysis script
     ├── analyze-binance-accuracy-fast.ts # Duplicate
     ├── analyze-divergence.ts       # Analysis script
     ├── analyze-divergence-timeseries.ts # Analysis
     ├── analyze-sharpe.ts           # Analysis
     ├── adaptive-adjustment-test.ts # Experimental
     ├── conservative-mode-test.ts   # Test harness
     ├── out-of-sample-test.ts       # Test harness
     ├── vol-mult-sweep.ts           # Parameter sweep
     ├── fetch-1month.ts             # One-off data fetch
     └── engine/adaptive-adjustment.ts # Experimental

  ⚠️ Root (live trading - untested)
     ├── arb-trader.ts        # Main trader (18k - large, needs refactor)
     ├── index.ts             # Entry point (missing dependencies)
     ├── binance-ws.ts        # WebSocket client
     ├── market-finder.ts     # Market discovery
     ├── orderbook-service.ts # Orderbook management
     ├── position-manager.ts  # Live positions
     ├── resolution-tracker.ts # Resolution monitoring
     ├── strike-service.ts    # Strike price fetching
     ├── telegram.ts          # Alerts
     ├── execution-metrics.ts # Metrics
     └── types.ts             # Root types

  Strategy-Related (Simplify)

  🔧 strategies/ljd.ts       # Can remove if not using LJD
  🔧 strategies/index.ts     # Simplify factory if only BS
  🔧 backtest/types.ts       # Remove LJDParams if not using
  🔧 backtest/index.ts       # Remove --ljd flags if not using

  ---
  7. Configuration

  Environment Variables

  # Required for backtest
  ARCHIVE_RPC_URL=          # Polygon archive node (Alchemy/Ankr) for Chainlink

  # Required for live trading
  RPC_URL=                  # Polygon RPC
  PRIVATE_KEY=              # Trading wallet
  FUNDER_ADDRESS=           # Polymarket proxy address
  CLOB_HOST=                # https://clob.polymarket.com
  CHAIN_ID=137              # Polygon

  # Optional trading params
  ARB_EDGE_MIN=0.2          # Minimum edge (20%)
  ARB_STOP_BEFORE_END=30    # Stop 30s before resolution
  ARB_MAX_ORDER_USD=2       # $2 per trade
  ARB_MAX_POSITION_USD=5    # $5 per market
  ARB_MAX_TOTAL_USD=10000000 # Total exposure limit
  ARB_SLIPPAGE_BPS=200      # 2% slippage

  # Telegram alerts
  TELEGRAM_BOT_TOKEN=
  TELEGRAM_CHAT_ID=

  Backtest CLI Parameters

  npx ts-node backtest/index.ts \
    --days 14 \                    # Period length
    --spread 1 \                   # Spread in cents
    --edge 2 \                     # Min edge % to trade
    --size 100 \                   # Shares per order
    --max-pos 1000 \               # Max position per market
    --lag 0 \                      # BTC observation delay
    --latency-ms 0 \               # Execution delay
    --vol-mult 1.0 \               # Vol multiplier
    --adjustment -104 \            # Binance→Chainlink correction
    --strategy bs \                # Pricing strategy (bs/ljd)
    --normal                       # Mode (normal/conservative)

  Key Tunable Parameters
  ┌────────────────────┬──────────────┬──────────────────────┬──────────────────────┐
  │     Parameter      │   Backtest   │         Live         │       Location       │
  ├────────────────────┼──────────────┼──────────────────────┼──────────────────────┤
  │ Min Edge           │ --edge       │ ARB_EDGE_MIN         │ CLI / config.ts      │
  ├────────────────────┼──────────────┼──────────────────────┼──────────────────────┤
  │ Spread             │ --spread     │ Polymarket API       │ CLI / live orderbook │
  ├────────────────────┼──────────────┼──────────────────────┼──────────────────────┤
  │ Vol Multiplier     │ --vol-mult   │ N/A                  │ CLI only             │
  ├────────────────────┼──────────────┼──────────────────────┼──────────────────────┤
  │ Binance Adjustment │ --adjustment │ Manual               │ CLI / hardcode       │
  ├────────────────────┼──────────────┼──────────────────────┼──────────────────────┤
  │ Order Size         │ --size       │ ARB_MAX_ORDER_USD    │ CLI / config.ts      │
  ├────────────────────┼──────────────┼──────────────────────┼──────────────────────┤
  │ Position Limit     │ --max-pos    │ ARB_MAX_POSITION_USD │ CLI / config.ts      │
  └────────────────────┴──────────────┴──────────────────────┴──────────────────────┘
  ---
  This covers the complete system architecture. The key insight is that the oracle adjustment ($-104) is critical - it bridges the        
  Binance/Chainlink price gap and is discovered through the adjustment sweep backtest.