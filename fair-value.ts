/**
 * Crypto Pricer Arb - Fair Value Calculator
 * 
 * Uses Black-Scholes approach for binary options with:
 * - Drift correction (Itô's lemma): d₂ = [ln(S/K) + (r - σ²/2)τ] / (σ√τ)
 * - Fat tails adjustment (kurtosis): Increases vol for extreme moves
 * - Volatility smile: Higher vol for OTM options
 */

import { FairValue } from './types';

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Model parameters - tune these based on backtesting
 */
export const MODEL_PARAMS = {
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

// =============================================================================
// MATH UTILITIES
// =============================================================================

/**
 * Standard normal CDF approximation (Abramowitz & Stegun)
 * Accurate to ~1e-7
 */
function normalCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);

  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);

  return 0.5 * (1.0 + sign * y);
}

// Seconds in a year for τ conversion
const SECONDS_PER_YEAR = 365 * 24 * 3600;

// =============================================================================
// VOLATILITY ADJUSTMENTS
// =============================================================================

/**
 * Apply volatility smile adjustment
 * OTM options have higher implied vol due to jump risk / hedging demand
 * 
 * Uses quadratic smile: vol_adj = vol_base * (1 + coef * moneyness²)
 */
function applyVolSmile(
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
  const smileMultiplier = 1 + MODEL_PARAMS.SMILE_COEFFICIENT * (moneyness ** 2);
  
  // Cap the boost
  const cappedMultiplier = Math.min(smileMultiplier, MODEL_PARAMS.SMILE_MAX_BOOST);
  
  return baseVol * cappedMultiplier;
}

/**
 * Apply fat tails (kurtosis) adjustment
 * BTC has fatter tails than log-normal - extreme moves are more likely
 * 
 * Increases effective vol when price is far from strike
 */
function applyFatTailsAdjustment(
  baseVol: number,
  d: number
): number {
  // Only apply for moves beyond threshold
  if (Math.abs(d) <= MODEL_PARAMS.KURTOSIS_THRESHOLD) {
    return baseVol;
  }
  
  // Scale vol boost by how far beyond threshold
  const excess = Math.abs(d) - MODEL_PARAMS.KURTOSIS_THRESHOLD;
  const boost = 1 + (MODEL_PARAMS.KURTOSIS_FACTOR - 1) * Math.min(excess, 2);
  
  return baseVol * boost;
}

// =============================================================================
// MAIN FAIR VALUE CALCULATION
// =============================================================================

/**
 * Calculate fair value probabilities for UP/DOWN market
 * 
 * Uses corrected Black-Scholes for binary options:
 * d₂ = [ln(S/K) + (r - σ²/2)τ] / (σ√τ)
 * P(UP) = Φ(d₂)
 * 
 * @param currentPrice - Current BTC price from Binance
 * @param strikePrice - Strike price at start of period
 * @param secondsRemaining - Time until resolution in seconds
 * @param annualizedVol - Annualized volatility (e.g., 0.60 for 60%)
 * @param applyAdjustments - Whether to apply smile/fat-tails (default: true)
 * @returns FairValue with pUp, pDown, d, and sigmaT
 */
export function calculateFairValue(
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
    effectiveVol = applyVolSmile(effectiveVol, currentPrice, strikePrice, baseSigmaT);
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
  
  const r = MODEL_PARAMS.RISK_FREE_RATE;
  const driftTerm = (r - (effectiveVol ** 2) / 2) * tau;
  
  // d₂ with drift correction
  let d = (Math.log(currentPrice / strikePrice) + driftTerm) / sigmaT;
  
  // Apply fat tails adjustment (increases P of extreme outcomes)
  if (applyAdjustments) {
    // Fat tails make extreme moves MORE likely
    // So we reduce |d| for extreme values (push probability toward tails)
    const originalD = d;
    if (Math.abs(d) > MODEL_PARAMS.KURTOSIS_THRESHOLD) {
      // Compress d toward the threshold
      const sign = d > 0 ? 1 : -1;
      const excess = Math.abs(d) - MODEL_PARAMS.KURTOSIS_THRESHOLD;
      // Compress excess by kurtosis factor
      const compressedExcess = excess / MODEL_PARAMS.KURTOSIS_FACTOR;
      d = sign * (MODEL_PARAMS.KURTOSIS_THRESHOLD + compressedExcess);
    }
  }
  
  // P(UP) = Φ(d₂)
  const pUp = normalCDF(d);
  const pDown = 1 - pUp;
  
  return {
    pUp,
    pDown,
    d,
    sigmaT,
  };
}

/**
 * Simple fair value without adjustments (for comparison/debugging)
 */
export function calculateFairValueSimple(
  currentPrice: number,
  strikePrice: number,
  secondsRemaining: number,
  annualizedVol: number
): FairValue {
  return calculateFairValue(currentPrice, strikePrice, secondsRemaining, annualizedVol, false);
}

// =============================================================================
// EDGE CALCULATION
// =============================================================================

/**
 * Calculate edge for a potential trade
 * 
 * @param fairValue - Fair value probability (0-1)
 * @param marketPrice - Market price on Polymarket
 * @returns Edge in probability points (positive = opportunity)
 */
export function calculateEdge(fairValue: number, marketPrice: number): number {
  return fairValue - marketPrice;
}

/**
 * Calculate edge with Kelly sizing suggestion
 */
export function calculateEdgeWithKelly(
  fairValue: number,
  marketPrice: number,
  kellyFraction: number = 0.25  // Quarter Kelly is safer
): { edge: number; kellySizePercent: number } {
  const edge = fairValue - marketPrice;
  
  // Kelly formula for binary bet: f* = (p*b - q) / b
  // where p = win prob, q = lose prob, b = odds
  // For binary at price m: b = (1-m)/m, p = fairValue
  if (edge <= 0 || marketPrice <= 0 || marketPrice >= 1) {
    return { edge, kellySizePercent: 0 };
  }
  
  const b = (1 - marketPrice) / marketPrice;  // Implied odds
  const q = 1 - fairValue;
  const fullKelly = (fairValue * b - q) / b;
  const kellySizePercent = Math.max(0, fullKelly * kellyFraction * 100);
  
  return { edge, kellySizePercent };
}

// =============================================================================
// FORMATTING / LOGGING
// =============================================================================

/**
 * Format fair value for logging
 */
export function formatFairValue(fv: FairValue, currentPrice: number, strikePrice: number): string {
  const pctFromStrike = ((currentPrice - strikePrice) / strikePrice * 100).toFixed(3);
  return `d=${fv.d.toFixed(2)} | σ√τ=${(fv.sigmaT * 100).toFixed(3)}% | P(UP)=${(fv.pUp * 100).toFixed(1)}% | price ${pctFromStrike}% from strike`;
}

/**
 * Compare adjusted vs simple model (for debugging)
 */
export function compareModels(
  currentPrice: number,
  strikePrice: number,
  secondsRemaining: number,
  annualizedVol: number
): string {
  const adjusted = calculateFairValue(currentPrice, strikePrice, secondsRemaining, annualizedVol, true);
  const simple = calculateFairValue(currentPrice, strikePrice, secondsRemaining, annualizedVol, false);
  
  const diff = (adjusted.pUp - simple.pUp) * 100;
  
  return [
    `Simple:   P(UP)=${(simple.pUp * 100).toFixed(2)}% | d=${simple.d.toFixed(3)}`,
    `Adjusted: P(UP)=${(adjusted.pUp * 100).toFixed(2)}% | d=${adjusted.d.toFixed(3)}`,
    `Δ = ${diff > 0 ? '+' : ''}${diff.toFixed(2)}%`,
  ].join('\n');
}
