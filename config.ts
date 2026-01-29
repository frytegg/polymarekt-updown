/**
 * Crypto Pricer Arb - Configuration
 * Parameters for the BTC UP/DOWN arbitrage strategy
 */

export interface ArbConfig {
  // Trading thresholds
  edgeMinimum: number;          // Minimum edge to trade (e.g., 0.05 = 5¢)
  stopBeforeEndSec: number;     // Stop trading X seconds before resolution

  // Position limits (in USD)
  minOrderUsd: number;          // Minimum order size in USD (Polymarket requires $1 min)
  maxOrderUsd: number;          // Max order size in USD per trade
  maxPositionUsd: number;       // Max position per market in USD
  maxTotalUsd: number;          // Max total exposure across ALL markets in USD

  // Price limits (avoid buying expensive tokens with low upside)
  maxBuyPrice: number;          // Don't buy if price > this (e.g., 0.40 = 40¢)
  slippageBps: number;          // Slippage in basis points (e.g., 100 = 1%)

  // Strike price override (set manually from Polymarket "Price to Beat")
  manualStrike?: number;        // If set, use this instead of Binance price

  // Polymarket API
  clobHost: string;
  chainId: number;
  privateKey: string;
  funderAddress: string;
  signatureType: number;
}

export function loadArbConfig(): ArbConfig {
  // Check for manual strike override
  const manualStrikeEnv = process.env.ARB_STRIKE;
  const manualStrike = manualStrikeEnv ? parseFloat(manualStrikeEnv) : undefined;

  return {

    // Trading thresholds
    edgeMinimum: parseFloat(process.env.ARB_EDGE_MIN || "0.2"),
    stopBeforeEndSec: parseInt(process.env.ARB_STOP_BEFORE_END || "30"),

    // Position limits in USD
    minOrderUsd: parseFloat(process.env.ARB_MIN_ORDER_USD || "1"),      // Polymarket minimum
    maxOrderUsd: parseFloat(process.env.ARB_MAX_ORDER_USD || "2"),      // $5 per trade
    maxPositionUsd: parseFloat(process.env.ARB_MAX_POSITION_USD || "5"), // $25 per market
    maxTotalUsd: parseFloat(process.env.ARB_MAX_TOTAL_USD || "10000000"),   // $100 total exposure per session (need a restart to reset)

    // Price limits (0.99 = no limit)
    maxBuyPrice: parseFloat(process.env.ARB_MAX_BUY_PRICE || "0.99"), // No limit by default
    slippageBps: parseInt(process.env.ARB_SLIPPAGE_BPS || "200"), // 2% slippage

    // Manual strike override (from Polymarket "Price to Beat")
    manualStrike,

    // Polymarket API (reuse from main .env)
    clobHost: process.env.CLOB_HOST || "https://clob.polymarket.com",
    chainId: parseInt(process.env.CHAIN_ID || "137"),
    privateKey: process.env.PRIVATE_KEY || "",
    funderAddress: process.env.FUNDER_ADDRESS || "",
    signatureType: parseInt(process.env.SIGNATURE_TYPE || "2"),
  };
}

export function validateArbConfig(config: ArbConfig): void {
  if (!config.privateKey || !config.funderAddress) {
    throw new Error("PRIVATE_KEY and FUNDER_ADDRESS must be set in .env");
  }

  if (config.edgeMinimum < 0.01 || config.edgeMinimum > 0.99) {
    throw new Error("ARB_EDGE_MIN should be between 0.01 and 0.99");
  }
}

export function logArbConfig(config: ArbConfig): void {
  console.log(`\n📊 Arb Strategy Configuration:`);
  console.log(`   σ (vol): Deribit DVOL (live)`);
  console.log(`   Edge minimum: ${(config.edgeMinimum * 100).toFixed(0)}%`);
  console.log(`   Stop avant fin: ${config.stopBeforeEndSec}s`);
  console.log(`   Min order: $${config.minOrderUsd} (Polymarket min)`);
  console.log(`   Max order: $${config.maxOrderUsd}`);
  console.log(`   Max position/market: $${config.maxPositionUsd}`);
  console.log(`   Max total exposure: $${config.maxTotalUsd}`);
  console.log(`   Max buy price: ${(config.maxBuyPrice * 100).toFixed(0)}¢`);
  console.log(`   Slippage: ${(config.slippageBps / 100).toFixed(1)}%`);
  console.log();
}

