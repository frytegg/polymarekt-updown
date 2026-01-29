/**
 * Deribit Historical Volatility Fetcher
 * Fetches DVOL (Deribit Volatility Index) historical data
 * 
 * API: GET https://www.deribit.com/api/v2/public/get_volatility_index_data
 * Params:
 *   - currency: BTC or ETH
 *   - start_timestamp: Unix ms
 *   - end_timestamp: Unix ms
 *   - resolution: 1, 60, 3600, 43200, 1D
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { DeribitVolPoint, CachedData } from '../types';

const DERIBIT_API = 'https://www.deribit.com/api/v2/public';
const DATA_DIR = path.join(__dirname, '../../data/deribit');

// Deribit resolution options (in seconds, or '1D' for daily)
export type DeribitResolution = 1 | 60 | 3600 | 43200 | '1D';

/**
 * Fetch historical DVOL data from Deribit
 * 
 * @param currency - Currency (BTC or ETH)
 * @param startTs - Start timestamp in ms
 * @param endTs - End timestamp in ms
 * @param resolution - Data resolution (default 60 = 1 minute)
 * @param useCache - Whether to use cached data
 */
export async function fetchDeribitVolatility(
  currency: 'BTC' | 'ETH' = 'BTC',
  startTs: number,
  endTs: number,
  resolution: DeribitResolution = 60,
  useCache: boolean = true
): Promise<DeribitVolPoint[]> {
  // Check cache first
  if (useCache) {
    const cached = loadFromCache(currency, startTs, endTs, resolution);
    if (cached) {
      console.log(`📦 Loaded ${cached.length} DVOL points from cache`);
      return cached;
    }
  }

  console.log(`📡 Fetching Deribit DVOL for ${currency} from ${new Date(startTs).toISOString()} to ${new Date(endTs).toISOString()}`);

  const allPoints: DeribitVolPoint[] = [];
  let currentStart = startTs;
  
  // Deribit limits results, so we may need to paginate
  const maxPointsPerRequest = 10000;
  const resolutionMs = typeof resolution === 'number' ? resolution * 1000 : 86400000;

  while (currentStart < endTs) {
    try {
      const response = await axios.get(`${DERIBIT_API}/get_volatility_index_data`, {
        params: {
          currency,
          start_timestamp: currentStart,
          end_timestamp: endTs,
          resolution: typeof resolution === 'number' ? resolution : resolution,
        },
        timeout: 30000,
      });

      const result = response.data?.result;
      if (!result || !result.data || result.data.length === 0) {
        break;
      }

      // Result format: { data: [[timestamp, open, high, low, close], ...] }
      for (const point of result.data) {
        const [timestamp, open, high, low, close] = point;
        
        // Use close price as the DVOL value
        // DVOL is in percentage (e.g., 48.5 for 48.5%)
        allPoints.push({
          timestamp,
          vol: close / 100, // Convert to decimal (0.485)
        });
      }

      // Move to next batch
      const lastTimestamp = result.data[result.data.length - 1][0];
      currentStart = lastTimestamp + resolutionMs;

      // Rate limiting
      await sleep(200);

      // Progress log
      if (allPoints.length % 5000 === 0) {
        console.log(`   Fetched ${allPoints.length} DVOL points...`);
      }

    } catch (error: any) {
      if (error.response?.status === 429) {
        console.log('⚠️ Rate limited, waiting 10s...');
        await sleep(10000);
        continue;
      }
      console.log(`⚠️ Deribit API error: ${error.message}`);
      break;
    }
  }

  console.log(`✅ Fetched ${allPoints.length} total DVOL points`);

  // Save to cache
  if (useCache && allPoints.length > 0) {
    saveToCache(currency, startTs, endTs, resolution, allPoints);
  }

  return allPoints;
}

/**
 * Get volatility at a specific timestamp (finds closest point)
 */
export function getVolAt(volPoints: DeribitVolPoint[], timestamp: number): number {
  if (volPoints.length === 0) {
    return 0.50; // Default 50% vol
  }

  // Binary search for closest timestamp
  let left = 0;
  let right = volPoints.length - 1;

  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (volPoints[mid].timestamp < timestamp) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }

  // Return the closest vol
  const idx = Math.max(0, left);
  return volPoints[idx].vol;
}

/**
 * Interpolate volatility values for given timestamps
 */
export function interpolateVol(
  volPoints: DeribitVolPoint[],
  timestamps: number[]
): Map<number, number> {
  const volMap = new Map<number, number>();
  
  if (volPoints.length === 0) {
    // Return default vol for all timestamps
    for (const ts of timestamps) {
      volMap.set(ts, 0.50);
    }
    return volMap;
  }

  let volIdx = 0;

  for (const ts of timestamps) {
    // Find the vol point before or at this timestamp
    while (volIdx < volPoints.length - 1 && volPoints[volIdx + 1].timestamp <= ts) {
      volIdx++;
    }

    volMap.set(ts, volPoints[volIdx].vol);
  }

  return volMap;
}

/**
 * Calculate average volatility over a period
 */
export function averageVol(volPoints: DeribitVolPoint[], startTs: number, endTs: number): number {
  const relevant = volPoints.filter(p => p.timestamp >= startTs && p.timestamp <= endTs);
  
  if (relevant.length === 0) return 0.50;
  
  const sum = relevant.reduce((acc, p) => acc + p.vol, 0);
  return sum / relevant.length;
}

// =============================================================================
// CACHE MANAGEMENT
// =============================================================================

function getCacheFilename(
  currency: string,
  startTs: number,
  endTs: number,
  resolution: DeribitResolution
): string {
  const startDate = new Date(startTs).toISOString().split('T')[0];
  const endDate = new Date(endTs).toISOString().split('T')[0];
  return `dvol_${currency}_${startDate}_${endDate}_r${resolution}.json`;
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

function loadFromCache(
  currency: string,
  startTs: number,
  endTs: number,
  resolution: DeribitResolution
): DeribitVolPoint[] | null {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    // Normalize to day boundaries for comparison
    const requestStartDay = toDayStart(startTs);
    const requestEndDay = toDayEnd(endTs);

    // First try exact match
    const filename = getCacheFilename(currency, startTs, endTs, resolution);
    const filepath = path.join(DATA_DIR, filename);

    if (fs.existsSync(filepath)) {
      const content = fs.readFileSync(filepath, 'utf-8');
      const cached: CachedData<DeribitVolPoint> = JSON.parse(content);
      const cacheStartDay = toDayStart(cached.metadata.startTs);
      const cacheEndDay = toDayEnd(cached.metadata.endTs);
      
      if (cacheStartDay <= requestStartDay && cacheEndDay >= requestEndDay) {
        console.log(`📦 DVOL Cache HIT (exact): ${filename}`);
        return cached.data.filter(p => p.timestamp >= startTs && p.timestamp <= endTs);
      }
    }

    // Try to find any cache file that covers our range
    const files = fs.readdirSync(DATA_DIR).filter(f => 
      f.startsWith(`dvol_${currency}_`) && f.includes(`_r${resolution}`) && f.endsWith('.json')
    );

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(DATA_DIR, file), 'utf-8');
        const cached: CachedData<DeribitVolPoint> = JSON.parse(content);
        const cacheStartDay = toDayStart(cached.metadata.startTs);
        const cacheEndDay = toDayEnd(cached.metadata.endTs);
        
        if (cacheStartDay <= requestStartDay && cacheEndDay >= requestEndDay) {
          console.log(`📦 DVOL Cache HIT (overlap): ${file}`);
          return cached.data.filter(p => p.timestamp >= startTs && p.timestamp <= endTs);
        }
      } catch {
        // Skip corrupted files
      }
    }

    // Try to merge multiple cache files for partial coverage
    const allPoints: Map<number, DeribitVolPoint> = new Map();
    let coverageStartDay = Infinity;
    let coverageEndDay = 0;

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(DATA_DIR, file), 'utf-8');
        const cached: CachedData<DeribitVolPoint> = JSON.parse(content);
        const cacheStartDay = toDayStart(cached.metadata.startTs);
        const cacheEndDay = toDayEnd(cached.metadata.endTs);
        
        if (cacheEndDay >= requestStartDay && cacheStartDay <= requestEndDay) {
          for (const p of cached.data) {
            if (p.timestamp >= startTs && p.timestamp <= endTs) {
              allPoints.set(p.timestamp, p);
            }
          }
          coverageStartDay = Math.min(coverageStartDay, cacheStartDay);
          coverageEndDay = Math.max(coverageEndDay, cacheEndDay);
        }
      } catch {
        // Skip corrupted files
      }
    }

    if (coverageStartDay <= requestStartDay && coverageEndDay >= requestEndDay && allPoints.size > 0) {
      const result = Array.from(allPoints.values()).sort((a, b) => a.timestamp - b.timestamp);
      console.log(`📦 DVOL Cache HIT (merged): ${result.length} points`);
      return result;
    }

    return null;
  } catch {
    return null;
  }
}

function saveToCache(
  currency: string,
  startTs: number,
  endTs: number,
  resolution: DeribitResolution,
  data: DeribitVolPoint[]
): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    const filename = getCacheFilename(currency, startTs, endTs, resolution);
    const filepath = path.join(DATA_DIR, filename);

    const cached: CachedData<DeribitVolPoint> = {
      metadata: {
        source: 'deribit',
        startTs,
        endTs,
        symbol: currency,
        fetchedAt: Date.now(),
      },
      data,
    };

    fs.writeFileSync(filepath, JSON.stringify(cached, null, 2));
    console.log(`💾 Cached DVOL to ${filename}`);
  } catch (err: any) {
    console.log(`⚠️ Failed to cache: ${err.message}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =============================================================================
// EXPORTS
// =============================================================================

export class DeribitVolFetcher {
  private cache: DeribitVolPoint[] = [];
  private currency: 'BTC' | 'ETH';
  private resolution: DeribitResolution;

  constructor(currency: 'BTC' | 'ETH' = 'BTC', resolution: DeribitResolution = 60) {
    this.currency = currency;
    this.resolution = resolution;
  }

  async fetch(startTs: number, endTs: number): Promise<DeribitVolPoint[]> {
    this.cache = await fetchDeribitVolatility(
      this.currency,
      startTs,
      endTs,
      this.resolution
    );
    return this.cache;
  }

  getVolAt(timestamp: number): number {
    return getVolAt(this.cache, timestamp);
  }

  getAverageVol(startTs: number, endTs: number): number {
    return averageVol(this.cache, startTs, endTs);
  }

  getVolPoints(): DeribitVolPoint[] {
    return this.cache;
  }
}




