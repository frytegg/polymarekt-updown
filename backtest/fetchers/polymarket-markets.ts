/**
 * Polymarket Historical Markets Fetcher
 * Fetches historical BTC UP/DOWN markets from Gamma API
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { HistoricalMarket, CachedData } from '../types';

const GAMMA_API_URL = 'https://gamma-api.polymarket.com';
const DATA_DIR = path.join(__dirname, '../../data/polymarket');

// Series slugs for crypto UP/DOWN markets
const CRYPTO_SERIES = [
  'btc-up-or-down-15m',
];

interface SeriesEvent {
  id: string;
  slug: string;
  title: string;
  endDate: string;
  startTime?: string;
  closed: boolean;
}

interface EventMarket {
  conditionId: string;
  clobTokenIds: string;
  outcomes: string;
  negRisk?: boolean;
  eventStartTime?: string;
}

interface EventDetails {
  id: string;
  slug: string;
  title: string;
  description: string;
  endDate: string;
  startTime?: string;
  resolutionSource?: string;
  markets: EventMarket[];
}

/**
 * Fetch historical markets within a date range
 */
export async function fetchHistoricalMarkets(
  startTime: number,
  endTime: number,
  useCache: boolean = true
): Promise<HistoricalMarket[]> {
  // Check cache first
  if (useCache) {
    const cached = loadFromCache(startTime, endTime);
    if (cached) {
      console.log(`📦 Loaded ${cached.length} historical markets from cache`);
      return cached;
    }
    console.log(`💨 Cache MISS - will fetch from API`);
  }

  console.log(`📡 Fetching historical Polymarket markets from ${new Date(startTime).toISOString()} to ${new Date(endTime).toISOString()}`);

  const markets: HistoricalMarket[] = [];

  for (const seriesSlug of CRYPTO_SERIES) {
    try {
      // Get all events from series
      const seriesResponse = await axios.get(`${GAMMA_API_URL}/series`, {
        params: { slug: seriesSlug },
        timeout: 10000,
      });

      const seriesData = seriesResponse.data;
      if (!seriesData || seriesData.length === 0) {
        console.log(`   ⚠️ Series ${seriesSlug} not found`);
        continue;
      }

      const series = seriesData[0];
      const events: SeriesEvent[] = series.events || [];

      console.log(`   📊 Series ${seriesSlug}: ${events.length} total events`);

      // Filter events within our date range
      const relevantEvents = events.filter(e => {
        const eventEnd = new Date(e.endDate).getTime();
        return eventEnd >= startTime && eventEnd <= endTime;
      });

      console.log(`   📊 ${relevantEvents.length} events in date range`);

      // Fetch details in parallel batches for speed
      const BATCH_SIZE = 10; // Fetch 10 events at a time
      let processed = 0;
      
      for (let i = 0; i < relevantEvents.length; i += BATCH_SIZE) {
        const batch = relevantEvents.slice(i, i + BATCH_SIZE);
        
        // Fetch all events in batch in parallel
        const batchResults = await Promise.all(
          batch.map(async (event) => {
            try {
              const eventDetails = await fetchEventDetails(event.id);
              if (!eventDetails || !eventDetails.markets || eventDetails.markets.length === 0) {
                return null;
              }

              const market = parseEventToHistoricalMarket(eventDetails);
              if (market) {
                // Fetch strike price
                const strike = await fetchStrikePrice(market);
                if (strike) {
                  market.strikePrice = strike;
                }
                return market;
              }
              return null;
            } catch (err) {
              return null;
            }
          })
        );
        
        // Add successful results
        for (const market of batchResults) {
          if (market) {
            markets.push(market);
          }
        }
        
        processed += batch.length;
        if (processed % 50 === 0 || processed === relevantEvents.length) {
          console.log(`   Processed ${processed}/${relevantEvents.length} events...`);
        }

        // Small delay between batches to be nice to the API
        if (i + BATCH_SIZE < relevantEvents.length) {
          await sleep(50);
        }
      }

    } catch (error: any) {
      console.error(`   ❌ Error fetching series ${seriesSlug}: ${error.message}`);
    }
  }

  // Sort by end date
  markets.sort((a, b) => a.endTime - b.endTime);

  console.log(`✅ Fetched ${markets.length} historical markets`);

  // Save to cache
  if (useCache && markets.length > 0) {
    saveToCache(startTime, endTime, markets);
  }

  return markets;
}

/**
 * Fetch full event details by ID
 */
async function fetchEventDetails(eventId: string): Promise<EventDetails | null> {
  try {
    const response = await axios.get(`${GAMMA_API_URL}/events/${eventId}`, {
      timeout: 10000,
    });
    return response.data;
  } catch (error) {
    return null;
  }
}

/**
 * Parse event details into HistoricalMarket
 */
function parseEventToHistoricalMarket(event: EventDetails): HistoricalMarket | null {
  try {
    if (!event.markets || event.markets.length === 0) return null;

    const market = event.markets[0];

    // Parse token IDs
    const tokenIds = JSON.parse(market.clobTokenIds || '[]');
    if (tokenIds.length !== 2) return null;

    // Parse outcomes
    const outcomes = JSON.parse(market.outcomes || '[]');
    if (outcomes.length !== 2) return null;

    // Parse dates
    const endDate = event.endDate ? new Date(event.endDate) : null;
    if (!endDate || isNaN(endDate.getTime())) return null;

    const startTimeStr = event.startTime || market.eventStartTime;
    const startTime = startTimeStr ? new Date(startTimeStr) : null;
    if (!startTime || isNaN(startTime.getTime())) return null;

    // Determine outcome from title/description or market state
    let outcome: 'UP' | 'DOWN' | undefined;
    const closedEvent = event as any;
    if (closedEvent.outcome) {
      outcome = closedEvent.outcome.toLowerCase().includes('up') ? 'UP' : 'DOWN';
    }

    return {
      conditionId: market.conditionId,
      question: event.title,
      slug: event.slug,
      tokenIds: tokenIds as [string, string],
      outcomes: outcomes as [string, string],
      strikePrice: 0, // Will be fetched separately
      startTime: startTime.getTime(),
      endTime: endDate.getTime(),
      resolved: !!outcome,
      outcome,
    };

  } catch (err) {
    return null;
  }
}

/**
 * Fetch strike price from Polymarket crypto API
 */
async function fetchStrikePrice(market: HistoricalMarket): Promise<number | null> {
  try {
    const startTime = new Date(market.startTime).toISOString();
    const endTime = new Date(market.endTime).toISOString();

    const url = `https://polymarket.com/api/crypto/crypto-price?symbol=BTC&eventStartTime=${startTime}&variant=fifteen&endDate=${endTime}`;

    const response = await axios.get(url, { timeout: 5000 });
    const data = response.data;

    if (data && data.openPrice && data.openPrice > 0) {
      return data.openPrice;
    }

    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Determine market outcome based on final BTC price vs strike
 * This can be used when the API doesn't return the outcome
 */
export function determineOutcome(
  finalBtcPrice: number,
  strikePrice: number
): 'UP' | 'DOWN' {
  return finalBtcPrice > strikePrice ? 'UP' : 'DOWN';
}

// =============================================================================
// CACHE MANAGEMENT
// =============================================================================

function getCacheFilename(startTime: number, endTime: number): string {
  const startDate = new Date(startTime).toISOString().split('T')[0];
  const endDate = new Date(endTime).toISOString().split('T')[0];
  return `markets_${startDate}_${endDate}.json`;
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

function loadFromCache(startTime: number, endTime: number): HistoricalMarket[] | null {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    // Normalize to day boundaries for comparison (ignore time of day)
    const requestStartDay = toDayStart(startTime);
    const requestEndDay = toDayEnd(endTime);

    // First try exact match
    const filename = getCacheFilename(startTime, endTime);
    const filepath = path.join(DATA_DIR, filename);

    if (fs.existsSync(filepath)) {
      const content = fs.readFileSync(filepath, 'utf-8');
      const cached: CachedData<HistoricalMarket> = JSON.parse(content);
      const cacheStartDay = toDayStart(cached.metadata.startTs);
      const cacheEndDay = toDayEnd(cached.metadata.endTs);
      
      if (cacheStartDay <= requestStartDay && cacheEndDay >= requestEndDay) {
        console.log(`📦 Markets Cache HIT (exact): ${filename}`);
        return cached.data.filter(m => m.endTime >= startTime && m.endTime <= endTime);
      }
    }

    // Try to find any cache file that covers our range
    const files = fs.readdirSync(DATA_DIR).filter(f => 
      f.startsWith('markets_') && f.endsWith('.json')
    );

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(DATA_DIR, file), 'utf-8');
        const cached: CachedData<HistoricalMarket> = JSON.parse(content);
        const cacheStartDay = toDayStart(cached.metadata.startTs);
        const cacheEndDay = toDayEnd(cached.metadata.endTs);
        
        if (cacheStartDay <= requestStartDay && cacheEndDay >= requestEndDay) {
          console.log(`📦 Markets Cache HIT (overlap): ${file}`);
          return cached.data.filter(m => m.endTime >= startTime && m.endTime <= endTime);
        }
      } catch {
        // Skip corrupted files
      }
    }

    // Try to merge multiple cache files for partial coverage
    const allMarkets: Map<string, HistoricalMarket> = new Map();
    let coverageStartDay = Infinity;
    let coverageEndDay = 0;

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(DATA_DIR, file), 'utf-8');
        const cached: CachedData<HistoricalMarket> = JSON.parse(content);
        const cacheStartDay = toDayStart(cached.metadata.startTs);
        const cacheEndDay = toDayEnd(cached.metadata.endTs);
        
        // Check if there's any overlap
        if (cacheEndDay >= requestStartDay && cacheStartDay <= requestEndDay) {
          for (const m of cached.data) {
            if (m.endTime >= startTime && m.endTime <= endTime) {
              allMarkets.set(m.conditionId, m);
            }
          }
          coverageStartDay = Math.min(coverageStartDay, cacheStartDay);
          coverageEndDay = Math.max(coverageEndDay, cacheEndDay);
        }
      } catch {
        // Skip corrupted files
      }
    }

    if (coverageStartDay <= requestStartDay && coverageEndDay >= requestEndDay && allMarkets.size > 0) {
      const result = Array.from(allMarkets.values()).sort((a, b) => a.endTime - b.endTime);
      console.log(`📦 Markets Cache HIT (merged from ${files.length} files): ${result.length} markets`);
      return result;
    }

    return null;
  } catch {
    return null;
  }
}

function saveToCache(startTime: number, endTime: number, data: HistoricalMarket[]): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    const filename = getCacheFilename(startTime, endTime);
    const filepath = path.join(DATA_DIR, filename);

    const cached: CachedData<HistoricalMarket> = {
      metadata: {
        source: 'polymarket',
        startTs: startTime,
        endTs: endTime,
        fetchedAt: Date.now(),
      },
      data,
    };

    fs.writeFileSync(filepath, JSON.stringify(cached, null, 2));
    console.log(`💾 Cached markets to ${filename}`);
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

export class PolymarketMarketsFetcher {
  private cache: HistoricalMarket[] = [];

  async fetch(startTime: number, endTime: number): Promise<HistoricalMarket[]> {
    this.cache = await fetchHistoricalMarkets(startTime, endTime);
    return this.cache;
  }

  getMarkets(): HistoricalMarket[] {
    return this.cache;
  }

  getMarketById(conditionId: string): HistoricalMarket | undefined {
    return this.cache.find(m => m.conditionId === conditionId);
  }

  /**
   * Get markets that were active at a specific time
   */
  getMarketsActiveAt(timestamp: number): HistoricalMarket[] {
    return this.cache.filter(m => 
      m.startTime <= timestamp && m.endTime >= timestamp
    );
  }
}

