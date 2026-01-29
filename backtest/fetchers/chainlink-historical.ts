/**
 * Chainlink Historical Price Fetcher
 * Fetches BTC/USD prices from Chainlink oracle on Polygon
 *
 * IMPORTANT: Requires an archive node RPC to query historical rounds.
 * Set ARCHIVE_RPC_URL environment variable (Alchemy, Ankr, or QuickNode recommended).
 */

import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import { CachedData } from '../types';

// =============================================================================
// CONSTANTS
// =============================================================================

// Chainlink BTC/USD Price Feed on Polygon
const CHAINLINK_BTC_USD_POLYGON = "0xc907E116054Ad103354f2D350FD2514433D57F6f";

// ABI for Chainlink Aggregator V3
const CHAINLINK_ABI = [
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function getRoundData(uint80 _roundId) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
];

const DATA_DIR = path.join(__dirname, '../../data/chainlink');

// Retry configuration
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;

// Rate limiting
const DELAY_BETWEEN_CALLS_MS = 50;

// =============================================================================
// TYPES
// =============================================================================

/**
 * Price point from Chainlink oracle
 */
export interface ChainlinkPricePoint {
  roundId: string;      // uint80 as string (BigInt safe)
  price: number;        // USD price (already divided by 10^8)
  timestamp: number;    // Unix ms
  blockNumber?: number; // Optional: block where this round was answered
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get RPC URL with archive node preference
 */
function getRpcUrl(): string {
  const archiveUrl = process.env.ARCHIVE_RPC_URL;
  const rpcUrl = process.env.RPC_URL;

  if (archiveUrl) {
    return archiveUrl;
  }

  if (rpcUrl) {
    console.log('⚠️ Using RPC_URL (may not support historical queries). Set ARCHIVE_RPC_URL for reliable historical data.');
    return rpcUrl;
  }

  throw new Error(
    'No RPC URL configured. Set ARCHIVE_RPC_URL (recommended) or RPC_URL environment variable.\n' +
    'Historical Chainlink queries require an archive node (Alchemy, Ankr, or QuickNode).'
  );
}

/**
 * Retry wrapper with exponential backoff
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  context: string,
  maxRetries: number = MAX_RETRIES
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;

      // Check if it's a revert (invalid round) - don't retry these
      if (error.message?.includes('revert') || error.code === 'CALL_EXCEPTION') {
        throw error;
      }

      if (attempt < maxRetries) {
        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        console.log(`⚠️ ${context} failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }

  throw new Error(`${context} failed after ${maxRetries} attempts: ${lastError?.message}`);
}

// =============================================================================
// CACHE MANAGEMENT
// =============================================================================

function getCacheFilename(startTime: number, endTime: number): string {
  const startDate = new Date(startTime).toISOString().split('T')[0];
  const endDate = new Date(endTime).toISOString().split('T')[0];
  return `chainlink_BTC_${startDate}_${endDate}.json`;
}

// Normalize timestamp to start of day (for cache comparison)
function toDayStart(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// Normalize timestamp to end of day
function toDayEnd(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
}

function loadFromCache(startTime: number, endTime: number): ChainlinkPricePoint[] | null {
  try {
    // Ensure data directory exists
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    // Normalize to day boundaries for comparison
    const requestStartDay = toDayStart(startTime);
    const requestEndDay = toDayEnd(endTime);

    // First try exact match
    const filename = getCacheFilename(startTime, endTime);
    const filepath = path.join(DATA_DIR, filename);

    if (fs.existsSync(filepath)) {
      const content = fs.readFileSync(filepath, 'utf-8');
      const cached: CachedData<ChainlinkPricePoint> = JSON.parse(content);
      const cacheStartDay = toDayStart(cached.metadata.startTs);
      const cacheEndDay = toDayEnd(cached.metadata.endTs);

      if (cacheStartDay <= requestStartDay && cacheEndDay >= requestEndDay) {
        console.log(`📦 Chainlink Cache HIT (exact): ${filename}`);
        return cached.data.filter(p => p.timestamp >= startTime && p.timestamp <= endTime);
      }
    }

    // Try to find any cache file that covers our range
    const files = fs.readdirSync(DATA_DIR).filter(f =>
      f.startsWith('chainlink_BTC_') && f.endsWith('.json')
    );

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(DATA_DIR, file), 'utf-8');
        const cached: CachedData<ChainlinkPricePoint> = JSON.parse(content);
        const cacheStartDay = toDayStart(cached.metadata.startTs);
        const cacheEndDay = toDayEnd(cached.metadata.endTs);

        if (cacheStartDay <= requestStartDay && cacheEndDay >= requestEndDay) {
          console.log(`📦 Chainlink Cache HIT (overlap): ${file}`);
          return cached.data.filter(p => p.timestamp >= startTime && p.timestamp <= endTime);
        }
      } catch {
        // Skip corrupted files
      }
    }

    // Try to merge multiple cache files for partial coverage
    const allPoints: Map<string, ChainlinkPricePoint> = new Map();
    let coverageStartDay = Infinity;
    let coverageEndDay = 0;

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(DATA_DIR, file), 'utf-8');
        const cached: CachedData<ChainlinkPricePoint> = JSON.parse(content);
        const cacheStartDay = toDayStart(cached.metadata.startTs);
        const cacheEndDay = toDayEnd(cached.metadata.endTs);

        // Check if there's any overlap with our range
        if (cacheEndDay >= requestStartDay && cacheStartDay <= requestEndDay) {
          for (const p of cached.data) {
            if (p.timestamp >= startTime && p.timestamp <= endTime) {
              allPoints.set(p.roundId, p);
            }
          }
          coverageStartDay = Math.min(coverageStartDay, cacheStartDay);
          coverageEndDay = Math.max(coverageEndDay, cacheEndDay);
        }
      } catch {
        // Skip corrupted files
      }
    }

    // Check if merged data covers our full range
    if (coverageStartDay <= requestStartDay && coverageEndDay >= requestEndDay && allPoints.size > 0) {
      const result = Array.from(allPoints.values()).sort((a, b) => a.timestamp - b.timestamp);
      console.log(`📦 Chainlink Cache HIT (merged from ${files.length} files): ${result.length} price points`);
      return result;
    }

    return null;
  } catch {
    return null;
  }
}

function saveToCache(startTime: number, endTime: number, data: ChainlinkPricePoint[]): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    const filename = getCacheFilename(startTime, endTime);
    const filepath = path.join(DATA_DIR, filename);

    const cached: CachedData<ChainlinkPricePoint> = {
      metadata: {
        source: 'chainlink' as any, // Type will be extended in types.ts
        startTs: startTime,
        endTs: endTime,
        symbol: 'BTC/USD',
        fetchedAt: Date.now(),
      },
      data,
    };

    fs.writeFileSync(filepath, JSON.stringify(cached, null, 2));
    console.log(`💾 Cached ${data.length} Chainlink prices to ${filename}`);
  } catch (err: any) {
    console.log(`⚠️ Failed to cache: ${err.message}`);
  }
}

// =============================================================================
// MAIN FETCH FUNCTION
// =============================================================================

/**
 * Fetch historical Chainlink BTC/USD prices
 *
 * @param startTime - Start timestamp in Unix ms
 * @param endTime - End timestamp in Unix ms
 * @param useCache - Whether to use cached data (default: true)
 * @returns Array of price points sorted by timestamp ascending
 */
export async function fetchChainlinkPrices(
  startTime: number,
  endTime: number,
  useCache: boolean = true
): Promise<ChainlinkPricePoint[]> {
  // Check cache first
  if (useCache) {
    const cached = loadFromCache(startTime, endTime);
    if (cached) {
      console.log(`📦 Loaded ${cached.length} Chainlink prices from cache`);
      return cached;
    }
  }

  console.log(`📡 Fetching Chainlink prices from ${new Date(startTime).toISOString()} to ${new Date(endTime).toISOString()}`);

  const rpcUrl = getRpcUrl();
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const contract = new ethers.Contract(CHAINLINK_BTC_USD_POLYGON, CHAINLINK_ABI, provider);

  // Get decimals (should be 8 for BTC/USD)
  const decimals = await withRetry(
    () => contract.decimals(),
    'Fetching decimals'
  );
  const divisor = Math.pow(10, decimals);

  // Get latest round to start iteration
  const latestRound = await withRetry(
    () => contract.latestRoundData(),
    'Fetching latest round'
  );

  let currentRoundId = latestRound.roundId;
  const latestTimestamp = latestRound.updatedAt.toNumber() * 1000;

  console.log(`   Latest round: ${currentRoundId.toString()} at ${new Date(latestTimestamp).toISOString()}`);

  // If latest round is before our end time, we can only get data up to latest
  if (latestTimestamp < startTime) {
    console.log(`⚠️ Latest Chainlink data (${new Date(latestTimestamp).toISOString()}) is before requested start time`);
    return [];
  }

  const prices: ChainlinkPricePoint[] = [];
  let roundsFetched = 0;
  let consecutiveErrors = 0;
  const maxConsecutiveErrors = 50; // Stop if we hit too many invalid rounds in a row

  // Work backwards from latest round
  while (consecutiveErrors < maxConsecutiveErrors) {
    try {
      const roundData = await withRetry(
        () => contract.getRoundData(currentRoundId),
        `Fetching round ${currentRoundId.toString()}`
      );

      const timestamp = roundData.updatedAt.toNumber() * 1000;
      const price = parseFloat(ethers.utils.formatUnits(roundData.answer, decimals));

      // Stop if we've gone past our start time
      if (timestamp < startTime) {
        console.log(`   Reached start time at round ${currentRoundId.toString()}`);
        break;
      }

      // Only include rounds within our time range
      if (timestamp <= endTime && timestamp >= startTime && price > 0) {
        prices.push({
          roundId: roundData.roundId.toString(),
          price,
          timestamp,
        });
      }

      roundsFetched++;
      consecutiveErrors = 0; // Reset error counter on success

      // Progress logging
      if (roundsFetched % 100 === 0) {
        console.log(`   Fetched ${roundsFetched} rounds... (at ${new Date(timestamp).toISOString()})`);
      }

      // Rate limiting
      await sleep(DELAY_BETWEEN_CALLS_MS);

    } catch (error: any) {
      // Check if it's a revert (invalid round) - this is expected for gaps
      if (error.message?.includes('revert') || error.code === 'CALL_EXCEPTION') {
        consecutiveErrors++;
        // Don't log every invalid round, just count them
      } else {
        // Unexpected error - log it but continue
        console.log(`⚠️ Error at round ${currentRoundId.toString()}: ${error.message?.slice(0, 50)}`);
        consecutiveErrors++;
      }
    }

    // Move to previous round
    // Chainlink roundIds are not always sequential, but decrementing usually works
    currentRoundId = currentRoundId.sub(1);

    // Safety check: don't go below 0
    if (currentRoundId.lte(0)) {
      console.log(`   Reached round 0`);
      break;
    }
  }

  if (consecutiveErrors >= maxConsecutiveErrors) {
    console.log(`⚠️ Stopped after ${maxConsecutiveErrors} consecutive invalid rounds`);
  }

  // Sort by timestamp ascending
  prices.sort((a, b) => a.timestamp - b.timestamp);

  console.log(`✅ Fetched ${prices.length} Chainlink price points (${roundsFetched} rounds checked)`);

  // Save to cache
  if (useCache && prices.length > 0) {
    saveToCache(startTime, endTime, prices);
  }

  return prices;
}

// =============================================================================
// HELPER FUNCTIONS FOR BACKTEST
// =============================================================================

/**
 * Get the Chainlink price at or just before a target timestamp
 * Uses binary search for efficiency
 *
 * @param prices - Array of price points (must be sorted by timestamp ascending)
 * @param targetTime - Target timestamp in Unix ms
 * @returns The most recent price point at or before targetTime, or null if none found
 */
export function getChainlinkPriceAt(
  prices: ChainlinkPricePoint[],
  targetTime: number
): ChainlinkPricePoint | null {
  if (prices.length === 0) return null;

  // If target is before all prices, return null
  if (targetTime < prices[0].timestamp) return null;

  // If target is after all prices, return the last one
  if (targetTime >= prices[prices.length - 1].timestamp) {
    return prices[prices.length - 1];
  }

  // Binary search for the price at or just before targetTime
  let left = 0;
  let right = prices.length - 1;

  while (left < right) {
    const mid = Math.floor((left + right + 1) / 2);
    if (prices[mid].timestamp <= targetTime) {
      left = mid;
    } else {
      right = mid - 1;
    }
  }

  return prices[left];
}

/**
 * Get just the price value at a target timestamp
 * Convenience wrapper around getChainlinkPriceAt
 */
export function getChainlinkPriceValueAt(
  prices: ChainlinkPricePoint[],
  targetTime: number
): number | null {
  const point = getChainlinkPriceAt(prices, targetTime);
  return point ? point.price : null;
}

/**
 * Interpolate Chainlink prices at given timestamps
 * Returns a map of timestamp -> price
 */
export function interpolateChainlinkPrices(
  prices: ChainlinkPricePoint[],
  timestamps: number[]
): Map<number, number> {
  const priceMap = new Map<number, number>();

  if (prices.length === 0) return priceMap;

  let priceIdx = 0;

  for (const ts of timestamps) {
    // Find the price point at or just before this timestamp
    while (priceIdx < prices.length - 1 && prices[priceIdx + 1].timestamp <= ts) {
      priceIdx++;
    }

    // Only set if we have a valid price at or before this timestamp
    if (prices[priceIdx].timestamp <= ts) {
      priceMap.set(ts, prices[priceIdx].price);
    }
  }

  return priceMap;
}

// =============================================================================
// CLASS WRAPPER (for consistency with other fetchers)
// =============================================================================

export class ChainlinkHistoricalFetcher {
  private cache: ChainlinkPricePoint[] = [];

  async fetch(startTime: number, endTime: number): Promise<ChainlinkPricePoint[]> {
    this.cache = await fetchChainlinkPrices(startTime, endTime);
    return this.cache;
  }

  getPriceAt(timestamp: number): number | null {
    return getChainlinkPriceValueAt(this.cache, timestamp);
  }

  getPricePointAt(timestamp: number): ChainlinkPricePoint | null {
    return getChainlinkPriceAt(this.cache, timestamp);
  }

  getPrices(): ChainlinkPricePoint[] {
    return this.cache;
  }

  /**
   * Get the price closest to a specific timestamp (for market resolution)
   * This is useful for determining the exact Chainlink price at market end
   */
  getClosestPrice(targetTime: number, maxDeltaMs: number = 60000): ChainlinkPricePoint | null {
    if (this.cache.length === 0) return null;

    const point = getChainlinkPriceAt(this.cache, targetTime);
    if (!point) return null;

    // Check if the price is within acceptable time delta
    const delta = targetTime - point.timestamp;
    if (delta > maxDeltaMs) {
      console.log(`⚠️ Chainlink price at ${new Date(point.timestamp).toISOString()} is ${(delta / 1000).toFixed(0)}s before target`);
    }

    return point;
  }
}
