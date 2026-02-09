/**
 * Trading Service
 *
 * Handles order execution via Polymarket CLOB API.
 * Wraps @polymarket/clob-client with FAK (Fill-and-Kill) order support.
 */

import { ClobClient, Side, Chain, OrderType } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import { loadArbConfig } from './config';

// =============================================================================
// TYPES
// =============================================================================

export interface OrderConfig {
  tokenId: string;
  price: number;
  size: number;
  side: Side;
  tickSize: string;  // String as returned by Polymarket API
  negRisk: boolean;
}

export interface OrderResult {
  success: boolean;
  error?: string;
  orderId?: string;
}

// =============================================================================
// TRADING SERVICE
// =============================================================================

export class TradingService {
  private client: ClobClient | null = null;
  private initialized = false;

  /**
   * Initialize the CLOB client with credentials from environment
   * Skips initialization in paper trading mode (no credentials needed)
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const config = loadArbConfig();

    // Skip CLOB initialization in paper trading mode
    if (config.paperTrading) {
      this.initialized = true;
      console.log('[TradingService] Paper trading mode - CLOB client not initialized');
      return;
    }

    if (!config.privateKey || !config.funderAddress) {
      throw new Error('PRIVATE_KEY and FUNDER_ADDRESS must be set in environment');
    }

    const wallet = new Wallet(config.privateKey);

    this.client = new ClobClient(
      config.clobHost,
      config.chainId as Chain,
      wallet,
      undefined,  // creds - will be derived
      config.signatureType,
      config.funderAddress
    );

    // Derive API credentials using the correct method
    await this.client.createOrDeriveApiKey();

    this.initialized = true;
    console.log(`[TradingService] Initialized with CLOB: ${config.clobHost}`);
  }

  /**
   * Place a Fill-and-Kill (FAK) order
   *
   * FAK orders attempt to fill immediately at the specified price or better.
   * Any unfilled portion is cancelled (not left in the book).
   * Perfect for arb strategies that need immediate execution without leaving resting orders.
   */
  async placeOrderFAK(orderConfig: OrderConfig): Promise<OrderResult> {
    if (!this.client || !this.initialized) {
      return { success: false, error: 'TradingService not initialized' };
    }

    try {
      // Use createAndPostMarketOrder for FAK orders
      // This is the correct API for fill-and-kill behavior
      // Note: UserMarketOrder uses 'amount' not 'size'
      // For BUY orders: amount = $$$ amount to spend
      // For SELL orders: amount = shares to sell
      const response = await this.client.createAndPostMarketOrder(
        {
          tokenID: orderConfig.tokenId,
          price: orderConfig.price,
          amount: orderConfig.size,  // 'amount' is the API field name
          side: orderConfig.side,
        },
        undefined,  // options
        OrderType.FAK  // FAK = Fill-and-Kill
      );

      // Check for error in response
      if (response?.errorMsg) {
        return { success: false, error: response.errorMsg };
      }

      return {
        success: true,
        orderId: response?.orderID,
      };
    } catch (error: any) {
      // Extract useful error info
      const message = error.response?.data?.message || error.message || 'Unknown error';
      return { success: false, error: message };
    }
  }

  /**
   * Check if service is ready
   */
  isReady(): boolean {
    return this.initialized && this.client !== null;
  }
}
