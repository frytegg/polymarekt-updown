/**
 * Core Volatility Calculator
 * Shared between live trading and backtest.
 * Pure functions — no side effects, no state, no I/O.
 */

/**
 * Calculate log returns from an array of close prices
 * @param closes - Array of close prices
 * @returns Array of log returns (length = closes.length - 1)
 */
export function calculateLogReturns(closes: number[]): number[] {
  if (closes.length < 2) return [];

  const logReturns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const logReturn = Math.log(closes[i] / closes[i - 1]);
    logReturns.push(logReturn);
  }

  return logReturns;
}

/**
 * Calculate realized volatility from close prices
 * @param closes - Array of close prices (e.g., from klines)
 * @param intervalMinutes - Candle interval in minutes (e.g., 1 for 1-min candles)
 * @returns Annualized volatility as decimal (e.g., 0.50 for 50%)
 */
export function calculateRealizedVol(
  closes: number[],
  intervalMinutes: number
): number {
  if (closes.length < 2) return 0;

  // Calculate log returns
  const logReturns = calculateLogReturns(closes);

  if (logReturns.length < 2) return 0;

  // Standard deviation of log returns
  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance =
    logReturns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) /
    (logReturns.length - 1);
  const stdDev = Math.sqrt(variance);

  // Annualize
  return annualizeVolatility(stdDev, intervalMinutes);
}

/**
 * Annualize volatility given standard deviation and interval
 * @param stdDev - Standard deviation of log returns
 * @param intervalMinutes - Candle interval in minutes
 * @returns Annualized volatility as decimal
 */
export function annualizeVolatility(
  stdDev: number,
  intervalMinutes: number
): number {
  // Minutes per year = 365 * 24 * 60 = 525,600
  const minutesPerYear = 525600;
  const periodsPerYear = minutesPerYear / intervalMinutes;
  return stdDev * Math.sqrt(periodsPerYear);
}
