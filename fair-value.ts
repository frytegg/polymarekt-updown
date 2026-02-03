/**
 * Crypto Pricer Arb - Fair Value Calculator
 *
 * BACKWARD COMPATIBILITY SHIM
 *
 * This file re-exports from the new strategies module for backward compatibility.
 * New code should import directly from './strategies' instead.
 *
 * @deprecated Import from './strategies' for new code
 */

// Re-export main function and types
export { calculateFairValue, FairValue } from './strategies';

// Re-export BS params as MODEL_PARAMS for backward compatibility
export { BS_PARAMS as MODEL_PARAMS } from './strategies/black-scholes';

// =============================================================================
// LEGACY EXPORTS (for existing code that imports specific functions)
// =============================================================================

import { calculateFairValue as calcFV, FairValue, BS_PARAMS } from './strategies';

/**
 * Simple fair value without adjustments (for comparison/debugging)
 * @deprecated Use calculateFairValue with applyAdjustments=false
 */
export function calculateFairValueSimple(
  currentPrice: number,
  strikePrice: number,
  secondsRemaining: number,
  annualizedVol: number
): FairValue {
  return calcFV(currentPrice, strikePrice, secondsRemaining, annualizedVol, false);
}

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

/**
 * Format fair value for logging
 */
export function formatFairValue(fv: FairValue, currentPrice: number, strikePrice: number): string {
  const pctFromStrike = ((currentPrice - strikePrice) / strikePrice * 100).toFixed(3);
  const dStr = fv.d !== undefined ? fv.d.toFixed(2) : 'N/A';
  const sigmaTStr = fv.sigmaT !== undefined ? (fv.sigmaT * 100).toFixed(3) : 'N/A';
  return `d=${dStr} | σ√τ=${sigmaTStr}% | P(UP)=${(fv.pUp * 100).toFixed(1)}% | price ${pctFromStrike}% from strike`;
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
  const adjusted = calcFV(currentPrice, strikePrice, secondsRemaining, annualizedVol, true);
  const simple = calcFV(currentPrice, strikePrice, secondsRemaining, annualizedVol, false);

  const diff = (adjusted.pUp - simple.pUp) * 100;

  const adjD = adjusted.d !== undefined ? adjusted.d.toFixed(3) : 'N/A';
  const simD = simple.d !== undefined ? simple.d.toFixed(3) : 'N/A';

  return [
    `Simple:   P(UP)=${(simple.pUp * 100).toFixed(2)}% | d=${simD}`,
    `Adjusted: P(UP)=${(adjusted.pUp * 100).toFixed(2)}% | d=${adjD}`,
    `Δ = ${diff > 0 ? '+' : ''}${diff.toFixed(2)}%`,
  ].join('\n');
}
