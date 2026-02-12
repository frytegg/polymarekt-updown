/**
 * Adaptive Oracle Divergence Tracker
 *
 * Maintains a rolling window of Binance-Chainlink price divergences
 * and provides dynamic adjustment for fair value calculation.
 *
 * The divergence (Binance - Chainlink) varies from approximately -50 to -150
 * depending on market conditions. Using a rolling mean provides better
 * accuracy than a static adjustment.
 *
 * Usage:
 *   const tracker = new DivergenceTracker();
 *   tracker.start();  // Begins polling Chainlink every 60s
 *
 *   // In trading loop:
 *   const adjustment = tracker.getRollingMeanAdjustment();
 *   const adjustedPrice = binancePrice + adjustment;
 *
 * Data flow:
 *   1. Poll Chainlink every 60 seconds (reuses fetchChainlinkBTCPrice)
 *   2. Compare to latest Binance price
 *   3. Store divergence in circular buffer (2h window)
 *   4. Calculate rolling mean/median on demand
 */

import * as fs from 'fs';
import * as path from 'path';
import { fetchChainlinkBTCPrice } from './strike-service';

// =============================================================================
// TYPES
// =============================================================================

export interface DivergencePoint {
  timestamp: number;
  binancePrice: number;
  chainlinkPrice: number;
  divergence: number;  // binance - chainlink (positive = Binance higher)
}

export interface DivergenceStats {
  count: number;
  mean: number;
  median: number;
  ema: number;
  stdDev: number;
  min: number;
  max: number;
  lastUpdate: number;
}

// =============================================================================
// CONFIGURATION
// =============================================================================

const FALLBACK_ADJUSTMENT = -104;               // Static fallback
const STATE_FILE = path.join(process.cwd(), 'data', 'divergence-state.json');
const MAX_STATE_AGE_MS = 2 * 60 * 60 * 1000;   // Discard saved state older than 2 hours

// =============================================================================
// DIVERGENCE TRACKER
// =============================================================================

export class DivergenceTracker {
  private buffer: DivergencePoint[] = [];
  private windowMs: number;
  private pollIntervalMs: number;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private lastBinancePrice: number = 0;
  private isRunning = false;
  private emaValue: number = 0;
  private emaAlpha: number;
  private emaInitialized: boolean = false;

  constructor(windowHours: number = 2, pollIntervalSeconds: number = 60) {
    this.windowMs = windowHours * 60 * 60 * 1000;
    this.pollIntervalMs = pollIntervalSeconds * 1000;
    // EMA half-life of 30 minutes with 60s samples: alpha ≈ 0.023
    const emaHalfLifeMinutes = 30;
    this.emaAlpha = 1 - Math.exp(-Math.LN2 / emaHalfLifeMinutes);
  }

  /**
   * Update the latest Binance price (called from BinanceWebSocket handler)
   */
  updateBinancePrice(price: number): void {
    this.lastBinancePrice = price;
  }

  /**
   * Add a new divergence point to the buffer
   * Called internally after Chainlink poll
   */
  private addPoint(binancePrice: number, chainlinkPrice: number): void {
    const now = Date.now();
    const divergence = binancePrice - chainlinkPrice;

    this.buffer.push({
      timestamp: now,
      binancePrice,
      chainlinkPrice,
      divergence,
    });

    // Update EMA
    if (!this.emaInitialized) {
      this.emaValue = divergence;
      this.emaInitialized = true;
    } else {
      this.emaValue = this.emaAlpha * divergence + (1 - this.emaAlpha) * this.emaValue;
    }

    // Prune old points outside window
    const cutoff = now - this.windowMs;
    this.buffer = this.buffer.filter(p => p.timestamp >= cutoff);
  }

  /**
   * Poll Chainlink and record divergence
   */
  private async pollChainlink(): Promise<void> {
    if (this.lastBinancePrice <= 0) {
      return;  // No Binance price yet
    }

    try {
      const result = await fetchChainlinkBTCPrice();
      if (result && result.price > 0) {
        this.addPoint(this.lastBinancePrice, result.price);
      }
    } catch (error) {
      // Silently ignore poll failures - will use existing data
    }
  }

  /**
   * Start the Chainlink polling loop
   * Restores persisted EMA state if available and recent
   */
  start(): void {
    if (this.isRunning) return;

    // Restore persisted state before starting
    this.loadState();

    this.isRunning = true;

    // Initial poll
    this.pollChainlink();

    // Start interval
    this.pollInterval = setInterval(() => {
      this.pollChainlink();
    }, this.pollIntervalMs);

    console.log(`[DivergenceTracker] Started (${this.windowMs / 3600000}h window, ${this.pollIntervalMs / 1000}s poll)`);
  }

  /**
   * Stop the polling loop and persist EMA state for quick restart
   */
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    // Persist state before stopping
    this.saveState();

    this.isRunning = false;
    console.log('[DivergenceTracker] Stopped');
  }

  /**
   * Save EMA state to disk for persistence across restarts
   */
  private saveState(): void {
    try {
      const dir = path.dirname(STATE_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const state = {
        emaValue: this.emaValue,
        emaInitialized: this.emaInitialized,
        lastUpdate: this.buffer.length > 0
          ? this.buffer[this.buffer.length - 1].timestamp
          : 0,
        bufferSize: this.buffer.length,
        savedAt: Date.now(),
      };

      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
      console.log(`[DivergenceTracker] State saved (EMA: $${this.emaValue.toFixed(1)}, buffer: ${this.buffer.length})`);
    } catch (err: any) {
      console.log(`[DivergenceTracker] Failed to save state: ${err.message}`);
    }
  }

  /**
   * Load persisted EMA state if available and recent enough
   * Eliminates the 30-minute warm-up blind spot on quick restarts
   */
  private loadState(): void {
    try {
      if (!fs.existsSync(STATE_FILE)) return;

      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
      const state = JSON.parse(raw);

      const age = Date.now() - (state.savedAt ?? 0);
      if (age > MAX_STATE_AGE_MS) {
        console.log(`[DivergenceTracker] Saved state too old (${(age / 60000).toFixed(0)}min), starting fresh`);
        return;
      }

      if (state.emaInitialized && typeof state.emaValue === 'number') {
        this.emaValue = state.emaValue;
        this.emaInitialized = true;
        console.log(`[DivergenceTracker] Restored EMA state: $${this.emaValue.toFixed(1)} (${(age / 60000).toFixed(0)}min old)`);
      }
    } catch (err: any) {
      console.log(`[DivergenceTracker] Failed to load state: ${err.message}`);
    }
  }

  /**
   * Get Rolling Mean adjustment (negated for use)
   *
   * Returns NEGATIVE number to apply to Binance price
   * e.g., if mean divergence is +104, returns -104
   */
  getRollingMeanAdjustment(): number {
    if (this.buffer.length === 0) {
      return FALLBACK_ADJUSTMENT;
    }

    const sum = this.buffer.reduce((acc, p) => acc + p.divergence, 0);
    const mean = sum / this.buffer.length;

    // Return negative to correct Binance price down to Chainlink level
    return -mean;
  }

  /**
   * Get Median adjustment (more robust to outliers)
   */
  getMedianAdjustment(): number {
    if (this.buffer.length === 0) {
      return FALLBACK_ADJUSTMENT;
    }

    const sorted = [...this.buffer.map(p => p.divergence)].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);

    const median = sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];

    return -median;
  }

  /**
   * Get EMA adjustment (smoothest, lowest drawdown - RECOMMENDED)
   * EMA reacts faster to recent changes while smoothing noise
   */
  getEmaAdjustment(): number {
    if (!this.emaInitialized) {
      return FALLBACK_ADJUSTMENT;
    }

    return -this.emaValue;
  }

  /**
   * Get current divergence statistics
   */
  getStats(): DivergenceStats {
    if (this.buffer.length === 0) {
      return {
        count: 0,
        mean: 0,
        median: 0,
        ema: this.emaValue,
        stdDev: 0,
        min: 0,
        max: 0,
        lastUpdate: 0,
      };
    }

    const divergences = this.buffer.map(p => p.divergence);
    const sum = divergences.reduce((a, b) => a + b, 0);
    const mean = sum / divergences.length;

    const sorted = [...divergences].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];

    const variance = divergences.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / divergences.length;
    const stdDev = Math.sqrt(variance);

    return {
      count: divergences.length,
      mean,
      median,
      ema: this.emaValue,
      stdDev,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      lastUpdate: this.buffer[this.buffer.length - 1]?.timestamp ?? 0,
    };
  }

  /**
   * Check if tracker has enough data for reliable adjustment
   * Returns true if we have 30+ live points OR if EMA was restored from persisted state
   */
  hasReliableData(): boolean {
    if (this.emaInitialized && this.buffer.length === 0) {
      // EMA was restored from disk but no new live points yet — still reliable
      return true;
    }
    return this.buffer.length >= 30;
  }

  /**
   * Get current buffer size
   */
  getBufferSize(): number {
    return this.buffer.length;
  }

  /**
   * Log current status
   */
  logStatus(): void {
    const stats = this.getStats();
    const emaAdj = this.getEmaAdjustment();

    console.log(`[DivergenceTracker] Status:`);
    console.log(`   Buffer: ${stats.count} points (${this.windowMs / 3600000}h window)`);
    console.log(`   Mean divergence: $${stats.mean.toFixed(2)}`);
    console.log(`   EMA divergence:  $${stats.ema.toFixed(2)}`);
    console.log(`   Std Dev: $${stats.stdDev.toFixed(2)}`);
    console.log(`   Range: $${stats.min.toFixed(2)} to $${stats.max.toFixed(2)}`);
    console.log(`   EMA adjustment:  $${emaAdj.toFixed(2)} (RECOMMENDED)`);
    console.log(`   Reliable: ${this.hasReliableData() ? 'YES' : 'NO (need more data)'}`);
  }
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

export const divergenceTracker = new DivergenceTracker();
