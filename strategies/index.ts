/**
 * Pricing Strategies - Exports
 *
 * Simplified module exporting Black-Scholes pricing.
 */

export { BlackScholesStrategy, BS_PARAMS } from './black-scholes';
export { FairValue } from './types';

// Singleton instance for convenience
import { BlackScholesStrategy } from './black-scholes';
import { FairValue } from './types';

const bsInstance = new BlackScholesStrategy();

/**
 * Calculate fair value using Black-Scholes
 *
 * @param currentPrice - Current BTC price
 * @param strikePrice - Strike price at start of period
 * @param secondsRemaining - Time until resolution in seconds
 * @param annualizedVol - Annualized volatility (decimal, e.g., 0.60 for 60%)
 * @param applyAdjustments - Whether to apply model adjustments (default: true)
 * @returns FairValue with probabilities and diagnostics
 */
export function calculateFairValue(
  currentPrice: number,
  strikePrice: number,
  secondsRemaining: number,
  annualizedVol: number,
  applyAdjustments: boolean = true
): FairValue {
  return bsInstance.calculateFairValue(
    currentPrice,
    strikePrice,
    secondsRemaining,
    annualizedVol,
    applyAdjustments
  );
}
