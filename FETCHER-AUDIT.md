# Fetcher Infrastructure Audit

Produced for the `fetch-range` tool. Documents each fetcher's cache behavior, directory structure, and existing merge/dedup capabilities.

---

## 1. Fetcher Cache Behavior

### 1.1 Binance Historical (binance-historical.ts)

**Cache read:** `loadFromCache()` L201-291
- Filename pattern: `{symbol}_{interval}_{startDate}_{endDate}.json`
- Looks for exact match first, then scans all matching files for one that covers the requested range
- **Does support merge:** If no single file covers the range, merges all overlapping files via a Map keyed by timestamp (L254-286)
- Coverage check: normalizes to day boundaries (`toDayStart`/`toDayEnd`), cache file must cover `[requestStartDay, requestEndDay]`

**Cache write:** `saveToCache()` L294-325
- Writes a single file with `CachedData<BinanceKline>` format
- Filename from `getCacheFilename()` — overwrites if same dates
- Does NOT merge with existing — just writes the full fetch result

**Range handling:** Fetcher re-fetches entire range if cache miss. No incremental/gap-fill logic.

**Rate limiting:** 100ms between requests. 60s backoff on 429. ~1000 klines per request, ~7 requests per day of 1-min data. **~1 day = ~0.7s fetch time. 90 days = ~63s.**

**Error handling:** 429 → wait 60s + retry. Other errors → throw.

**Cache file structure:**
```
{
  "metadata": { "source": "binance", "startTs": <ms>, "endTs": <ms>, "symbol": "BTCUSDT", "fetchedAt": <ms> },
  "data": [ { "timestamp": <ms>, "open": N, "high": N, "low": N, "close": N, "volume": N }, ... ]
}
```

**Current files:** 10 files in `data/binance/`, earliest 2025-12-12, latest 2026-02-12. Significant overlap. ~35 MB total.

---

### 1.2 Chainlink Historical (chainlink-historical.ts)

**Cache read:** `loadFromCache()` L136-246
- Filename pattern: `chainlink_BTC_{startDate}_{endDate}.json`
- Same 3-step approach: exact match → single-file overlap → multi-file merge (Map keyed by roundId)
- **Extra:** Has a "partial match" fallback with 4-hour tolerance (L186-206)

**Cache write:** `saveToCache()` L248-273
- Standard single-file write. Overwrites on same dates.

**Range handling:** `fetchChainlinkPrices()` L355-439 has **incremental gap-fill!**
- Uses `findCachedCoverage()` to detect partial cache
- Only fetches missing start/end ranges
- Merges new data with cached data, saves combined result
- This is the most sophisticated of all fetchers.

**Rate limiting:** 50ms between calls. 3 retries with exponential backoff. **~1 round per 50ms = 20 rounds/sec. 1 day ≈ 86,400 rounds / 20 ≈ 72 minutes. 90 days ≈ ~100+ hours** (but rounds share across days, actual is ~3-5 hours for 90 days).

**Error handling:** Reverts → no retry. Other → retry 3x with backoff. 50 consecutive errors → stop.

**Cache file structure:**
```
{
  "metadata": { "source": "chainlink", "startTs": <ms>, "endTs": <ms>, "symbol": "BTC/USD", "fetchedAt": <ms> },
  "data": [ { "roundId": "<string>", "price": N, "timestamp": <ms> }, ... ]
}
```

**Current files:** 9 files in `data/chainlink/`, earliest 2026-01-03, latest 2026-02-12. ~42 MB total.

---

### 1.3 Deribit DVOL (deribit-vol.ts)

**Cache read:** `loadFromCache()` L216-304
- Filename pattern: `dvol_{currency}_{startDate}_{endDate}_r{resolution}.json`
- Same 3-step approach. Merge via Map keyed by timestamp.

**Cache write:** `saveToCache()` L306-337
- Standard single-file write.

**Range handling:** Re-fetches entire range on cache miss. No incremental logic.

**Rate limiting:** 200ms between requests. 10s backoff on 429. Paginated by 10,000 points. **~1 day = 1,440 points (1-min) → 1 request. 90 days = ~13 requests = ~3s.**

**Error handling:** 429 → wait 10s + retry. Other → log and break.

**Cache file structure:**
```
{
  "metadata": { "source": "deribit", "startTs": <ms>, "endTs": <ms>, "symbol": "BTC", "fetchedAt": <ms> },
  "data": [ { "timestamp": <ms>, "vol": N }, ... ]
}
```

**Current files:** 10 files in `data/deribit/`, earliest 2025-12-12, latest 2026-02-12. ~700 KB total.

---

### 1.4 Polymarket Markets (polymarket-markets.ts)

**Cache read:** `loadFromCache()` L284-368
- Filename pattern: `markets_{startDate}_{endDate}.json`
- Same 3-step approach. Merge via Map keyed by conditionId.

**Cache write:** `saveToCache()` L370-394
- Standard single-file write.

**Range handling:** Fetches entire series from Gamma API, filters by date range. Always full-range. The API returns ALL events in a series — filtering is client-side.

**Rate limiting:** 50ms between event-detail batches (10 events per batch). Each event also hits the strike-price API. **~90 days = ~8,640 markets = ~864 batches = ~43s (plus strike price calls, ~2-3 min total).**

**Error handling:** Per-event errors → skip that event. Series-level error → log and continue.

**Cache file structure:**
```
{
  "metadata": { "source": "polymarket", "startTs": <ms>, "endTs": <ms>, "fetchedAt": <ms> },
  "data": [ { "conditionId": "0x...", "question": "...", "slug": "...", "tokenIds": [...], "outcomes": [...], "strikePrice": N, "startTime": <ms>, "endTime": <ms>, "resolved": bool }, ... ]
}
```

**Current files:** 10 files in `data/polymarket/`, earliest 2025-12-12, latest 2026-02-12.

---

### 1.5 Polymarket Prices (polymarket-prices.ts)

**Cache read:** `loadFromCache()` L194-274
- Filename pattern: `prices_{shortTokenId(16)}}_{startDate}_{endDate}_f{fidelity}.json`
- Searches by tokenId prefix (first 16 chars). Validates full tokenId in metadata.
- Supports merge via Map keyed by timestamp.

**Cache write:** `saveToCache()` L277-308
- Standard single-file write. Includes `tokenId` in metadata.

**Range handling:** One API call per tokenId. No pagination needed (15-min market ≈ 15 points at 1-min fidelity). Re-fetches entire token range on miss.

**Rate limiting:** None explicit. Relies on upstream caller batching.

**Error handling:** 404 or 400 → return []. Other → throw.

**Cache file structure:**
```
{
  "metadata": { "source": "polymarket", "startTs": <ms>, "endTs": <ms>, "tokenId": "<full>", "fetchedAt": <ms> },
  "data": [ { "timestamp": <ms>, "price": N }, ... ]
}
```

**Current files:** 3,997 files in `data/polymarket/prices_*`. Each covers one tokenId's active period (typically a single day). ~1-4 KB each.

---

## 2. Cache Directory Structure

```
data/
├── binance/          10 files, ~35 MB, covers 2025-12-12 → 2026-02-12 (with overlaps)
│   └── BTCUSDT_1m_{start}_{end}.json
├── chainlink/        9 files, ~42 MB, covers 2026-01-03 → 2026-02-12
│   └── chainlink_BTC_{start}_{end}.json
├── deribit/          10 files, ~700 KB, covers 2025-12-12 → 2026-02-12
│   └── dvol_BTC_{start}_{end}_r60.json
└── polymarket/       10 market files + 3,997 price files
    ├── markets_{start}_{end}.json
    └── prices_{shortTokenId}_{start}_{end}_f1.json
```

**Overlaps:** Heavy. Each backtest run creates its own date-range cache file even if an existing file already covers a superset. This is harmless (merge logic handles it) but wastes disk space.

**Bottleneck for coverage:** Chainlink starts at 2026-01-03, while Binance/Deribit start at 2025-12-12. The effective intersection is currently ~2026-01-03 → 2026-02-12 (~40 days).

---

## 3. Existing Merge/Dedup Utilities

**What exists:**
- All 5 fetchers have a "merge multiple cache files" step in their `loadFromCache()`. Each uses a Map to deduplicate (keyed by timestamp, roundId, or conditionId).
- Chainlink fetcher has `findCachedCoverage()` for incremental gap detection (start/end gap only, not middle gaps).
- Polymarket markets fetcher has batch parallel pattern (10 at a time) in `fetchHistoricalMarkets()` L96-144.

**What's missing (needed for fetch-range):**
- No standalone "cache gap detection" function — it's buried inside `loadFromCache()` and returns null (not the gaps).
- No date-range parser from filenames — the fetchers read file contents to check metadata.
- No coverage report generator.
- No cross-source intersection calculator.
- No Polymarket price completeness checker (which tokenIds have prices vs. which don't).

**Key design decision:** The fetch-range tool should NOT try to detect gaps by reading metadata from every cache file. Instead, it should:
1. Parse date ranges from filenames (fast, no I/O)
2. Compute union of filename-based ranges
3. Call fetchers for gaps (fetchers handle their own internal caching/dedup)
