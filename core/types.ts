/**
 * Crypto Pricer Arb - Types
 */

export interface CryptoMarket {
  conditionId: string;
  question: string;
  slug: string;
  tokenIds: [string, string];  // [YES, NO]
  outcomes: [string, string];  // ["Up", "Down"] or similar
  tickSize: string;
  negRisk: boolean;
  endDate: Date;
  startTime: Date;             // When the period STARTS (strike determined here)
  strikePrice: number;         // Price at start of period (from Chainlink)
  resolutionSource?: string;   // e.g., "Chainlink"
  // Live pricing from Gamma API
  bestBid?: number;            // Best bid for YES (Up)
  bestAsk?: number;            // Best ask for YES (Up)
  volume?: number;             // Trading volume
}

export interface OrderBookState {
  yesAsk: number;
  yesBid: number;
  noAsk: number;
  noBid: number;
  yesAskSize: number;
  noAskSize: number;
  timestamp: number;
}

export interface FairValue {
  pUp: number;        // Probability of UP (0-1)
  pDown: number;      // Probability of DOWN (0-1)
  d?: number;         // BS: d₂ value from Black-Scholes
  sigmaT?: number;    // BS: σ√τ
  logit?: number;     // LJD: current logit value
  beliefVol?: number; // LJD: calibrated σ_b
}

export interface TradeSignal {
  side: 'YES' | 'NO';
  edge: number;
  fairValue: number;
  marketPrice: number;
  size: number;
}

export interface Position {
  yesShares: number;
  noShares: number;
  totalShares: number;
  pairCost: number;  // Cost to lock profit if < 1
}

export interface BinancePrice {
  symbol: string;
  bid: number;
  ask: number;
  price: number;  // mid price = (bid + ask) / 2
  timestamp: number;
}

export type PriceCallback = (price: BinancePrice) => void;
export type OrderBookCallback = (book: OrderBookState, tokenId: string) => void;

