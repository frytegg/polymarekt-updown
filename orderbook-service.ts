/**
 * Orderbook Service
 * 
 * Fetches and parses orderbooks from the Polymarket CLOB API.
 * Handles proper sorting of bids/asks.
 */

import axios from 'axios';
import { OrderBookState } from './types';

// =============================================================================
// TYPES
// =============================================================================

export interface TokenOrderbook {
  bestBid: number;
  bestAsk: number;
  askSize: number;
}

// =============================================================================
// ORDERBOOK SERVICE CLASS
// =============================================================================

export class OrderbookService {
  constructor(private clobHost: string) {}

  /**
   * Fetch orderbook for a single token with proper sorting
   */
  async fetchTokenOrderbook(tokenId: string): Promise<TokenOrderbook> {
    const response = await axios.get(`${this.clobHost}/book`, {
      params: { token_id: tokenId },
    });

    const bids = response.data.bids || [];
    const asks = response.data.asks || [];

    // CRITICAL: Sort orderbooks properly!
    // Bids: highest price first (best bid = highest)
    // Asks: lowest price first (best ask = lowest)
    const sortedBids = bids.sort((a: any, b: any) => parseFloat(b.price) - parseFloat(a.price));
    const sortedAsks = asks.sort((a: any, b: any) => parseFloat(a.price) - parseFloat(b.price));

    const bestBid = parseFloat(sortedBids[0]?.price || '0');
    const bestAsk = parseFloat(sortedAsks[0]?.price || '1');
    const askSize = parseFloat(sortedAsks[0]?.size || '0');

    return { bestBid, bestAsk, askSize };
  }

  /**
   * Fetch complete orderbook state for YES/NO tokens
   * @param yesTokenId - Token ID for YES outcome
   * @param noTokenId - Token ID for NO outcome
   * @returns Combined orderbook state
   */
  async fetchOrderbook(yesTokenId: string, noTokenId: string): Promise<OrderBookState> {
    const [yesBook, noBook] = await Promise.all([
      this.fetchTokenOrderbook(yesTokenId),
      this.fetchTokenOrderbook(noTokenId),
    ]);

    return {
      yesBid: yesBook.bestBid,
      yesAsk: yesBook.bestAsk,
      yesAskSize: yesBook.askSize,
      noBid: noBook.bestBid,
      noAsk: noBook.bestAsk,
      noAskSize: noBook.askSize,
      timestamp: Date.now(),
    };
  }

  /**
   * Fetch orderbook and log the prices
   * @param yesTokenId - Token ID for YES outcome
   * @param noTokenId - Token ID for NO outcome
   * @returns Combined orderbook state
   */
  async fetchAndLogOrderbook(yesTokenId: string, noTokenId: string): Promise<OrderBookState> {
    const orderBook = await this.fetchOrderbook(yesTokenId, noTokenId);
    
    const spread = ((orderBook.yesAsk - orderBook.yesBid) * 100).toFixed(0);
    console.log(
      `📖 CLOB prices: YES ${(orderBook.yesBid * 100).toFixed(0)}¢/${(orderBook.yesAsk * 100).toFixed(0)}¢ | ` +
      `NO ${(orderBook.noBid * 100).toFixed(0)}¢/${(orderBook.noAsk * 100).toFixed(0)}¢ | Spread: ${spread}¢`
    );
    
    return orderBook;
  }

  /**
   * Refresh orderbook silently (no logging, ignores errors)
   * @param yesTokenId - Token ID for YES outcome
   * @param noTokenId - Token ID for NO outcome
   * @returns Combined orderbook state or null on error
   */
  async refreshOrderbook(yesTokenId: string, noTokenId: string): Promise<OrderBookState | null> {
    try {
      return await this.fetchOrderbook(yesTokenId, noTokenId);
    } catch (err) {
      // Silently ignore refresh errors
      return null;
    }
  }
}

// =============================================================================
// DEFAULT ORDERBOOK STATE
// =============================================================================

/**
 * Get default (empty) orderbook state
 */
export function getDefaultOrderBookState(): OrderBookState {
  return {
    yesAsk: 1,
    yesBid: 0,
    noAsk: 1,
    noBid: 0,
    yesAskSize: 0,
    noAskSize: 0,
    timestamp: Date.now(),
  };
}

