/**
 * Crypto Pricer Arb - Binance Price Client
 * Real-time BTC price feed from Binance (WebSocket + REST fallback)
 *
 * Falls back to REST polling if WebSocket is geo-blocked (HTTP 451)
 */

import WebSocket from 'ws';
const axios = require('axios');
import { BinancePrice, PriceCallback } from '../core/types';
import { createLogger, rateLimitedLog, safeErrorData, Logger } from '../core/logger';

// Try multiple endpoints in order of preference
const BINANCE_WS_URLS = [
  'wss://stream.binance.com:9443/ws',      // Global (blocked in some regions)
  'wss://stream.binance.us:9443/ws',        // US
  'wss://fstream.binance.com/ws',           // Futures (sometimes works)
];

const BINANCE_REST_URLS = [
  'https://api.binance.com/api/v3',         // Global
  'https://api.binance.us/api/v3',          // US
  'https://api1.binance.com/api/v3',        // Backup 1
  'https://api2.binance.com/api/v3',        // Backup 2
];

export class BinanceWebSocket {
  private ws: WebSocket | null = null;
  private symbol: string;
  private callbacks: PriceCallback[] = [];
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3; // Reduced - we'll fallback to REST faster
  private reconnectDelay = 1000;
  private lastPrice: BinancePrice | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private restPollingInterval: NodeJS.Timeout | null = null;
  private usingRestFallback = false;
  private currentWsUrlIndex = 0;
  private currentRestUrlIndex = 0;
  private wsBlocked = false;
  private log: Logger = createLogger('BinanceWS', { mode: 'live' });
  private wsConnId = 0;

  constructor(symbol: string = 'btcusdt') {
    this.symbol = symbol.toLowerCase();
  }

  /**
   * Connect to Binance - tries WebSocket first, falls back to REST
   */
  connect(): void {
    if (this.wsBlocked) {
      this.startRestPolling();
      return;
    }
    this.connectWebSocket();
  }

  /**
   * Connect to Binance WebSocket
   */
  private connectWebSocket(): void {
    const wsUrl = BINANCE_WS_URLS[this.currentWsUrlIndex];
    const streamUrl = `${wsUrl}/${this.symbol}@bookTicker`;
    
    this.wsConnId++;
    this.log.info('ws.connecting', { symbol: this.symbol.toUpperCase(), wsConnId: this.wsConnId, urlIndex: this.currentWsUrlIndex });

    try {
      this.ws = new WebSocket(streamUrl);
    } catch (err: any) {
      this.log.error('ws.create_failed', { ...safeErrorData(err), wsConnId: this.wsConnId });
      this.handleWsFailure();
      return;
    }

    const ws = this.ws;
    
    ws.on('open', () => {
      this.log.info('ws.connected', { symbol: this.symbol.toUpperCase(), wsConnId: this.wsConnId });
      this.reconnectAttempts = 0;
      this.usingRestFallback = false;
      this.stopRestPolling();
      
      // Binance requires ping every 30s to keep connection alive
      this.pingInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.ping();
        }
      }, 30000);
    });
    
    ws.on('message', (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString());
        
        // bookTicker format: { "s": "BTCUSDT", "b": "92651.50", "a": "92651.80", ... }
        if (msg.s && msg.b && msg.a) {
          const bid = parseFloat(msg.b);
          const ask = parseFloat(msg.a);
          const price: BinancePrice = {
            symbol: msg.s,
            bid,
            ask,
            price: (bid + ask) / 2,  // mid price
            timestamp: msg.u || Date.now(),
          };
          
          this.lastPrice = price;
          this.notifyCallbacks(price);
        }
      } catch (err) {
        // Ignore parse errors
      }
    });
    
    ws.on('error', (error: any) => {
      const msg = error.message || '';
      rateLimitedLog(this.log, 'error', 'binance_ws_error', 60_000, 'ws.error', {
        error: msg.slice(0, 120),
        wsConnId: this.wsConnId,
      });

      // HTTP 451 = geo-blocked, switch to REST immediately
      if (msg.includes('451') || msg.includes('403') || msg.includes('Unexpected server response')) {
        this.handleWsFailure();
      }
    });
    
    ws.on('close', (code: number) => {
      this.log.warn('ws.disconnected', { code, wsConnId: this.wsConnId });
      this.clearPingInterval();
      
      // If we've failed multiple times, mark WS as blocked
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        this.handleWsFailure();
      } else {
        this.attemptReconnect();
      }
    });
    
    ws.on('pong', () => {
      // Connection is alive
    });
  }

  /**
   * Handle WebSocket failure - try next URL or fallback to REST
   */
  private handleWsFailure(): void {
    this.clearPingInterval();
    
    // Try next WS URL
    this.currentWsUrlIndex++;
    if (this.currentWsUrlIndex < BINANCE_WS_URLS.length) {
      this.log.info('ws.trying_alternative', { urlIndex: this.currentWsUrlIndex });
      this.reconnectAttempts = 0;
      setTimeout(() => this.connectWebSocket(), 1000);
      return;
    }

    // All WS URLs failed - switch to REST
    this.log.warn('ws.all_blocked', { triedUrls: BINANCE_WS_URLS.length });
    this.wsBlocked = true;
    this.startRestPolling();
  }

  /**
   * Start REST API polling as fallback
   */
  private startRestPolling(): void {
    if (this.restPollingInterval) return; // Already polling
    
    this.usingRestFallback = true;
    this.log.info('rest.polling_started', { intervalMs: 1000 });
    
    // Fetch immediately, then every second
    this.fetchRestPrice();
    this.restPollingInterval = setInterval(() => {
      this.fetchRestPrice();
    }, 1000);
  }

  /**
   * Stop REST polling
   */
  private stopRestPolling(): void {
    if (this.restPollingInterval) {
      clearInterval(this.restPollingInterval);
      this.restPollingInterval = null;
    }
    this.usingRestFallback = false;
  }

  /**
   * Fetch price from REST API
   */
  private async fetchRestPrice(): Promise<void> {
    const baseUrl = BINANCE_REST_URLS[this.currentRestUrlIndex];
    const symbol = this.symbol.toUpperCase();
    
    try {
      // Use ticker/bookTicker for bid/ask (more data than ticker/price)
      const response = await axios.get(`${baseUrl}/ticker/bookTicker`, {
        params: { symbol },
        timeout: 5000,
      });
      
      const data = response.data;
      if (data.bidPrice && data.askPrice) {
        const bid = parseFloat(data.bidPrice);
        const ask = parseFloat(data.askPrice);
        const price: BinancePrice = {
          symbol: data.symbol,
          bid,
          ask,
          price: (bid + ask) / 2,
          timestamp: Date.now(),
        };
        
        this.lastPrice = price;
        this.notifyCallbacks(price);
      }
    } catch (error: any) {
      const status = error.response?.status;
      
      // Try next REST endpoint if this one fails
      if (status === 451 || status === 403 || status === 418) {
        this.currentRestUrlIndex++;
        if (this.currentRestUrlIndex >= BINANCE_REST_URLS.length) {
          this.currentRestUrlIndex = 0; // Cycle back
        }
        rateLimitedLog(this.log, 'warn', 'binance_rest_blocked', 60_000, 'rest.endpoint_blocked', {
          httpStatus: status,
          nextUrlIndex: this.currentRestUrlIndex,
        });
      }
    }
  }

  /**
   * Register callback for price updates
   */
  onPrice(callback: PriceCallback): void {
    this.callbacks.push(callback);
  }

  /**
   * Get last known price
   */
  getLastPrice(): BinancePrice | null {
    return this.lastPrice;
  }

  /**
   * Check if using REST fallback
   */
  isUsingRestFallback(): boolean {
    return this.usingRestFallback;
  }

  /**
   * Disconnect from WebSocket and stop polling
   */
  disconnect(): void {
    this.clearPingInterval();
    this.stopRestPolling();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private notifyCallbacks(price: BinancePrice): void {
    for (const cb of this.callbacks) {
      try {
        cb(price);
      } catch (err) {
        // Don't let callback errors crash
      }
    }
  }

  private clearPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.handleWsFailure();
      return;
    }
    
    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    
    this.log.info('ws.reconnecting', { delayMs: delay, attempt: this.reconnectAttempts, maxAttempts: this.maxReconnectAttempts });
    
    setTimeout(() => {
      this.connectWebSocket();
    }, delay);
  }
}
