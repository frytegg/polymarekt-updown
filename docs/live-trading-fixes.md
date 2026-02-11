# Live Trading Fixes

Bugs and features discovered during first live deployment on AWS (Ireland).
Apply these to any repo using `@polymarket/clob-client` with FAK orders and Gnosis Safe wallets.

---

## 1. ClobClient Credentials Not Persisted (Auth Failure)

**Symptom**: `"API Credentials are needed to interact with this endpoint!"`

**Root cause**: `ClobClient.createOrDeriveApiKey()` returns the `ApiKeyCreds` object but does **NOT** set `this.creds` internally. Only the constructor sets it.

**Fix**: After deriving creds, re-create the entire ClobClient with creds passed to the constructor:

```typescript
const creds = await client.createOrDeriveApiKey();

// WRONG: creds are returned but NOT stored on the client instance
// client is still missing this.creds — all orders will fail

// CORRECT: rebuild client with creds in constructor
client = new ClobClient(host, chain, wallet, creds, signatureType, funderAddress);
```

**Also note**: The creds type is `ApiKeyCreds` with field `key` (NOT `apiKey`), `secret`, `passphrase`.

---

## 2. FAK Errors Returned Instead of Thrown (Phantom Fills)

**Symptom**: FAK order gets killed ("no orders found to match"), but bot records it as a successful fill. Telegram shows trades that never happened on-chain.

**Root cause**: ClobClient's internal `http-helpers/index.js` `post()` method catches Axios errors and **returns** `{ error: "...", status: 400 }` instead of throwing. Our code only checked `response?.errorMsg` (wrong field).

**Fix**: Check both `response.error` and `response.errorMsg`:

```typescript
const errorMsg = response?.errorMsg || response?.error;
if (errorMsg) {
  return { success: false, error: typeof errorMsg === 'string' ? errorMsg : JSON.stringify(errorMsg) };
}
```

---

## 3. FAK BUY Amount: USD, Not Shares (Position Sizing Overspend)

**Symptom**: Bot intends to buy 3 shares at 37c ($1.11 cost), but actually spends $3.00 (~8 shares). Wallet overexposed by ~3x.

**Root cause**: `createAndPostMarketOrder` takes a `UserMarketOrder` where `amount` means:
- **BUY**: USD to spend
- **SELL**: shares to sell

The bot's `calculateOrderSize(price)` returns **shares**, which was passed directly as `amount`.

**Fix**: Convert shares to USD cost before passing to the API:

```typescript
const amountUsd = orderConfig.side === Side.BUY
  ? orderConfig.size * orderConfig.price   // shares x price = USD to spend
  : orderConfig.size;                       // SELL: amount = shares

const response = await client.createAndPostMarketOrder({
  tokenID: orderConfig.tokenId,
  price: orderConfig.price,
  amount: amountUsd,  // NOT orderConfig.size for BUY!
  side: orderConfig.side,
});
```

---

## 4. Verbose Credential Logging

**Why**: When auth fails on a remote server, you need to know which piece is missing without SSH debugging.

**What to log on init**:

```typescript
console.log(`[TradingService] EOA (signer):     ${wallet.address}`);
console.log(`[TradingService] Funder (proxy):    ${config.funderAddress}`);
console.log(`[TradingService] Signature type:    ${config.signatureType}`);
console.log(`[TradingService] CLOB host:         ${config.clobHost}`);

// After deriving creds:
const hasApiKey = !!creds?.key;
const hasSecret = !!creds?.secret;
const hasPassphrase = !!creds?.passphrase;
console.log(`[TradingService] API Key: ${hasApiKey ? 'OK' : 'MISSING'} | Secret: ${hasSecret ? 'OK' : 'MISSING'} | Passphrase: ${hasPassphrase ? 'OK' : 'MISSING'}`);
```

---

## 5. FUNDER_ADDRESS Must Be the Polymarket Proxy Wallet

**Symptom**: `"Could not create api key"` (400) during credential derivation.

**Root cause**: `FUNDER_ADDRESS` was set to the wrong address. It must be the **Polymarket-created Gnosis Safe proxy wallet**, not your EOA or a personal wallet.

**How to find it**: Look at your deposit TX on Polygonscan. The USDC recipient is your Polymarket proxy wallet (the `to` address on the internal USDC transfer). This is the address Polymarket creates when you first deposit.

---

## 6. Auto-Redemption of Winning Positions

**Problem**: Polymarket does NOT auto-redeem winning tokens. After market resolution, USDC sits locked in CTF tokens until manually claimed via the UI.

**Solution**: New `RedemptionService` class that calls `NegRiskAdapter.redeemPositions()` through the Gnosis Safe's `execTransaction` after each market resolves.

**Key details**:
- Positions are held by the Safe proxy, so all on-chain calls must route through `safe.execTransaction()`
- BTC Up/Down uses `negRisk: true` — must use NegRiskAdapter (not raw CTF) to get USDC back
- One-time CTF approval needed: `CTF.setApprovalForAll(NegRiskAdapter, true)` via Safe
- Safe 1/1 signing: `getTransactionHash() -> wallet.signMessage() -> v += 4 -> execTransaction()`
- EOA needs a small MATIC/POL balance on Polygon for gas (~0.01 per redemption)

**Contract addresses** (Polygon):
- CTF: `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045`
- NegRiskAdapter: `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296`

**Integration**: Wire a callback from your resolution tracker:
```typescript
tracker.onRedemptionNeeded = (conditionId: string, yesTokenId?: string, noTokenId?: string) => {
  redemptionService.redeemPositions(conditionId, yesTokenId, noTokenId).catch(err => {
    console.log(`[Redemption] Error: ${err.message}`);
  });
};
```

---

## 7. Redemption Requires Actual Token Amounts (Not Empty Array)

**Symptom**: Redemption TX succeeds silently but no USDC returned. Manual redeem via UI still required.

**Root cause**: `NegRiskAdapter.redeemPositions(conditionId, amounts)` requires `amounts` to be a **length-2 array** `[yesBalance, noBalance]` with actual on-chain CTF token balances. Passing `[]` (empty array) means `safeBatchTransferFrom` transfers nothing, so payout is zero.

From the [NegRiskAdapter Solidity source](https://github.com/Polymarket/neg-risk-ctf-adapter/blob/main/src/NegRiskAdapter.sol):
```solidity
function redeemPositions(bytes32 _conditionId, uint256[] calldata _amounts) public {
    uint256[] memory positionIds = Helpers.positionIds(address(wcol), _conditionId);
    ctf.safeBatchTransferFrom(msg.sender, address(this), positionIds, _amounts, "");
    // ...
}
```

**Fix**: Query actual CTF balances before calling redeem, and pass token IDs through the callback:

```typescript
// Query on-chain balances for the Safe proxy wallet
const yesBalance = yesTokenId
  ? await ctf.balanceOf(safeAddress, yesTokenId)
  : BigNumber.from(0);
const noBalance = noTokenId
  ? await ctf.balanceOf(safeAddress, noTokenId)
  : BigNumber.from(0);

// Pass actual amounts — NOT empty array!
const redeemData = iface.encodeFunctionData('redeemPositions', [
  conditionId,
  [yesBalance, noBalance],  // was: []
]);
```

Also added:
- 15s delay before first attempt (on-chain resolution finality)
- 3 retries with 30s spacing
- Token IDs passed through `onRedemptionNeeded` callback

---

## 8. Resolution Tracking Never Resolves Trades (Slug-Based API Lookup)

**Symptom**: `/stats` shows all trades as "open" with 0 resolved, even hours after markets closed. P&L stuck at $0.00.

**Root cause (two bugs)**:

**Bug A**: `fetchMarketOutcome()` searched the Gamma API by event slug (`btc-up-or-down-15m`). This slug doesn't match the actual event slugs, so the market is never found and outcome is always `null`. Positions never resolve.

**Fix**: Use CLOB API with direct conditionId lookup:

```typescript
// WRONG: slug-based search — unreliable, slug varies
const response = await fetch(
  `https://gamma-api.polymarket.com/events?slug=btc-up-or-down-15m&limit=100`
);

// CORRECT: direct conditionId lookup — guaranteed to find the market
const response = await fetch(
  `https://clob.polymarket.com/markets/${conditionId}`
);
const market = await response.json();
if (market.closed) {
  if (market.tokens[0]?.winner === true) return 'UP';
  if (market.tokens[1]?.winner === true) return 'DOWN';
}
```

**Bug B**: `loadFromFile()` dropped expired positions on restart, orphaning their trades as permanently "open". Trades were loaded with `resolved: false` but had no position for `checkAndResolveExpired` to find.

**Fix**: Keep expired positions during load. Let `checkAndResolveExpired()` resolve them via the API on the next 30s cycle.

---

## 9. Startup Cooldown (False Signals from Stale Oracle Adjustment)

**Symptom**: Immediate edge detection and fills within seconds of bot startup. These trades frequently lose.

**Root cause**: At startup the divergence EMA tracker has zero data points, so the bot falls back to the static `ARB_ORACLE_ADJUSTMENT` (e.g., -$104). If the actual Binance-Chainlink divergence at that moment is -$40, the bot shifts BTC price down by an extra $64 — enough to manufacture a phantom 20%+ edge on a 15-min binary where strike is only $10-$20 from spot.

**Fix**: `ARB_STARTUP_COOLDOWN_SEC` env var (default: 120s). Trading is blocked for this period after startup while the bot streams prices, refreshes orderbooks, and collects initial divergence data. Logging and state display continue normally during warmup.

```typescript
// In checkAndTrade(), top guard:
const startupElapsedSec = (now - this.startupTime) / 1000;
if (startupElapsedSec < this.config.startupCooldownSec) {
  return; // Oracle/orderbook not yet stable
}
```

```bash
# .env
ARB_STARTUP_COOLDOWN_SEC=120   # 2 minutes (default)
```

---

## Summary Table

| # | Fix | File(s) | Severity |
|---|-----|---------|----------|
| 1 | Rebuild ClobClient with derived creds | trading-service.ts | Critical — no orders work |
| 2 | Check `response.error` not just `errorMsg` | trading-service.ts | Critical — phantom fills |
| 3 | Convert shares to USD for BUY amount | trading-service.ts | Critical — 3x overspend |
| 4 | Verbose credential logging | trading-service.ts | QoL |
| 5 | Correct FUNDER_ADDRESS (Polymarket proxy) | .env | Critical — auth fails |
| 6 | Auto-redeem winning positions | redemption-service.ts | Feature — capital efficiency |
| 7 | Pass actual token amounts to redeemPositions | redemption-service.ts | Critical — redemption no-op |
| 8 | Use CLOB API for resolution + keep expired positions | paper-trading-tracker.ts | Critical — trades never resolve |
| 9 | Startup cooldown (stale oracle adjustment) | arb-trader.ts, config.ts | Critical — false signals at boot |
