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
tracker.onRedemptionNeeded = (conditionId: string) => {
  redemptionService.redeemPositions(conditionId).catch(err => {
    console.log(`[Redemption] Error: ${err.message}`);
  });
};
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
