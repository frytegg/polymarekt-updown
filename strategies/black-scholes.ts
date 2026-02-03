/**
 * Black-Scholes Pricing Strategy for Polymarket BTC Up/Down Markets
 *
 * This is the production pricing model. Key features:
 * - Drift-corrected d₂ formula: d₂ = [ln(S/K) + (r - σ²/2)τ] / (σ√τ)
 * - Volatility smile adjustment for OTM options
 * - Kurtosis (fat-tail) adjustment for extreme moves
 *
 * Parameters (BS_PARAMS):
 * - RISK_FREE_RATE: 0 (crypto has no risk-free rate)
 * - SMILE_COEFFICIENT: 0.08 (8% vol boost per unit moneyness²)
 * - KURTOSIS_FACTOR: 1.15 (compress d by 15% beyond threshold)
 * - KURTOSIS_THRESHOLD: 1.5 (apply kurtosis for |d| > 1.5)
 *
 * Usage:
 *   const bs = new BlackScholesStrategy();
 *   const fv = bs.calculateFairValue(btcPrice, strike, secondsRemaining, vol);
 *   console.log(fv.pUp);  // Probability of UP
 */

import { PricingStrategy, FairValue } from './types';

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Model parameters - tune these based on backtesting
 */
export const BS_PARAMS = {
  // Risk-free rate (use 0 for crypto, or funding rate if available)
  RISK_FREE_RATE: 0,

  // Fat tails / Kurtosis adjustment
  // BTC typically has kurtosis ~4-6 vs normal's 3
  // This scales vol for events > 1.5 sigma
  KURTOSIS_FACTOR: 1.15,      // 15% vol boost for fat tails
  KURTOSIS_THRESHOLD: 1.5,    // Apply to moves > 1.5 sigma

  // Volatility smile parameters (quadratic smile)
  // vol_adjusted = vol_base * (1 + SMILE_COEF * moneyness²)
  // where moneyness = |ln(S/K)| / (σ√τ)
  SMILE_COEFFICIENT: 0.08,    // 8% vol increase per unit moneyness²
  SMILE_MAX_BOOST: 1.40,      // Cap smile boost at 40%
};

// Seconds in a year for τ conversion
const SECONDS_PER_YEAR = 365 * 24 * 3600;

// =============================================================================
// BLACK-SCHOLES STRATEGY
// =============================================================================

export class BlackScholesStrategy implements PricingStrategy {
  readonly name = 'bs';

  /**
   * Standard normal CDF approximation (Abramowitz & Stegun)
   * Accurate to ~1e-7
   */
  private normalCDF(x: number): number {
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const sign = x < 0 ? -1 : 1;
    const absX = Math.abs(x);

    const t = 1.0 / (1.0 + p * absX);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX / 2);

    return 0.5 * (1.0 + sign * y);
  }

  /**
   * Apply volatility smile adjustment
   * OTM options have higher implied vol due to jump risk / hedging demand
   *
   * Uses quadratic smile: vol_adj = vol_base * (1 + coef * moneyness²)
   */
  private applyVolSmile(
    baseVol: number,
    currentPrice: number,
    strikePrice: number,
    sigmaT: number
  ): number {
    if (sigmaT < 1e-10) return baseVol;

    // Moneyness = how many sigmas away from ATM
    const logMoneyness = Math.abs(Math.log(currentPrice / strikePrice));
    const moneyness = logMoneyness / sigmaT;

    // Quadratic smile
    const smileMultiplier = 1 + BS_PARAMS.SMILE_COEFFICIENT * (moneyness ** 2);

    // Cap the boost
    const cappedMultiplier = Math.min(smileMultiplier, BS_PARAMS.SMILE_MAX_BOOST);

    return baseVol * cappedMultiplier;
  }

  /**
   * Calculate fair value probabilities for UP/DOWN market
   *
   * Uses corrected Black-Scholes for binary options:
   * d₂ = [ln(S/K) + (r - σ²/2)τ] / (σ√τ)
   * P(UP) = Φ(d₂)
   */
  calculateFairValue(
    currentPrice: number,
    strikePrice: number,
    secondsRemaining: number,
    annualizedVol: number,
    applyAdjustments: boolean = true
  ): FairValue {
    // Convert time to years
    const tau = secondsRemaining / SECONDS_PER_YEAR;

    // Base σ√τ (before adjustments)
    let effectiveVol = annualizedVol;
    const baseSigmaT = annualizedVol * Math.sqrt(tau);

    // Handle edge cases - almost no time left
    if (baseSigmaT < 1e-10) {
      const pUp = currentPrice >= strikePrice ? 1 : 0;
      return {
        pUp,
        pDown: 1 - pUp,
        d: currentPrice >= strikePrice ? Infinity : -Infinity,
        sigmaT: 0,
      };
    }

    // Apply volatility smile (OTM options have higher IV)
    if (applyAdjustments) {
      effectiveVol = this.applyVolSmile(effectiveVol, currentPrice, strikePrice, baseSigmaT);
    }

    // Recalculate sigmaT with adjusted vol
    const sigmaT = effectiveVol * Math.sqrt(tau);

    // ==========================================================================
    // DRIFT CORRECTION (Itô's lemma)
    // ==========================================================================
    // Under risk-neutral measure with geometric Brownian motion:
    // S_T = S_0 * exp((r - σ²/2)T + σ√T * Z)
    //
    // For binary option paying $1 if S_T > K:
    // d₂ = [ln(S/K) + (r - σ²/2)τ] / (σ√τ)
    //
    // The -σ²/2 term corrects for the drift in log-returns
    // Without it, we overestimate P(UP) systematically
    // ==========================================================================

    const r = BS_PARAMS.RISK_FREE_RATE;
    const driftTerm = (r - (effectiveVol ** 2) / 2) * tau;

    // d₂ with drift correction
    let d = (Math.log(currentPrice / strikePrice) + driftTerm) / sigmaT;

    // Apply fat tails adjustment (increases P of extreme outcomes)
    if (applyAdjustments) {
      // Fat tails make extreme moves MORE likely
      // So we reduce |d| for extreme values (push probability toward tails)
      if (Math.abs(d) > BS_PARAMS.KURTOSIS_THRESHOLD) {
        // Compress d toward the threshold
        const sign = d > 0 ? 1 : -1;
        const excess = Math.abs(d) - BS_PARAMS.KURTOSIS_THRESHOLD;
        // Compress excess by kurtosis factor
        const compressedExcess = excess / BS_PARAMS.KURTOSIS_FACTOR;
        d = sign * (BS_PARAMS.KURTOSIS_THRESHOLD + compressedExcess);
      }
    }

    // P(UP) = Φ(d₂)
    const pUp = this.normalCDF(d);
    const pDown = 1 - pUp;

    return {
      pUp,
      pDown,
      d,
      sigmaT,
    };
  }
}
