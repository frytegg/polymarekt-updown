/**
 * Order Matcher for Backtest
 * Simulates order fills with configurable spread
 */

import { Trade, TradeSignal } from '../types';
import { calculatePolymarketFee } from '../../core/fees';

/**
 * Order matcher configuration
 */
export interface OrderMatcherConfig {
  spreadCents: number;     // Spread in cents (default 1¢ = 0.01)
  slippageBps: number;     // Additional slippage in basis points (default 0)
  minPrice: number;        // Minimum tradeable price (default 0.01)
  maxPrice: number;        // Maximum tradeable price (default 0.99)
  includeFees: boolean;    // Include Polymarket taker fees (default false)
}

const DEFAULT_CONFIG: OrderMatcherConfig = {
  spreadCents: 1,
  slippageBps: 0,
  minPrice: 0.01,
  maxPrice: 0.99,
  includeFees: false,
};

// Fee calculation is now imported from core/fees.ts
// See core/fees.ts for implementation and documentation
export { calculatePolymarketFee } from '../../core/fees';

/**
 * Order Matcher - simulates trade execution with spread
 */
export class OrderMatcher {
  private config: OrderMatcherConfig;
  private tradeCounter = 0;

  constructor(config: Partial<OrderMatcherConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Calculate buy price (mid + spread/2)
   */
  getBuyPrice(midPrice: number): number {
    const spreadDecimal = this.config.spreadCents / 100;
    const slippageMultiplier = 1 + (this.config.slippageBps / 10000);
    
    let buyPrice = (midPrice + spreadDecimal / 2) * slippageMultiplier;
    
    // Clamp to valid range
    buyPrice = Math.max(this.config.minPrice, Math.min(this.config.maxPrice, buyPrice));
    
    // Round to tick size (1¢)
    return Math.round(buyPrice * 100) / 100;
  }

  /**
   * Calculate sell price (mid - spread/2)
   */
  getSellPrice(midPrice: number): number {
    const spreadDecimal = this.config.spreadCents / 100;
    const slippageMultiplier = 1 - (this.config.slippageBps / 10000);
    
    let sellPrice = (midPrice - spreadDecimal / 2) * slippageMultiplier;
    
    // Clamp to valid range
    sellPrice = Math.max(this.config.minPrice, Math.min(this.config.maxPrice, sellPrice));
    
    // Round to tick size (1¢)
    return Math.round(sellPrice * 100) / 100;
  }

  /**
   * Execute a buy order
   */
  executeBuy(
    signal: TradeSignal,
    btcPrice: number,
    strike: number,
    timeRemainingMs: number
  ): Trade {
    const price = this.getBuyPrice(signal.marketPrice);
    const cost = price * signal.size;
    const fee = this.config.includeFees ? calculatePolymarketFee(signal.size, price) : 0;
    const totalCost = cost + fee;

    this.tradeCounter++;

    return {
      id: `trade_${this.tradeCounter}`,
      timestamp: signal.timestamp,
      marketId: signal.marketId,
      side: signal.side,
      action: 'BUY',
      price,
      size: signal.size,
      fairValue: signal.fairValue,
      edge: signal.edge,
      btcPrice,
      strike,
      timeRemainingMs,
      cost,
      fee,
      totalCost,
    };
  }

  /**
   * Execute a sell order
   */
  executeSell(
    signal: TradeSignal,
    btcPrice: number,
    strike: number,
    timeRemainingMs: number
  ): Trade {
    const price = this.getSellPrice(signal.marketPrice);
    const cost = price * signal.size; // Negative cost = revenue
    const fee = this.config.includeFees ? calculatePolymarketFee(signal.size, price) : 0;
    // For sells: revenue = cost - fee (fee reduces what you get)
    const totalCost = -cost + fee;

    this.tradeCounter++;

    return {
      id: `trade_${this.tradeCounter}`,
      timestamp: signal.timestamp,
      marketId: signal.marketId,
      side: signal.side,
      action: 'SELL',
      price,
      size: signal.size,
      fairValue: signal.fairValue,
      edge: signal.edge,
      btcPrice,
      strike,
      timeRemainingMs,
      cost: -cost, // Selling generates revenue (before fee)
      fee,
      totalCost,   // Net revenue after fee
    };
  }

  /**
   * Check if a buy at this price would be valid
   */
  canBuy(midPrice: number, fairValue: number, minEdge: number): boolean {
    const buyPrice = this.getBuyPrice(midPrice);
    const edge = fairValue - buyPrice;
    return edge >= minEdge && buyPrice >= this.config.minPrice && buyPrice <= this.config.maxPrice;
  }

  /**
   * Check if a sell at this price would be valid
   */
  canSell(midPrice: number, fairValue: number, minEdge: number): boolean {
    const sellPrice = this.getSellPrice(midPrice);
    const edge = sellPrice - fairValue;
    return edge >= minEdge && sellPrice >= this.config.minPrice && sellPrice <= this.config.maxPrice;
  }

  /**
   * Calculate the edge for a potential buy
   */
  calculateBuyEdge(midPrice: number, fairValue: number): number {
    const buyPrice = this.getBuyPrice(midPrice);
    return fairValue - buyPrice;
  }

  /**
   * Calculate the edge for a potential sell
   */
  calculateSellEdge(midPrice: number, fairValue: number): number {
    const sellPrice = this.getSellPrice(midPrice);
    return sellPrice - fairValue;
  }

  /**
   * Get current configuration
   */
  getConfig(): OrderMatcherConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<OrderMatcherConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Reset trade counter
   */
  reset(): void {
    this.tradeCounter = 0;
  }
}




