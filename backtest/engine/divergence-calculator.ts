/**
 * Divergence Calculator for Backtest
 *
 * Calculates adaptive Binance→Chainlink price adjustment using historical data.
 * Supports multiple methods: rolling mean, EMA, median.
 *
 * Unlike the live DivergenceTracker (which polls in real-time), this calculator
 * works with pre-fetched historical data for backtest simulation.
 */

import { BinanceKline } from '../types';
import { ChainlinkPricePoint } from '../fetchers/chainlink-historical';

// =============================================================================
// TYPES
// =============================================================================

interface DivergencePoint {
  timestamp: number;
  binancePrice: number;
  chainlinkPrice: number;
  divergence: number;  // binance - chainlink
  runningEma: number;  // Pre-computed running EMA at this point
}

interface DivergenceStats {
  count: number;
  mean: number;
  median: number;
  ema: number;
  min: number;
  max: number;
  stdDev: number;
}

// =============================================================================
// DIVERGENCE CALCULATOR
// =============================================================================

export class DivergenceCalculator {
  private divergencePoints: DivergencePoint[] = [];
  private emaAlpha: number;

  /**
   * Create a DivergenceCalculator from historical data
   *
   * @param chainlinkPrices - Historical Chainlink prices
   * @param binanceKlines - Historical Binance 1-min klines
   * @param emaHalfLifeMinutes - Half-life for EMA in minutes (default: 30)
   */
  constructor(
    chainlinkPrices: ChainlinkPricePoint[],
    binanceKlines: BinanceKline[],
    emaHalfLifeMinutes: number = 30
  ) {
    // EMA decay factor: alpha = 1 - exp(-ln(2) / halfLife)
    // For 30-min half-life with 1-min samples: alpha ≈ 0.023
    this.emaAlpha = 1 - Math.exp(-Math.LN2 / emaHalfLifeMinutes);

    this.buildDivergencePoints(chainlinkPrices, binanceKlines);
  }

  /**
   * Build divergence points by aligning Binance and Chainlink timestamps
   */
  private buildDivergencePoints(
    chainlinkPrices: ChainlinkPricePoint[],
    binanceKlines: BinanceKline[]
  ): void {
    if (chainlinkPrices.length === 0 || binanceKlines.length === 0) {
      console.log('[DivergenceCalculator] Warning: Empty price data');
      return;
    }

    // Create a map for quick Binance price lookup
    const binanceMap = new Map<number, number>();
    for (const kline of binanceKlines) {
      // Round to minute for alignment
      const minuteTs = Math.floor(kline.timestamp / 60000) * 60000;
      binanceMap.set(minuteTs, kline.close);
    }

    // For each Chainlink price, find the closest Binance price
    for (const clPrice of chainlinkPrices) {
      const minuteTs = Math.floor(clPrice.timestamp / 60000) * 60000;

      // Try exact minute, then ±1 minute
      let binancePrice = binanceMap.get(minuteTs);
      if (!binancePrice) {
        binancePrice = binanceMap.get(minuteTs - 60000) || binanceMap.get(minuteTs + 60000);
      }

      if (binancePrice && clPrice.price > 0) {
        this.divergencePoints.push({
          timestamp: clPrice.timestamp,
          binancePrice,
          chainlinkPrice: clPrice.price,
          divergence: binancePrice - clPrice.price,
          runningEma: 0, // Will be computed below
        });
      }
    }

    // Sort by timestamp
    this.divergencePoints.sort((a, b) => a.timestamp - b.timestamp);

    // Pre-compute running EMA across the full dataset (matches live DivergenceTracker behavior)
    if (this.divergencePoints.length > 0) {
      this.divergencePoints[0].runningEma = this.divergencePoints[0].divergence;
      for (let i = 1; i < this.divergencePoints.length; i++) {
        const prev = this.divergencePoints[i - 1].runningEma;
        this.divergencePoints[i].runningEma =
          this.emaAlpha * this.divergencePoints[i].divergence + (1 - this.emaAlpha) * prev;
      }
    }

    console.log(`[DivergenceCalculator] Built ${this.divergencePoints.length} divergence points`);

    if (this.divergencePoints.length > 0) {
      const stats = this.getStatsAtTime(this.divergencePoints[this.divergencePoints.length - 1].timestamp, 2);
      console.log(`[DivergenceCalculator] Overall stats: mean=${stats.mean.toFixed(1)}, median=${stats.median.toFixed(1)}, stdDev=${stats.stdDev.toFixed(1)}`);
    }
  }

  /**
   * Get the EMA adjustment to apply at a given timestamp.
   *
   * @param timestamp - The timestamp to calculate adjustment for
   * @param _method - Unused, kept for call-site compat (always EMA)
   * @param windowHours - Rolling window size in hours
   * @returns Adjustment value (negative of EMA divergence), or 0 during warmup
   */
  getAdjustment(
    timestamp: number,
    _method: string,
    windowHours: number,
  ): number {
    const stats = this.getStatsAtTime(timestamp, windowHours);

    if (stats.count < 5) {
      // Not enough data during warmup — return 0 (no adjustment)
      return 0;
    }

    return -stats.ema;
  }

  /**
   * Calculate statistics for divergence at a given timestamp
   * Only uses data BEFORE the timestamp (causal/look-back only)
   */
  private getStatsAtTime(timestamp: number, windowHours: number): DivergenceStats {
    const windowMs = windowHours * 60 * 60 * 1000;
    const cutoffStart = timestamp - windowMs;

    // Filter points within window and before timestamp
    const windowPoints = this.divergencePoints.filter(
      p => p.timestamp >= cutoffStart && p.timestamp < timestamp
    );

    if (windowPoints.length === 0) {
      return {
        count: 0,
        mean: 0,
        median: 0,
        ema: 0,
        min: 0,
        max: 0,
        stdDev: 0,
      };
    }

    const divergences = windowPoints.map(p => p.divergence);

    // Mean
    const sum = divergences.reduce((a, b) => a + b, 0);
    const mean = sum / divergences.length;

    // Median
    const sorted = [...divergences].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];

    // EMA: use pre-computed running EMA from the last point in window
    // This matches live behavior where EMA accumulates state from the start
    const ema = windowPoints[windowPoints.length - 1].runningEma;

    // Standard deviation
    const variance = divergences.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / divergences.length;
    const stdDev = Math.sqrt(variance);

    return {
      count: divergences.length,
      mean,
      median,
      ema,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      stdDev,
    };
  }

  /**
   * Get the number of divergence points
   */
  getPointCount(): number {
    return this.divergencePoints.length;
  }

  /**
   * Get divergence statistics for the entire dataset
   */
  getOverallStats(): DivergenceStats {
    if (this.divergencePoints.length === 0) {
      return {
        count: 0,
        mean: 0,
        median: 0,
        ema: 0,
        min: 0,
        max: 0,
        stdDev: 0,
      };
    }

    const lastTimestamp = this.divergencePoints[this.divergencePoints.length - 1].timestamp;
    const firstTimestamp = this.divergencePoints[0].timestamp;
    const totalHours = (lastTimestamp - firstTimestamp) / (60 * 60 * 1000);

    return this.getStatsAtTime(lastTimestamp + 1, totalHours + 1);
  }
}
