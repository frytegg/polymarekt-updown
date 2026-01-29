/**
 * Execution Metrics Tracker
 * 
 * Collects and analyzes execution metrics for trades.
 * Used for backtest calibration (latency, slippage, edge capture rate).
 */

// =============================================================================
// TYPES
// =============================================================================

export interface TradeMetric {
  timestamp: number;
  side: 'YES' | 'NO';
  
  // Latency: time from signal to fill (ms)
  latencyMs: number;
  
  // Price metrics
  expectedPrice: number;      // Price when we saw the opportunity
  actualPrice: number;        // Price we actually paid (with slippage)
  slippageCents: number;      // Difference in cents
  
  // Edge metrics
  expectedEdge: number;       // Edge when we decided to trade
  realizedEdge: number;       // Actual edge after slippage (fair value - actual price)
  
  // BTC price movement during execution
  btcPriceAtSignal: number;
  btcPriceAtFill: number;
  btcMovePct: number;         // % change in BTC during execution
}

export interface ExecutionStats {
  count: number;
  
  // Latency stats (ms)
  latencyMin: number;
  latencyMax: number;
  latencyMean: number;
  latencyP50: number;
  latencyP95: number;
  
  // Slippage stats (cents)
  slippageMin: number;
  slippageMax: number;
  slippageMean: number;
  
  // Edge stats (decimal)
  expectedEdgeMean: number;
  realizedEdgeMean: number;
  edgeCaptureRate: number;    // realizedEdge / expectedEdge
  
  // BTC movement during execution (%)
  btcMoveAbsMean: number;
  btcMoveAbsP95: number;
}

// =============================================================================
// EXECUTION METRICS TRACKER CLASS
// =============================================================================

export class ExecutionMetricsTracker {
  private tradeMetrics: TradeMetric[] = [];
  private lastLogTime: number = 0;
  private logInterval: number;

  /**
   * @param logIntervalMs - Interval between automatic stats logging (default: 5 minutes)
   */
  constructor(logIntervalMs: number = 5 * 60 * 1000) {
    this.logInterval = logIntervalMs;
  }

  /**
   * Record a trade metric after successful fill
   */
  record(
    side: 'YES' | 'NO',
    signalTime: number,
    fillTime: number,
    expectedPrice: number,
    actualPrice: number,
    expectedEdge: number,
    fairValue: number,
    btcPriceAtSignal: number,
    btcPriceAtFill: number
  ): void {
    const metric: TradeMetric = {
      timestamp: fillTime,
      side,
      latencyMs: fillTime - signalTime,
      expectedPrice,
      actualPrice,
      slippageCents: (actualPrice - expectedPrice) * 100,
      expectedEdge,
      realizedEdge: fairValue - actualPrice,
      btcPriceAtSignal,
      btcPriceAtFill,
      btcMovePct: ((btcPriceAtFill - btcPriceAtSignal) / btcPriceAtSignal) * 100,
    };

    this.tradeMetrics.push(metric);

    // Log stats periodically
    const now = Date.now();
    if (now - this.lastLogTime > this.logInterval && this.tradeMetrics.length >= 3) {
      this.logStats();
      this.lastLogTime = now;
    }
  }

  /**
   * Calculate percentile from sorted array
   */
  private percentile(sortedArr: number[], p: number): number {
    if (sortedArr.length === 0) return 0;
    const idx = Math.ceil((p / 100) * sortedArr.length) - 1;
    return sortedArr[Math.max(0, Math.min(idx, sortedArr.length - 1))];
  }

  /**
   * Calculate execution statistics from recorded metrics
   */
  getStats(): ExecutionStats | null {
    if (this.tradeMetrics.length === 0) return null;

    const metrics = this.tradeMetrics;
    const n = metrics.length;

    // Extract and sort arrays for percentile calculations
    const latencies = metrics.map(m => m.latencyMs).sort((a, b) => a - b);
    const slippages = metrics.map(m => m.slippageCents).sort((a, b) => a - b);
    const btcMoves = metrics.map(m => Math.abs(m.btcMovePct)).sort((a, b) => a - b);

    // Calculate means
    const latencyMean = latencies.reduce((a, b) => a + b, 0) / n;
    const slippageMean = slippages.reduce((a, b) => a + b, 0) / n;
    const expectedEdgeMean = metrics.reduce((a, m) => a + m.expectedEdge, 0) / n;
    const realizedEdgeMean = metrics.reduce((a, m) => a + m.realizedEdge, 0) / n;
    const btcMoveAbsMean = btcMoves.reduce((a, b) => a + b, 0) / n;

    return {
      count: n,
      
      latencyMin: latencies[0],
      latencyMax: latencies[n - 1],
      latencyMean,
      latencyP50: this.percentile(latencies, 50),
      latencyP95: this.percentile(latencies, 95),
      
      slippageMin: slippages[0],
      slippageMax: slippages[n - 1],
      slippageMean,
      
      expectedEdgeMean,
      realizedEdgeMean,
      edgeCaptureRate: expectedEdgeMean > 0 ? realizedEdgeMean / expectedEdgeMean : 0,
      
      btcMoveAbsMean,
      btcMoveAbsP95: this.percentile(btcMoves, 95),
    };
  }

  /**
   * Log execution statistics to console
   */
  logStats(): void {
    const stats = this.getStats();
    if (!stats) return;

    console.log(`\n📊 ══════════════════════════════════════════════════════════════`);
    console.log(`   EXECUTION METRICS (${stats.count} trades)`);
    console.log(`   ──────────────────────────────────────────────────────────────`);
    console.log(`   ⏱️  Latency:    min=${stats.latencyMin}ms  mean=${stats.latencyMean.toFixed(0)}ms  p50=${stats.latencyP50}ms  p95=${stats.latencyP95}ms  max=${stats.latencyMax}ms`);
    console.log(`   💸 Slippage:   min=${stats.slippageMin.toFixed(1)}¢  mean=${stats.slippageMean.toFixed(1)}¢  max=${stats.slippageMax.toFixed(1)}¢`);
    console.log(`   📈 Edge:       expected=${(stats.expectedEdgeMean * 100).toFixed(1)}¢  realized=${(stats.realizedEdgeMean * 100).toFixed(1)}¢  capture=${(stats.edgeCaptureRate * 100).toFixed(0)}%`);
    console.log(`   ₿  BTC move:   mean=${stats.btcMoveAbsMean.toFixed(3)}%  p95=${stats.btcMoveAbsP95.toFixed(3)}%`);
    console.log(`   ──────────────────────────────────────────────────────────────`);
    console.log(`   💡 For backtest: lagSeconds ≈ ${(stats.latencyP95 / 1000).toFixed(1)}s (p95 latency)`);
    console.log(`   💡 For backtest: spreadCents ≈ ${Math.ceil(stats.slippageMean + 0.5)}¢ (mean slippage + buffer)`);
    console.log(`══════════════════════════════════════════════════════════════════\n`);
  }

  /**
   * Get raw trade metrics (for analysis)
   */
  getMetrics(): TradeMetric[] {
    return [...this.tradeMetrics];
  }

  /**
   * Get number of recorded trades
   */
  getCount(): number {
    return this.tradeMetrics.length;
  }

  /**
   * Clear all trade metrics
   */
  clear(): void {
    this.tradeMetrics = [];
    this.lastLogTime = Date.now();
  }
}

