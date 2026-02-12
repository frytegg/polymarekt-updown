/**
 * Pricing Strategy Types
 */

/**
 * Fair value calculation result
 */
export interface FairValue {
  pUp: number;      // Probability of UP (0-1)
  pDown: number;    // Probability of DOWN (0-1)
  d: number;        // d₂ value from Black-Scholes
  sigmaT: number;   // σ√τ (volatility * sqrt(time))
}

/**
 * Pricing strategy interface
 */
export interface PricingStrategy {
  readonly name: string;

  calculateFairValue(
    currentPrice: number,
    strikePrice: number,
    secondsRemaining: number,
    annualizedVol: number,
    applyAdjustments?: boolean
  ): FairValue;
}
