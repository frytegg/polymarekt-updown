# Logging Contract

## Overview

All runtime logging in `crypto-pricer` goes through a central `logger.ts` module.
Raw `console.*` calls are prohibited in new code and are being migrated file-by-file.

## Environment Variables

| Variable     | Values                           | Default      |
|-------------|----------------------------------|--------------|
| `LOG_LEVEL` | `error`, `warn`, `info`, `debug`, `trace` | `info` |
| `LOG_FORMAT` | `pretty`, `json`                | `pretty`     |
| `LOG_MODE`  | `dev`, `live-test`, `prod`       | `dev`        |

### LOG_MODE Presets

| Mode        | LOG_LEVEL | LOG_FORMAT | Behavior                                        |
|-------------|-----------|------------|--------------------------------------------------|
| `dev`       | `debug`   | `pretty`   | Verbose, colored, per-tick status allowed.       |
| `live-test` | `info`    | `pretty`   | Clean output. See Live-Test Contract below.      |
| `prod`      | `info`    | `json`     | Structured JSON lines, one per event.            |

Explicit `LOG_LEVEL` / `LOG_FORMAT` overrides the mode preset.

## Live-Test Contract (`LOG_MODE=live-test`)

Target: **< 200 lines/hour** of steady-state output (excludes real trade fills and errors).

### Rules

1. **No per-tick or per-poll logs at INFO.**
   Status-line ticks, orderbook refreshes, and WS message handling produce zero output at INFO.

2. **Only state transitions and business events at INFO:**
   - `startup.*` — process and service init events
   - `shutdown.*` — graceful stop events
   - `trade.signal` — signal detected
   - `trade.filled` — order filled
   - `trade.rejected` — order rejected or errored
   - `trade.lock_acquired` / `trade.lock_released` — trade mutex lifecycle
   - `market.switched` — active market changed
   - `market.search_changed` — search results differ from previous
   - `resolution.*` — position resolved, outcome determined
   - `redemption.*` — on-chain redemption lifecycle

3. **Periodic summaries max once per 60 seconds per subsystem:**
   - Volatility refresh → max 1 INFO line/60s
   - Divergence tracker status → max 1 INFO line/60s (was 5 min, acceptable)
   - Market search → only on result change, rate-limited 60s
   - Paper-trading resolution check → only state transitions, never "still waiting"

4. **Every log line must include:**
   - `ts` — ISO 8601 timestamp with milliseconds
   - `level` — ERROR, WARN, INFO, DEBUG, TRACE
   - `module` — source module name
   - `event` — stable event name (dot-separated, e.g., `trade.filled`)
   - `marketId` — condition ID (first 12 chars) when in trade/market context
   - `tradeId` — numeric trade ID when in trade context
   - `runId` — process-scoped UUID set at startup

5. **DEBUG level (visible with `LOG_LEVEL=debug`):**
   - Per-tick status line (sampled, configurable interval, default 5s)
   - Vol refresh details
   - Divergence tracker point-by-point
   - Orderbook REST refresh results
   - Position manager sizing decisions

6. **TRACE level (visible with `LOG_LEVEL=trace`):**
   - Every WS message received
   - Every orderbook delta applied
   - Every price callback dispatched

## Log Line Format

### Pretty (`LOG_FORMAT=pretty`)

```
2025-01-30T14:00:00.123Z [INFO] [ArbTrader] trade.filled | side=YES price=0.42 size=5 latencyMs=120 marketId=0x1a2b3c...
```

### JSON (`LOG_FORMAT=json`)

```json
{"ts":"2025-01-30T14:00:00.123Z","level":"info","module":"ArbTrader","event":"trade.filled","side":"YES","price":0.42,"size":5,"latencyMs":120,"marketId":"0x1a2b3c...","runId":"a1b2c3d4"}
```

## Correlation IDs

| ID          | Scope            | Generation                        |
|-------------|------------------|-----------------------------------|
| `runId`     | Process lifetime | `crypto.randomUUID()` at startup  |
| `tradeId`   | Per trade attempt| Incrementing counter from PaperTradingTracker |
| `marketId`  | Per market       | `conditionId.slice(0, 12)`        |
| `wsConnId`  | Per WS connection| Incrementing counter per connect  |

All IDs propagated through context objects, not global state.

## Redaction

The logger automatically redacts values for keys matching:
`authorization`, `cookie`, `apiKey`, `secret`, `token`, `signature`, `passphrase`, `privateKey`, `key`

Redacted values appear as `[REDACTED]`.

### Payload Safety

- Max string length per field: 200 characters. Truncated values include `[truncated]` suffix.
- Max object serialization depth: 3 levels.
- `error.response.data` is never logged raw. Use `{ status, message, code }` extraction.

## Anti-Spam Strategies (by module)

| Module | Before | After |
|--------|--------|-------|
| ArbTrader status line | 3600 lines/hr (1/sec) | 0 at INFO; 1/5s at DEBUG |
| "Trade in progress" | 10-50 per trade | Replaced by lock_acquired + lock_released (2 per trade) |
| MarketFinder search | 16-28 lines/min | Only on result change, rate-limited 60s |
| PaperTracker resolution check | 4-10 lines/min | Only state transitions (resolved/failed) |
| Binance WS/REST errors | Unbounded repeats | Rate-limited 60s with suppression counter |
| VolatilityService refresh | 30/hr | Max 1/60s (unchanged in practice) |

## Estimated Steady-State Output (live-test mode)

| Category | Lines/hour |
|----------|-----------|
| Startup (one-time) | ~25 |
| Trade fills + signals | ~10-30 (depends on activity) |
| Market switches | ~8 (every ~7.5 min) |
| Vol refresh | ~30 |
| Divergence status | ~12 |
| Resolution events | ~4-8 |
| Errors/warnings | ~5-10 |
| **Total** | **~95-125** |

## Migration Status

Files converted to `logger.ts`:
- [ ] arb-trader.ts (PR 1)
- [ ] market-finder.ts (PR 1)
- [ ] paper-trading-tracker.ts (PR 1)
- [ ] strike-service.ts (PR 1 — payload dump fix)
- [ ] binance-ws.ts (PR 1)
- [ ] index.ts (PR 2)
- [ ] config.ts (PR 2)
- [ ] volatility-service.ts (PR 2)
- [ ] trading-service.ts (PR 2)
- [ ] resolution-tracker.ts (PR 2)
- [ ] divergence-tracker.ts (PR 2)
- [ ] redemption-service.ts (PR 2)
- [ ] position-manager.ts (PR 2)
- [ ] execution-metrics.ts (PR 2)
- [ ] orderbook-service.ts (PR 2)
- [ ] telegram.ts (PR 2)
