/**
 * Adaptive Binance→Chainlink Divergence Adjustment
 *
 * Calculates dynamic adjustment based on historical divergence between
 * Binance and Chainlink prices. Useful when Chainlink settlement differs
 * from Binance fair value source.
 */

import { BinanceKline } from '../types';
import { ChainlinkPricePoint } from '../fetchers/chainlink-historical';

// =============================================================================
// TYPES
// =============================================================================

export type AdjustmentMethod = 'static' | 'rolling-mean' | 'ema' | 'median';

export interface AdaptiveAdjustmentConfig {
  method: AdjustmentMethod;
  windowHours: number;       // Window size for adaptive methods
  staticValue?: number;      // For static method
}

interface DivergencePoint {
  timestamp: number;
  divergence: number;  // Binance - Chainlink
}

// =============================================================================
// DIVERGENCE CALCULATOR
// =============================================================================

/**
 * Calculates Binance - Chainlink divergence at aligned timestamps
 */
export class DivergenceCalculator {
  private divergences: DivergencePoint[] = [];
  private binanceKlines: BinanceKline[] = [];
  private chainlinkPrices: ChainlinkPricePoint[] = [];

  constructor(
    binanceKlines: BinanceKline[],
    chainlinkPrices: ChainlinkPricePoint[]
  ) {
    this.binanceKlines = binanceKlines;
    this.chainlinkPrices = chainlinkPrices;
    this.calculateDivergences();
  }

  /**
   * Pre-calculate divergences at each Binance kline timestamp
   */
  private calculateDivergences(): void {
    if (this.binanceKlines.length === 0 || this.chainlinkPrices.length === 0) {
      return;
    }

    let chainlinkIdx = 0;

    for (const kline of this.binanceKlines) {
      // Find Chainlink price at or just before this kline timestamp
      while (
        chainlinkIdx < this.chainlinkPrices.length - 1 &&
        this.chainlinkPrices[chainlinkIdx + 1].timestamp <= kline.timestamp
      ) {
        chainlinkIdx++;
      }

      const chainlinkPrice = this.chainlinkPrices[chainlinkIdx];

      // Only include if Chainlink price is within 2 minutes of kline
      if (Math.abs(chainlinkPrice.timestamp - kline.timestamp) <= 120000) {
        this.divergences.push({
          timestamp: kline.timestamp,
          divergence: kline.close - chainlinkPrice.price,
        });
      }
    }
  }

  /**
   * Get all divergences within a time window ending at timestamp
   */
  private getDivergencesInWindow(endTimestamp: number, windowMs: number): number[] {
    const startTimestamp = endTimestamp - windowMs;
    const values: number[] = [];

    for (const d of this.divergences) {
      if (d.timestamp >= startTimestamp && d.timestamp < endTimestamp) {
        values.push(d.divergence);
      }
    }

    return values;
  }

  /**
   * Get index for binary search
   */
  private getIndexAt(timestamp: number): number {
    if (this.divergences.length === 0) return -1;

    let left = 0;
    let right = this.divergences.length - 1;

    while (left < right) {
      const mid = Math.floor((left + right + 1) / 2);
      if (this.divergences[mid].timestamp <= timestamp) {
        left = mid;
      } else {
        right = mid - 1;
      }
    }

    return left;
  }

  /**
   * Rolling Mean Adjustment
   * Uses simple average of divergences in the last N hours
   */
  rollingMeanAdjustment(timestamp: number, windowHours: number): number {
    const windowMs = windowHours * 60 * 60 * 1000;
    const values = this.getDivergencesInWindow(timestamp, windowMs);

    if (values.length === 0) {
      return 0; // No data, no adjustment
    }

    const sum = values.reduce((a, b) => a + b, 0);
    return sum / values.length;
  }

  /**
   * Exponential Moving Average Adjustment
   * Weights recent divergences more heavily
   * alpha = 2 / (windowHours + 1)
   */
  emaAdjustment(timestamp: number, windowHours: number): number {
    const windowMs = windowHours * 60 * 60 * 1000;
    const startTimestamp = timestamp - windowMs;

    // Get divergences in window, sorted by timestamp
    const windowDivergences = this.divergences.filter(
      d => d.timestamp >= startTimestamp && d.timestamp < timestamp
    );

    if (windowDivergences.length === 0) {
      return 0;
    }

    // Calculate EMA
    // alpha controls decay: higher = more weight on recent
    // For hours-based window, use alpha = 2 / (N + 1) where N = number of points proportional to window
    const alpha = 2 / (windowHours * 60 + 1); // Approximately one point per minute

    let ema = windowDivergences[0].divergence;

    for (let i = 1; i < windowDivergences.length; i++) {
      ema = alpha * windowDivergences[i].divergence + (1 - alpha) * ema;
    }

    return ema;
  }

  /**
   * Median Adjustment
   * More robust to outliers than mean
   */
  medianAdjustment(timestamp: number, windowHours: number): number {
    const windowMs = windowHours * 60 * 60 * 1000;
    const values = this.getDivergencesInWindow(timestamp, windowMs);

    if (values.length === 0) {
      return 0;
    }

    // Sort and find median
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);

    if (sorted.length % 2 === 0) {
      return (sorted[mid - 1] + sorted[mid]) / 2;
    } else {
      return sorted[mid];
    }
  }

  /**
   * Get adjustment based on method
   */
  getAdjustment(
    timestamp: number,
    method: AdjustmentMethod,
    windowHours: number,
    staticValue: number = 0
  ): number {
    switch (method) {
      case 'static':
        return staticValue;
      case 'rolling-mean':
        return -this.rollingMeanAdjustment(timestamp, windowHours);
      case 'ema':
        return -this.emaAdjustment(timestamp, windowHours);
      case 'median':
        return -this.medianAdjustment(timestamp, windowHours);
      default:
        return staticValue;
    }
  }

  /**
   * Get divergence statistics for a time range
   */
  getStats(startTs: number, endTs: number): {
    count: number;
    mean: number;
    median: number;
    stdDev: number;
    min: number;
    max: number;
  } {
    const values = this.divergences
      .filter(d => d.timestamp >= startTs && d.timestamp <= endTs)
      .map(d => d.divergence);

    if (values.length === 0) {
      return { count: 0, mean: 0, median: 0, stdDev: 0, min: 0, max: 0 };
    }

    const sum = values.reduce((a, b) => a + b, 0);
    const mean = sum / values.length;

    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];

    const variance = values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);

    return {
      count: values.length,
      mean,
      median,
      stdDev,
      min: sorted[0],
      max: sorted[sorted.length - 1],
    };
  }

  /**
   * Get all divergence points (for analysis)
   */
  getDivergences(): DivergencePoint[] {
    return [...this.divergences];
  }
}
