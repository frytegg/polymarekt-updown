/**
 * Mock Trading Service (Paper Trading)
 *
 * Implements ITradingService without placing real orders.
 * Returns simulated successful fills for order requests.
 *
 * Behavior contract:
 *   - initialize() → No-op, logs paper mode active, returns immediately
 *   - placeOrderFAK() → Logs order details, returns simulated fill (success + mock order ID)
 *   - isReady() → Always returns true after initialize()
 *   - All methods produce log format compatible with live service
 *
 * Design:
 * This mock returns SUCCESS for all orders, allowing arb-trader to continue with
 * its normal post-trade logic (position updates, trade persistence, resolution tracking).
 * The mock does NOT directly call paperTracker or positionManager — those responsibilities
 * remain in arb-trader to maintain consistency between live and paper execution paths.
 *
 * The only difference between live and paper is WHERE the order goes:
 *   - Live: TradingService sends to CLOB API
 *   - Paper: MockTradingService returns success immediately
 *
 * After both return, arb-trader handles position updates, trade recording, and logging identically.
 */

import { ITradingService, OrderConfig, OrderResult } from '../core/trading-interface';
import { createLogger } from '../core/logger';

const log = createLogger('MockTradingService', { mode: 'paper' });

/**
 * Generate a mock order ID for paper trading
 * Format: "paper_<timestamp>_<random>"
 */
function generateMockOrderId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `paper_${timestamp}_${random}`;
}

export class MockTradingService implements ITradingService {
  private initialized = false;

  /**
   * Initialize the mock trading service
   * No credentials needed, no CLOB client initialization
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Same log message as the current paper mode bypass
    console.log('[MockTradingService] Paper trading mode - CLOB client not initialized');
    this.initialized = true;
  }

  /**
   * Simulate a Fill-and-Kill (FAK) order
   *
   * Returns immediate success with a mock order ID.
   * Logs the order details in the same format as live orders.
   *
   * @param orderConfig - Order parameters (token, price, size, side)
   * @returns OrderResult with success=true and mock orderId
   */
  async placeOrderFAK(orderConfig: OrderConfig): Promise<OrderResult> {
    if (!this.initialized) {
      log.warn('order.not_initialized', {
        tokenId: orderConfig.tokenId,
        reason: 'MockTradingService not initialized',
      });
      return { success: false, error: 'MockTradingService not initialized' };
    }

    // Generate mock order ID
    const orderId = generateMockOrderId();

    // Log the simulated order in the same format as live orders
    // This helps maintain log consistency for analysis
    log.info('order.simulated', {
      orderId,
      tokenId: orderConfig.tokenId,
      side: orderConfig.side,
      price: orderConfig.price,
      size: orderConfig.size,
      tickSize: orderConfig.tickSize,
      negRisk: orderConfig.negRisk,
    });

    // Return success — arb-trader will handle the rest
    // (position updates, trade persistence, resolution tracking)
    return {
      success: true,
      orderId,
    };
  }

  /**
   * Check if mock service is ready
   * Always true after initialization
   */
  isReady(): boolean {
    return this.initialized;
  }
}
