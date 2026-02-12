/**
 * Trading Service Interface
 *
 * Defines the contract for order execution in the arbitrage bot.
 * This interface enables dependency injection for different execution modes.
 *
 * Two implementations exist:
 *   - live/trading-service.ts  → Real Polymarket CLOB execution (ClobTradingService)
 *   - paper/mock-trading-service.ts → Simulated execution for paper trading (MockTradingService)
 *
 * Consumers (arb-trader.ts, index.ts) depend on this interface, never on concrete implementations.
 * The implementation is chosen at startup via dependency injection in index.ts based on config.paperTrading.
 *
 * Design principle: Perfect behavioral equivalence
 * - Paper mode must produce identical logs, trade persistence, and position updates as live mode
 * - The only difference is that orders are simulated rather than sent to the CLOB API
 * - This ensures paper trading accurately reflects live trading behavior for signal validation
 */

import { Side } from '@polymarket/clob-client';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Order configuration for placing trades
 * Used by both live and paper implementations
 */
export interface OrderConfig {
  tokenId: string;
  price: number;
  size: number;
  side: Side;
  tickSize: string;  // String as returned by Polymarket API (e.g., "0.01")
  negRisk: boolean;
}

/**
 * Result of an order execution
 * Returned by both live and paper implementations
 */
export interface OrderResult {
  success: boolean;
  error?: string;
  orderId?: string;
}

// =============================================================================
// INTERFACE
// =============================================================================

/**
 * Trading Service Interface
 *
 * Contract for order execution services.
 * All methods use the EXACT same signatures as the original TradingService class.
 */
export interface ITradingService {
  /**
   * Initialize the trading service
   *
   * - Live: Initializes CLOB client, derives API credentials, verifies wallet
   * - Paper: No-op initialization, logs paper mode active
   *
   * Must be called before placeOrderFAK() or isReady().
   * Multiple calls are safe (idempotent).
   */
  initialize(): Promise<void>;

  /**
   * Place a Fill-and-Kill (FAK) order
   *
   * FAK orders attempt to fill immediately at the specified price or better.
   * Any unfilled portion is cancelled (not left in the book).
   *
   * - Live: Sends order to Polymarket CLOB API via createAndPostMarketOrder()
   * - Paper: Simulates a fill at the requested price, records via paperTracker
   *
   * @param orderConfig - Order parameters (token, price, size, side)
   * @returns OrderResult with success/error and optional orderId
   *
   * Note: For BUY orders, the CLOB API expects amount in USD (size × price).
   * For SELL orders, amount is in shares. Implementations must handle this conversion.
   */
  placeOrderFAK(orderConfig: OrderConfig): Promise<OrderResult>;

  /**
   * Check if service is ready to accept orders
   *
   * - Live: Returns true if CLOB client is initialized and credentials are set
   * - Paper: Returns true after initialize() completes
   *
   * @returns true if service is ready, false otherwise
   */
  isReady(): boolean;
}
