/**
 * Binance Historical Data Fetcher
 * Fetches BTC klines (candlestick data) from Binance API
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { BinanceKline, CachedData } from '../types';

const BINANCE_API = 'https://api.binance.com/api/v3';
const DATA_DIR = path.join(__dirname, '../../data/binance');

// Binance kline intervals
export type KlineInterval = '1s' | '1m' | '3m' | '5m' | '15m' | '1h' | '4h' | '1d';

/**
 * Fetch historical klines from Binance
 * 
 * @param symbol - Trading pair (e.g., 'BTCUSDT')
 * @param interval - Kline interval
 * @param startTime - Start time in ms
 * @param endTime - End time in ms
 * @param useCache - Whether to use cached data
 */
export async function fetchBinanceKlines(
  symbol: string = 'BTCUSDT',
  interval: KlineInterval = '1m',
  startTime: number,
  endTime: number,
  useCache: boolean = true
): Promise<BinanceKline[]> {
  // Check cache first
  if (useCache) {
    const cached = loadFromCache(symbol, interval, startTime, endTime);
    if (cached) {
      console.log(`📦 Loaded ${cached.length} klines from cache`);
      return cached;
    }
  }

  console.log(`📡 Fetching Binance klines: ${symbol} ${interval} from ${new Date(startTime).toISOString()} to ${new Date(endTime).toISOString()}`);

  const allKlines: BinanceKline[] = [];
  let currentStart = startTime;
  const maxLimit = 1000; // Binance max per request

  while (currentStart < endTime) {
    try {
      const response = await axios.get(`${BINANCE_API}/klines`, {
        params: {
          symbol,
          interval,
          startTime: currentStart,
          endTime,
          limit: maxLimit,
        },
        timeout: 10000,
      });

      const klines = response.data as any[][];
      
      if (klines.length === 0) break;

      for (const k of klines) {
        // Binance kline format: [openTime, open, high, low, close, volume, closeTime, ...]
        allKlines.push({
          timestamp: k[0] as number,
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
        });
      }

      // Move to next batch
      const lastTimestamp = klines[klines.length - 1][0] as number;
      currentStart = lastTimestamp + 1;

      // Rate limiting
      await sleep(100);

      // Progress log
      if (allKlines.length % 5000 === 0) {
        console.log(`   Fetched ${allKlines.length} klines...`);
      }

    } catch (error: any) {
      if (error.response?.status === 429) {
        console.log('⚠️ Rate limited, waiting 60s...');
        await sleep(60000);
        continue;
      }
      throw error;
    }
  }

  console.log(`✅ Fetched ${allKlines.length} total klines`);

  // Save to cache
  if (useCache && allKlines.length > 0) {
    saveToCache(symbol, interval, startTime, endTime, allKlines);
  }

  return allKlines;
}

/**
 * Get BTC price at a specific timestamp (finds closest kline)
 */
export function getBtcPriceAt(klines: BinanceKline[], timestamp: number): number {
  // Binary search for closest timestamp
  let left = 0;
  let right = klines.length - 1;

  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (klines[mid].timestamp < timestamp) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }

  // Return the close price of the closest kline
  const idx = Math.max(0, left - 1);
  return klines[idx].close;
}

/**
 * Interpolate BTC prices for given timestamps
 */
export function interpolatePrices(
  klines: BinanceKline[],
  timestamps: number[]
): Map<number, number> {
  const priceMap = new Map<number, number>();
  let klineIdx = 0;

  for (const ts of timestamps) {
    // Find the kline that contains this timestamp
    while (klineIdx < klines.length - 1 && klines[klineIdx + 1].timestamp <= ts) {
      klineIdx++;
    }

    if (klineIdx < klines.length) {
      // Use close price of the containing kline
      priceMap.set(ts, klines[klineIdx].close);
    }
  }

  return priceMap;
}

// =============================================================================
// CACHE MANAGEMENT
// =============================================================================

function getCacheFilename(symbol: string, interval: string, startTime: number, endTime: number): string {
  const startDate = new Date(startTime).toISOString().split('T')[0];
  const endDate = new Date(endTime).toISOString().split('T')[0];
  return `${symbol}_${interval}_${startDate}_${endDate}.json`;
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
  symbol: string,
  interval: string,
  startTime: number,
  endTime: number
): BinanceKline[] | null {
  try {
    // Ensure data directory exists
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    // Normalize to day boundaries for comparison
    const requestStartDay = toDayStart(startTime);
    const requestEndDay = toDayEnd(endTime);

    // First try exact match
    const filename = getCacheFilename(symbol, interval, startTime, endTime);
    const filepath = path.join(DATA_DIR, filename);

    if (fs.existsSync(filepath)) {
      const content = fs.readFileSync(filepath, 'utf-8');
      const cached: CachedData<BinanceKline> = JSON.parse(content);
      const cacheStartDay = toDayStart(cached.metadata.startTs);
      const cacheEndDay = toDayEnd(cached.metadata.endTs);
      
      if (cacheStartDay <= requestStartDay && cacheEndDay >= requestEndDay) {
        console.log(`📦 Binance Cache HIT (exact): ${filename}`);
        return cached.data.filter(k => k.timestamp >= startTime && k.timestamp <= endTime);
      }
    }

    // Try to find any cache file that covers our range
    const files = fs.readdirSync(DATA_DIR).filter(f => 
      f.startsWith(`${symbol}_${interval}_`) && f.endsWith('.json')
    );

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(DATA_DIR, file), 'utf-8');
        const cached: CachedData<BinanceKline> = JSON.parse(content);
        const cacheStartDay = toDayStart(cached.metadata.startTs);
        const cacheEndDay = toDayEnd(cached.metadata.endTs);
        
        if (cacheStartDay <= requestStartDay && cacheEndDay >= requestEndDay) {
          console.log(`📦 Binance Cache HIT (overlap): ${file}`);
          return cached.data.filter(k => k.timestamp >= startTime && k.timestamp <= endTime);
        }
      } catch {
        // Skip corrupted files
      }
    }

    // Try to merge multiple cache files for partial coverage
    const allKlines: Map<number, BinanceKline> = new Map();
    let coverageStartDay = Infinity;
    let coverageEndDay = 0;

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(DATA_DIR, file), 'utf-8');
        const cached: CachedData<BinanceKline> = JSON.parse(content);
        const cacheStartDay = toDayStart(cached.metadata.startTs);
        const cacheEndDay = toDayEnd(cached.metadata.endTs);
        
        // Check if there's any overlap with our range
        if (cacheEndDay >= requestStartDay && cacheStartDay <= requestEndDay) {
          for (const k of cached.data) {
            if (k.timestamp >= startTime && k.timestamp <= endTime) {
              allKlines.set(k.timestamp, k);
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
    if (coverageStartDay <= requestStartDay && coverageEndDay >= requestEndDay && allKlines.size > 0) {
      const result = Array.from(allKlines.values()).sort((a, b) => a.timestamp - b.timestamp);
      console.log(`📦 Binance Cache HIT (merged from ${files.length} files): ${result.length} klines`);
      return result;
    }

    return null;
  } catch {
    return null;
  }
}

function saveToCache(
  symbol: string,
  interval: string,
  startTime: number,
  endTime: number,
  data: BinanceKline[]
): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    const filename = getCacheFilename(symbol, interval, startTime, endTime);
    const filepath = path.join(DATA_DIR, filename);

    const cached: CachedData<BinanceKline> = {
      metadata: {
        source: 'binance',
        startTs: startTime,
        endTs: endTime,
        symbol,
        fetchedAt: Date.now(),
      },
      data,
    };

    fs.writeFileSync(filepath, JSON.stringify(cached, null, 2));
    console.log(`💾 Cached to ${filename}`);
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

export class BinanceHistoricalFetcher {
  private symbol: string;
  private interval: KlineInterval;
  private cache: BinanceKline[] = [];

  constructor(symbol: string = 'BTCUSDT', interval: KlineInterval = '1m') {
    this.symbol = symbol;
    this.interval = interval;
  }

  async fetch(startTime: number, endTime: number): Promise<BinanceKline[]> {
    this.cache = await fetchBinanceKlines(
      this.symbol,
      this.interval,
      startTime,
      endTime
    );
    return this.cache;
  }

  getPriceAt(timestamp: number): number {
    return getBtcPriceAt(this.cache, timestamp);
  }

  getKlines(): BinanceKline[] {
    return this.cache;
  }
}

