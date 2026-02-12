/**
 * Volatility Service for Short-Term Binary Options Pricing
 * 
 * For 15-minute options, using DVOL (30-day implied vol) alone is suboptimal.
 * This service combines:
 * - Realized volatility from recent price action (1h, 4h windows)
 * - Implied volatility from Deribit (DVOL 30d + short-term ATM IV)
 * 
 * Refreshes every 2 minutes by fetching Binance klines and Deribit data.
 * 
 * Academic Reference: Andersen & Bollerslev (1998) - For horizons < 1 day,
 * realized volatility is a better predictor than implied volatility.
 */

const axios = require('axios');
import { calculateRealizedVol as coreCalculateRealizedVol } from './core/vol-calculator';

// =============================================================================
// TYPES
// =============================================================================

interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

interface VolatilityDiagnostics {
  realizedVol1h: number;
  realizedVol4h: number;
  dvolImplied: number;
  shortTermIV: number | null;
  lastRefresh: number;
  lastRefreshAgo: string;
  isRunning: boolean;
  klineCount: number;
}

// =============================================================================
// CONFIGURATION
// =============================================================================

const BINANCE_API = 'https://api.binance.com/api/v3';
const DERIBIT_API = 'https://www.deribit.com/api/v2/public';

const CONFIG = {
  REFRESH_INTERVAL_MS: 2 * 60 * 1000, // 2 minutes
  KLINE_INTERVAL: '1m' as const,
  KLINE_LIMIT: 240, // 4 hours of 1-minute candles
  REQUEST_TIMEOUT: 10000,
  
  // Blend weights for different horizons
  BLEND_SHORT_TERM: {
    realized1h: 0.70,
    realized4h: 0.20,
    implied: 0.10,
  },
  BLEND_MEDIUM_TERM: {
    realized4h: 0.50,
    implied: 0.50,
  },
};

// =============================================================================
// VOLATILITY SERVICE CLASS
// =============================================================================

export class VolatilityService {
  // Cached volatility values
  private realizedVol1h: number = 0;
  private realizedVol4h: number = 0;
  private dvolImplied: number = 0.50; // Default 50% until fetched
  private shortTermIV: number | null = null;
  
  // State
  private lastRefresh: number = 0;
  private klineCount: number = 0;
  private refreshInterval: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  
  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================
  
  /**
   * Initialize the service - fetches initial data
   * Must be called before start()
   */
  async init(): Promise<void> {
    console.log('📊 Initializing VolatilityService...');
    
    await this.refresh();
    
    console.log(`✅ VolatilityService initialized:`);
    console.log(`   Realized 1h: ${(this.realizedVol1h * 100).toFixed(1)}%`);
    console.log(`   Realized 4h: ${(this.realizedVol4h * 100).toFixed(1)}%`);
    console.log(`   DVOL 30d: ${(this.dvolImplied * 100).toFixed(1)}%`);
    if (this.shortTermIV) {
      console.log(`   Short-term IV: ${(this.shortTermIV * 100).toFixed(1)}%`);
    }
  }
  
  /**
   * Start the refresh loop (every 2 minutes)
   */
  start(): void {
    if (this.isRunning) return;
    
    this.isRunning = true;
    this.refreshInterval = setInterval(async () => {
      try {
        await this.refresh();
      } catch (error: any) {
        console.warn(`⚠️ Volatility refresh failed: ${error.message}`);
        // Keep using cached values
      }
    }, CONFIG.REFRESH_INTERVAL_MS);
    
    console.log(`🔄 VolatilityService started (refresh every ${CONFIG.REFRESH_INTERVAL_MS / 1000}s)`);
  }
  
  /**
   * Stop the refresh loop
   */
  stop(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
    this.isRunning = false;
    console.log('⏹️ VolatilityService stopped');
  }
  
  // ==========================================================================
  // CORE REFRESH LOGIC
  // ==========================================================================
  
  /**
   * Refresh all volatility data
   * - Fetches Binance klines (4h of 1-min candles)
   * - Calculates realized vol on 1h and 4h windows
   * - Fetches Deribit DVOL and optionally short-term IV
   */
  async refresh(): Promise<void> {
    // Fetch Binance klines and Deribit data in parallel
    const [klines, deribitData] = await Promise.all([
      this.fetchBinanceKlines(),
      this.fetchDeribitData(),
    ]);
    
    // Calculate realized volatility
    if (klines.length >= 60) {
      this.realizedVol1h = this.calculateRealizedVol(klines.slice(-60));
    }
    if (klines.length >= 240) {
      this.realizedVol4h = this.calculateRealizedVol(klines);
    } else if (klines.length >= 60) {
      // Use what we have if less than 4h of data
      this.realizedVol4h = this.calculateRealizedVol(klines);
    }
    
    // Update Deribit data
    this.dvolImplied = deribitData.dvol;
    this.shortTermIV = deribitData.shortTermIV;
    
    this.klineCount = klines.length;
    this.lastRefresh = Date.now();
    
    // Log significant changes
    console.log(`📊 Vol refreshed: RV1h=${(this.realizedVol1h * 100).toFixed(1)}% RV4h=${(this.realizedVol4h * 100).toFixed(1)}% DVOL=${(this.dvolImplied * 100).toFixed(1)}%`);
  }
  
  // ==========================================================================
  // BINANCE DATA
  // ==========================================================================
  
  /**
   * Fetch 1-minute klines from Binance (last 4 hours)
   */
  private async fetchBinanceKlines(): Promise<Kline[]> {
    const response = await axios.get(`${BINANCE_API}/klines`, {
      params: {
        symbol: 'BTCUSDT',
        interval: CONFIG.KLINE_INTERVAL,
        limit: CONFIG.KLINE_LIMIT,
      },
      timeout: CONFIG.REQUEST_TIMEOUT,
    });
    
    const rawKlines = response.data;
    if (!Array.isArray(rawKlines) || rawKlines.length === 0) {
      throw new Error('No klines data from Binance');
    }
    
    // Parse kline format: [openTime, open, high, low, close, volume, closeTime, ...]
    return rawKlines.map((k: any[]) => ({
      openTime: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      closeTime: k[6],
    }));
  }
  
  /**
   * Calculate annualized realized volatility from klines using log returns
   * Delegates to core/vol-calculator for the calculation
   */
  private calculateRealizedVol(klines: Kline[]): number {
    if (klines.length < 2) return 0;

    // Extract close prices and delegate to core calculator
    const closes = klines.map(k => k.close);
    return coreCalculateRealizedVol(closes, 1); // 1-minute intervals
  }
  
  // ==========================================================================
  // DERIBIT DATA
  // ==========================================================================
  
  /**
   * Fetch DVOL and optionally short-term ATM IV from Deribit
   */
  private async fetchDeribitData(): Promise<{ dvol: number; shortTermIV: number | null }> {
    let dvol = this.dvolImplied; // Keep cached value as fallback
    let shortTermIV: number | null = null;
    
    try {
      // Fetch DVOL (30-day implied volatility index)
      const dvolResponse = await axios.get(`${DERIBIT_API}/get_index_price`, {
        params: { index_name: 'btcdvol_usdc' },
        timeout: CONFIG.REQUEST_TIMEOUT,
      });
      
      const dvolValue = dvolResponse.data?.result?.index_price;
      if (dvolValue && dvolValue > 0 && dvolValue < 300) {
        dvol = dvolValue / 100; // Convert from percentage to decimal
      }
    } catch (error: any) {
      console.warn(`⚠️ Failed to fetch DVOL: ${error.message}`);
    }
    
    try {
      // Try to fetch short-term ATM IV (options expiring in 1-3 days)
      shortTermIV = await this.fetchShortTermATMIV();
    } catch (error: any) {
      // Optional - don't warn, just use DVOL
    }
    
    return { dvol, shortTermIV };
  }
  
  /**
   * Fetch ATM implied volatility from near-term options (1-3 day expiry)
   * This is more relevant than DVOL for short-term pricing
   */
  private async fetchShortTermATMIV(): Promise<number | null> {
    // Get current BTC price for ATM determination
    const priceResponse = await axios.get(`${DERIBIT_API}/get_index_price`, {
      params: { index_name: 'btc_usd' },
      timeout: 5000,
    });
    const btcPrice = priceResponse.data?.result?.index_price;
    if (!btcPrice) return null;
    
    // Get list of BTC options
    const instrumentsResponse = await axios.get(`${DERIBIT_API}/get_instruments`, {
      params: { currency: 'BTC', kind: 'option', expired: false },
      timeout: CONFIG.REQUEST_TIMEOUT,
    });
    
    const instruments = instrumentsResponse.data?.result;
    if (!instruments || !Array.isArray(instruments)) return null;
    
    // Filter for options expiring in 1-3 days
    const now = Date.now();
    const minExpiry = now + 1 * 24 * 60 * 60 * 1000;  // 1 day
    const maxExpiry = now + 3 * 24 * 60 * 60 * 1000;  // 3 days
    
    const nearTermOptions = instruments.filter((inst: any) => {
      const expiry = inst.expiration_timestamp;
      return expiry >= minExpiry && expiry <= maxExpiry;
    });
    
    if (nearTermOptions.length === 0) return null;
    
    // Find ATM options (within 2% of current price)
    const atmOptions = nearTermOptions.filter((inst: any) => {
      const strike = inst.strike;
      const pctDiff = Math.abs(strike - btcPrice) / btcPrice;
      return pctDiff < 0.02;
    });
    
    if (atmOptions.length === 0) return null;
    
    // Fetch ticker for ATM options to get mark IV
    const ivPromises = atmOptions.slice(0, 4).map(async (opt: any) => {
      try {
        const tickerResp = await axios.get(`${DERIBIT_API}/ticker`, {
          params: { instrument_name: opt.instrument_name },
          timeout: 5000,
        });
        return tickerResp.data?.result?.mark_iv;
      } catch {
        return null;
      }
    });
    
    const ivResults = await Promise.all(ivPromises);
    const validIVs = ivResults.filter((iv): iv is number => iv !== null && iv > 0);
    
    if (validIVs.length === 0) return null;
    
    // Return average ATM IV (as decimal)
    const avgIV = validIVs.reduce((a, b) => a + b, 0) / validIVs.length;
    return avgIV / 100;
  }
  
  // ==========================================================================
  // PUBLIC API
  // ==========================================================================
  
  /**
   * Get the optimal volatility estimate for a specific time horizon
   * 
   * For 15-minute options:
   * - 70% realized vol 1h (what's happening now)
   * - 20% realized vol 4h (stability/context)
   * - 10% implied vol (market signal)
   * 
   * @param horizonMinutes - Time to expiry in minutes
   * @returns Annualized volatility as decimal (e.g., 0.50 for 50%)
   */
  getVolForHorizon(horizonMinutes: number): number {
    // Fallback if not initialized
    if (this.realizedVol1h === 0 && this.realizedVol4h === 0) {
      return this.dvolImplied;
    }
    
    const implied = this.shortTermIV ?? this.dvolImplied;
    
    // Ultra short-term (< 30 min) - realized volatility dominates
    if (horizonMinutes <= 30) {
      const w = CONFIG.BLEND_SHORT_TERM;
      const blended = w.realized1h * this.realizedVol1h 
                    + w.realized4h * this.realizedVol4h 
                    + w.implied * implied;
      
      // Sanity check: vol should be between 10% and 300% annualized
      return Math.max(0.10, Math.min(3.00, blended));
    }
    
    // Short-term (30 min - 4 hours) - blend realized and implied
    if (horizonMinutes <= 240) {
      // Linearly increase implied weight as horizon increases
      const impliedWeight = horizonMinutes / 240; // 0 at 30min, 1 at 4h
      const realizedWeight = 1 - impliedWeight;
      
      const blended = realizedWeight * this.realizedVol4h + impliedWeight * implied;
      return Math.max(0.10, Math.min(3.00, blended));
    }
    
    // Medium-term (4h - 24h) - blend of daily realized and implied
    if (horizonMinutes <= 1440) {
      const w = CONFIG.BLEND_MEDIUM_TERM;
      return w.realized4h * this.realizedVol4h + w.implied * implied;
    }
    
    // Longer term - use DVOL (30-day implied)
    return this.dvolImplied;
  }
  
  /**
   * Get raw DVOL (for compatibility/fallback)
   */
  getDVOL(): number {
    return this.dvolImplied;
  }
  
  /**
   * Get diagnostics for debugging/monitoring
   */
  getDiagnostics(): VolatilityDiagnostics {
    const now = Date.now();
    const lastRefreshAgo = this.lastRefresh > 0 
      ? `${((now - this.lastRefresh) / 1000).toFixed(0)}s ago`
      : 'never';
    
    return {
      realizedVol1h: this.realizedVol1h,
      realizedVol4h: this.realizedVol4h,
      dvolImplied: this.dvolImplied,
      shortTermIV: this.shortTermIV,
      lastRefresh: this.lastRefresh,
      lastRefreshAgo,
      isRunning: this.isRunning,
      klineCount: this.klineCount,
    };
  }
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

// Export a singleton instance for easy use
export const volatilityService = new VolatilityService();

// Also export the class for testing
export default VolatilityService;

