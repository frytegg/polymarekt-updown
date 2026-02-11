/**
 * Paper Trading Tracker v2
 * Clean metrics, trade IDs, no misleading unrealized P&L
 */

import * as fs from 'fs';
import * as path from 'path';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Paper trade record with unique ID
 */
export interface PaperTrade {
  id: number;                    // Unique trade ID
  timestamp: Date;
  marketId: string;
  tokenId: string;
  side: 'YES' | 'NO';
  price: number;
  size: number;
  fairValue: number;
  edge: number;
  fee: number;
  adjustment: number;
  adjustmentMethod: 'static' | 'ema';
  btcPrice: number;
  strike: number;
  timeRemainingMs: number;
  marketEndTime: number;         // Unix ms when market resolves
  // Calculated fields
  cost: number;                  // price * size
  maxProfit: number;             // (1 - price) * size - fee (if win)
  maxLoss: number;               // price * size + fee (if lose)
  // Status
  resolved: boolean;
  outcome?: 'WIN' | 'LOSS';
  pnl?: number;
}

/**
 * Paper position (aggregated trades for a token)
 */
export interface PaperPosition {
  tokenId: string;
  marketId: string;
  side: 'YES' | 'NO';
  avgPrice: number;
  shares: number;
  totalCost: number;
  totalFees: number;
  tradeIds: number[];
  marketEndTime: number;
  strike: number;
  maxProfit: number;             // If this position wins
  maxLoss: number;               // If this position loses
}

/**
 * Resolution record
 */
export interface ResolutionRecord {
  id: number;
  marketId: string;
  timestamp: Date;
  outcome: 'UP' | 'DOWN';
  position: PaperPosition;
  pnl: number;
  payout: number;
  tradeIds: number[];
}

/**
 * Clean statistics (no misleading metrics)
 */
export interface PaperStats {
  // Counts
  totalTrades: number;
  openTrades: number;
  resolvedTrades: number;

  // Financial - Realized (actual)
  realizedPnL: number;
  totalFeesPaid: number;

  // Financial - At Risk (potential)
  capitalAtRisk: number;         // Cost of open positions
  potentialProfit: number;       // If all open positions win
  potentialLoss: number;         // If all open positions lose

  // Performance
  winCount: number;
  lossCount: number;
  winRate: number;
  avgEdge: number;

  // For JSON export
  openPositions: PaperPosition[];
}

// =============================================================================
// FEE CALCULATION
// =============================================================================

/**
 * Calculate Polymarket taker fee for 15-min crypto markets
 * Fee formula: shares * price * 0.25 * (price * (1 - price))^2
 */
export function calculatePolymarketFee(shares: number, price: number): number {
  const feeMultiplier = 0.25 * Math.pow(price * (1 - price), 2);
  return shares * price * feeMultiplier;
}

// =============================================================================
// PAPER TRADING TRACKER
// =============================================================================

class PaperTradingTracker {
  private trades: PaperTrade[] = [];
  private positions: Map<string, PaperPosition> = new Map();
  private resolutions: ResolutionRecord[] = [];
  private nextTradeId: number = 1;
  private nextResolutionId: number = 1;
  private logFile: string;
  private dataDir: string;

  // Callbacks for Telegram notifications (set by telegram.ts)
  public onTradeOpened?: (trade: PaperTrade) => void;
  public onTradeResolved?: (trade: PaperTrade, resolution: ResolutionRecord) => void;
  public onSummaryRequested?: (stats: PaperStats) => void;

  constructor() {
    this.dataDir = path.join(process.cwd(), 'data', 'paper-trades');
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().split('T')[0];
    this.logFile = path.join(this.dataDir, `paper-trades-${timestamp}.json`);
    this.loadFromFile();
  }

  /**
   * Record a new paper trade
   */
  recordTrade(tradeInput: Omit<PaperTrade, 'id' | 'cost' | 'maxProfit' | 'maxLoss' | 'resolved'>): PaperTrade {
    const cost = tradeInput.price * tradeInput.size;
    const maxProfit = (1 - tradeInput.price) * tradeInput.size - tradeInput.fee;
    const maxLoss = cost + tradeInput.fee;

    const trade: PaperTrade = {
      ...tradeInput,
      id: this.nextTradeId++,
      cost,
      maxProfit,
      maxLoss,
      resolved: false,
    };

    this.trades.push(trade);
    this.updatePosition(trade);
    this.logTrade(trade);
    this.saveToFile();

    // Notify via callback
    if (this.onTradeOpened) {
      this.onTradeOpened(trade);
    }

    return trade;
  }

  /**
   * Update position based on trade
   */
  private updatePosition(trade: PaperTrade): void {
    const key = trade.tokenId;
    const existing = this.positions.get(key);

    if (existing) {
      const totalShares = existing.shares + trade.size;
      const totalCost = existing.totalCost + trade.cost;
      const totalFees = existing.totalFees + trade.fee;
      const maxProfit = totalShares - totalCost - totalFees;
      const maxLoss = totalCost + totalFees;

      this.positions.set(key, {
        ...existing,
        avgPrice: totalCost / totalShares,
        shares: totalShares,
        totalCost,
        totalFees,
        tradeIds: [...existing.tradeIds, trade.id],
        maxProfit,
        maxLoss,
      });
    } else {
      this.positions.set(key, {
        tokenId: trade.tokenId,
        marketId: trade.marketId,
        side: trade.side,
        avgPrice: trade.price,
        shares: trade.size,
        totalCost: trade.cost,
        totalFees: trade.fee,
        tradeIds: [trade.id],
        marketEndTime: trade.marketEndTime,
        strike: trade.strike,
        maxProfit: trade.maxProfit,
        maxLoss: trade.maxLoss,
      });
    }
  }

  /**
   * Record market resolution
   */
  recordResolution(
    marketId: string,
    yesTokenId: string,
    noTokenId: string,
    outcome: 'UP' | 'DOWN'
  ): void {
    // Process YES position
    const yesPosition = this.positions.get(yesTokenId);
    if (yesPosition) {
      this.resolvePosition(yesPosition, outcome, outcome === 'UP');
    }

    // Process NO position
    const noPosition = this.positions.get(noTokenId);
    if (noPosition) {
      this.resolvePosition(noPosition, outcome, outcome === 'DOWN');
    }

    this.saveToFile();
  }

  /**
   * Resolve a single position
   */
  private resolvePosition(
    position: PaperPosition,
    marketOutcome: 'UP' | 'DOWN',
    isWin: boolean
  ): void {
    const payout = isWin ? position.shares : 0;
    const pnl = payout - position.totalCost - position.totalFees;

    const resolution: ResolutionRecord = {
      id: this.nextResolutionId++,
      marketId: position.marketId,
      timestamp: new Date(),
      outcome: marketOutcome,
      position: { ...position },
      pnl,
      payout,
      tradeIds: position.tradeIds,
    };

    this.resolutions.push(resolution);
    this.positions.delete(position.tokenId);

    // Mark trades as resolved
    for (const tradeId of position.tradeIds) {
      const trade = this.trades.find(t => t.id === tradeId);
      if (trade) {
        trade.resolved = true;
        trade.outcome = isWin ? 'WIN' : 'LOSS';
        trade.pnl = pnl / position.tradeIds.length; // Distribute P&L across trades

        // Notify via callback
        if (this.onTradeResolved) {
          this.onTradeResolved(trade, resolution);
        }
      }
    }

    // Console log
    const emoji = isWin ? '🟢' : '🔴';
    console.log(
      `[TRACKER] Resolution #${resolution.id}: ${position.side} ${isWin ? 'WON' : 'LOST'} | ` +
      `${position.shares} shares @ ${(position.avgPrice * 100).toFixed(1)}¢ | ` +
      `${emoji} P&L: $${pnl.toFixed(2)}`
    );
  }

  /**
   * Get clean statistics
   */
  getStats(): PaperStats {
    const openTrades = this.trades.filter(t => !t.resolved);
    const resolvedTrades = this.trades.filter(t => t.resolved);
    const positions = Array.from(this.positions.values());

    // Realized P&L
    const realizedPnL = this.resolutions.reduce((sum, r) => sum + r.pnl, 0);
    const totalFeesPaid = this.trades.reduce((sum, t) => sum + t.fee, 0);

    // At-risk metrics
    const capitalAtRisk = positions.reduce((sum, p) => sum + p.totalCost, 0);
    const potentialProfit = positions.reduce((sum, p) => sum + p.maxProfit, 0);
    const potentialLoss = positions.reduce((sum, p) => sum + p.maxLoss, 0);

    // Win/loss
    const winCount = this.resolutions.filter(r => r.pnl > 0).length;
    const lossCount = this.resolutions.filter(r => r.pnl <= 0).length;
    const totalResolved = winCount + lossCount;
    const winRate = totalResolved > 0 ? winCount / totalResolved : 0;

    // Average edge
    const avgEdge = this.trades.length > 0
      ? this.trades.reduce((sum, t) => sum + t.edge, 0) / this.trades.length
      : 0;

    return {
      totalTrades: this.trades.length,
      openTrades: openTrades.length,
      resolvedTrades: resolvedTrades.length,
      realizedPnL,
      totalFeesPaid,
      capitalAtRisk,
      potentialProfit,
      potentialLoss,
      winCount,
      lossCount,
      winRate,
      avgEdge,
      openPositions: positions,
    };
  }

  /**
   * Get open (live) trades
   */
  getLiveTrades(): PaperTrade[] {
    return this.trades.filter(t => !t.resolved);
  }

  /**
   * Get resolved (past) trades
   */
  getPastTrades(): PaperTrade[] {
    return this.trades.filter(t => t.resolved);
  }

  /**
   * Get all positions
   */
  getPositions(): PaperPosition[] {
    return Array.from(this.positions.values());
  }

  /**
   * Get all resolutions
   */
  getResolutions(): ResolutionRecord[] {
    return [...this.resolutions];
  }

  /**
   * Log trade to console
   */
  private logTrade(trade: PaperTrade): void {
    const adjMethod = trade.adjustmentMethod === 'ema' ? 'EMA' : 'STATIC';
    console.log(
      `\n[TRADE #${trade.id}] BUY ${trade.size} ${trade.side} @ ${(trade.price * 100).toFixed(1)}¢ | ` +
      `Edge: +${(trade.edge * 100).toFixed(1)}% | ` +
      `Cost: $${trade.cost.toFixed(2)} | ` +
      `Max Profit: $${trade.maxProfit.toFixed(2)} | ` +
      `Adj: $${trade.adjustment.toFixed(0)} (${adjMethod})`
    );
  }

  /**
   * Print summary (console + optional callback)
   */
  printSummary(): void {
    const stats = this.getStats();

    console.log('\n============ TRADING SUMMARY ============');
    console.log(`Total Trades:     ${stats.totalTrades} (${stats.openTrades} open, ${stats.resolvedTrades} resolved)`);
    console.log(`Realized P&L:     $${stats.realizedPnL.toFixed(2)}`);
    console.log(`Total Fees:       $${stats.totalFeesPaid.toFixed(2)}`);
    console.log(`Win Rate:         ${(stats.winRate * 100).toFixed(1)}% (${stats.winCount}W / ${stats.lossCount}L)`);
    console.log(`Avg Edge:         ${(stats.avgEdge * 100).toFixed(1)}%`);

    if (stats.openPositions.length > 0) {
      console.log(`\n--- Open Positions (${stats.openPositions.length}) ---`);
      console.log(`Capital at Risk:  $${stats.capitalAtRisk.toFixed(2)}`);
      console.log(`If all WIN:       +$${stats.potentialProfit.toFixed(2)}`);
      console.log(`If all LOSE:      -$${stats.potentialLoss.toFixed(2)}`);

      for (const pos of stats.openPositions) {
        const tradeIdsStr = pos.tradeIds?.join(', ') ?? 'unknown';
        console.log(`  ${pos.side}: ${pos.shares} @ ${(pos.avgPrice * 100).toFixed(1)}¢ | Cost: $${pos.totalCost.toFixed(2)} | Trades: ${tradeIdsStr}`);
      }
    }
    console.log('=========================================\n');

    // Notify via callback
    if (this.onSummaryRequested) {
      this.onSummaryRequested(stats);
    }
  }

  /**
   * Save to JSON file
   */
  private saveToFile(): void {
    try {
      const data = {
        trades: this.trades.map(t => ({
          ...t,
          timestamp: t.timestamp.toISOString(),
        })),
        positions: Array.from(this.positions.values()),
        resolutions: this.resolutions.map(r => ({
          ...r,
          timestamp: r.timestamp.toISOString(),
        })),
        stats: this.getStats(),
        meta: {
          nextTradeId: this.nextTradeId,
          nextResolutionId: this.nextResolutionId,
          savedAt: new Date().toISOString(),
        },
      };

      fs.writeFileSync(this.logFile, JSON.stringify(data, null, 2));
    } catch (err: any) {
      console.error(`[TRACKER] Save failed: ${err.message}`);
    }
  }

  /**
   * Load from JSON file
   */
  private loadFromFile(): void {
    try {
      if (fs.existsSync(this.logFile)) {
        const raw = fs.readFileSync(this.logFile, 'utf-8');
        const data = JSON.parse(raw);

        // Restore trades with validation/migration
        const now = Date.now();
        let skippedTrades = 0;
        let skippedPositions = 0;

        this.trades = (data.trades || [])
          .map((t: any, index: number) => {
            // Validate required fields exist
            if (!t.tokenId || !t.marketId || t.price === undefined || t.size === undefined) {
              skippedTrades++;
              return null;
            }

            // Migrate/calculate missing fields
            const cost = t.cost ?? (t.price * t.size);
            const fee = t.fee ?? 0;
            const maxProfit = t.maxProfit ?? ((1 - t.price) * t.size - fee);
            const maxLoss = t.maxLoss ?? (cost + fee);
            const id = t.id ?? (index + 1);
            const resolved = t.resolved ?? false;
            const marketEndTime = t.marketEndTime ?? 0;

            return {
              ...t,
              id,
              timestamp: new Date(t.timestamp),
              cost,
              maxProfit,
              maxLoss,
              resolved,
              marketEndTime,
            };
          })
          .filter((t: PaperTrade | null): t is PaperTrade => t !== null);

        // Restore positions with validation
        this.positions.clear();
        for (const pos of data.positions || []) {
          // Validate required fields
          if (!pos.tokenId || !pos.marketId || pos.shares === undefined) {
            skippedPositions++;
            continue;
          }

          // Find trade IDs for this position from loaded trades
          const positionTradeIds = pos.tradeIds ?? this.trades
            .filter((t: PaperTrade) => t.tokenId === pos.tokenId && !t.resolved)
            .map((t: PaperTrade) => t.id);

          // Skip positions with no associated trades (stale data)
          if (positionTradeIds.length === 0) {
            skippedPositions++;
            continue;
          }

          // Migrate/calculate missing fields
          const totalCost = pos.totalCost ?? (pos.avgPrice * pos.shares);
          const totalFees = pos.totalFees ?? 0;
          const maxProfit = pos.maxProfit ?? (pos.shares - totalCost - totalFees);
          const maxLoss = pos.maxLoss ?? (totalCost + totalFees);

          // Try to get marketEndTime and strike from associated trades
          const associatedTrade = this.trades.find((t: PaperTrade) => t.tokenId === pos.tokenId);
          const marketEndTime = pos.marketEndTime ?? associatedTrade?.marketEndTime ?? 0;
          const strike = pos.strike ?? associatedTrade?.strike ?? 0;

          // Skip positions for markets that have already expired
          if (marketEndTime > 0 && marketEndTime < now) {
            console.log(`[TRACKER] Skipping expired position for market ending at ${new Date(marketEndTime).toISOString()}`);
            skippedPositions++;
            continue;
          }

          this.positions.set(pos.tokenId, {
            tokenId: pos.tokenId,
            marketId: pos.marketId,
            side: pos.side,
            avgPrice: pos.avgPrice,
            shares: pos.shares,
            totalCost,
            totalFees,
            tradeIds: positionTradeIds,
            marketEndTime,
            strike,
            maxProfit,
            maxLoss,
          });
        }

        // Restore resolutions
        this.resolutions = (data.resolutions || []).map((r: any) => ({
          ...r,
          timestamp: new Date(r.timestamp),
        }));

        // Restore IDs
        this.nextTradeId = data.meta?.nextTradeId || this.trades.length + 1;
        this.nextResolutionId = data.meta?.nextResolutionId || this.resolutions.length + 1;

        const loadMsg = `[TRACKER] Loaded ${this.trades.length} trades, ${this.positions.size} positions`;
        const skipMsg = skippedTrades > 0 || skippedPositions > 0
          ? ` (skipped ${skippedTrades} invalid trades, ${skippedPositions} stale/invalid positions)`
          : '';
        console.log(loadMsg + skipMsg);

        // Resave if we migrated/cleaned data
        if (skippedTrades > 0 || skippedPositions > 0) {
          this.saveToFile();
        }
      }
    } catch (err: any) {
      console.error(`[TRACKER] Load failed: ${err.message}`);
    }
  }

  /**
   * Check for expired positions and resolve them via Polymarket API
   * Call this periodically (e.g., every 30 seconds) to catch any missed resolutions
   * Replaces the fragile setTimeout approach in switchToNextMarket()
   */
  async checkAndResolveExpired(): Promise<void> {
    const now = Date.now();
    const positions = Array.from(this.positions.values());

    for (const pos of positions) {
      // Only check positions past their expiry + 2 min buffer
      if (pos.marketEndTime <= 0 || pos.marketEndTime + 120_000 > now) continue;

      try {
        const outcome = await this.fetchMarketOutcome(pos.marketId);
        if (outcome) {
          // Determine YES/NO token IDs from position
          // We track by tokenId, so we need to resolve by iterating all positions for this market
          const allPositionsForMarket = positions.filter(p => p.marketId === pos.marketId);
          const yesPos = allPositionsForMarket.find(p => p.side === 'YES');
          const noPos = allPositionsForMarket.find(p => p.side === 'NO');

          if (yesPos) {
            this.resolvePosition(yesPos, outcome, outcome === 'UP');
          }
          if (noPos) {
            this.resolvePosition(noPos, outcome, outcome === 'DOWN');
          }
          this.saveToFile();
        }
      } catch (err: any) {
        // Silently retry next cycle
      }
    }
  }

  /**
   * Fetch market outcome from Polymarket API
   */
  private async fetchMarketOutcome(conditionId: string): Promise<'UP' | 'DOWN' | null> {
    try {
      const response = await fetch(
        `https://gamma-api.polymarket.com/events?slug=btc-up-or-down-15m&limit=100`
      );
      const data = await response.json() as any[];

      for (const event of data) {
        for (const market of event.markets || []) {
          if (market.conditionId === conditionId) {
            if (market.closed && market.resolutionSource) {
              const yesPrice = parseFloat(market.outcomePrices?.[0] || '0');
              const noPrice = parseFloat(market.outcomePrices?.[1] || '0');
              if (yesPrice > 0.9) return 'UP';
              if (noPrice > 0.9) return 'DOWN';
            }
            return null; // Not resolved yet
          }
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Reset all data
   */
  reset(): void {
    this.trades = [];
    this.positions.clear();
    this.resolutions = [];
    this.nextTradeId = 1;
    this.nextResolutionId = 1;
    this.saveToFile();
  }
}

// Export singleton
export const paperTracker = new PaperTradingTracker();
