/**
 * Tests for RedemptionService: persistent queue, retry, dedup, logging.
 *
 * All I/O goes to os.tmpdir() — never touches data/ or project root.
 * All contract calls and network I/O are fully mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// =============================================================================
// MOCK ethers — must be before importing RedemptionService
// =============================================================================

// Mock balances returned by ctf.balanceOf
let mockYesBalance = { isZero: () => false, toString: () => '1000000' };
let mockNoBalance = { isZero: () => true, toString: () => '0' };

// Mock contract call results
let mockExecTxResult: any = {
  wait: vi.fn().mockResolvedValue({
    transactionHash: '0xabc123def456789012345678901234567890abcdef',
    gasUsed: { toString: () => '250000' },
  }),
};
let mockBalanceOfFn: Mock = vi.fn()
  .mockResolvedValueOnce(mockYesBalance)
  .mockResolvedValueOnce(mockNoBalance);
let mockIsApprovedFn: Mock = vi.fn().mockResolvedValue(true);
let mockNonceFn: Mock = vi.fn().mockResolvedValue(1);
let mockGetTxHashFn: Mock = vi.fn().mockResolvedValue('0x' + 'ab'.repeat(32));
let mockExecTxFn: Mock = vi.fn().mockResolvedValue(mockExecTxResult);
let mockShouldRevert = false;

vi.mock('ethers', () => {
  const BigNumber = {
    from: function (n: number) {
      return { isZero: () => n === 0, toString: () => String(n) };
    },
  };

  // Use regular functions (not arrows) so they work as constructors with `new`
  function MockJsonRpcProvider() { /* noop */ }
  function MockWallet() {
    return {
      address: '0x1234567890abcdef1234567890abcdef12345678',
      signMessage: vi.fn().mockResolvedValue('0x' + 'ff'.repeat(65)),
    };
  }
  function MockContract(this: any, _addr: string, abi: string[]) {
    const abiStr = JSON.stringify(abi);
    if (abiStr.includes('balanceOf')) {
      this.balanceOf = function (...args: any[]) { return mockBalanceOfFn(...args); };
      this.isApprovedForAll = function (...args: any[]) { return mockIsApprovedFn(...args); };
    } else if (abiStr.includes('nonce')) {
      this.nonce = function () { return mockNonceFn(); };
      this.getTransactionHash = function (...args: any[]) { return mockGetTxHashFn(...args); };
      this.execTransaction = function (...args: any[]) {
        if (mockShouldRevert) {
          const err: any = new Error('execution reverted');
          err.code = 'CALL_EXCEPTION';
          throw err;
        }
        return mockExecTxFn(...args);
      };
    }
  }
  function MockInterface() {
    return { encodeFunctionData: vi.fn().mockReturnValue('0xencoded') };
  }

  return {
    ethers: {
      providers: { JsonRpcProvider: MockJsonRpcProvider },
      Wallet: MockWallet,
      Contract: MockContract,
      BigNumber,
      utils: {
        Interface: MockInterface,
        arrayify: vi.fn().mockReturnValue(new Uint8Array(65)),
        hexlify: vi.fn().mockReturnValue('0x' + 'aa'.repeat(65)),
      },
      constants: {
        AddressZero: '0x' + '0'.repeat(40),
      },
    },
  };
});

// Mock telegram (prevent real messages)
vi.mock('../live/telegram', () => ({
  sendTelegramMessage: vi.fn().mockResolvedValue(undefined),
}));

import { RedemptionService } from '../live/redemption-service';

// =============================================================================
// HELPERS
// =============================================================================

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rs-test-'));
}

function cleanDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore
  }
}

function readQueue(dir: string): any[] {
  const file = path.join(dir, 'pending-redemptions.json');
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function writeQueue(dir: string, entries: any[]): void {
  fs.writeFileSync(path.join(dir, 'pending-redemptions.json'), JSON.stringify(entries, null, 2));
}

const FAKE_KEY = '0x' + 'ab'.repeat(32);
const FAKE_SAFE = '0x' + 'cd'.repeat(20);
const FAKE_RPC = 'https://fake-rpc.test';

function createService(dir: string): RedemptionService {
  return new RedemptionService(FAKE_KEY, FAKE_SAFE, FAKE_RPC, dir);
}

// =============================================================================
// TEST SUITE 3: Persistent redemption queue
// =============================================================================

describe('Persistent redemption queue', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mockShouldRevert = false;

    // Reset mock implementations to defaults
    mockExecTxResult = {
      wait: vi.fn().mockResolvedValue({
        transactionHash: '0xabc123def456789012345678901234567890abcdef',
        gasUsed: { toString: () => '250000' },
      }),
    };

    mockYesBalance = { isZero: () => false, toString: () => '1000000' };
    mockNoBalance = { isZero: () => true, toString: () => '0' };

    mockBalanceOfFn = vi.fn()
      .mockImplementation((_addr: string, tokenId: string) => {
        if (tokenId === 'token-yes') return Promise.resolve(mockYesBalance);
        return Promise.resolve(mockNoBalance);
      });

    mockIsApprovedFn = vi.fn().mockResolvedValue(true);
    mockNonceFn = vi.fn().mockResolvedValue(1);
    mockGetTxHashFn = vi.fn().mockResolvedValue('0x' + 'ab'.repeat(32));
    mockExecTxFn = vi.fn().mockResolvedValue(mockExecTxResult);
  });

  afterEach(() => {
    cleanDir(tmpDir);
    vi.restoreAllMocks();
  });

  it('happy path: queue → redeem → remove from file', async () => {
    const svc = createService(tmpDir);

    // Override sleep to be instant
    (svc as any).sleep = vi.fn().mockResolvedValue(undefined);

    await svc.redeemPositions('cond-happy', 'token-yes', 'token-no');

    // Queue file should be empty after successful redemption
    const queue = readQueue(tmpDir);
    expect(queue).toHaveLength(0);
    expect(svc.getPendingCount()).toBe(0);
  });

  it('crash recovery: loads pending from file and retries', async () => {
    // Pre-write a pending entry (simulating crash before completion)
    writeQueue(tmpDir, [{
      conditionId: 'cond-crashed',
      yesTokenId: 'token-yes',
      noTokenId: 'token-no',
      addedAt: Date.now() - 600_000,
      lastAttemptAt: 0,
      attemptCount: 0,
    }]);

    const svc = createService(tmpDir);

    // Override sleep
    (svc as any).sleep = vi.fn().mockResolvedValue(undefined);

    // Should have loaded the pending entry
    expect(svc.getPendingCount()).toBe(1);

    // Retry should process it
    await svc.retryPending();

    // Successfully redeemed — removed from queue
    expect(svc.getPendingCount()).toBe(0);
    expect(readQueue(tmpDir)).toHaveLength(0);
  });

  it('transient failure keeps entry in queue for later retry', async () => {
    // Make the Safe execution throw a transient (non-revert) error
    mockExecTxFn = vi.fn().mockRejectedValue(new Error('TIMEOUT: network connection lost'));

    const svc = createService(tmpDir);
    (svc as any).sleep = vi.fn().mockResolvedValue(undefined);

    await svc.redeemPositions('cond-transient', 'token-yes', 'token-no');

    // Entry should remain in queue (transient failure, not a revert)
    const queue = readQueue(tmpDir);
    expect(queue).toHaveLength(1);
    expect(queue[0].conditionId).toBe('cond-transient');
    expect(queue[0].attemptCount).toBe(3); // 3 retries exhausted
    expect(svc.getPendingCount()).toBe(1);
  });

  it('in-flight guard prevents concurrent calls for same conditionId', async () => {
    let resolveFirst: () => void;
    const blockingPromise = new Promise<void>(r => { resolveFirst = r; });

    // Make first call block until we release it
    let execCallCount = 0;
    mockExecTxFn = vi.fn().mockImplementation(async () => {
      execCallCount++;
      if (execCallCount === 1) {
        await blockingPromise; // Block first call
      }
      return mockExecTxResult;
    });

    const svc = createService(tmpDir);
    (svc as any).sleep = vi.fn().mockResolvedValue(undefined);

    // Fire two concurrent redemptions for the same conditionId
    const p1 = svc.redeemPositions('cond-concurrent', 'token-yes', 'token-no');

    // Small delay to let p1 start
    await new Promise(r => setTimeout(r, 50));

    const p2 = svc.redeemPositions('cond-concurrent', 'token-yes', 'token-no');

    // Release the blocking call
    resolveFirst!();

    await Promise.all([p1, p2]);

    // Only one queue entry ever created (dedup), only one contract call
    // The second call was rejected by the "already queued" check
    expect(execCallCount).toBe(1);
  });

  it('already-redeemed (contract revert) removes entry from queue', async () => {
    mockShouldRevert = true;

    const svc = createService(tmpDir);
    (svc as any).sleep = vi.fn().mockResolvedValue(undefined);

    await svc.redeemPositions('cond-already-redeemed', 'token-yes', 'token-no');

    // Should be removed from queue (revert = already redeemed, no retry needed)
    expect(readQueue(tmpDir)).toHaveLength(0);
    expect(svc.getPendingCount()).toBe(0);
  });

  it('dedup: double call with same conditionId creates only 1 queue entry', async () => {
    // Make redemption slow enough that second call arrives before first completes
    let callCount = 0;
    mockExecTxFn = vi.fn().mockImplementation(async () => {
      callCount++;
      await new Promise(r => setTimeout(r, 100));
      return mockExecTxResult;
    });

    const svc = createService(tmpDir);
    (svc as any).sleep = vi.fn().mockResolvedValue(undefined);

    // Fire two simultaneous calls
    const p1 = svc.redeemPositions('cond-dedup', 'token-yes', 'token-no');
    // Second call happens immediately — before first writes to disk
    const p2 = svc.redeemPositions('cond-dedup', 'token-yes', 'token-no');

    await Promise.all([p1, p2]);

    // Should have made at most 1 contract call
    expect(callCount).toBeLessThanOrEqual(1);
  });
});

// =============================================================================
// TEST SUITE 4: Structured logging (no console.log leaks)
// =============================================================================

describe('Structured logging in RedemptionService', () => {
  let tmpDir: string;

  // Capture ALL console output
  const origConsoleLog = console.log;
  const origConsoleWarn = console.warn;
  const origConsoleError = console.error;
  let loggedLines: string[] = [];

  beforeEach(() => {
    tmpDir = makeTmpDir();
    loggedLines = [];
    mockShouldRevert = false;

    mockExecTxResult = {
      wait: vi.fn().mockResolvedValue({
        transactionHash: '0xabc123def456789012345678901234567890abcdef',
        gasUsed: { toString: () => '250000' },
      }),
    };

    mockYesBalance = { isZero: () => false, toString: () => '1000000' };
    mockNoBalance = { isZero: () => true, toString: () => '0' };

    mockBalanceOfFn = vi.fn().mockImplementation((_addr: string, tokenId: string) => {
      if (tokenId === 'token-yes') return Promise.resolve(mockYesBalance);
      return Promise.resolve(mockNoBalance);
    });

    mockIsApprovedFn = vi.fn().mockResolvedValue(true);
    mockNonceFn = vi.fn().mockResolvedValue(1);
    mockGetTxHashFn = vi.fn().mockResolvedValue('0x' + 'ab'.repeat(32));
    mockExecTxFn = vi.fn().mockResolvedValue(mockExecTxResult);

    // Intercept ALL console methods — capture the output
    console.log = (...args: any[]) => { loggedLines.push(args.join(' ')); };
    console.warn = (...args: any[]) => { loggedLines.push(args.join(' ')); };
    console.error = (...args: any[]) => { loggedLines.push(args.join(' ')); };
  });

  afterEach(() => {
    console.log = origConsoleLog;
    console.warn = origConsoleWarn;
    console.error = origConsoleError;
    cleanDir(tmpDir);
    vi.restoreAllMocks();
  });

  it('happy path logs correct structured events in order', async () => {
    const svc = createService(tmpDir);
    (svc as any).sleep = vi.fn().mockResolvedValue(undefined);

    await svc.redeemPositions('cond-log-happy', 'token-yes', 'token-no');

    // All output goes through the structured logger (via console.log/warn internally)
    // The logger formats lines like: "2025-... [INFO] [Redemption] redeem.queued | ..."
    // Check that the expected structured events appear in order
    const events = loggedLines
      .filter(line => line.includes('[Redemption]'))
      .map(line => {
        // Extract the event name from structured log format
        const match = line.match(/\[Redemption\]\s+([\w.]+)/);
        return match ? match[1] : null;
      })
      .filter(Boolean);

    expect(events).toContain('redeem.queued');
    expect(events).toContain('redeem.attempt');
    expect(events).toContain('redeem.balances');
    expect(events).toContain('redeem.success');

    // No raw "[Redemption] " prefixed console.log (the old pattern was e.g. "[Redemption] Waiting...")
    const rawLogs = loggedLines.filter(line =>
      line.startsWith('[Redemption]') && !line.includes('[INFO]') && !line.includes('[DBG ]')
    );
    expect(rawLogs).toHaveLength(0);
  });

  it('failure path logs structured error events', async () => {
    mockExecTxFn = vi.fn().mockRejectedValue(new Error('TIMEOUT'));

    const svc = createService(tmpDir);
    (svc as any).sleep = vi.fn().mockResolvedValue(undefined);

    await svc.redeemPositions('cond-log-fail', 'token-yes', 'token-no');

    const events = loggedLines
      .filter(line => line.includes('[Redemption]'))
      .map(line => {
        const match = line.match(/\[Redemption\]\s+([\w.]+)/);
        return match ? match[1] : null;
      })
      .filter(Boolean);

    expect(events).toContain('redeem.queued');
    expect(events).toContain('redeem.attempt');
    expect(events).toContain('redeem.attempt_failed');
    expect(events).toContain('redeem.cycle_exhausted');
  });
});
