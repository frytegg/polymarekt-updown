/**
 * Tests for TradePersistence: cross-midnight recovery & dedup market resolution.
 *
 * All I/O goes to os.tmpdir() — never touches data/ or project root.
 * All network calls are mocked — zero real API calls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock global fetch before importing the module that uses it
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { TradePersistence, PaperTrade, PaperPosition } from '../live/trade-persistence';

// =============================================================================
// HELPERS
// =============================================================================

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tp-test-'));
}

function cleanDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

/** Build a minimal valid paper-trades JSON file. */
function buildTradeFile(options: {
  trades?: Partial<PaperTrade>[];
  positions?: Partial<PaperPosition>[];
  resolutions?: any[];
  nextTradeId?: number;
  nextResolutionId?: number;
}): string {
  const trades = (options.trades || []).map((t, i) => ({
    id: i + 1,
    timestamp: new Date().toISOString(),
    marketId: 'cond-abc-123',
    tokenId: 'token-yes-001',
    side: 'YES',
    price: 0.50,
    size: 10,
    fairValue: 0.55,
    edge: 0.10,
    fee: 0.02,
    adjustment: 0,
    adjustmentMethod: 'ema',
    btcPrice: 95000,
    strike: 95000,
    timeRemainingMs: 600000,
    marketEndTime: Date.now() - 300_000, // Expired 5 min ago
    cost: 5.0,
    maxProfit: 4.98,
    maxLoss: 5.02,
    resolved: false,
    ...t,
  }));

  const positions = (options.positions || []).map(p => ({
    tokenId: 'token-yes-001',
    marketId: 'cond-abc-123',
    side: 'YES',
    avgPrice: 0.50,
    shares: 10,
    totalCost: 5.0,
    totalFees: 0.02,
    tradeIds: [1],
    marketEndTime: Date.now() - 300_000,
    strike: 95000,
    maxProfit: 4.98,
    maxLoss: 5.02,
    ...p,
  }));

  return JSON.stringify({
    trades,
    positions,
    resolutions: options.resolutions || [],
    stats: {},
    meta: {
      nextTradeId: options.nextTradeId || trades.length + 1,
      nextResolutionId: options.nextResolutionId || 1,
      savedAt: new Date().toISOString(),
    },
  }, null, 2);
}

/** Get the date string for N days ago (YYYY-MM-DD). */
function dateNDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

function todayStr(): string {
  return new Date().toISOString().split('T')[0];
}

// =============================================================================
// TEST SUITE 1: Cross-midnight recovery (recoverOrphanedPositions)
// =============================================================================

describe('Cross-midnight recovery', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mockFetch.mockReset();
  });

  afterEach(() => {
    cleanDir(tmpDir);
  });

  it('recovers orphaned position from yesterday file', () => {
    const yesterday = dateNDaysAgo(1);
    const today = todayStr();

    // Yesterday's file has an unresolved position
    const yesterdayFile = path.join(tmpDir, `paper-trades-${yesterday}.json`);
    fs.writeFileSync(yesterdayFile, buildTradeFile({
      trades: [{
        id: 1,
        tokenId: 'token-orphan-yes',
        marketId: 'cond-orphan-market',
        resolved: false,
      }],
      positions: [{
        tokenId: 'token-orphan-yes',
        marketId: 'cond-orphan-market',
        tradeIds: [1],
      }],
    }));

    // Today's file does not exist (first boot after midnight)
    const tracker = new TradePersistence(tmpDir);
    const positions = tracker.getPositions();

    expect(positions).toHaveLength(1);
    expect(positions[0].tokenId).toBe('token-orphan-yes');
    expect(positions[0].marketId).toBe('cond-orphan-market');

    // Verify it was saved to today's file
    const todayFile = path.join(tmpDir, `paper-trades-${today}.json`);
    expect(fs.existsSync(todayFile)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(todayFile, 'utf-8'));
    expect(saved.positions).toHaveLength(1);
    expect(saved.positions[0].tokenId).toBe('token-orphan-yes');
  });

  it('skips already-resolved positions from old files', () => {
    const yesterday = dateNDaysAgo(1);

    // Yesterday's file has a resolved position (no unresolved trades)
    const yesterdayFile = path.join(tmpDir, `paper-trades-${yesterday}.json`);
    fs.writeFileSync(yesterdayFile, buildTradeFile({
      trades: [{
        id: 1,
        tokenId: 'token-resolved',
        marketId: 'cond-resolved',
        resolved: true,
        outcome: 'WIN',
        pnl: 4.5,
      }],
      positions: [], // No open positions (resolved = removed from positions)
    }));

    const tracker = new TradePersistence(tmpDir);
    const positions = tracker.getPositions();

    // No positions recovered — the file had none
    expect(positions).toHaveLength(0);
  });

  it('handles corrupted files gracefully', () => {
    const yesterday = dateNDaysAgo(1);
    const twoDaysAgo = dateNDaysAgo(2);

    // Corrupted file
    fs.writeFileSync(
      path.join(tmpDir, `paper-trades-${twoDaysAgo}.json`),
      '{INVALID JSON HERE!!!',
    );

    // Valid file from yesterday
    fs.writeFileSync(
      path.join(tmpDir, `paper-trades-${yesterday}.json`),
      buildTradeFile({
        trades: [{
          id: 1,
          tokenId: 'token-valid',
          marketId: 'cond-valid',
          resolved: false,
        }],
        positions: [{
          tokenId: 'token-valid',
          marketId: 'cond-valid',
          tradeIds: [1],
        }],
      }),
    );

    // Should not throw, and should still recover the valid file
    const tracker = new TradePersistence(tmpDir);
    const positions = tracker.getPositions();

    expect(positions).toHaveLength(1);
    expect(positions[0].tokenId).toBe('token-valid');
  });

  it('does not duplicate positions present in both old and today file', () => {
    const yesterday = dateNDaysAgo(1);
    const today = todayStr();

    const sharedPosition = {
      tokenId: 'token-shared',
      marketId: 'cond-shared',
      tradeIds: [1],
    };
    const sharedTrade = {
      id: 1,
      tokenId: 'token-shared',
      marketId: 'cond-shared',
      resolved: false,
    };

    // Position in yesterday's file
    fs.writeFileSync(
      path.join(tmpDir, `paper-trades-${yesterday}.json`),
      buildTradeFile({ trades: [sharedTrade], positions: [sharedPosition] }),
    );

    // Same position also in today's file
    fs.writeFileSync(
      path.join(tmpDir, `paper-trades-${today}.json`),
      buildTradeFile({ trades: [sharedTrade], positions: [sharedPosition] }),
    );

    const tracker = new TradePersistence(tmpDir);
    const positions = tracker.getPositions();

    // Should appear exactly once (today's file takes precedence)
    expect(positions).toHaveLength(1);
    expect(positions[0].tokenId).toBe('token-shared');
  });
});

// =============================================================================
// TEST SUITE 2: Dedup market resolution (checkAndResolveExpired)
// =============================================================================

describe('Dedup market resolution (checkAndResolveExpired)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mockFetch.mockReset();
  });

  afterEach(() => {
    cleanDir(tmpDir);
  });

  it('single API call when both YES+NO positions exist for same market', async () => {
    const today = todayStr();
    const expiredTime = Date.now() - 300_000; // 5 min ago (well past 2-min buffer)
    const conditionId = 'cond-dual-positions';

    // Create file with both YES and NO positions for same market
    fs.writeFileSync(
      path.join(tmpDir, `paper-trades-${today}.json`),
      buildTradeFile({
        trades: [
          { id: 1, tokenId: 'token-yes-dual', marketId: conditionId, side: 'YES', resolved: false, marketEndTime: expiredTime },
          { id: 2, tokenId: 'token-no-dual', marketId: conditionId, side: 'NO', resolved: false, marketEndTime: expiredTime },
        ],
        positions: [
          { tokenId: 'token-yes-dual', marketId: conditionId, side: 'YES', tradeIds: [1], marketEndTime: expiredTime },
          { tokenId: 'token-no-dual', marketId: conditionId, side: 'NO', tradeIds: [2], marketEndTime: expiredTime },
        ],
        nextTradeId: 3,
      }),
    );

    const tracker = new TradePersistence(tmpDir);
    expect(tracker.getPositions()).toHaveLength(2);

    // Mock the CLOB API response — market resolved UP
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        closed: true,
        tokens: [
          { token_id: 'token-yes-dual', winner: true, price: '1.00' },
          { token_id: 'token-no-dual', winner: false, price: '0.00' },
        ],
      }),
    });

    // Track redemption callbacks
    const redemptionCalls: string[] = [];
    tracker.onRedemptionNeeded = (condId, yesId, noId) => {
      redemptionCalls.push(condId);
    };

    await tracker.checkAndResolveExpired();

    // API called exactly ONCE (not twice)
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining(conditionId),
    );

    // Redemption callback fired exactly ONCE
    expect(redemptionCalls).toHaveLength(1);
    expect(redemptionCalls[0]).toBe(conditionId);

    // Both positions should be resolved (removed)
    expect(tracker.getPositions()).toHaveLength(0);

    // Both trades should be marked resolved
    const resolved = tracker.getPastTrades();
    expect(resolved).toHaveLength(2);
  });

  it('resolves independent markets separately', async () => {
    const today = todayStr();
    const expiredTime = Date.now() - 300_000;

    fs.writeFileSync(
      path.join(tmpDir, `paper-trades-${today}.json`),
      buildTradeFile({
        trades: [
          { id: 1, tokenId: 'token-mkt1-yes', marketId: 'cond-market-1', side: 'YES', resolved: false, marketEndTime: expiredTime },
          { id: 2, tokenId: 'token-mkt2-no', marketId: 'cond-market-2', side: 'NO', resolved: false, marketEndTime: expiredTime },
        ],
        positions: [
          { tokenId: 'token-mkt1-yes', marketId: 'cond-market-1', side: 'YES', tradeIds: [1], marketEndTime: expiredTime },
          { tokenId: 'token-mkt2-no', marketId: 'cond-market-2', side: 'NO', tradeIds: [2], marketEndTime: expiredTime },
        ],
        nextTradeId: 3,
      }),
    );

    const tracker = new TradePersistence(tmpDir);

    // Both markets resolve
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        closed: true,
        tokens: [
          { token_id: 'x', winner: true, price: '1.00' },
          { token_id: 'y', winner: false, price: '0.00' },
        ],
      }),
    });

    const redemptionCalls: string[] = [];
    tracker.onRedemptionNeeded = (condId) => {
      redemptionCalls.push(condId);
    };

    await tracker.checkAndResolveExpired();

    // Two independent API calls (one per market)
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Two redemption callbacks
    expect(redemptionCalls).toHaveLength(2);
    expect(redemptionCalls).toContain('cond-market-1');
    expect(redemptionCalls).toContain('cond-market-2');

    // All positions resolved
    expect(tracker.getPositions()).toHaveLength(0);
  });
});
