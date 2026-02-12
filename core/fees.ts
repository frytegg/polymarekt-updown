/**
 * Polymarket Fee Calculator
 * Shared between live trade persistence and backtest order matching.
 * Pure function — no side effects.
 */

/**
 * Calculate Polymarket taker fee for 15-min crypto markets
 *
 * Fee formula: shares × price × 0.25 × (price × (1 - price))²
 *
 * Typical rates:
 * - 1.56% @ 50¢
 * - 1.10% @ 30¢
 * - 0.64% @ 80¢
 *
 * @param shares - Number of shares
 * @param price - Price per share (0-1)
 * @returns Fee in USD
 */
export function calculatePolymarketFee(shares: number, price: number): number {
  const feeMultiplier = 0.25 * Math.pow(price * (1 - price), 2);
  return shares * price * feeMultiplier;
}
