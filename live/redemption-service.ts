/**
 * Redemption Service
 *
 * Auto-redeems resolved positions via Gnosis Safe → NegRiskAdapter → CTF.
 *
 * Key design:
 * - File-persisted queue (`data/pending-redemptions.json`) survives restarts
 * - redeemPositions() adds to queue first, then attempts — no capital lost on crash
 * - Contract reverts (already redeemed) remove from queue silently
 * - retryPending() sweeps the queue periodically for transient failures
 *
 * redeemPositions requires actual token amounts [yesBalance, noBalance],
 * NOT an empty array. We query CTF.balanceOf() for the Safe's on-chain balances.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ethers } from 'ethers';
import { createLogger } from '../core/logger';
import { sendTelegramMessage } from './telegram';

// =============================================================================
// CONTRACT ADDRESSES (Polygon mainnet)
// =============================================================================

const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

// =============================================================================
// MINIMAL ABIs (only functions we call)
// =============================================================================

const SAFE_ABI = [
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
];

const CTF_ABI = [
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function isApprovedForAll(address account, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
];

const NEG_RISK_ADAPTER_ABI = [
  'function redeemPositions(bytes32 conditionId, uint256[] amounts)',
];

// Delay before first attempt (ms) — gives on-chain resolution time to finalize
const REDEMPTION_DELAY_MS = 15_000;

// Retry config per attempt cycle
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 30_000;

// =============================================================================
// PENDING REDEMPTION QUEUE (persisted to disk)
// =============================================================================

interface PendingRedemption {
  conditionId: string;
  yesTokenId?: string;
  noTokenId?: string;
  addedAt: number;        // Unix ms when first queued
  lastAttemptAt: number;  // Unix ms of last attempt
  attemptCount: number;   // Total attempts across all cycles
}

// =============================================================================
// REDEMPTION SERVICE
// =============================================================================

export class RedemptionService {
  private wallet: ethers.Wallet;
  private safeAddress: string;
  private safe: ethers.Contract;
  private ctf: ethers.Contract;
  private approvalChecked = false;
  private log = createLogger('Redemption', { mode: 'live' });

  // Persistent queue
  private pending: PendingRedemption[] = [];
  private queueFile: string;

  // Guard against concurrent redemption attempts on the same conditionId
  private inFlight = new Set<string>();

  constructor(privateKey: string, funderAddress: string, rpcUrl: string, queueDir?: string) {
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    this.wallet = new ethers.Wallet(privateKey, provider);
    this.safeAddress = funderAddress;

    this.safe = new ethers.Contract(funderAddress, SAFE_ABI, this.wallet);
    this.ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, this.wallet);

    // Queue file persists across restarts
    const dataDir = queueDir ?? path.join(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    this.queueFile = path.join(dataDir, 'pending-redemptions.json');
    this.loadQueue();

    this.log.info('init', {
      safe: funderAddress.slice(0, 10),
      eoa: this.wallet.address.slice(0, 10),
      pendingCount: this.pending.length,
    });
  }

  /**
   * Queue and attempt redemption for a resolved market.
   * Persists to disk before attempting so no capital is lost on crash.
   */
  async redeemPositions(
    conditionId: string,
    yesTokenId?: string,
    noTokenId?: string
  ): Promise<void> {
    // Skip if already queued (dedup from double callback or rapid retrigger)
    if (this.pending.some(p => p.conditionId === conditionId)) {
      this.log.debug('redeem.already_queued', { conditionId: conditionId.slice(0, 18) });
      return;
    }

    // Add to persistent queue before attempting
    const entry: PendingRedemption = {
      conditionId,
      yesTokenId,
      noTokenId,
      addedAt: Date.now(),
      lastAttemptAt: 0,
      attemptCount: 0,
    };
    this.pending.push(entry);
    this.saveQueue();

    this.log.info('redeem.queued', { conditionId: conditionId.slice(0, 18) });

    // Wait for on-chain resolution to finalize
    this.log.debug('redeem.waiting_finality', { delaySec: REDEMPTION_DELAY_MS / 1000 });
    await this.sleep(REDEMPTION_DELAY_MS);

    await this.attemptRedemption(entry);
  }

  /**
   * Retry all pending redemptions that haven't been attempted recently.
   * Call this periodically (e.g., every 5 minutes) and on startup.
   */
  async retryPending(): Promise<void> {
    if (this.pending.length === 0) return;

    const now = Date.now();
    // Minimum 2 minutes between retry cycles for the same entry
    const MIN_RETRY_INTERVAL_MS = 120_000;

    this.log.info('retry.sweep_start', { pendingCount: this.pending.length });

    for (const entry of [...this.pending]) {
      if (this.inFlight.has(entry.conditionId)) continue;
      if (now - entry.lastAttemptAt < MIN_RETRY_INTERVAL_MS) continue;

      await this.attemptRedemption(entry);
    }
  }

  /**
   * Get count of pending redemptions (for status logging).
   */
  getPendingCount(): number {
    return this.pending.length;
  }

  // ===========================================================================
  // PRIVATE — Redemption attempt
  // ===========================================================================

  private async attemptRedemption(entry: PendingRedemption): Promise<void> {
    const { conditionId, yesTokenId, noTokenId } = entry;
    const shortId = conditionId.slice(0, 18);

    if (this.inFlight.has(conditionId)) return;
    this.inFlight.add(conditionId);

    try {
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        entry.lastAttemptAt = Date.now();
        entry.attemptCount++;
        this.saveQueue();

        try {
          this.log.info('redeem.attempt', { conditionId: shortId, attempt, total: entry.attemptCount });

          // Query actual on-chain balances for the Safe
          const yesBalance = yesTokenId
            ? await this.ctf.balanceOf(this.safeAddress, yesTokenId)
            : ethers.BigNumber.from(0);
          const noBalance = noTokenId
            ? await this.ctf.balanceOf(this.safeAddress, noTokenId)
            : ethers.BigNumber.from(0);

          this.log.info('redeem.balances', {
            conditionId: shortId,
            yesBalance: yesBalance.toString(),
            noBalance: noBalance.toString(),
          });

          if (yesBalance.isZero() && noBalance.isZero()) {
            this.log.info('redeem.no_tokens', { conditionId: shortId });
            this.removeFromQueue(conditionId);
            return;
          }

          // Ensure CTF approval for NegRiskAdapter (one-time)
          await this.ensureApproval();

          // Encode NegRiskAdapter.redeemPositions([yesBalance, noBalance])
          const iface = new ethers.utils.Interface(NEG_RISK_ADAPTER_ABI);
          const redeemData = iface.encodeFunctionData('redeemPositions', [
            conditionId,
            [yesBalance, noBalance],
          ]);

          // Execute through Safe
          const tx = await this.executeThroughSafe(NEG_RISK_ADAPTER, redeemData);

          if (tx) {
            const receipt = await tx.wait();
            this.log.info('redeem.success', {
              conditionId: shortId,
              txHash: receipt.transactionHash.slice(0, 18),
              gasUsed: receipt.gasUsed.toString(),
            });
            sendTelegramMessage(
              `<b>REDEEMED</b>\nMarket: ${shortId}...\nYES: ${yesBalance.toString()} | NO: ${noBalance.toString()}\nTX: ${receipt.transactionHash.slice(0, 18)}...`
            ).catch(() => {});
            this.removeFromQueue(conditionId);
            return;
          }
        } catch (err: any) {
          const msg = err.message?.slice(0, 120) || 'Unknown error';
          this.log.warn('redeem.attempt_failed', { conditionId: shortId, attempt, error: msg });

          // Contract revert → already redeemed or permanently invalid, remove from queue
          if (this.isContractRevert(err)) {
            this.log.info('redeem.contract_revert', { conditionId: shortId });
            this.removeFromQueue(conditionId);
            return;
          }

          if (attempt < MAX_RETRIES) {
            this.log.debug('redeem.retry_wait', { conditionId: shortId, delaySec: RETRY_DELAY_MS / 1000 });
            await this.sleep(RETRY_DELAY_MS);
          } else {
            // Exhausted retries for this cycle — keep in queue for retryPending()
            this.log.warn('redeem.cycle_exhausted', {
              conditionId: shortId,
              totalAttempts: entry.attemptCount,
            });
            sendTelegramMessage(
              `<b>Redemption deferred</b>\n${shortId}...\n${entry.attemptCount} total attempts\nWill retry next sweep`
            ).catch(() => {});
          }
        }
      }
    } finally {
      this.inFlight.delete(conditionId);
    }
  }

  // ===========================================================================
  // PRIVATE — Approval, Safe execution, helpers
  // ===========================================================================

  private async ensureApproval(): Promise<void> {
    if (this.approvalChecked) return;

    const isApproved = await this.ctf.isApprovedForAll(this.safeAddress, NEG_RISK_ADAPTER);

    if (!isApproved) {
      this.log.info('approval.setting', { operator: NEG_RISK_ADAPTER.slice(0, 10) });
      const iface = new ethers.utils.Interface(CTF_ABI);
      const approveData = iface.encodeFunctionData('setApprovalForAll', [NEG_RISK_ADAPTER, true]);
      const tx = await this.executeThroughSafe(CTF_ADDRESS, approveData);
      if (tx) {
        await tx.wait();
        this.log.info('approval.set');
      }
    }

    this.approvalChecked = true;
  }

  /**
   * Execute a call through the Gnosis Safe's execTransaction (1/1 Safe, EOA is owner).
   */
  private async executeThroughSafe(
    to: string,
    data: string
  ): Promise<ethers.ContractTransaction | null> {
    const nonce = await this.safe.nonce();
    const ZERO = ethers.constants.AddressZero;

    const txHash: string = await this.safe.getTransactionHash(
      to, 0, data, 0, 0, 0, 0, ZERO, ZERO, nonce
    );

    // EIP-191 personal sign + Safe v adjustment (+4)
    const signature = await this.wallet.signMessage(ethers.utils.arrayify(txHash));
    const sigBytes = ethers.utils.arrayify(signature);
    sigBytes[sigBytes.length - 1] += 4;
    const safeSignature = ethers.utils.hexlify(sigBytes);

    const tx = await this.safe.execTransaction(
      to, 0, data, 0, 0, 0, 0, ZERO, ZERO, safeSignature,
      { gasLimit: 500_000 }
    );

    return tx;
  }

  /**
   * Detect contract reverts that will never succeed on retry.
   */
  private isContractRevert(err: any): boolean {
    const msg = (err.message || '').toLowerCase();
    const code = err.code;

    if (code === 'CALL_EXCEPTION' || code === 'UNPREDICTABLE_GAS_LIMIT') return true;
    if (msg.includes('execution reverted')) return true;
    if (msg.includes('transaction gas')) return true;
    if (msg.includes('-32000')) return true;

    const innerCode = err.error?.code;
    if (innerCode === -32000 || innerCode === -32603) return true;

    return false;
  }

  // ===========================================================================
  // PRIVATE — Persistent queue management
  // ===========================================================================

  private removeFromQueue(conditionId: string): void {
    this.pending = this.pending.filter(p => p.conditionId !== conditionId);
    this.saveQueue();
    this.log.debug('queue.removed', { conditionId: conditionId.slice(0, 18), remaining: this.pending.length });
  }

  private saveQueue(): void {
    try {
      fs.writeFileSync(this.queueFile, JSON.stringify(this.pending, null, 2));
    } catch (err: any) {
      this.log.error('queue.save_failed', { error: err.message?.slice(0, 100) });
    }
  }

  private loadQueue(): void {
    try {
      if (fs.existsSync(this.queueFile)) {
        const raw = fs.readFileSync(this.queueFile, 'utf-8');
        this.pending = JSON.parse(raw) || [];
      }
    } catch (err: any) {
      this.log.warn('queue.load_failed', { error: err.message?.slice(0, 100) });
      this.pending = [];
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
