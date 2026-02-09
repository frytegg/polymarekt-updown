# Polymarket BTC Up/Down Arbitrage Bot

Automated arbitrage strategy for Polymarket's 15-minute BTC Up/Down binary options markets. Exploits the pricing lag between Binance (price discovery) and Polymarket (retail sentiment) by computing Black-Scholes fair value in real time and buying mispriced YES/NO tokens.

## How It Works

Every 15 minutes, Polymarket opens a new market: *"Will BTC go up or down in the next 15 minutes?"* The market resolves based on the **Chainlink oracle** price at expiry vs. the strike price set at market open.

This bot:

1. **Streams BTC price** from Binance WebSocket (~100ms latency)
2. **Computes fair value** using Black-Scholes with live Deribit implied volatility
3. **Reads the Polymarket orderbook** via REST + WebSocket
4. **Detects mispricing** when `fair_value - market_price > edge_threshold`
5. **Executes Fill-and-Kill orders** on the underpriced side (YES or NO)
6. **Auto-rotates** to the next market as each 15-min window expires

### Fair Value Model

The probability that BTC finishes above the strike is modeled as:

```
P(UP) = N(d2)

where d2 = [ln(S/K) + (r - sigma^2/2) * T] / (sigma * sqrt(T))

S     = Current BTC price (Binance, adjusted for Chainlink divergence)
K     = Strike price (set at market open)
sigma = Annualized implied volatility (70% realized 1h + 20% realized 4h + 10% Deribit DVOL)
T     = Time remaining in years
N()   = Standard normal CDF
```

### Oracle Divergence Correction

Polymarket settles on Chainlink, but Binance leads price discovery. The bot maintains a rolling EMA of the Binance-Chainlink spread (~$50-150) and dynamically adjusts the BTC price fed into the model, eliminating systematic mispricing of fair value.

## Architecture

```
                    Binance WS (BTC price)
                           |
                           v
index.ts ---- arb-trader.ts ---- fair-value.ts (Black-Scholes)
   |               |                    |
   |               |            volatility-service.ts (Deribit DVOL + realized vol)
   |               |
   |          position-manager.ts (USD limits, sizing)
   |               |
   |          trading-service.ts (CLOB API, FAK orders)
   |               |
   |          paper-trading-tracker.ts (simulated fills + resolution)
   |
   +--- divergence-tracker.ts (Binance-Chainlink EMA)
   +--- market-finder.ts (auto-discover next market)
   +--- orderbook-service.ts (REST polling + WS deltas)
   +--- strike-service.ts (Chainlink strike fetch)
   +--- telegram.ts (trade alerts, summaries, bot commands)
   +--- resolution-tracker.ts (post-expiry P&L)
```

### Backtest Engine

```
backtest/
  index.ts                         CLI entry point with 25+ flags
  types.ts                         Config and result types
  engine/
    simulator.ts                   Main simulation loop
    order-matcher.ts               Fill simulation (spread, latency, kline worst-case)
    position-tracker.ts            Per-market position and P&L tracking
    divergence-calculator.ts       Pre-computed Binance-Chainlink EMA for backtest
  fetchers/
    binance-historical.ts          Kline data with local caching
    chainlink-historical.ts        On-chain round-by-round price data
    polymarket-markets.ts          Historical market metadata
    polymarket-prices.ts           Historical orderbook prices
    deribit-vol.ts                 DVOL index history
  output/
    statistics.ts                  Sharpe, Sortino, win rate, drawdown, profit factor
    pnl-curve.ts                   Equity curve and drawdown analysis
    trade-log.ts                   CSV/JSON export
```

### Key Files

| File | Purpose |
|------|---------|
| `index.ts` | Entry point, WebSocket orchestration, market rotation |
| `arb-trader.ts` | Edge detection, order execution, signal generation |
| `strategies/black-scholes.ts` | Core pricing model |
| `volatility-service.ts` | Blended vol: 70% realized 1h + 20% realized 4h + 10% DVOL |
| `divergence-tracker.ts` | Live Binance-Chainlink EMA with disk persistence |
| `config.ts` | All tunable parameters with env var overrides |
| `position-manager.ts` | USD-based position limits and order sizing |
| `trading-service.ts` | Polymarket CLOB API wrapper (FAK orders) |

## Quick Start

### Prerequisites

- Node.js 18+
- A Polygon RPC endpoint (Alchemy, Infura, or QuickNode recommended)
- A funded Polymarket wallet (for live trading)

### Installation

```bash
git clone <repo-url>
cd crypto-pricer
npm install
```

### Configuration

```bash
cp .env.example .env
```

Edit `.env` with your settings. Key variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `PAPER_TRADING` | Simulate trades without real money | `true` |
| `ARB_EDGE_MIN` | Minimum edge to trade (0.2 = 20%) | `0.2` |
| `ARB_MAX_ORDER_USD` | Max USD per order | `2` |
| `ARB_MAX_POSITION_USD` | Max USD per market | `5` |
| `ARB_MAX_TOTAL_USD` | Max total exposure | `100` |
| `ARB_STOP_BEFORE_END` | Stop trading N seconds before resolution | `30` |
| `PRIVATE_KEY` | Wallet private key (not needed for paper) | - |
| `ARCHIVE_RPC_URL` | Polygon archive RPC (required for backtest) | - |
| `TELEGRAM_BOT_TOKEN` | Telegram alerts (optional) | - |

See [.env.example](.env.example) for the complete list with documentation.

### Paper Trading

```bash
# Start paper trading (default mode)
npx ts-node index.ts
```

The bot will:
- Connect to Binance and Polymarket WebSockets
- Auto-discover active BTC Up/Down markets
- Log simulated trades with edge, fees, and P&L
- Resolve positions against Polymarket outcomes
- Save results to `data/paper-trades/`
- Send Telegram alerts (if configured)

### Live Trading

```bash
# Set PAPER_TRADING=false in .env and configure wallet credentials
npx ts-node index.ts
```

## Backtesting

Run historical backtests against cached Binance + Chainlink + Polymarket data:

```bash
# Standard 7-day backtest with fees
npx ts-node backtest/index.ts --edge 5 --fees --adjustment-method ema

# 34-day conservative mode (worst-case kline pricing + 200ms latency)
npx ts-node backtest/index.ts --days 34 --edge 5 --fees --conservative --adjustment-method ema

# Edge threshold sweep optimization
npx ts-node backtest/index.ts --sweep --sweep-min 0 --sweep-max 30 --sweep-step 2 --fees

# Export results to CSV/JSON
npx ts-node backtest/index.ts --days 14 --fees --export --verbose
```

### Backtest CLI Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--days <n>` | Number of days to backtest | `7` |
| `--edge <pct>` | Minimum edge percentage | `2` |
| `--spread <cents>` | Bid-ask spread in cents | `6` |
| `--fees` | Include Polymarket taker fees | off |
| `--normal` | Close-price execution | default |
| `--conservative` | Worst-case kline pricing + 200ms latency | off |
| `--adjustment-method` | Oracle adjustment: `static`, `ema`, `rolling-mean`, `median` | `static` |
| `--cooldown-ms <ms>` | Min ms between trades per market+side | `60000` |
| `--max-trades <n>` | Max trades per market | `3` |
| `--max-order-usd <$>` | Max USD per order | unlimited |
| `--max-position-usd <$>` | Max USD per market | unlimited |
| `--sweep` | Run edge sweep optimization | off |
| `--export` | Export results to `data/output/` | off |
| `--verbose` | Detailed trade-by-trade logging | off |

### Output Metrics

The backtest reports: total P&L, trade count, win rate, Sharpe ratio, Sortino ratio, profit factor, max drawdown, ROI, and edge capture rate.

## Telegram Notifications

Optional real-time alerts via Telegram bot:

1. Message `@BotFather` on Telegram, create a new bot
2. Copy the bot token to `TELEGRAM_BOT_TOKEN` in `.env`
3. Get your chat ID from `@userinfobot`, set `TELEGRAM_CHAT_ID`

The bot sends alerts for: trades, market resolutions, periodic summaries, and errors.

## Project Structure

```
crypto-pricer/
├── index.ts                  # Entry point and WebSocket orchestration
├── arb-trader.ts             # Trading logic and edge detection
├── config.ts                 # Configuration with env var overrides
├── types.ts                  # Core type definitions
├── fair-value.ts             # Black-Scholes pricing (shim)
├── strategies/
│   ├── black-scholes.ts      # Core BS model
│   ├── types.ts              # Strategy types
│   └── index.ts              # Strategy exports
├── binance-ws.ts             # Binance WebSocket price feed
├── volatility-service.ts     # Blended volatility calculator
├── strike-service.ts         # Chainlink strike price fetcher
├── divergence-tracker.ts     # Live oracle divergence EMA
├── market-finder.ts          # Auto-discover Polymarket markets
├── orderbook-service.ts      # CLOB orderbook fetcher
├── position-manager.ts       # USD-based position limits
├── trading-service.ts        # Polymarket CLOB API (FAK orders)
├── paper-trading-tracker.ts  # Paper trading simulator
├── resolution-tracker.ts     # Post-expiry resolution tracking
├── execution-metrics.ts      # Latency and slippage metrics
├── telegram.ts               # Telegram alerts and bot commands
├── backtest/
│   ├── index.ts              # Backtest CLI entry point
│   ├── types.ts              # Backtest config and result types
│   ├── engine/               # Simulation engine
│   ├── fetchers/             # Historical data fetchers (Binance, Chainlink, Polymarket, Deribit)
│   └── output/               # Statistics, P&L curve, trade log export
├── data/                     # Cached historical data (gitignored)
├── .env.example              # Environment variable template
├── tsconfig.json             # TypeScript configuration
└── package.json              # Dependencies and scripts
```

## Tech Stack

- **TypeScript** / Node.js
- **Binance WebSocket** - Real-time BTC price feed
- **Polymarket CLOB API** - Orderbook data and order execution
- **Chainlink Oracle** - Strike price and settlement (on-chain via ethers.js)
- **Deribit API** - Implied volatility (DVOL index)
- **Telegram Bot API** - Trade notifications

## License

Private. All rights reserved.
