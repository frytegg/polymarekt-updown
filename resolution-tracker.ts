/**
 * Resolution Tracker
 *
 * Tracks market resolutions and calculates post-resolution edge statistics.
 * Outcome is determined via Polymarket CLOB API (on-chain settlement source).
 * Telegram notifications are handled by trade-persistence callbacks.
 */

import { createLogger, Logger } from './logger';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Per-trade info for resolution tracking
 */
export interface TrackedTrade {
  side: 'YES' | 'NO';
  price: number;           // Price paid per share
  size: number;            // Number of shares
  fairValue: number;       // Fair value at trade time
  expectedEdge: number;    // fairValue - price
  timestamp: number;
}

/**
 * Pending resolution to track
 */
export interface PendingResolution {
  conditionId: string;
  question: string;
  yesShares: number;
  noShares: number;
  yesCost: number;
  noCost: number;
  strike: number;
  endTime: number;
  trades: TrackedTrade[];  // All trades made in this market
}

/**
 * Resolution result with per-trade realized returns
 */
export interface ResolvedTradeResult {
  side: 'YES' | 'NO';
  price: number;
  size: number;
  expectedEdge: number;    // What we expected (fairValue - price)
  realizedReturn: number;  // What we got (payout - price)
  won: boolean;
}

/**
 * Aggregate resolution stats
 */
export interface ResolutionStats {
  totalTrades: number;
  totalMarkets: number;
  winningTrades: number;
  losingTrades: number;
  
  // Per-share returns (like backtest)
  avgExpectedEdge: number;      // Avg (fairValue - price)
  avgRealizedReturn: number;    // Avg (payout - price) where payout = 1 if win, 0 if lose
  edgeCaptureRate: number;      // realizedReturn / expectedEdge
  
  // By outcome
  winningAvgExpectedEdge: number;
  winningAvgRealizedReturn: number;
  losingAvgExpectedEdge: number;
  losingAvgRealizedReturn: number;
}

// =============================================================================
// RESOLUTION TRACKER CLASS
// =============================================================================

export class ResolutionTracker {
  private pendingResolutions: PendingResolution[] = [];
  private resolvedConditions: Set<string> = new Set();
  private resolvedTrades: ResolvedTradeResult[] = [];
  private resolvedMarkets: number = 0;
  private isCheckingResolutions: boolean = false;
  private lastStatsLog: number = 0;
  private statsLogInterval: number;
  private log: Logger = createLogger('ResolutionTracker', { mode: 'live' });

  /**
   * @param statsLogIntervalMs - Interval between automatic stats logging (default: 10 minutes)
   */
  constructor(statsLogIntervalMs: number = 10 * 60 * 1000) {
    this.statsLogInterval = statsLogIntervalMs;
  }

  /**
   * Add a pending resolution to track
   */
  addPendingResolution(resolution: PendingResolution): void {
    // Skip if already tracking or already resolved
    const isDuplicate = this.pendingResolutions.some(
      p => p.conditionId === resolution.conditionId
    ) || this.resolvedConditions.has(resolution.conditionId);

    if (!isDuplicate) {
      this.pendingResolutions.push(resolution);
      this.log.info('resolution.tracking', {
        marketId: resolution.conditionId.slice(0, 12),
        question: resolution.question.slice(0, 40),
        tradeCount: resolution.trades.length,
      });
    }
  }

  /**
   * Check if we have pending resolutions
   */
  hasPendingResolutions(): boolean {
    return this.pendingResolutions.length > 0;
  }

  /**
   * Get count of pending resolutions
   */
  getPendingCount(): number {
    return this.pendingResolutions.length;
  }

  /**
   * Check pending resolutions via CLOB API (on-chain settlement)
   * Telegram notifications are handled by trade-persistence callbacks.
   */
  async checkResolutions(): Promise<void> {
    // Prevent concurrent checks
    if (this.isCheckingResolutions) return;
    if (this.pendingResolutions.length === 0) return;

    this.isCheckingResolutions = true;

    try {
      for (let i = this.pendingResolutions.length - 1; i >= 0; i--) {
        const pending = this.pendingResolutions[i];

        // Only check if market ended at least 2 minutes ago (CLOB API needs time)
        if (Date.now() < pending.endTime + 120_000) continue;

        const marketId = pending.conditionId.slice(0, 12);

        try {
          const outcome = await this.fetchMarketOutcome(pending.conditionId);

          if (!outcome) {
            // Not resolved yet on CLOB — will retry next cycle
            this.log.debug('resolution.not_yet_resolved', { marketId });
            continue;
          }

          // Track per-trade realized returns (edge analysis)
          for (const trade of pending.trades) {
            const won = (trade.side === 'YES' && outcome === 'UP') ||
                        (trade.side === 'NO' && outcome === 'DOWN');
            const tradePayout = won ? 1 : 0;
            const realizedReturn = tradePayout - trade.price;

            this.resolvedTrades.push({
              side: trade.side,
              price: trade.price,
              size: trade.size,
              expectedEdge: trade.expectedEdge,
              realizedReturn,
              won,
            });
          }
          this.resolvedMarkets++;
          this.resolvedConditions.add(pending.conditionId);

          const totalCost = pending.yesCost + pending.noCost;
          const payout = outcome === 'UP' ? pending.yesShares : pending.noShares;
          const pnl = payout - totalCost;

          this.log.info('resolution.resolved', {
            marketId, outcome,
            pnl: +pnl.toFixed(2),
            tradeCount: pending.trades.length,
          });

          // Remove from pending
          this.pendingResolutions.splice(i, 1);

          // Log edge analysis stats periodically
          const now = Date.now();
          if (now - this.lastStatsLog > this.statsLogInterval && this.resolvedTrades.length >= 3) {
            this.logStats();
            this.lastStatsLog = now;
          }
        } catch (err: any) {
          this.log.warn('resolution.check_error', { marketId, error: err.message?.slice(0, 80) });
        }
      }
    } finally {
      this.isCheckingResolutions = false;
    }
  }

  /**
   * Fetch market outcome from Polymarket CLOB API (on-chain settlement).
   * Returns 'UP' or 'DOWN' if resolved, null if not yet resolved.
   */
  private async fetchMarketOutcome(conditionId: string): Promise<'UP' | 'DOWN' | null> {
    const response = await fetch(
      `https://clob.polymarket.com/markets/${conditionId}`
    );

    if (!response.ok) {
      this.log.warn('resolution.lookup_failed', { marketId: conditionId.slice(0, 12), httpStatus: response.status });
      return null;
    }

    const market = await response.json() as any;

    // Not resolved yet
    if (!market.closed && market.active !== false) return null;

    // Check tokens[].winner field (most reliable)
    const tokens = market.tokens || [];
    if (tokens.length >= 2) {
      if (tokens[0]?.winner === true) return 'UP';
      if (tokens[1]?.winner === true) return 'DOWN';
    }

    // Fallback: check token prices after resolution
    if (tokens.length >= 2) {
      const yesPrice = parseFloat(tokens[0]?.price ?? '0');
      const noPrice = parseFloat(tokens[1]?.price ?? '0');
      if (yesPrice > 0.9) return 'UP';
      if (noPrice > 0.9) return 'DOWN';
    }

    return null;
  }

  /**
   * Calculate resolution statistics
   */
  getStats(): ResolutionStats | null {
    if (this.resolvedTrades.length === 0) return null;
    
    const trades = this.resolvedTrades;
    const n = trades.length;
    
    // Calculate averages
    const avgExpectedEdge = trades.reduce((sum, t) => sum + t.expectedEdge, 0) / n;
    const avgRealizedReturn = trades.reduce((sum, t) => sum + t.realizedReturn, 0) / n;
    const edgeCaptureRate = avgExpectedEdge > 0 ? avgRealizedReturn / avgExpectedEdge : 0;
    
    // By outcome
    const winningTrades = trades.filter(t => t.won);
    const losingTrades = trades.filter(t => !t.won);
    
    const winningAvgExpectedEdge = winningTrades.length > 0
      ? winningTrades.reduce((sum, t) => sum + t.expectedEdge, 0) / winningTrades.length
      : 0;
    const winningAvgRealizedReturn = winningTrades.length > 0
      ? winningTrades.reduce((sum, t) => sum + t.realizedReturn, 0) / winningTrades.length
      : 0;
    
    const losingAvgExpectedEdge = losingTrades.length > 0
      ? losingTrades.reduce((sum, t) => sum + t.expectedEdge, 0) / losingTrades.length
      : 0;
    const losingAvgRealizedReturn = losingTrades.length > 0
      ? losingTrades.reduce((sum, t) => sum + t.realizedReturn, 0) / losingTrades.length
      : 0;
    
    return {
      totalTrades: n,
      totalMarkets: this.resolvedMarkets,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      avgExpectedEdge,
      avgRealizedReturn,
      edgeCaptureRate,
      winningAvgExpectedEdge,
      winningAvgRealizedReturn,
      losingAvgExpectedEdge,
      losingAvgRealizedReturn,
    };
  }
  
  /**
   * Log resolution edge analysis statistics
   */
  logStats(): void {
    const stats = this.getStats();
    if (!stats) return;

    this.log.info('edge_analysis.stats', {
      trades: stats.totalTrades,
      markets: stats.totalMarkets,
      winRate: +((stats.winningTrades / stats.totalTrades) * 100).toFixed(1),
      wins: stats.winningTrades,
      losses: stats.losingTrades,
      avgExpectedEdgeCents: +(stats.avgExpectedEdge * 100).toFixed(1),
      avgRealizedReturnCents: +(stats.avgRealizedReturn * 100).toFixed(1),
      edgeCaptureRate: +(stats.edgeCaptureRate * 100).toFixed(0),
    });
  }

  /**
   * Get resolved trades count
   */
  getResolvedTradesCount(): number {
    return this.resolvedTrades.length;
  }

  /**
   * Get resolved markets count
   */
  getResolvedMarketsCount(): number {
    return this.resolvedMarkets;
  }
}

