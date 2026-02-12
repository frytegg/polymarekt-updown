/**
 * Crypto Pricer Arb - Market Finder
 * Finds active BTC UP/DOWN markets on Polymarket
 * 
 * API Flow:
 * 1. GET /series?slug=btc-up-or-down-15m → get all events in series
 * 2. Filter for closed=false events
 * 3. GET /events/{id} → get full market details including clobTokenIds
 */

const axios = require('axios');
import { CryptoMarket } from '../core/types';
import { createLogger, rateLimitedLog } from '../core/logger';

const log = createLogger('MarketFinder', { mode: 'live' });
const GAMMA_API_URL = 'https://gamma-api.polymarket.com';

// Track previous search result to detect changes
let lastSearchResultKey: string = '';

// Series slugs for crypto UP/DOWN markets
const CRYPTO_SERIES = [
  'btc-up-or-down-15m',
  // Can add more series like 'eth-up-or-down-15m' later
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
  bestBid?: number;
  bestAsk?: number;
  volumeNum?: number;
}

interface EventDetails {
  id: string;
  slug: string;
  title: string;
  description: string;
  endDate: string;
  startTime?: string;       // When event starts (event level)
  resolutionSource?: string;
  markets: EventMarket[];
}

/**
 * Find active BTC UP/DOWN markets from series
 */
export async function findCryptoMarkets(): Promise<CryptoMarket[]> {
  log.debug('search.started');

  const markets: CryptoMarket[] = [];

  for (const seriesSlug of CRYPTO_SERIES) {
    try {
      // Step 1: Get all events from series
      const seriesResponse = await axios.get(`${GAMMA_API_URL}/series`, {
        params: { slug: seriesSlug },
      });

      const seriesData = seriesResponse.data;
      if (!seriesData || seriesData.length === 0) {
        log.warn('search.series_not_found', { series: seriesSlug });
        continue;
      }

      const series = seriesData[0];
      const events: SeriesEvent[] = series.events || [];

      // Step 2: Filter for active (not closed) events
      const activeEvents = events.filter(e => !e.closed);

      // Sort by endDate (soonest first)
      activeEvents.sort((a, b) =>
        new Date(a.endDate).getTime() - new Date(b.endDate).getTime()
      );

      log.debug('search.series_result', { series: seriesSlug, activeCount: activeEvents.length });

      // Step 3: Get full details for nearest events (limit to avoid too many API calls)
      const eventsToFetch = activeEvents.slice(0, 5);

      for (const event of eventsToFetch) {
        try {
          const eventDetails = await fetchEventDetails(event.id);
          if (!eventDetails || !eventDetails.markets || eventDetails.markets.length === 0) {
            continue;
          }

          const market = parseEventToMarket(eventDetails);
          if (market) {
            markets.push(market);
          }
        } catch (err) {
          // Skip this event
        }
      }

    } catch (error: any) {
      log.error('search.series_error', { series: seriesSlug, error: error.message?.slice(0, 120) });
    }
  }

  // Sort by end date (soonest first)
  markets.sort((a, b) => a.endDate.getTime() - b.endDate.getTime());

  // Only log at INFO if results changed from last search (dedup repeated identical results)
  const resultKey = markets.map(m => m.conditionId.slice(0, 8)).join(',');
  if (resultKey !== lastSearchResultKey) {
    lastSearchResultKey = resultKey;
    log.info('search.result_changed', {
      count: markets.length,
      markets: markets.slice(0, 3).map(m => ({
        q: m.question.slice(0, 40),
        timeLeftSec: Math.max(0, Math.floor((m.endDate.getTime() - Date.now()) / 1000)),
      })),
    });
  } else {
    log.debug('search.result_unchanged', { count: markets.length });
  }

  return markets;
}

/**
 * Fetch full event details by ID
 */
async function fetchEventDetails(eventId: string): Promise<EventDetails | null> {
  try {
    const response = await axios.get(`${GAMMA_API_URL}/events/${eventId}`);
    return response.data;
  } catch (error) {
    return null;
  }
}

/**
 * Parse event details into CryptoMarket
 */
function parseEventToMarket(event: EventDetails): CryptoMarket | null {
  try {
    if (!event.markets || event.markets.length === 0) return null;
    
    const market = event.markets[0];
    
    // Parse token IDs
    const tokenIds = JSON.parse(market.clobTokenIds || '[]');
    if (tokenIds.length !== 2) return null;
    
    // Parse outcomes
    const outcomes = JSON.parse(market.outcomes || '[]');
    if (outcomes.length !== 2) return null;
    
    // Parse end date
    const endDate = event.endDate ? new Date(event.endDate) : null;
    if (!endDate || isNaN(endDate.getTime())) return null;
    
    // Check if market has already ended
    if (endDate.getTime() <= Date.now()) return null;
    
    // Parse start time (when strike is determined)
    const startTime = event.startTime ? new Date(event.startTime) : 
                      market.eventStartTime ? new Date(market.eventStartTime) : null;
    if (!startTime || isNaN(startTime.getTime())) return null;
    
    // Check for liquidity - skip markets with no real bids/asks
    const bestBid = market.bestBid || 0;
    const bestAsk = market.bestAsk || 1;
    
    // Skip if spread is too wide (> 50%) or no liquidity
    if (bestAsk - bestBid > 0.50 || bestBid <= 0.05 || bestAsk >= 0.95) {
      return null; // No real liquidity
    }
    
    // Extract strike price from description
    const strikePrice = extractStrikePrice(event.title, event.description);
    
    return {
      conditionId: market.conditionId,
      question: event.title,
      slug: event.slug,
      tokenIds: tokenIds as [string, string],
      outcomes: outcomes as [string, string],
      tickSize: '0.01',
      negRisk: market.negRisk || false,
      endDate,
      startTime,
      strikePrice,
      resolutionSource: event.resolutionSource,
      // Include live pricing
      bestBid,
      bestAsk,
      volume: market.volumeNum || 0,
    };
    
  } catch (err) {
    return null;
  }
}

/**
 * Find the next market to trade (soonest to expire, but not too soon)
 */
export function findNextMarket(
  markets: CryptoMarket[],
  minSecondsRemaining: number = 30
): CryptoMarket | null {
  const now = Date.now();
  
  for (const market of markets) {
    const secondsRemaining = (market.endDate.getTime() - now) / 1000;
    
    if (secondsRemaining > minSecondsRemaining) {
      return market;
    }
  }
  
  return null;
}

/**
 * Extract strike price from market title/description
 * For UP/DOWN markets, the strike is the price at the START of the period
 * We'll need to fetch this from the market or use current price as approximation
 */
function extractStrikePrice(title: string, description?: string): number {
  const text = `${title} ${description || ''}`;
  
  // Match price patterns: $92,527.89 or $92527.89
  const priceRegex = /\$?([\d,]+\.?\d*)/g;
  const matches = text.match(priceRegex);
  
  if (matches) {
    for (const match of matches) {
      const price = parseFloat(match.replace(/[$,]/g, ''));
      // BTC prices are typically > $10,000
      if (price > 10000 && price < 1000000) {
        return price;
      }
    }
  }
  
  // For UP/DOWN markets, strike isn't in description
  // It's determined at market start time
  // Return 0 to indicate we need to fetch it
  return 0;
}

// Re-export strike price functions from dedicated service (for backward compatibility)
export type { StrikePriceResult } from './strike-service';
export { fetchStrikePrice, fetchChainlinkBTCPrice } from './strike-service';

/**
 * Log market info (single structured line)
 */
export function logMarket(market: CryptoMarket): void {
  const now = Date.now();
  const secondsRemaining = Math.max(0, (market.endDate.getTime() - now) / 1000);
  const hasStarted = market.startTime.getTime() <= now;
  const secondsToStart = Math.max(0, (market.startTime.getTime() - now) / 1000);

  log.debug('market.details', {
    marketId: market.conditionId.slice(0, 12),
    question: market.question.slice(0, 50),
    expiresInSec: Math.floor(secondsRemaining),
    hasStarted,
    secondsToStart: hasStarted ? undefined : Math.floor(secondsToStart),
    strike: market.strikePrice > 0 ? market.strikePrice : 'pending',
    bestBid: market.bestBid,
    bestAsk: market.bestAsk,
    spreadCents: market.bestBid !== undefined && market.bestAsk !== undefined
      ? Math.round((market.bestAsk - market.bestBid) * 100)
      : undefined,
    volume: market.volume || undefined,
    resolution: market.resolutionSource || 'Chainlink',
  });
}
