/**
 * Position Manager
 * 
 * Manages trading positions, cost basis tracking, order sizing, and P&L calculations.
 * Handles USD-based position limits and provides position state.
 */

import { Position, OrderBookState } from './types';

// =============================================================================
// TYPES
// =============================================================================

export interface PositionLimits {
  maxOrderUsd: number;      // Max USD per order
  maxPositionUsd: number;   // Max USD per market position
  maxTotalUsd: number;      // Max USD across all markets (session total)
  minOrderUsd: number;      // Min USD per order (Polymarket minimum)
}

export interface PositionState {
  position: Position;
  yesCostBasis: number;
  noCostBasis: number;
  totalUsdSpent: number;    // Global counter (never reset between markets)
  tradeCount: number;
}

// =============================================================================
// POSITION MANAGER CLASS
// =============================================================================

export class PositionManager {
  private position: Position = {
    yesShares: 0,
    noShares: 0,
    totalShares: 0,
    pairCost: 0,
  };
  
  private yesCostBasis: number = 0;
  private noCostBasis: number = 0;
  private totalUsdSpent: number = 0;
  private tradeCount: number = 0;
  
  // Logging flags to avoid spam
  private globalLimitLogged: boolean = false;
  private positionLimitLogged: boolean = false;

  constructor(private limits: PositionLimits) {}

  // ===========================================================================
  // ORDER SIZING
  // ===========================================================================

  /**
   * Calculate order size in shares based on USD limits
   * @param price - Current ask price for this side
   * @returns Number of shares to buy (0 if blocked)
   */
  calculateOrderSize(price: number): number {
    const globalRemainingUsd = this.limits.maxTotalUsd - this.totalUsdSpent;
    
    // Check global USD limit first
    if (globalRemainingUsd < this.limits.minOrderUsd) {
      if (!this.globalLimitLogged) {
        console.log(`🛑 Global limit reached: $${this.totalUsdSpent.toFixed(2)}/$${this.limits.maxTotalUsd}`);
        this.globalLimitLogged = true;
      }
      return 0;
    }
    
    // Calculate current position value in USD (approximate using current price)
    const currentPositionUsd = this.position.totalShares * price;
    const positionRemainingUsd = this.limits.maxPositionUsd - currentPositionUsd;
    
    // Check position limit and log if blocked
    if (positionRemainingUsd < this.limits.minOrderUsd) {
      if (!this.positionLimitLogged) {
        console.log(`🛑 Position limit reached: $${currentPositionUsd.toFixed(2)}/$${this.limits.maxPositionUsd} per market`);
        this.positionLimitLogged = true;
      }
      return 0;
    }
    
    // Max USD for this order
    const orderUsd = Math.min(
      this.limits.maxOrderUsd,      // Per-order limit
      globalRemainingUsd,           // Global limit
      positionRemainingUsd          // Per-market limit
    );
    
    if (orderUsd < this.limits.minOrderUsd) return 0;
    
    // Convert USD to shares
    let shares = Math.floor(orderUsd / price);
    
    // Ensure minimum order size ($1 minimum on Polymarket)
    const minShares = Math.ceil(this.limits.minOrderUsd / price);
    if (shares < minShares) {
      if (orderUsd >= this.limits.minOrderUsd) {
        shares = minShares;
      } else {
        return 0;
      }
    }
    
    return shares;
  }

  // ===========================================================================
  // POSITION UPDATES
  // ===========================================================================

  /**
   * Update position after a successful trade
   */
  updatePosition(side: 'YES' | 'NO', size: number, price: number): void {
    const cost = size * price;
    
    if (side === 'YES') {
      this.position.yesShares += size;
      this.yesCostBasis += cost;
    } else {
      this.position.noShares += size;
      this.noCostBasis += cost;
    }
    
    this.position.totalShares = this.position.yesShares + this.position.noShares;
    this.totalUsdSpent += cost;
    this.tradeCount++;
  }

  /**
   * Reset position for a new market (cost basis reset, but totalUsdSpent persists)
   */
  resetForNewMarket(): void {
    this.position = {
      yesShares: 0,
      noShares: 0,
      totalShares: 0,
      pairCost: 0,
    };
    this.yesCostBasis = 0;
    this.noCostBasis = 0;
    this.tradeCount = 0;
    this.positionLimitLogged = false; // Reset for new market
    // Note: totalUsdSpent is NOT reset - it's a session total
  }

  /**
   * Full reset including totalUsdSpent (for new session)
   */
  resetAll(): void {
    this.resetForNewMarket();
    this.totalUsdSpent = 0;
    this.globalLimitLogged = false;
  }

  // ===========================================================================
  // P&L CALCULATION
  // ===========================================================================

  /**
   * Calculate current P&L based on positions and current prices
   * @param orderBook - Current orderbook for bid prices
   */
  calculatePnL(orderBook: OrderBookState | null): number {
    if (!orderBook) return 0;
    
    // Current market value (what we could sell for)
    const yesBid = orderBook.yesBid;
    const noBid = orderBook.noBid;
    
    const yesValue = this.position.yesShares * yesBid;
    const noValue = this.position.noShares * noBid;
    const currentValue = yesValue + noValue;
    
    // Total cost basis (what we paid)
    const totalCost = this.yesCostBasis + this.noCostBasis;
    
    // Unrealized P&L (mark-to-market)
    let pnl = currentValue - totalCost;
    
    // If we have pairs (both YES and NO), calculate locked profit
    // Each pair is worth $1 at settlement
    const pairs = Math.min(this.position.yesShares, this.position.noShares);
    if (pairs > 0) {
      // Average cost per pair
      const avgYesCost = this.position.yesShares > 0 ? this.yesCostBasis / this.position.yesShares : 0;
      const avgNoCost = this.position.noShares > 0 ? this.noCostBasis / this.position.noShares : 0;
      const pairCost = (avgYesCost + avgNoCost) * pairs;
      const pairValue = pairs * 1.0; // Each pair worth $1 at settlement
      const lockedProfit = pairValue - pairCost;
      
      // Use locked profit for paired shares
      pnl = lockedProfit + (this.position.yesShares - pairs) * (yesBid - avgYesCost) 
                        + (this.position.noShares - pairs) * (noBid - avgNoCost);
    }
    
    return pnl;
  }

  // ===========================================================================
  // STATE ACCESSORS
  // ===========================================================================

  /**
   * Get current position state (immutable copy)
   */
  getState(): PositionState {
    return {
      position: { ...this.position },
      yesCostBasis: this.yesCostBasis,
      noCostBasis: this.noCostBasis,
      totalUsdSpent: this.totalUsdSpent,
      tradeCount: this.tradeCount,
    };
  }

  /**
   * Get position only
   */
  getPosition(): Position {
    return { ...this.position };
  }

  /**
   * Get total USD spent (session total)
   */
  getTotalUsdSpent(): number {
    return this.totalUsdSpent;
  }

  /**
   * Get trade count for current market
   */
  getTradeCount(): number {
    return this.tradeCount;
  }

  /**
   * Get cost basis
   */
  getCostBasis(): { yes: number; no: number } {
    return {
      yes: this.yesCostBasis,
      no: this.noCostBasis,
    };
  }

  /**
   * Check if global limit is reached
   */
  isGlobalLimitReached(): boolean {
    return this.totalUsdSpent >= this.limits.maxTotalUsd;
  }

  /**
   * Get remaining USD budget
   */
  getRemainingBudget(): number {
    return Math.max(0, this.limits.maxTotalUsd - this.totalUsdSpent);
  }

  // ===========================================================================
  // LOGGING
  // ===========================================================================

  /**
   * Log current position to console
   */
  logPosition(): void {
    console.log(
      `   💼 Position: YES=${this.position.yesShares} | NO=${this.position.noShares} | ` +
      `Spent: $${this.totalUsdSpent.toFixed(2)}/$${this.limits.maxTotalUsd}`
    );
  }

  /**
   * Log total spent
   */
  logTotalSpent(): void {
    console.log(`   📊 Total spent: $${this.totalUsdSpent.toFixed(2)}/$${this.limits.maxTotalUsd}`);
  }
}

