/**
 * Resolution Tracker
 * 
 * Tracks market resolutions and calculates post-resolution statistics.
 * Sends Telegram notifications when markets resolve.
 */

const axios = require('axios');
import { sendNotification } from './telegram';

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
  private notifiedMarkets: Set<string> = new Set();
  private resolvedTrades: ResolvedTradeResult[] = [];
  private resolvedMarkets: number = 0;
  private isCheckingResolutions: boolean = false;
  private lastStatsLog: number = 0;
  private statsLogInterval: number;

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
    // Skip if already tracking this market
    const alreadyTracking = this.pendingResolutions.some(
      p => p.conditionId === resolution.conditionId
    );
    
    if (!alreadyTracking) {
      this.pendingResolutions.push(resolution);
      console.log(`📋 Tracking resolution for ${resolution.question.slice(0, 30)}... (${resolution.trades.length} trades)`);
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
   * Check pending resolutions and send Telegram notifications
   */
  async checkResolutions(): Promise<void> {
    // Prevent concurrent checks
    if (this.isCheckingResolutions) return;
    if (this.pendingResolutions.length === 0) return;

    this.isCheckingResolutions = true;

    try {
      for (let i = this.pendingResolutions.length - 1; i >= 0; i--) {
        const pending = this.pendingResolutions[i];

        // Skip if already notified (prevent duplicates)
        if (this.notifiedMarkets.has(pending.conditionId)) {
          this.pendingResolutions.splice(i, 1);
          continue;
        }

        // Only check if market ended at least 1 minute ago
        if (Date.now() < pending.endTime + 60000) continue;

        // Mark as notified BEFORE sending to prevent race conditions
        this.notifiedMarkets.add(pending.conditionId);

        try {
          // Fetch current BTC price to determine outcome
          const btcRes = await axios.get('https://api.binance.com/api/v3/ticker/price', {
            params: { symbol: 'BTCUSDT' },
          });
          const finalBtc = parseFloat(btcRes.data.price);
          const outcome = finalBtc > pending.strike ? 'UP' : 'DOWN';

          // Calculate PnL
          const totalCost = pending.yesCost + pending.noCost;
          const payout = outcome === 'UP' ? pending.yesShares : pending.noShares;
          const pnl = payout - totalCost;
          
          // Track per-trade realized returns (like backtest)
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

          // Send notification
          const msg = 
            `PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}\n`+
            `${pending.question}\n` +
            `Result: ${outcome} - Position: ${pending.yesShares} YES / ${pending.noShares} NO\n` +
            `Cost: $${totalCost.toFixed(2)} - Payout: $${payout.toFixed(2)}`;

          await sendNotification(msg);
          console.log(`\n📱 Telegram: ${outcome} | PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);

          // Remove from pending
          this.pendingResolutions.splice(i, 1);
          
          // Log resolution stats periodically
          const now = Date.now();
          if (now - this.lastStatsLog > this.statsLogInterval && this.resolvedTrades.length >= 3) {
            this.logStats();
            this.lastStatsLog = now;
          }
        } catch (err) {
          // Error sending - already marked as notified so won't retry
        }
      }
    } finally {
      this.isCheckingResolutions = false;
    }
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
   * Log resolution statistics to console
   */
  logStats(): void {
    if (this.resolvedTrades.length === 0) return;
    
    const trades = this.resolvedTrades;
    const n = trades.length;
    
    // Calculate averages
    const avgExpectedEdge = trades.reduce((sum, t) => sum + t.expectedEdge, 0) / n;
    const avgRealizedReturn = trades.reduce((sum, t) => sum + t.realizedReturn, 0) / n;
    const edgeCaptureRate = avgExpectedEdge > 0 ? avgRealizedReturn / avgExpectedEdge : 0;
    
    // By outcome
    const winningTrades = trades.filter(t => t.won);
    const losingTrades = trades.filter(t => !t.won);
    const winRate = winningTrades.length / n;
    
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
    
    // Log like backtest format
    console.log(`\n📊 ════════════════════════════════════════════════════════════════`);
    console.log(`   POST-RESOLUTION EDGE ANALYSIS (${n} trades, ${this.resolvedMarkets} markets)`);
    console.log(`   ──────────────────────────────────────────────────────────────────`);
    console.log(`   Win Rate:             ${(winRate * 100).toFixed(1)}% (${winningTrades.length}W / ${losingTrades.length}L)`);
    console.log(`   ──────────────────────────────────────────────────────────────────`);
    console.log(`   💰 Per-Trade Returns (per share)`);
    console.log(`      Expected Return:   ${(avgExpectedEdge * 100).toFixed(1)}¢`);
    console.log(`      Realized Return:   ${(avgRealizedReturn * 100).toFixed(1)}¢`);
    console.log(`      Edge Capture:      ${(edgeCaptureRate * 100).toFixed(0)}%`);
    console.log(`   ──────────────────────────────────────────────────────────────────`);
    console.log(`   ✅ WINNING TRADES (${winningTrades.length})`);
    console.log(`      Avg Expected Edge: ${(winningAvgExpectedEdge * 100).toFixed(1)}¢/share`);
    console.log(`      Avg Realized:      ${(winningAvgRealizedReturn * 100).toFixed(1)}¢/share`);
    console.log(`   ❌ LOSING TRADES (${losingTrades.length})`);
    console.log(`      Avg Expected Edge: ${(losingAvgExpectedEdge * 100).toFixed(1)}¢/share`);
    console.log(`      Avg Realized:      ${(losingAvgRealizedReturn * 100).toFixed(1)}¢/share`);
    console.log(`════════════════════════════════════════════════════════════════════\n`);
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

