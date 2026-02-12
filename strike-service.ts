/**
 * Strike Price Service
 * 
 * Manages fetching and tracking of strike prices ("Price to Beat") for crypto markets.
 * Supports Polymarket API (primary) and Chainlink on-chain (fallback).
 */

const axios = require('axios');
import { ethers } from 'ethers';
import { CryptoMarket } from './core/types';
import { createLogger, Logger, safeErrorData } from './core/logger';

// =============================================================================
// CONSTANTS
// =============================================================================

// Chainlink BTC/USD Price Feed on Polygon
const CHAINLINK_BTC_USD_POLYGON = "0xc907E116054Ad103354f2D350FD2514433D57F6f";
const CHAINLINK_ABI = [
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)"
];

// =============================================================================
// TYPES
// =============================================================================

export interface StrikePriceResult {
  price: number;
  priceTime: Date;    // The time this price corresponds to (market start time for Polymarket API)
  source: 'polymarket' | 'chainlink' | 'manual';
}

// =============================================================================
// STRIKE PRICE SERVICE CLASS
// =============================================================================

const strikeLog = createLogger('StrikeService', { mode: 'live' });

export class StrikePriceService {
  private currentStrike: number = 0;
  private strikeSetTime: number = 0;
  private strikeSource: 'polymarket' | 'chainlink' | 'manual' | null = null;
  private fetchInProgress: boolean = false;
  private log: Logger = strikeLog;

  /**
   * Get the current strike price (0 if not set)
   */
  getStrike(): number {
    return this.currentStrike;
  }

  /**
   * Check if strike is set
   */
  hasStrike(): boolean {
    return this.currentStrike > 0;
  }

  /**
   * Get strike metadata
   */
  getStrikeInfo(): { price: number; setTime: number; source: string | null } {
    return {
      price: this.currentStrike,
      setTime: this.strikeSetTime,
      source: this.strikeSource,
    };
  }

  /**
   * Manually set the strike price (e.g., from Polymarket UI "Price to Beat")
   */
  setManualStrike(price: number): void {
    const oldStrike = this.currentStrike;
    this.currentStrike = price;
    this.strikeSetTime = Date.now();
    this.strikeSource = 'manual';
    
    this.log.info('strike.set', {
      price,
      previousPrice: oldStrike > 0 ? oldStrike : undefined,
      source: 'manual',
    });
  }

  /**
   * Fetch and set strike price for a market
   * @param market - The crypto market
   * @param manualStrike - Optional manual strike from config/env
   * @returns True if strike was successfully set
   */
  async fetchAndSetStrike(market: CryptoMarket, manualStrike?: number): Promise<boolean> {
    // Already have strike or fetch in progress
    if (this.currentStrike > 0 || this.fetchInProgress) {
      return this.currentStrike > 0;
    }

    this.fetchInProgress = true;

    try {
      // Check if manual strike was provided
      if (manualStrike && manualStrike > 0) {
        this.currentStrike = manualStrike;
        this.strikeSetTime = Date.now();
        this.strikeSource = 'manual';
        this.log.info('strike.set', { price: this.currentStrike, source: 'manual_env' });
        return true;
      }

      // Try to fetch from Polymarket API (falls back to Chainlink)
      this.log.debug('strike.fetching');

      const result = await this.fetchStrikePrice(market);

      if (result && result.price > 0) {
        this.currentStrike = result.price;
        this.strikeSetTime = Date.now();
        this.strikeSource = result.source;

        this.log.info('strike.set', {
          price: this.currentStrike,
          source: result.source,
          priceTime: result.priceTime.toISOString(),
        });
        return true;
      } else {
        this.log.warn('strike.fetch_failed', { reason: 'no_valid_result' });
        return false;
      }
    } catch (err) {
      this.log.warn('strike.fetch_error', safeErrorData(err));
      return false;
    } finally {
      this.fetchInProgress = false;
    }
  }

  /**
   * Reset strike for new market
   */
  reset(): void {
    this.currentStrike = 0;
    this.strikeSetTime = 0;
    this.strikeSource = null;
    this.fetchInProgress = false;
  }

  // ===========================================================================
  // FETCH METHODS
  // ===========================================================================

  /**
   * Fetch strike price from Polymarket's crypto API
   * This is the ACTUAL "Price to Beat" at market start time
   */
  private async fetchPolymarketStrike(market: CryptoMarket): Promise<StrikePriceResult | null> {
    try {
      const startTime = market.startTime.toISOString();
      const endTime = market.endDate.toISOString();
      
      const url = `https://polymarket.com/api/crypto/crypto-price?symbol=BTC&eventStartTime=${startTime}&variant=fifteen&endDate=${endTime}`;
      
      const response = await axios.get(url, { timeout: 5000 });
      const data = response.data;
      
      if (data && data.openPrice && data.openPrice > 0) {
        return {
          price: data.openPrice,
          priceTime: market.startTime,
          source: 'polymarket',
        };
      }
      
      return null;
    } catch (error: any) {
      this.log.warn('strike.polymarket_error', safeErrorData(error));
      return null;
    }
  }

  /**
   * Fetch current BTC/USD price from Chainlink on-chain (Polygon)
   * No rate limits, same source as Polymarket resolution
   */
  private async fetchChainlinkBTCPrice(): Promise<StrikePriceResult | null> {
    try {
      const rpcUrl = process.env.RPC_URL || "https://polygon.drpc.org";
      const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
      const contract = new ethers.Contract(CHAINLINK_BTC_USD_POLYGON, CHAINLINK_ABI, provider);
      
      const [, answer, , updatedAt] = await contract.latestRoundData();
      const price = parseFloat(ethers.utils.formatUnits(answer, 8));
      
      if (price <= 0) return null;
      
      // updatedAt is a Unix timestamp (seconds)
      const priceTime = new Date(updatedAt.toNumber() * 1000);
      
      return { price, priceTime, source: 'chainlink' };
    } catch (err: any) {
      this.log.warn('strike.chainlink_error', safeErrorData(err));
      return null;
    }
  }

  /**
   * Fetch the strike price ("Price to Beat")
   * 1. Try Polymarket API first (gives exact price at market start time)
   * 2. Fallback to Chainlink current price if Polymarket fails
   */
  async fetchStrikePrice(market: CryptoMarket): Promise<StrikePriceResult | null> {
    // Try Polymarket API first (exact strike at market start)
    const polymarketResult = await this.fetchPolymarketStrike(market);
    if (polymarketResult) {
      return polymarketResult;
    }

    // Fallback to Chainlink current price
    this.log.info('strike.fallback_chainlink');
    return this.fetchChainlinkBTCPrice();
  }
}

// =============================================================================
// STANDALONE FUNCTIONS (for backward compatibility)
// =============================================================================

/**
 * Fetch current BTC/USD price from Chainlink on-chain (Polygon)
 * No rate limits, same source as Polymarket resolution
 */
export async function fetchChainlinkBTCPrice(): Promise<StrikePriceResult | null> {
  try {
    const rpcUrl = process.env.RPC_URL || "https://polygon.drpc.org";
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    const contract = new ethers.Contract(CHAINLINK_BTC_USD_POLYGON, CHAINLINK_ABI, provider);

    const [, answer, , updatedAt] = await contract.latestRoundData();
    const price = parseFloat(ethers.utils.formatUnits(answer, 8));

    if (price <= 0) return null;

    // updatedAt is a Unix timestamp (seconds)
    const priceTime = new Date(updatedAt.toNumber() * 1000);

    return { price, priceTime, source: 'chainlink' };
  } catch (err: any) {
    strikeLog.warn('strike.chainlink_error', safeErrorData(err));
    return null;
  }
}

/**
 * Fetch the strike price ("Price to Beat") - standalone function
 * @deprecated Use StrikePriceService.fetchStrikePrice instead
 */
export async function fetchStrikePrice(market: CryptoMarket): Promise<StrikePriceResult | null> {
  const service = new StrikePriceService();
  return service.fetchStrikePrice(market);
}

