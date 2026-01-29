/**
 * Polymarket Historical Prices Fetcher
 * Fetches historical price data via /prices-history API
 * 
 * API: GET https://clob.polymarket.com/prices-history
 * Params:
 *   - market: tokenId
 *   - startTs: Unix timestamp (seconds)
 *   - endTs: Unix timestamp (seconds)
 *   - fidelity: resolution in minutes
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { PolymarketPricePoint, CachedData } from '../types';

const CLOB_API_URL = 'https://clob.polymarket.com';
const DATA_DIR = path.join(__dirname, '../../data/polymarket');

/**
 * Fetch historical prices for a token from Polymarket CLOB API
 * 
 * @param tokenId - The CLOB token ID (YES or NO)
 * @param startTs - Start timestamp in ms
 * @param endTs - End timestamp in ms
 * @param fidelityMinutes - Resolution in minutes (default 1)
 * @param useCache - Whether to use cached data
 */
export async function fetchPolymarketPrices(
  tokenId: string,
  startTs: number,
  endTs: number,
  fidelityMinutes: number = 1,
  useCache: boolean = true
): Promise<PolymarketPricePoint[]> {
  // Check cache first
  if (useCache) {
    const cached = loadFromCache(tokenId, startTs, endTs, fidelityMinutes);
    if (cached) {
      console.log(`📦 Loaded ${cached.length} price points from cache for ${tokenId.slice(0, 10)}...`);
      return cached;
    }
  }

  console.log(`📡 Fetching Polymarket prices for ${tokenId.slice(0, 10)}... from ${new Date(startTs).toISOString()} to ${new Date(endTs).toISOString()}`);

  try {
    const response = await axios.get(`${CLOB_API_URL}/prices-history`, {
      params: {
        market: tokenId,
        startTs: Math.floor(startTs / 1000), // Convert to seconds
        endTs: Math.floor(endTs / 1000),     // Convert to seconds
        fidelity: fidelityMinutes,
      },
      timeout: 30000,
    });

    const history = response.data?.history || [];
    
    const prices: PolymarketPricePoint[] = history.map((h: { t: number; p: number }) => ({
      timestamp: h.t * 1000, // Convert back to ms
      price: h.p,
    }));

    console.log(`✅ Fetched ${prices.length} price points`);

    // Save to cache
    if (useCache && prices.length > 0) {
      saveToCache(tokenId, startTs, endTs, fidelityMinutes, prices);
    }

    return prices;

  } catch (error: any) {
    if (error.response?.status === 404) {
      console.log(`⚠️ No price history found for token ${tokenId.slice(0, 10)}...`);
      return [];
    }
    if (error.response?.status === 400) {
      console.log(`⚠️ Invalid request for token ${tokenId.slice(0, 10)}...`);
      return [];
    }
    throw error;
  }
}

/**
 * Fetch prices for both YES and NO tokens of a market
 */
export async function fetchMarketPrices(
  yesTokenId: string,
  noTokenId: string,
  startTs: number,
  endTs: number,
  fidelityMinutes: number = 1
): Promise<{ yes: PolymarketPricePoint[]; no: PolymarketPricePoint[] }> {
  const [yesPrices, noPrices] = await Promise.all([
    fetchPolymarketPrices(yesTokenId, startTs, endTs, fidelityMinutes),
    fetchPolymarketPrices(noTokenId, startTs, endTs, fidelityMinutes),
  ]);

  return {
    yes: yesPrices,
    no: noPrices,
  };
}

/**
 * Get price at a specific timestamp (finds closest point)
 */
export function getPriceAt(prices: PolymarketPricePoint[], timestamp: number): number | null {
  if (prices.length === 0) return null;

  // Binary search for closest timestamp
  let left = 0;
  let right = prices.length - 1;

  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (prices[mid].timestamp < timestamp) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }

  // Return the closest price
  const idx = Math.max(0, left);
  
  // Check if we're within reasonable range (5 minutes)
  const diff = Math.abs(prices[idx].timestamp - timestamp);
  if (diff > 5 * 60 * 1000) {
    // Too far, check previous point
    if (idx > 0) {
      const prevDiff = Math.abs(prices[idx - 1].timestamp - timestamp);
      if (prevDiff < diff) {
        return prices[idx - 1].price;
      }
    }
  }

  return prices[idx].price;
}

/**
 * Interpolate prices at given timestamps
 */
export function interpolatePrices(
  prices: PolymarketPricePoint[],
  timestamps: number[]
): Map<number, number> {
  const priceMap = new Map<number, number>();
  
  if (prices.length === 0) return priceMap;

  let priceIdx = 0;

  for (const ts of timestamps) {
    // Find the price point before or at this timestamp
    while (priceIdx < prices.length - 1 && prices[priceIdx + 1].timestamp <= ts) {
      priceIdx++;
    }

    // Use the most recent price
    priceMap.set(ts, prices[priceIdx].price);
  }

  return priceMap;
}

/**
 * Calculate mid price from YES prices
 * Note: NO price should be approximately 1 - YES price
 */
export function calculateMidFromYes(yesPrice: number): { yesMid: number; noMid: number } {
  return {
    yesMid: yesPrice,
    noMid: 1 - yesPrice,
  };
}

// =============================================================================
// CACHE MANAGEMENT
// =============================================================================

function getCacheFilename(tokenId: string, startTs: number, endTs: number, fidelity: number): string {
  const shortId = tokenId.slice(0, 16);
  const startDate = new Date(startTs).toISOString().split('T')[0];
  const endDate = new Date(endTs).toISOString().split('T')[0];
  return `prices_${shortId}_${startDate}_${endDate}_f${fidelity}.json`;
}

function loadFromCache(
  tokenId: string,
  startTs: number,
  endTs: number,
  fidelity: number
): PolymarketPricePoint[] | null {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    const shortId = tokenId.slice(0, 16);

    // First try exact match
    const filename = getCacheFilename(tokenId, startTs, endTs, fidelity);
    const filepath = path.join(DATA_DIR, filename);

    if (fs.existsSync(filepath)) {
      const content = fs.readFileSync(filepath, 'utf-8');
      const cached: CachedData<PolymarketPricePoint> = JSON.parse(content);
      if (cached.metadata.startTs <= startTs && cached.metadata.endTs >= endTs) {
        return cached.data.filter(p => p.timestamp >= startTs && p.timestamp <= endTs);
      }
    }

    // Try to find any cache file that covers our range for this token
    const files = fs.readdirSync(DATA_DIR).filter(f => 
      f.startsWith(`prices_${shortId}_`) && f.includes(`_f${fidelity}`) && f.endsWith('.json')
    );

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(DATA_DIR, file), 'utf-8');
        const cached: CachedData<PolymarketPricePoint> = JSON.parse(content);
        
        // Check if tokenId matches and covers our range
        if (cached.metadata.tokenId === tokenId && 
            cached.metadata.startTs <= startTs && 
            cached.metadata.endTs >= endTs) {
          return cached.data.filter(p => p.timestamp >= startTs && p.timestamp <= endTs);
        }
      } catch {
        // Skip corrupted files
      }
    }

    // Try to merge multiple cache files for partial coverage
    const allPoints: Map<number, PolymarketPricePoint> = new Map();
    let coverageStart = Infinity;
    let coverageEnd = 0;

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(DATA_DIR, file), 'utf-8');
        const cached: CachedData<PolymarketPricePoint> = JSON.parse(content);
        
        if (cached.metadata.tokenId === tokenId &&
            cached.metadata.endTs >= startTs && 
            cached.metadata.startTs <= endTs) {
          for (const p of cached.data) {
            if (p.timestamp >= startTs && p.timestamp <= endTs) {
              allPoints.set(p.timestamp, p);
            }
          }
          coverageStart = Math.min(coverageStart, cached.metadata.startTs);
          coverageEnd = Math.max(coverageEnd, cached.metadata.endTs);
        }
      } catch {
        // Skip corrupted files
      }
    }

    if (coverageStart <= startTs && coverageEnd >= endTs && allPoints.size > 0) {
      const result = Array.from(allPoints.values()).sort((a, b) => a.timestamp - b.timestamp);
      return result;
    }

    return null;
  } catch {
    return null;
  }
}

function saveToCache(
  tokenId: string,
  startTs: number,
  endTs: number,
  fidelity: number,
  data: PolymarketPricePoint[]
): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    const filename = getCacheFilename(tokenId, startTs, endTs, fidelity);
    const filepath = path.join(DATA_DIR, filename);

    const cached: CachedData<PolymarketPricePoint> = {
      metadata: {
        source: 'polymarket',
        startTs,
        endTs,
        tokenId,
        fetchedAt: Date.now(),
      },
      data,
    };

    fs.writeFileSync(filepath, JSON.stringify(cached, null, 2));
    console.log(`💾 Cached prices to ${filename}`);
  } catch (err: any) {
    console.log(`⚠️ Failed to cache: ${err.message}`);
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

export class PolymarketPricesFetcher {
  private yesPrices: PolymarketPricePoint[] = [];
  private noPrices: PolymarketPricePoint[] = [];
  private fidelity: number;

  constructor(fidelityMinutes: number = 1) {
    this.fidelity = fidelityMinutes;
  }

  /**
   * Fetch prices for a market's YES and NO tokens
   */
  async fetch(
    yesTokenId: string,
    noTokenId: string,
    startTs: number,
    endTs: number
  ): Promise<{ yes: PolymarketPricePoint[]; no: PolymarketPricePoint[] }> {
    const result = await fetchMarketPrices(
      yesTokenId,
      noTokenId,
      startTs,
      endTs,
      this.fidelity
    );
    
    this.yesPrices = result.yes;
    this.noPrices = result.no;
    
    return result;
  }

  /**
   * Fetch prices for just the YES token (NO is derived)
   */
  async fetchYesOnly(
    yesTokenId: string,
    startTs: number,
    endTs: number
  ): Promise<PolymarketPricePoint[]> {
    this.yesPrices = await fetchPolymarketPrices(
      yesTokenId,
      startTs,
      endTs,
      this.fidelity
    );
    
    // Derive NO prices
    this.noPrices = this.yesPrices.map(p => ({
      timestamp: p.timestamp,
      price: 1 - p.price,
    }));
    
    return this.yesPrices;
  }

  getYesPriceAt(timestamp: number): number | null {
    return getPriceAt(this.yesPrices, timestamp);
  }

  getNoPriceAt(timestamp: number): number | null {
    return getPriceAt(this.noPrices, timestamp);
  }

  getMidPriceAt(timestamp: number): { yesMid: number; noMid: number } | null {
    const yesPrice = this.getYesPriceAt(timestamp);
    if (yesPrice === null) return null;
    return calculateMidFromYes(yesPrice);
  }

  getYesPrices(): PolymarketPricePoint[] {
    return this.yesPrices;
  }

  getNoPrices(): PolymarketPricePoint[] {
    return this.noPrices;
  }
}

