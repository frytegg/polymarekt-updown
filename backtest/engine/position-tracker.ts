/**
 * Position Tracker for Backtest
 * Tracks positions per market and handles resolution (settle to $1 or $0)
 */

import { Trade, MarketPosition, MarketResolution, PnLPoint } from '../types';

/**
 * Position Tracker - manages positions across all markets
 */
export class PositionTracker {
  private positions: Map<string, MarketPosition> = new Map();
  private resolutions: MarketResolution[] = [];
  private allTrades: Trade[] = [];
  private pnlCurve: PnLPoint[] = [];

  // Running totals
  private realizedPnL = 0;
  private totalCost = 0;
  private totalFeesPaid = 0;

  /**
   * Record a trade and update position
   * Uses totalCost (including fees) for P&L calculations
   */
  recordTrade(trade: Trade): void {
    this.allTrades.push(trade);

    // Get or create position for this market
    let position = this.positions.get(trade.marketId);
    if (!position) {
      position = {
        marketId: trade.marketId,
        yesShares: 0,
        noShares: 0,
        yesCost: 0,
        noCost: 0,
        trades: [],
      };
      this.positions.set(trade.marketId, position);
    }

    // Track fees
    this.totalFeesPaid += trade.fee;

    // Update position based on trade (use totalCost which includes fees)
    if (trade.action === 'BUY') {
      if (trade.side === 'YES') {
        position.yesShares += trade.size;
        position.yesCost += trade.totalCost;
      } else {
        position.noShares += trade.size;
        position.noCost += trade.totalCost;
      }
      this.totalCost += trade.totalCost;
    } else {
      // SELL
      if (trade.side === 'YES') {
        position.yesShares -= trade.size;
        position.yesCost += trade.totalCost; // Negative (net revenue after fee) for sells
      } else {
        position.noShares -= trade.size;
        position.noCost += trade.totalCost;
      }
      this.totalCost += trade.totalCost; // Negative for sells
    }

    position.trades.push(trade);
  }

  /**
   * Resolve a market - settle positions to $1 or $0
   * 
   * @param marketId - Market condition ID
   * @param outcome - 'UP' = YES wins ($1), 'DOWN' = NO wins ($1)
   * @param finalBtcPrice - Final BTC price at resolution
   * @param strikePrice - Strike price of the market
   */
  resolve(
    marketId: string,
    outcome: 'UP' | 'DOWN',
    finalBtcPrice: number,
    strikePrice: number,
    resolutionTimestamp?: number
  ): MarketResolution | null {
    const position = this.positions.get(marketId);
    if (!position) {
      return null;
    }

    // Calculate payouts
    // YES pays $1 if UP, $0 if DOWN
    // NO pays $1 if DOWN, $0 if UP
    const yesPayout = position.yesShares * (outcome === 'UP' ? 1 : 0);
    const noPayout = position.noShares * (outcome === 'DOWN' ? 1 : 0);
    const totalPayout = yesPayout + noPayout;
    const totalCost = position.yesCost + position.noCost;
    const pnl = totalPayout - totalCost;

    const resolution: MarketResolution = {
      marketId,
      outcome,
      finalBtcPrice,
      strikePrice,
      yesShares: position.yesShares,
      noShares: position.noShares,
      yesCost: position.yesCost,
      noCost: position.noCost,
      yesPayout,
      noPayout,
      totalPayout,
      totalCost,
      pnl,
    };

    this.resolutions.push(resolution);
    this.realizedPnL += pnl;

    // Clear position (resolved)
    this.positions.delete(marketId);

    // Update P&L curve on resolution (not on trade) so daily variance is accurate
    this.updatePnLCurve(resolutionTimestamp ?? Date.now());

    return resolution;
  }

  /**
   * Get current position for a market
   */
  getPosition(marketId: string): MarketPosition | undefined {
    return this.positions.get(marketId);
  }

  /**
   * Get all active positions
   */
  getAllPositions(): MarketPosition[] {
    return Array.from(this.positions.values());
  }

  /**
   * Get all resolutions
   */
  getResolutions(): MarketResolution[] {
    return this.resolutions;
  }

  /**
   * Get all trades
   */
  getTrades(): Trade[] {
    return this.allTrades;
  }

  /**
   * Get P&L curve
   */
  getPnLCurve(): PnLPoint[] {
    return this.pnlCurve;
  }

  /**
   * Get realized P&L (from resolved markets)
   */
  getRealizedPnL(): number {
    return this.realizedPnL;
  }

  /**
   * Get total fees paid across all trades
   */
  getTotalFeesPaid(): number {
    return this.totalFeesPaid;
  }

  /**
   * Calculate unrealized P&L based on current market prices
   */
  getUnrealizedPnL(
    getCurrentPrice: (marketId: string, side: 'YES' | 'NO') => number
  ): number {
    let unrealized = 0;

    const positions = Array.from(this.positions.values());
    for (const position of positions) {
      if (position.yesShares > 0) {
        const yesPrice = getCurrentPrice(position.marketId, 'YES');
        const yesValue = position.yesShares * yesPrice;
        unrealized += yesValue - position.yesCost;
      }
      if (position.noShares > 0) {
        const noPrice = getCurrentPrice(position.marketId, 'NO');
        const noValue = position.noShares * noPrice;
        unrealized += noValue - position.noCost;
      }
    }

    return unrealized;
  }

  /**
   * Get total P&L (realized + unrealized)
   */
  getTotalPnL(
    getCurrentPrice: (marketId: string, side: 'YES' | 'NO') => number
  ): number {
    return this.realizedPnL + this.getUnrealizedPnL(getCurrentPrice);
  }

  /**
   * Check if position limits would be exceeded
   */
  canTrade(
    marketId: string,
    side: 'YES' | 'NO',
    size: number,
    maxPositionPerMarket: number
  ): boolean {
    const position = this.positions.get(marketId);
    if (!position) return size <= maxPositionPerMarket;

    const currentShares = side === 'YES' ? position.yesShares : position.noShares;
    return currentShares + size <= maxPositionPerMarket;
  }

  /**
   * Update P&L curve with current state
   */
  private updatePnLCurve(timestamp: number): void {
    // For backtest, we track cumulative realized P&L
    // Unrealized is calculated at each market resolution
    this.pnlCurve.push({
      timestamp,
      cumulativePnL: this.realizedPnL,
      unrealizedPnL: 0, // Calculated separately if needed
      realizedPnL: this.realizedPnL,
    });
  }

  /**
   * Get summary statistics
   */
  getSummary(): {
    totalTrades: number;
    totalMarkets: number;
    resolvedMarkets: number;
    openPositions: number;
    realizedPnL: number;
    totalCost: number;
    totalFeesPaid: number;
  } {
    return {
      totalTrades: this.allTrades.length,
      totalMarkets: this.resolutions.length + this.positions.size,
      resolvedMarkets: this.resolutions.length,
      openPositions: this.positions.size,
      realizedPnL: this.realizedPnL,
      totalCost: this.totalCost,
      totalFeesPaid: this.totalFeesPaid,
    };
  }

  /**
   * Reset all state
   */
  reset(): void {
    this.positions.clear();
    this.resolutions = [];
    this.allTrades = [];
    this.pnlCurve = [];
    this.realizedPnL = 0;
    this.totalCost = 0;
    this.totalFeesPaid = 0;
  }
}

