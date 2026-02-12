# Polymarket BTC Up/Down Trading Bot

## Project Overview

Automated trading bot for Polymarket 15-minute BTC Up/Down markets using Black-Scholes fair value pricing.

**Tech Stack:** TypeScript, Node.js, ethers.js, WebSocket (Binance), REST APIs (Polymarket, Deribit, Chainlink)

## Critical Rules

### 1. Financial Code Standards (MANDATORY)
- **NO approximations without documentation** — every assumption affects P&L
- **Immutability always** — never mutate price data, positions, or state objects
- **Decimal precision** — use proper rounding for financial calculations
- **Timestamp consistency** — all timestamps in Unix ms

### 2. Error Handling (CRITICAL)
- **Never swallow errors** — failed trades must be logged and alerted
- **Retry with exponential backoff** — all network calls
- **Fallback chains** — Chainlink → Binance, WebSocket → REST

### 3. Oracle Consistency
- **Settlement uses Chainlink** — backtest must use Chainlink prices
- **Log divergences** — when Binance vs Chainlink differ >$50

### 4. Code Organization
- 200-400 lines per file typical, 800 max
- Separate: fetchers, services, engine, types
- Cache data locally to reduce API calls

### 5. Testing
- Backtest before ANY live trading changes
- Unit tests for fair-value calculations
- Integration tests for all fetchers

## File Structure

crypto-pricer/
├── index.ts              # Main entry (dependency injection)
├── core/                 # Shared core (mode-agnostic)
│   ├── config.ts         # Configuration
│   ├── logger.ts         # Logging infrastructure
│   ├── types.ts          # Core types
│   ├── trading-interface.ts # ITradingService for DI
│   ├── fair-value.ts     # Black-Scholes pricing
│   ├── fees.ts           # Fee calculation
│   ├── vol-calculator.ts # Volatility math
│   └── strategies/       # Trading strategies
├── live/                 # Live trading infrastructure
│   ├── arb-trader.ts     # Trading logic (mode-agnostic)
│   ├── trading-service.ts # Real CLOB execution
│   ├── binance-ws.ts     # Price feed (WebSocket)
│   ├── volatility-service.ts # Vol calculation
│   ├── strike-service.ts # Strike price fetching
│   └── [10 other live modules]
├── paper/                # Paper trading mode
│   └── mock-trading-service.ts # Simulated execution
├── backtest/             # Backtest engine (separate mode)
│   ├── engine/           # Simulation
│   │   └── simulator.ts  # Main backtest engine
│   └── fetchers/         # Historical data
│       ├── binance-historical.ts
│       ├── chainlink-historical.ts
│       ├── polymarket-prices.ts
│       └── deribit-vol.ts
└── data/                 # Cached historical data
    ├── binance/
    ├── chainlink/
    ├── polymarket/
    └── deribit/

## Key Formulas

### Black-Scholes d₂
d₂ = [ln(S/K) + (r - σ²/2) × T] / (σ × √T)
P(above) = N(d₂)

### Volatility Blend
70% Realized 1h + 20% Realized 4h + 10% Deribit DVOL

### Edge Calculation
Edge = Fair Value − Market Price
Only trade when Edge > 20%

## Environment Variables

# Required for backtest
ARCHIVE_RPC_URL=         # Polygon archive node (Alchemy/Ankr)

# Required for live trading
RPC_URL=                 # Polygon RPC
TELEGRAM_BOT_TOKEN=      # Alerts
TELEGRAM_CHAT_ID=

## Commands

- Run backtest: `npx ts-node backtest/index.ts`
- Type check: `npx tsc --noEmit`