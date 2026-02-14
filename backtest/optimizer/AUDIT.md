# Optimizer Phase 0 — Programmatic API & Sizing Audit

Covers all files relevant to the optimizer: Simulator, DataBundle, position tracking, types, statistics, fees, config, and CLI entry point.

---

## Task 0.1 — Simulator Programmatic API

### Constructor
- **File:** `backtest/engine/simulator.ts:118`
- **Signature:** `constructor(config: Partial<BacktestConfig> = {})`
- Merges with `DEFAULT_CONFIG` at line 119: `{ ...DEFAULT_CONFIG, ...config }`
- Capital initialized at lines 122-124: `availableCapital = config.initialCapital`

### run() Method
- **File:** `backtest/engine/simulator.ts:165`
- **Signature:** `async run(bundle?: DataBundle): Promise<BacktestResult>`
- Accepts optional `DataBundle` — detected at line 209 (`if (bundle)`)
- When bundle provided, uses `bundle.data.markets`, `bundle.data.btcKlines`, etc. (lines 212-215)
- When no bundle, instantiates fetchers internally (lines 219-227)

### State Reset
- **File:** `backtest/engine/simulator.ts:192-201`
- `run()` resets ALL mutable state before each execution:
  - `positionTracker.reset()` (line 193)
  - `orderMatcher.reset()` (line 194)
  - `lastTradeTimestamp.clear()` (line 195)
  - `marketTradeCount.clear()` (line 196)
  - `availableCapital = config.initialCapital` (line 199)
  - `deployedCapital = 0` (line 200)
  - `peakDeployedCapital = 0` (line 201)
- **Conclusion:** Safe to call `run()` multiple times on the same Simulator instance.

### Sizing Logic (Current)
- **File:** `backtest/engine/simulator.ts:644-677`
- **Step 1 (line 644):** `let effectiveSize = this.config.orderSize;` — fixed share count
- **Step 2 (lines 645-648):** `maxOrderUsd` cap — converts to max shares by USD
- **Step 3 (lines 649-658):** `maxPositionUsd` cap — accounts for existing position
- **Step 4 (lines 659):** `if (effectiveSize <= 0) return;` — skip if nothing to trade
- **Step 5 (lines 662-677):** Capital constraint — reduce to affordable size or skip

### Capital Return on Resolution
- **File:** `backtest/engine/simulator.ts:352-364`
- On market resolution, if `initialCapital !== Infinity`:
  - Computes `totalCost` from position (line 354)
  - Computes `totalPayout` from outcome (lines 357-359)
  - Frees deployed capital: `deployedCapital -= totalCost` (line 362)
  - Credits payout: `availableCapital += totalPayout` (line 363)

### Mark-to-Market
- **NOT PRESENT.** Current P&L is settlement-based only.
- `availableCapital` (line 97) tracks cash, NOT equity.
- Position values are never recomputed at mid-market prices during the run.
- **This is where Kelly MTM equity will need to be computed.**

### Silent Mode
- **File:** `backtest/engine/simulator.ts:104-108`
- `config.silent` suppresses `console.log` via `this.log()` wrapper
- Already used in sweep mode (see `backtest/index.ts:702`)

---

## Task 0.2 — DataBundle API

### Static Factory
- **File:** `backtest/engine/data-bundle.ts:50`
- **Signature:** `static async load(startDate: Date, endDate: Date): Promise<DataBundle>`
- Loads 4 sources sequentially: markets, klines, DVOL, Chainlink (lines 58-78)
- Returns immutable `DataBundle` via private constructor (line 42)

### Immutability Guarantee
- **File:** `backtest/engine/data-bundle.ts:20-27`
- `DataBundleData` interface: all fields are `readonly`
- Arrays are reference-shared (not deep-cloned), but Simulator never mutates them

### Usage Pattern (proven)
- **File:** `backtest/index.ts:672-707`
- `runEdgeSweep()` loads bundle once (line 672), reuses across all edge values
- Each iteration creates `new Simulator(config)` (line 706), calls `sim.run(bundle)` (line 707)
- `calculateStatistics(result)` at line 708

### Memory Footprint Estimate
- From coverage report: Binance ~50 MB, Chainlink ~63 MB, Deribit ~0.8 MB, Polymarket ~20 MB
- Total: ~134 MB for 120 days of data
- Single DataBundle fits comfortably in memory for 40-cell grid optimizer

---

## Task 0.3 — State Isolation

### Instance-Level State (Simulator)
- **File:** `backtest/engine/simulator.ts:93-99`
- `lastTradeTimestamp: Map<string, number>` (line 93) — per instance
- `marketTradeCount: Map<string, number>` (line 94) — per instance
- `availableCapital: number` (line 97) — per instance
- `deployedCapital: number` (line 98) — per instance
- `peakDeployedCapital: number` (line 99) — per instance

### Instance-Level State (PositionTracker)
- **File:** `backtest/engine/position-tracker.ts:273-281`
- `positions: Map` — cleared on `reset()` (line 274)
- `resolutions: []` — cleared on `reset()` (line 275)
- `allTrades: []` — cleared on `reset()` (line 276)
- `pnlCurve: []` — cleared on `reset()` (line 277)
- `realizedPnL: number` — reset to 0 (line 278)

### Module-Level State
- **NONE.** All fetchers, trackers, and calculators use instance state only.
- `DEFAULT_CONFIG` (line 33) is a const object — never mutated (spread-merged in constructor).

### Conclusion
- **Safe for parallel-sequential operation:** Create N Simulators, run them sequentially with the same DataBundle. Each `run()` fully resets state.
- **NOT safe for true parallelism** (single Simulator, concurrent runs) — but that's not the plan.

---

## Task 0.4 — Sizing Insertion Point for Kelly

### Current Flow
```
checkAndTrade() {
  // ... fair value, edge check ...

  let effectiveSize = this.config.orderSize;    // ← LINE 644: INSERTION POINT
  // maxOrderUsd cap                              // lines 645-648
  // maxPositionUsd cap                           // lines 649-658
  // skip if zero                                 // line 659
  // capital constraint                           // lines 662-677

  // ... create signal, execute trade ...
}
```

### Kelly Insertion Plan
**Replace line 644** with:
```typescript
let effectiveSize: number;
if (this.config.sizingMode === 'kelly') {
    const equityMTM = this.computeEquityMTM(executionTs);
    const kellyOptimal = edge / (1 - buyPrice);
    const betUsd = equityMTM * this.config.kellyFraction * kellyOptimal;
    effectiveSize = Math.floor(betUsd / buyPrice);
} else {
    effectiveSize = this.config.orderSize;
}
```

### Required Data for MTM
- `availableCapital` — already tracked (line 97)
- Open positions — via `this.positionTracker.getAllPositions()` (line 144)
- Current market prices — need a `lastKnownPrices: Map<string, number>` updated in `processMarket()`
- **No Polymarket order book prices in backtest** — use BS fair value as position valuation

### Backward Compatibility
- New config fields: `sizingMode: 'fixed' | 'kelly'` (default `'fixed'`), `kellyFraction: number` (default `0.5`)
- When `sizingMode === 'fixed'`, line 644 behaves identically to current code
- All existing tests and CLI usage unchanged

### Position Valuation for MTM
- `position-tracker.ts:137` — `getPosition(marketId)` returns `MarketPosition`
- `position-tracker.ts:144` — `getAllPositions()` returns all open positions
- Each `MarketPosition` has `yesShares`, `noShares`, `yesCost`, `noCost`
- MTM value: `sum(shares × currentFairValue)` for each open position
- Total equity: `availableCapital + sum(position_i.shares × fairValue_i)`

---

## Key Interfaces to Extend

### BacktestConfig (backtest/types.ts:169)
Add:
- `sizingMode: 'fixed' | 'kelly'` — default `'fixed'`
- `kellyFraction: number` — default `0.5` (half-Kelly)

### DEFAULT_CONFIG (backtest/engine/simulator.ts:33)
Add:
- `sizingMode: 'fixed'`
- `kellyFraction: 0.5`

### CLI (backtest/index.ts)
Add:
- `--sizing fixed|kelly` — defaults to `'fixed'`
- `--kelly-fraction 0.5` — defaults to `0.5`

---

## Statistics Reuse (backtest/output/statistics.ts)

- **File:** `backtest/output/statistics.ts:11`
- `calculateStatistics(result: BacktestResult): Statistics` — pure function
- Already computes: sharpeRatio, sortinoRatio, profitFactor, maxDrawdown, maxDrawdownDuration, winRate, totalPnL, totalStaked, avgEdgeAtTrade, avgRealizedEdge
- Optimizer score formula `Profit_test - 0.5 × |MaxDrawdown_test|` can use `stats.totalPnL` and `stats.maxDrawdown` directly
- No modifications needed to statistics.ts

---

## Fees (core/fees.ts)

- **File:** `core/fees.ts` (24 lines)
- `calculatePolymarketFee(shares, price)` — pure function, NOT to be modified
- Already integrated in `order-matcher.ts:78` (`executeBuy()`)
- Taker fee formula: `shares * price * 0.25 * (price*(1-price))^2`

---

## Summary

| Item | Location | Status |
|------|----------|--------|
| Constructor | simulator.ts:118 | Ready — accepts Partial<BacktestConfig> |
| run() | simulator.ts:165 | Ready — accepts DataBundle, returns BacktestResult |
| State reset | simulator.ts:192-201 | Clean — all instance state reset per run |
| DataBundle | data-bundle.ts:50 | Ready — immutable, proven in sweep |
| Sizing insertion | simulator.ts:644 | Target — replace with Kelly branch |
| Capital return | simulator.ts:352-364 | Exists — will interact with Kelly equity |
| MTM | NOT PRESENT | Must add — positionTracker + fairValue map |
| Position data | position-tracker.ts:137,144 | Ready — getPosition, getAllPositions |
| Statistics | statistics.ts:11 | Reuse as-is |
| Fees | fees.ts | Do not modify |
