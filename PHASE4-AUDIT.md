# Phase 4 Paper Trading Mode Audit

## Paper Trading Surface Map

All references to `paperTrading`, `PAPER_TRADING`, or related flags:

| File | Line | Type | Code Snippet | Action |
|------|------|------|--------------|--------|
| **live/trading-service.ts** | 57 | DISPATCH | `if (config.paperTrading) { this.initialized = true; console.log('[TradingService] Paper trading mode - CLOB client not initialized'); return; }` | → Move to MockTradingService.initialize() |
| **live/arb-trader.ts** | 321-369 | DISPATCH | `if (this.config.paperTrading) { ... paperTracker.recordTrade(...); positionManager.updatePosition(...); return; }` | → Remove entire block, let MockTradingService handle paper fills |
| **index.ts** | 83 | DISPATCH | `if (!this.config.paperTrading && this.config.privateKey && this.config.funderAddress) { new RedemptionService(...) }` | → Keep (redemption is separate service, only needed in live mode) |
| **index.ts** | 122 | LOGGING | `if (this.config.paperTrading) { console.log('[System] Paper trading mode enabled...') }` | → Keep (startup info message) |
| **live/telegram.ts** | 259 | LOGGING | `const mode = config.paperTrading ? '📝 PAPER' : '💰 LIVE';` | → Keep (user-facing notification) |
| **core/config.ts** | 8 | CONFIG | `paperTrading: boolean;` field definition | → Keep (config interface) |
| **core/config.ts** | 60 | CONFIG | `paperTrading: process.env.PAPER_TRADING === 'true',` | → Keep (config loading) |
| **core/config.ts** | 101 | CONFIG | `if (!config.paperTrading) { ... }` validation | → Keep (config validation) |
| **core/config.ts** | 114 | CONFIG | `console.log(\`Mode: \${config.paperTrading ? '📝 PAPER...' : '💰 LIVE...'}\`);` | → Keep (config display) |
| **index.ts** | 41, 125, 434 | LOGGING | `paperTradingSummaryInterval` variable and interval setup/cleanup | → Keep (summary interval runs in both modes) |

## Key Findings

### DISPATCH Locations (to be eliminated)
1. **live/trading-service.ts:57** — Skips CLOB client initialization in paper mode
   → MockTradingService will never initialize CLOB

2. **live/arb-trader.ts:321-369** — Complete paper trading execution path
   - Records trade via paperTracker
   - Updates position manager
   - Logs trade
   - Returns without calling trading service
   → This entire block disappears; MockTradingService.placeOrder() will handle it

### CONFIG/LOGGING Locations (to be preserved)
- **core/config.ts** — Definition and loading of paperTrading flag (keep)
- **index.ts** — Startup messages and redemption service guard (keep, redemption is separate concern)
- **live/telegram.ts** — User-facing mode display (keep)

### Current Paper Trading Flow (To Be Refactored)
```
arb-trader.executeTrade()
  └─> if (config.paperTrading) {
        paperTracker.recordTrade(...)    ← Simulated fill
        positionManager.updatePosition(...) ← Local state update
        return;  ← EARLY EXIT, never calls trading service
      }
  └─> tradingService.placeOrder(...)     ← Only reached in live mode
```

### Target Paper Trading Flow (After Refactor)
```
arb-trader.executeTrade()
  └─> tradingService.placeOrder(...)  ← Interface, no mode knowledge
        ├─> ClobTradingService.placeOrder() → Real CLOB API call (live)
        └─> MockTradingService.placeOrder() → Simulated fill + paperTracker.recordTrade() (paper)
```

## Summary
- **2 DISPATCH sites** to eliminate (trading-service initialization, arb-trader execution)
- **8 CONFIG/LOGGING sites** to preserve (config definition, user messages)
- **0 hidden paper mode logic** in other files (clean!)

After refactor, only `index.ts` (injection point) and `core/config.ts` (definition) will reference the paper trading flag for order execution purposes.
