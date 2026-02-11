/**
 * Redemption Service
 *
 * Auto-redeems winning positions after market resolution via Gnosis Safe.
 * Calls NegRiskAdapter.redeemPositions() through the Safe's execTransaction.
 * No new dependencies — uses ethers.js (already installed).
 */

import { ethers } from 'ethers';
import { sendTelegramMessage } from './telegram';

// =============================================================================
// CONTRACT ADDRESSES (Polygon mainnet, from @polymarket/clob-client config)
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

// =============================================================================
// REDEMPTION SERVICE
// =============================================================================

export class RedemptionService {
  private wallet: ethers.Wallet;
  private safeAddress: string;
  private safe: ethers.Contract;
  private ctf: ethers.Contract;
  private negRiskAdapter: ethers.Contract;
  private approvalChecked = false;

  constructor(privateKey: string, funderAddress: string, rpcUrl: string) {
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    this.wallet = new ethers.Wallet(privateKey, provider);
    this.safeAddress = funderAddress;

    this.safe = new ethers.Contract(funderAddress, SAFE_ABI, this.wallet);
    this.ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, this.wallet);
    this.negRiskAdapter = new ethers.Contract(NEG_RISK_ADAPTER, NEG_RISK_ADAPTER_ABI, this.wallet);

    console.log(`[Redemption] Initialized: Safe=${funderAddress.slice(0, 10)}... EOA=${this.wallet.address.slice(0, 10)}...`);
  }

  /**
   * Redeem positions for a resolved market.
   * Queries token balances on the Safe, then calls NegRiskAdapter.redeemPositions
   * through the Safe's execTransaction.
   */
  async redeemPositions(conditionId: string): Promise<void> {
    try {
      console.log(`[Redemption] Attempting redemption for ${conditionId.slice(0, 18)}...`);

      // Ensure CTF approval for NegRiskAdapter (one-time)
      await this.ensureApproval();

      // Encode the NegRiskAdapter.redeemPositions call
      // For negRisk binary markets, pass conditionId and empty amounts array
      // The adapter redeems all tokens the caller (Safe) holds
      const iface = new ethers.utils.Interface(NEG_RISK_ADAPTER_ABI);
      const redeemData = iface.encodeFunctionData('redeemPositions', [
        conditionId,
        [], // empty amounts = redeem all
      ]);

      // Execute through Safe
      const tx = await this.executeThroughSafe(NEG_RISK_ADAPTER, redeemData);

      if (tx) {
        const receipt = await tx.wait();
        console.log(`[Redemption] TX confirmed: ${receipt.transactionHash} | Gas: ${receipt.gasUsed.toString()}`);
        sendTelegramMessage(
          `💰 <b>REDEEMED</b>\nMarket: ${conditionId.slice(0, 18)}...\nTX: ${receipt.transactionHash.slice(0, 18)}...`
        ).catch(() => {});
      }
    } catch (err: any) {
      const msg = err.message?.slice(0, 100) || 'Unknown error';
      console.log(`[Redemption] Failed: ${msg}`);
      sendTelegramMessage(`⚠️ <b>Redemption failed</b>\n${conditionId.slice(0, 18)}...\n${msg}`).catch(() => {});
    }
  }

  /**
   * Ensure the Safe has approved the NegRiskAdapter as an operator on the CTF contract.
   * Only checks once per session; sets approval if needed.
   */
  private async ensureApproval(): Promise<void> {
    if (this.approvalChecked) return;

    const isApproved = await this.ctf.isApprovedForAll(this.safeAddress, NEG_RISK_ADAPTER);

    if (!isApproved) {
      console.log(`[Redemption] Setting CTF approval for NegRiskAdapter...`);
      const iface = new ethers.utils.Interface(CTF_ABI);
      const approveData = iface.encodeFunctionData('setApprovalForAll', [NEG_RISK_ADAPTER, true]);
      const tx = await this.executeThroughSafe(CTF_ADDRESS, approveData);
      if (tx) {
        await tx.wait();
        console.log(`[Redemption] CTF approval set`);
      }
    }

    this.approvalChecked = true;
  }

  /**
   * Execute an arbitrary call through the Gnosis Safe's execTransaction.
   *
   * For a 1/1 Safe where the caller IS the owner:
   * 1. Get nonce from safe.nonce()
   * 2. Compute txHash via safe.getTransactionHash(...)
   * 3. Sign with wallet.signMessage (EIP-191 personal sign)
   * 4. Adjust v += 4 (Safe convention for eth_sign)
   * 5. Call safe.execTransaction with the adjusted signature
   */
  private async executeThroughSafe(
    to: string,
    data: string
  ): Promise<ethers.ContractTransaction | null> {
    const nonce = await this.safe.nonce();
    const ZERO = ethers.constants.AddressZero;

    // Compute the Safe transaction hash
    const txHash: string = await this.safe.getTransactionHash(
      to,       // to
      0,        // value
      data,     // data
      0,        // operation (CALL)
      0,        // safeTxGas
      0,        // baseGas
      0,        // gasPrice (0 = EOA pays)
      ZERO,     // gasToken
      ZERO,     // refundReceiver
      nonce     // _nonce
    );

    // Sign with EIP-191 personal sign
    const signature = await this.wallet.signMessage(ethers.utils.arrayify(txHash));

    // Adjust v for Safe: eth_sign signatures use v += 4
    const sigBytes = ethers.utils.arrayify(signature);
    sigBytes[sigBytes.length - 1] += 4;
    const safeSignature = ethers.utils.hexlify(sigBytes);

    // Execute
    const tx = await this.safe.execTransaction(
      to,
      0,
      data,
      0,        // operation
      0,        // safeTxGas
      0,        // baseGas
      0,        // gasPrice
      ZERO,     // gasToken
      ZERO,     // refundReceiver
      safeSignature,
      { gasLimit: 500_000 }
    );

    return tx;
  }
}
