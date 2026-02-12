# Market-Making Strategy Specification

## Final — v1.0

Polymarket 15-minute BTC Up/Down binary options. Complements the existing
Black-Scholes taker arbitrage strategy by adding resting maker orders that
capture spread + earn rebates, while retaining FAK taker capability for
high-edge situations.

---

## 1. Strategy Classification

**AS-lite informed market maker.**

- **NOT true Avellaneda-Stoikov**: Poisson arrival calibration is excluded
  (insufficient data in 15-min markets). Optimal spread formula collapses to
  rounding on 1-cent ticks. We use only the inventory-skew concept.
- **NOT naive market-making**: Quotes are centered on Black-Scholes fair value,
  not market mid. The BS model is our informational edge.
- **NOT pure arb/taker**: We rest limit orders to earn maker rebates and capture
  spread, not just hit mispriced asks.

### Core Formula

```
quote_center = fair_value - (net_inventory / max_inventory) * skew_max_cents
bid = round_to_tick(quote_center - half_spread)
ask = round_to_tick(quote_center + half_spread)
```

Where:
- `fair_value` = N(d2) from Black-Scholes (same model as taker strategy)
- `net_inventory` = yes_shares - no_shares (signed, directional exposure)
- `max_inventory` = configurable hard limit (default 100 shares)
- `skew_max_cents` = 0.02 (2 cents max skew at full inventory)
- `half_spread` = configurable (default 0.03 = 3 cents per side)

### Gross Inventory Throttle

```
gross_inventory = yes_shares + no_shares
gross_ratio = gross_inventory / max_gross_shares

if gross_ratio > 0.7:
    half_spread += (gross_ratio - 0.7) * 0.10    # widen up to 3c extra at 100%
if gross_ratio >= 1.0:
    cancel all bids (no new inventory)
```

---

## 2. Unified Order Book Abstraction

Polymarket operates a unified book: a YES buy at $0.35 is equivalent to a NO
sell at $0.65. The matching engine handles this transparently, but we must
compute effective prices from both books.

### `getUnifiedTopOfBook()`

```typescript
interface UnifiedTopOfBook {
  yesBestBid: number;   // best price to sell YES
  yesBestAsk: number;   // best price to buy YES
  noBestBid: number;    // best price to sell NO
  noBestAsk: number;    // best price to buy NO
  yesSpread: number;
  noSpread: number;
  isValid: boolean;     // false if data missing/stale/crossed
  staleSide: 'yes' | 'no' | 'both' | null;
}

function getUnifiedTopOfBook(ob: OrderBookState): UnifiedTopOfBook {
  // Cross-book effective prices
  const crossYesBid = 1 - ob.noAsk;    // selling YES = buying NO complement
  const crossYesAsk = 1 - ob.noBid;    // buying YES = selling NO complement
  const crossNoBid  = 1 - ob.yesAsk;
  const crossNoAsk  = 1 - ob.yesBid;

  // Best effective price = best of native + cross-book
  const yesBestBid = Math.max(ob.yesBid, crossYesBid);
  const yesBestAsk = Math.min(ob.yesAsk, crossYesAsk);
  const noBestBid  = Math.max(ob.noBid, crossNoBid);
  const noBestAsk  = Math.min(ob.noAsk, crossNoAsk);

  // Validity checks
  const yesSpread = yesBestAsk - yesBestBid;
  const noSpread  = noBestAsk - noBestBid;
  const isValid   = yesSpread > 0 && noSpread > 0;

  return {
    yesBestBid, yesBestAsk, noBestBid, noBestAsk,
    yesSpread, noSpread, isValid, staleSide: null,
  };
}
```

### Staleness Detection

```typescript
const MAX_BOOK_AGE_MS = 5000;  // 5 seconds

function isBookFresh(ob: OrderBookState): boolean {
  return (Date.now() - ob.timestamp) < MAX_BOOK_AGE_MS;
}
```

### Handling Invalid / Stale / Crossed Data

On every quote cycle, before computing quotes:

1. **Missing data** (bid=0 or ask=0 on either side): Skip cycle entirely. Do
   not quote. Log warning.
2. **Stale data** (book age > 5s): Skip cycle. Do not quote. Existing orders
   remain (GTD will expire on their own). Log warning.
3. **Crossed book** (best_bid >= best_ask after unification): Skip cycle. This
   indicates either stale data or a transient arbitrage opportunity being
   consumed. Do not quote into a crossed book.
4. **One side stale, other fresh**: Mark `staleSide`. Only quote the fresh side
   (sell inventory on fresh side, do not place bids on stale side).

**Rule: Never place a new order when the book is invalid. Existing orders are
allowed to rest (they have GTD expiration as safety net).**

### Arbitrage Constraint (Pre-Placement Gate)

Before placing any order, verify the combined book does not create free money:

```typescript
function enforceArbitrageConstraint(
  yesBid: number, yesAsk: number,
  noBid: number, noAsk: number,
  tick: number
): { yesBid: number; yesAsk: number; noBid: number; noAsk: number } {
  // Bids must not sum > 1.00 (otherwise arbers drain us)
  if (yesBid + noBid > 1.00) {
    const excess = yesBid + noBid - 1.00;
    yesBid = Math.max(0.01, yesBid - Math.ceil(excess / 2 / tick) * tick);
    noBid  = Math.max(0.01, noBid  - Math.ceil(excess / 2 / tick) * tick);
  }
  // Asks must not sum < 1.00
  if (yesAsk + noAsk < 1.00) {
    const deficit = 1.00 - yesAsk - noAsk;
    yesAsk = Math.min(0.99, yesAsk + Math.ceil(deficit / 2 / tick) * tick);
    noAsk  = Math.min(0.99, noAsk  + Math.ceil(deficit / 2 / tick) * tick);
  }
  return { yesBid, yesAsk, noBid, noAsk };
}
```

This is a **hard gate** — if quotes violate the constraint, they are adjusted
before placement, never skipped silently.

---

## 3. Order Lifetime: GTD with Market-Aligned Expiration

### Why GTD (not GTC)

GTC orders survive bot crashes. A stale directional bet resting through
resolution creates uncontrolled risk. GTD orders die automatically, providing
crash safety as a structural guarantee.

### Expiration Math

Polymarket GTD orders require a unix timestamp (seconds) at least 60 seconds in
the future (the "security threshold").

```typescript
function computeGtdExpiration(marketEndTimeMs: number, nowMs: number): number {
  const timeLeftMs = marketEndTimeMs - nowMs;

  // Kill orders at least 90s before resolution (our safety margin)
  const desiredLifetimeMs = Math.min(120_000, timeLeftMs - 90_000);

  // Polymarket requires >= 60s in the future
  const lifetimeMs = Math.max(60_000, desiredLifetimeMs);

  return Math.floor((nowMs + lifetimeMs) / 1000);
}
```

**Example timeline** (market ends at T=900s):

| now (s left) | desiredLifetime | clamped | expires at (s left) | Notes |
|---|---|---|---|---|
| 800s left | 120s | 120s | 680s left | Normal quoting |
| 300s left | 120s | 120s | 180s left | Normal quoting |
| 180s left | 90s | 90s | 90s left | Orders die right at wind-down |
| 150s left | 60s | 60s | 90s left | Minimum GTD lifetime |
| 130s left | 40s → 60s | 60s | 70s left | Clamped to 60s minimum |

### Split by Phase

- **Quoting phase (>120s left)**: BUY orders use GTD. SELL orders use GTD.
- **Wind-down phase (30-120s left)**: No new BUY orders. SELL orders use **GTC**
  (safe because: sells reduce inventory, and if bot crashes during wind-down,
  resolution voids unfilled sell orders — but we do NOT rely on this, see
  Section 8).
- **Stop phase (<30s left)**: Cancel everything. FAK exit only.

---

## 4. Time Phases and Dedicated Phase Timer

### Phase Definitions

```
QUOTING:    time_left > 120s   — place bids + asks, normal MM
WIND_DOWN:  30s < time_left <= 120s  — cancel bids, sell inventory
STOP:       time_left <= 30s   — cancel all, FAK emergency exit
```

### Dedicated Timer (CRITICAL)

Phase transitions **must not** depend on the quote refresh cadence (which runs
every 2-5s depending on book activity). A dedicated `setInterval` runs at
**1-second resolution** and is the sole authority for phase transitions.

```typescript
// Dedicated phase timer — runs independently of quote refresh
private phaseTimer: ReturnType<typeof setInterval> | null = null;
private currentPhase: 'QUOTING' | 'WIND_DOWN' | 'STOP' = 'QUOTING';

startPhaseTimer(marketEndTimeMs: number): void {
  this.phaseTimer = setInterval(() => {
    const timeLeftMs = marketEndTimeMs - Date.now();
    const timeLeftSec = timeLeftMs / 1000;

    if (timeLeftSec <= 30 && this.currentPhase !== 'STOP') {
      this.currentPhase = 'STOP';
      this.onEnterStop();        // cancel all, FAK exit
    } else if (timeLeftSec <= 120 && this.currentPhase === 'QUOTING') {
      this.currentPhase = 'WIND_DOWN';
      this.onEnterWindDown();    // cancel bids, start selling
    }
  }, 1000);  // 1-second resolution
}
```

### Phase Transition Actions

**QUOTING → WIND_DOWN** (`onEnterWindDown`):
1. Cancel ALL resting buy orders immediately
2. Resync inventory from API (see Section 7)
3. Place GTC sell orders for all inventory at competitive prices
4. Quote refresh continues for sell-side only

**WIND_DOWN → STOP** (`onEnterStop`):
1. Cancel ALL resting orders (buy and sell)
2. If inventory > 0: place FAK sell at `best_bid - 1 tick` (fire-sale)
3. No further order placement

**On market switch** (`switchToNextMarket`):
1. Clear phase timer
2. Cancel all orders for previous market
3. Reset phase to QUOTING for new market

---

## 5. Hybrid Maker / Taker Mode

The strategy dynamically chooses between maker (GTD limit) and taker (FAK) based
on the current edge level.

### Decision Logic

```
gross_edge = fair_value - market_best_ask

if gross_edge > 0.15:           # >15% edge
    → TAKER (FAK): speed matters, edge is large enough to absorb fees
    → Fee formula: shares * price * 0.25 * (price * (1-price))^2
    → Max fee ~1.56% at p=0.50, near-zero at extremes

elif gross_edge > 0:            # 0-15% edge
    → MAKER (GTD): rest limit order, capture spread + rebate
    → Zero taker fees, plus daily maker rebate (20% of taker fee pool)

else:                           # no edge
    → MAKER (GTD): spread-only capture
    → Bid/ask around fair value, earn spread on both sides
```

### Maker Rebate Eligibility

- **Automatic**: any filled maker order qualifies. No opt-in.
- **Pro-rata**: rebate pool = 20% of daily taker fees, distributed proportional
  to maker's fee-equivalent volume.
- **Fee-equivalent**: `shares * price * 0.25 * (price*(1-price))^2` — same
  formula as taker fees, but computed on the maker's filled volume for rebate
  allocation purposes.
- **Single-sided OK**: one-sided maker orders qualify, but two-sided quoting
  generates more volume and therefore more rebate.

---

## 6. Fill-and-Flip Exit Logic

When a BUY order fills, immediately place a SELL order to capture spread +
(optionally) BS edge.

### Flip Sell Price with Time-Based De-Greed

The flip sell starts at fair value (maximum greed) and decays toward the
competitive ask over 60 seconds.

```typescript
function computeFlipSellPrice(
  fillPrice: number,
  fairValue: number,
  bestAsk: number,
  fillAgeMs: number,
  tickSize: number
): number {
  const GREED_WINDOW_MS = 15_000;     // 0-15s: full greed
  const DECAY_WINDOW_MS = 45_000;     // 15-60s: linear decay
  const TOTAL_WINDOW_MS = GREED_WINDOW_MS + DECAY_WINDOW_MS;

  // Minimum sell price: fill + 2 cents (guaranteed profit per share)
  const minSell = fillPrice + 0.02;

  // Greed target = fair value (max upside)
  // Competitive target = best ask (guaranteed to be near top of book)
  let target: number;

  if (fillAgeMs <= GREED_WINDOW_MS) {
    // Phase 1: full greed — post at fair value
    target = fairValue;
  } else if (fillAgeMs <= TOTAL_WINDOW_MS) {
    // Phase 2: linear decay from fair value toward best ask
    const decayProgress = (fillAgeMs - GREED_WINDOW_MS) / DECAY_WINDOW_MS;
    target = fairValue + (bestAsk - fairValue) * decayProgress;
  } else {
    // Phase 3: competitive — join best ask
    target = bestAsk;
  }

  // Floor at minimum profitable price
  const finalPrice = Math.max(minSell, target);
  return Math.round(finalPrice / tickSize) * tickSize;
}
```

### Flip Sell Lifecycle

1. BUY fills → record `fillPrice`, `fillTimestamp`
2. Immediately post SELL at `computeFlipSellPrice(age=0)` → typically fair_value
3. Every quote refresh cycle (2-5s), recompute and update if price changed by
   >= tolerance (2 ticks)
4. At 60s+ post-fill, sell joins best_ask (competitive, high fill probability)
5. At WIND_DOWN phase, all sells become urgent (join best_bid if needed)

---

## 7. Inventory Management and Over-Sell Protection

### Inventory Tracking

```typescript
interface InventoryState {
  yesShares: number;      // shares held
  noShares: number;       // shares held
  yesPendingSell: number; // shares in resting sell orders
  noPendingSell: number;  // shares in resting sell orders
}

// Net inventory (directional exposure)
net_inventory = yesShares - noShares;

// Gross inventory (total capital at risk)
gross_inventory = yesShares + noShares;

// Available to sell (hard guard against over-selling)
yesAvailableToSell = yesShares - yesPendingSell;
noAvailableToSell  = noShares - noPendingSell;
```

### Hard Sell Guard (CRITICAL)

Before placing ANY sell order:

```typescript
function computeSellSize(
  intendedSize: number,
  currentShares: number,
  pendingSellShares: number
): number {
  const available = currentShares - pendingSellShares;
  return Math.max(0, Math.min(intendedSize, available));
}
```

**Rule: `sell_size = min(inventory_available, intended_sell_size)`. If available
<= 0, do not place the sell order. This prevents over-selling when fills arrive
out of order or WebSocket confirmations are delayed.**

### API Resync Before Wind-Down

When transitioning from QUOTING to WIND_DOWN:

1. Fetch open orders from API: `GET /orders?market=<conditionId>&open=true`
2. Reconcile local order cache with API response
3. Compute true `pendingSellShares` from API data (not local cache)
4. Only then compute wind-down sell sizes

This prevents scenarios where a WebSocket fill notification was missed and local
inventory is out of sync.

### Periodic Resync (Every 30s During Quoting)

Every 30 seconds, fetch open orders from API and reconcile with local state.
If discrepancies are found, log a warning and update local state to match API.

---

## 8. Safety Architecture

### Three Pillars (No Resolution Dependency)

The safety model relies on exactly three mechanisms. Market resolution (which
voids unfilled orders) is a **nice-to-have cleanup**, NOT a safety assumption.

**Pillar 1: GTD Expiration**
- All buy orders during quoting phase use GTD with market-aligned expiration
- Orders die automatically even if the bot crashes
- No stale directional bets can survive through resolution

**Pillar 2: Cancel-All on Startup**
- On every bot startup, before placing any new orders:
  `DELETE /<clob-endpoint>/cancel-all`
- This handles: bot crashes, restarts, network partitions
- Must complete before any new order placement

**Pillar 3: Explicit Time Phases**
- Dedicated 1s timer forces phase transitions regardless of quote refresh
- WIND_DOWN cancels all bids and sells inventory
- STOP cancels everything and does FAK fire-sale
- Phase transitions are idempotent (safe to trigger multiple times)

### Failure Mode Table

| Failure | Impact | Mitigation |
|---------|--------|------------|
| Bot crash during quoting | GTD orders expire, no new orders | Cancel-all on restart |
| Bot crash during wind-down | GTC sells may rest, buys already cancelled | Cancel-all on restart; GTC sells are safe (reduce inventory) |
| WebSocket disconnect | No new quotes placed (no book data) | Staleness guard skips cycles; existing GTD orders expire |
| API timeout on cancel | Orders may still rest | GTD expiration is the backstop; retry cancel on next cycle |
| Fill notification missed | Local inventory out of sync | API resync every 30s + before wind-down |
| Book data crossed/stale | Bad quotes placed | Validity check skips cycle; never quote into crossed book |
| Network partition at T-30s | Can't cancel, can't place FAK | GTD orders expire; worst case = hold through resolution (P&L determined by market outcome, not unlimited loss) |

### What Market Resolution Does (Informational, Not Safety-Critical)

When a market resolves:
- All unfilled orders are voided by the exchange
- Shares pay out $1 (correct outcome) or $0 (incorrect outcome)
- This is a natural cleanup, but our safety model does not depend on it

---

## 9. Cancel/Replace Tolerance

### Fixed 2-Tick Tolerance

Only cancel and replace an order if the target price moved >= 2 ticks (2 cents).

**Rationale:**
- 1 tick (1 cent) causes excessive cancellation, loses queue priority
- 3+ ticks is too sluggish for 15-min markets
- 2 ticks balances responsiveness vs. queue retention
- On 1-cent ticks, 2 ticks = 2% price movement at p=1.00, 4% at p=0.50

```typescript
const ORDER_TOLERANCE_TICKS = 2;
const tickSize = 0.01;  // BTC 15-min markets

function shouldUpdateOrder(
  currentPrice: number,
  targetPrice: number
): boolean {
  return Math.abs(currentPrice - targetPrice) >= ORDER_TOLERANCE_TICKS * tickSize;
}
```

### Rate Limit Awareness

Polymarket rate limits:
- Order placement: 3500 burst / 10s, 36000 sustained / 10min
- Cancellation: 3000 burst / 10s
- Throttled (delayed), not rejected

With 2-tick tolerance and 2-5s refresh, we stay well within limits even with
4 active orders (YES bid, YES ask, NO bid, NO ask).

---

## 10. Configuration Parameters

New parameters to add to `config.ts`:

```typescript
interface MarketMakerConfig {
  // Mode
  makerEnabled: boolean;          // Enable MM mode (default: false)

  // Spread
  halfSpreadCents: number;        // Half-spread per side in cents (default: 3)

  // Inventory limits
  maxInventoryShares: number;     // Max net inventory per side (default: 100)
  maxGrossShares: number;         // Max total shares held (default: 200)
  skewMaxCents: number;           // Max inventory skew in cents (default: 2)

  // Order management
  quoteRefreshMs: number;         // Quote refresh interval in ms (default: 3000)
  orderToleranceTicks: number;    // Min ticks to trigger cancel/replace (default: 2)
  orderExpirationBuffer: number;  // Seconds before resolution to kill orders (default: 90)

  // Hybrid mode
  takerEdgeThreshold: number;     // Edge above which to use FAK taker (default: 0.15)

  // Safety
  cancelOnStartup: boolean;       // Cancel all orders on startup (default: true)
  apiResyncIntervalMs: number;    // Resync open orders from API (default: 30000)
  bookMaxAgeMs: number;           // Max orderbook age before skipping cycle (default: 5000)
}
```

Environment variables:

```
MM_ENABLED=false
MM_HALF_SPREAD_CENTS=3
MM_MAX_INVENTORY=100
MM_MAX_GROSS=200
MM_SKEW_MAX_CENTS=2
MM_QUOTE_REFRESH_MS=3000
MM_ORDER_TOLERANCE_TICKS=2
MM_ORDER_EXPIRATION_BUFFER=90
MM_TAKER_EDGE_THRESHOLD=0.15
MM_CANCEL_ON_STARTUP=true
MM_API_RESYNC_MS=30000
MM_BOOK_MAX_AGE_MS=5000
```

---

## 11. File Plan

### New Files

| File | Lines | Purpose |
|------|-------|---------|
| `market-maker.ts` | ~350 | Core MM loop: quote computation, phase management, flip sells |
| `order-manager.ts` | ~200 | Order state tracking, cancel/replace, API resync |

### Modified Files

| File | Changes |
|------|---------|
| `trading-service.ts` | Add `placeOrderGTD()`, `cancelAll()`, `cancelOrders()`, `getOpenOrders()` |
| `config.ts` | Add `MarketMakerConfig` interface and `loadMmConfig()` |
| `index.ts` | Cancel-all on startup, MM mode wiring, phase timer lifecycle |
| `types.ts` | Add `UnifiedTopOfBook`, `InventoryState` interfaces |

### Unchanged Files

All existing taker-arb files remain functional. MM mode is additive — the
existing `ArbTrader` continues to work when `MM_ENABLED=false`.

---

## 12. Implementation Phases

### Phase 1: Basic Maker Quoting (MVP)
- `market-maker.ts` with quote computation, GTD placement, cancel/replace
- `order-manager.ts` with local order tracking
- `trading-service.ts` extensions (GTD, cancelAll, getOpenOrders)
- Config additions
- Cancel-all on startup
- Dedicated phase timer
- Book validity checks

### Phase 2: Fill-and-Flip
- Fill detection via WebSocket order status messages
- Flip sell placement with time-based de-greed
- Inventory tracking with hard sell guard

### Phase 3: Inventory-Aware Quoting
- Net inventory skew on quote center
- Gross inventory throttle (spread widening)
- API resync every 30s + before wind-down

### Phase 4: Hybrid Maker/Taker
- Edge-based mode selection (>15% = FAK, 0-15% = GTD)
- Unified decision loop integrating both modes
- Telegram alerts for MM fills and inventory state

---

## 13. Polymarket API Reference

### Order Placement (GTD)
```typescript
// Via @polymarket/clob-client
const result = await clobClient.createAndPostOrder(
  {
    tokenID: tokenId,
    price: price,        // 0.01 to 0.99
    side: Side.BUY,      // or Side.SELL
    size: size,          // shares (min 5)
    expiration: Math.floor(expirationMs / 1000).toString(),  // unix seconds
  },
  { tickSize: "0.01", negRisk: true },
  OrderType.GTD
);
```

### Cancel All Orders
```
DELETE /<clob-endpoint>/cancel-all
```

### Get Open Orders
```
GET /<clob-endpoint>/orders?market=<conditionId>&open=true
```

### Taker Fee Formula
```
fee = shares * price * 0.25 * (price * (1 - price))^2
```
Max ~1.56% at p=0.50, near-zero at extremes (p<0.10 or p>0.90).

### Maker Fees
Zero. Plus daily rebate from 20% of taker fee pool.

---

## Appendix A: Quote Cycle Pseudocode

```
every quote_refresh_ms:
    if currentPhase == STOP: return
    if currentPhase == WIND_DOWN: manageSellsOnly(); return

    ob = getLatestOrderBook()
    if !isBookFresh(ob): skip cycle, log warning, return

    unified = getUnifiedTopOfBook(ob)
    if !unified.isValid: skip cycle, log warning, return

    fairValue = blackScholes(adjustedBtcPrice, strike, timeLeft, vol)
    netInv = yesShares - noShares
    grossInv = yesShares + noShares

    // Inventory skew
    center = fairValue - (netInv / maxInventory) * skewMaxCents

    // Spread (may widen under gross pressure)
    spread = halfSpreadCents
    if grossInv / maxGross > 0.7:
        spread += (grossInv / maxGross - 0.7) * 10  // up to 3c extra

    // Raw quotes
    yesBid = round(center - spread)
    yesAsk = round(center + spread)
    noBid  = round((1 - center) - spread)
    noAsk  = round((1 - center) + spread)

    // Arbitrage constraint
    { yesBid, yesAsk, noBid, noAsk } = enforceArbitrageConstraint(...)

    // Hybrid: check if taker edge exists
    if (fairValue - unified.yesBestAsk) > takerEdgeThreshold:
        placeFAK(YES, BUY, unified.yesBestAsk)
    elif (1-fairValue - unified.noBestAsk) > takerEdgeThreshold:
        placeFAK(NO, BUY, unified.noBestAsk)

    // Maker: place/update GTD orders
    for each (token, bid, ask) in [(YES, yesBid, yesAsk), (NO, noBid, noAsk)]:
        if shouldUpdateOrder(existingBid, bid): cancelAndReplace(bid, GTD)
        if shouldUpdateOrder(existingAsk, ask):
            sellSize = computeSellSize(intended, shares, pendingSell)
            if sellSize > 0: cancelAndReplace(ask, GTD)
```

## Appendix B: Phase Timer Pseudocode

```
every 1 second (dedicated timer, independent of quote refresh):
    timeLeftSec = (marketEndTimeMs - Date.now()) / 1000

    if timeLeftSec <= 30 and phase != STOP:
        phase = STOP
        cancelAllOrders()
        if inventory > 0:
            placeFAK(SELL, bestBid - tick)  // fire-sale

    elif timeLeftSec <= 120 and phase == QUOTING:
        phase = WIND_DOWN
        cancelAllBuyOrders()
        resyncInventoryFromApi()
        placeGtcSellsForAllInventory()
```
