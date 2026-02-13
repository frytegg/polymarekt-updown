#!/usr/bin/env npx ts-node
/**
 * Data Fetch & Merge Tool
 *
 * Orchestrates existing fetchers to fill gaps in cached data.
 * Safe to run overnight. Idempotent (re-running fetches nothing if complete).
 *
 * Usage:
 *   npx ts-node scripts/fetch-range.ts --from 2025-11-15 --to 2026-02-12
 *   npx ts-node scripts/fetch-range.ts --from 2025-11-15 --to 2026-02-12 --dry-run
 *   npx ts-node scripts/fetch-range.ts --from 2025-11-15 --to 2026-02-12 --sources binance,chainlink
 *   npx ts-node scripts/fetch-range.ts --from 2026-01-06 --to 2026-01-30 --report-only
 *
 * Options:
 *   --from <YYYY-MM-DD>        Start date (required)
 *   --to <YYYY-MM-DD>          End date (required)
 *   --sources <list>           Comma-separated sources (default: all)
 *                              Options: binance, chainlink, deribit, polymarket
 *   --concurrency <N>          Max concurrent Polymarket price fetches (default: 5)
 *   --dry-run                  Show what would be fetched without fetching
 *   --report-only              Only generate coverage report from existing cache
 *   --help                     Show help
 */

import * as dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import * as path from 'path';

// Fetchers (reuse existing infrastructure)
import { BinanceHistoricalFetcher } from '../backtest/fetchers/binance-historical';
import { ChainlinkHistoricalFetcher } from '../backtest/fetchers/chainlink-historical';
import { DeribitVolFetcher } from '../backtest/fetchers/deribit-vol';
import { PolymarketMarketsFetcher } from '../backtest/fetchers/polymarket-markets';
import { PolymarketPricesFetcher, fetchPolymarketPrices } from '../backtest/fetchers/polymarket-prices';
import { HistoricalMarket } from '../backtest/types';

// =============================================================================
// CONSTANTS
// =============================================================================

const VALID_SOURCES = ['binance', 'chainlink', 'deribit', 'polymarket'] as const;
type Source = typeof VALID_SOURCES[number];

const DATA_ROOT = path.join(__dirname, '..', 'data');

// =============================================================================
// CLI TYPES
// =============================================================================

interface CliArgs {
    from: Date;
    to: Date;
    sources: Source[];
    concurrency: number;
    dryRun: boolean;
    reportOnly: boolean;
}

// =============================================================================
// CACHE GAP DETECTION TYPES
// =============================================================================

interface CacheRange {
    start: Date;
    end: Date;
    filename: string;
}

interface GapAnalysis {
    source: string;
    requestedRange: { start: Date; end: Date };
    cachedRanges: CacheRange[];
    gaps: Array<{ start: Date; end: Date }>;
    coveragePct: number;
}

interface PolymarketPriceAnalysis {
    totalMarkets: number;
    totalTokenIds: number;
    completeTokenIds: number;
    missingTokenIds: Array<{ tokenId: string; startTime: number; endTime: number }>;
    partialTokenIds: Array<{ tokenId: string; startTime: number; endTime: number }>;
    estimatedFetchCount: number;
}

interface FetchResult {
    source: string;
    gapsFound: number;
    gapsFilled: number;
    gapsFailed: number;
    pointsFetched: number;
    timeMs: number;
    errors: string[];
}

interface SourceCoverage {
    source: string;
    earliestDate: Date | null;
    latestDate: Date | null;
    fileCount: number;
    totalSizeMb: number;
    gaps: Array<{ start: Date; end: Date; durationHours: number }>;
    warnings: string[];
}

interface CoverageReport {
    generatedAt: Date;
    requestedRange: { start: Date; end: Date };
    sources: SourceCoverage[];
    intersection: { start: Date; end: Date; days: number } | null;
    polymarket: {
        totalMarkets: number;
        marketsWithPrices: number;
        marketsMissingPrices: number;
        coveragePct: number;
    };
    recommendations: string[];
}

// =============================================================================
// CLI PARSING
// =============================================================================

function parseArgs(): CliArgs {
    const args = process.argv.slice(2);

    if (args.includes('--help') || args.includes('-h')) {
        printHelp();
        process.exit(0);
    }

    let from: string | undefined;
    let to: string | undefined;
    let sources: Source[] = [...VALID_SOURCES];
    let concurrency = 5;
    let dryRun = false;
    let reportOnly = false;

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--from':
                from = args[++i];
                break;
            case '--to':
                to = args[++i];
                break;
            case '--sources':
                sources = args[++i].split(',').map(s => {
                    const trimmed = s.trim().toLowerCase();
                    if (!VALID_SOURCES.includes(trimmed as Source)) {
                        console.error(`Unknown source: ${trimmed}. Valid: ${VALID_SOURCES.join(', ')}`);
                        process.exit(1);
                    }
                    return trimmed as Source;
                });
                break;
            case '--concurrency':
                concurrency = parseInt(args[++i], 10) || 5;
                break;
            case '--dry-run':
                dryRun = true;
                break;
            case '--report-only':
                reportOnly = true;
                break;
        }
    }

    // Validate required args
    if (!from || !to) {
        console.error('Error: --from and --to are required.\n');
        printHelp();
        process.exit(1);
    }

    // Validate date format
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(from) || !dateRegex.test(to)) {
        console.error('Error: Dates must be in YYYY-MM-DD format.');
        process.exit(1);
    }

    const fromDate = new Date(from + 'T00:00:00Z');
    const toDate = new Date(to + 'T23:59:59.999Z');

    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
        console.error('Error: Invalid date values.');
        process.exit(1);
    }

    if (fromDate >= toDate) {
        console.error('Error: --from must be before --to.');
        process.exit(1);
    }

    // Warn if > 365 days ago
    const daysDiff = (Date.now() - fromDate.getTime()) / (24 * 60 * 60 * 1000);
    if (daysDiff > 365) {
        console.warn(`Warning: --from is ${Math.floor(daysDiff)} days ago. Some APIs may not have data this far back.`);
    }

    return { from: fromDate, to: toDate, sources, concurrency, dryRun, reportOnly };
}

function printHelp(): void {
    console.log(`
Data Fetch & Merge Tool — Fill gaps in cached backtest data

Usage:
  npx ts-node scripts/fetch-range.ts --from <date> --to <date> [options]

Required:
  --from <YYYY-MM-DD>        Start date
  --to <YYYY-MM-DD>          End date

Options:
  --sources <list>           Comma-separated sources to fetch (default: all)
                             Options: binance, chainlink, deribit, polymarket
  --concurrency <N>          Max concurrent Polymarket price fetches (default: 5)
  --dry-run                  Show what would be fetched without fetching
  --report-only              Only generate coverage report from existing cache
  --help                     Show this help

Examples:
  # Dry run — see what needs fetching
  npx ts-node scripts/fetch-range.ts --from 2025-11-15 --to 2026-02-12 --dry-run

  # Fetch only Binance and Deribit (fast sources)
  npx ts-node scripts/fetch-range.ts --from 2025-11-15 --to 2026-02-12 --sources binance,deribit

  # Generate coverage report from existing cache
  npx ts-node scripts/fetch-range.ts --from 2025-11-15 --to 2026-02-12 --report-only

  # Full fetch (Chainlink will take hours for large ranges)
  npx ts-node scripts/fetch-range.ts --from 2025-11-15 --to 2026-02-12
`);
}

// =============================================================================
// CACHE GAP DETECTION
// =============================================================================

/**
 * Parse date range from a cache filename.
 * Supports patterns: {prefix}_{startDate}_{endDate}[_suffix].json
 */
function parseDatesFromFilename(filename: string): { start: Date; end: Date } | null {
    // Match YYYY-MM-DD patterns in filename
    const dateMatches = filename.match(/(\d{4}-\d{2}-\d{2})/g);
    if (!dateMatches || dateMatches.length < 2) return null;

    const start = new Date(dateMatches[0] + 'T00:00:00Z');
    const end = new Date(dateMatches[1] + 'T23:59:59.999Z');

    if (isNaN(start.getTime()) || isNaN(end.getTime())) return null;
    return { start, end };
}

/**
 * Compute the union of date ranges (merging overlaps).
 * Returns sorted, non-overlapping ranges.
 */
function unionRanges(ranges: Array<{ start: Date; end: Date }>): Array<{ start: Date; end: Date }> {
    if (ranges.length === 0) return [];

    // Sort by start date
    const sorted = [...ranges].sort((a, b) => a.start.getTime() - b.start.getTime());
    const merged: Array<{ start: Date; end: Date }> = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
        const current = sorted[i];
        const last = merged[merged.length - 1];

        // Overlap or adjacent (within 1 day)
        if (current.start.getTime() <= last.end.getTime() + 86400000) {
            // Extend the last range
            if (current.end.getTime() > last.end.getTime()) {
                merged[merged.length - 1] = { start: last.start, end: current.end };
            }
        } else {
            merged.push(current);
        }
    }

    return merged;
}

/**
 * Compute gaps between a requested range and the union of cached ranges.
 */
function computeGaps(
    requestedStart: Date,
    requestedEnd: Date,
    coveredRanges: Array<{ start: Date; end: Date }>
): Array<{ start: Date; end: Date }> {
    if (coveredRanges.length === 0) {
        return [{ start: requestedStart, end: requestedEnd }];
    }

    const gaps: Array<{ start: Date; end: Date }> = [];
    let currentStart = requestedStart.getTime();

    for (const range of coveredRanges) {
        const rangeStart = range.start.getTime();
        const rangeEnd = range.end.getTime();

        // Gap before this range
        if (currentStart < rangeStart) {
            gaps.push({
                start: new Date(currentStart),
                end: new Date(Math.min(rangeStart, requestedEnd.getTime())),
            });
        }

        // Move past this range
        currentStart = Math.max(currentStart, rangeEnd);
    }

    // Gap after last range
    if (currentStart < requestedEnd.getTime()) {
        gaps.push({
            start: new Date(currentStart),
            end: requestedEnd,
        });
    }

    return gaps;
}

/**
 * Analyze cache gaps for a single source (binance, chainlink, deribit, or polymarket-markets).
 */
function analyzeCacheGaps(
    source: string,
    dataDir: string,
    filenamePrefix: string,
    requestedStart: Date,
    requestedEnd: Date,
): GapAnalysis {
    const cachedRanges: CacheRange[] = [];

    if (fs.existsSync(dataDir)) {
        const files = fs.readdirSync(dataDir).filter(f =>
            f.startsWith(filenamePrefix) && f.endsWith('.json')
        );

        for (const file of files) {
            const parsed = parseDatesFromFilename(file);
            if (parsed) {
                cachedRanges.push({ ...parsed, filename: file });
            }
        }
    }

    // Compute union and gaps
    const union = unionRanges(cachedRanges);
    const gaps = computeGaps(requestedStart, requestedEnd, union);

    // Compute coverage percentage
    const totalMs = requestedEnd.getTime() - requestedStart.getTime();
    let coveredMs = 0;
    for (const range of union) {
        const overlapStart = Math.max(range.start.getTime(), requestedStart.getTime());
        const overlapEnd = Math.min(range.end.getTime(), requestedEnd.getTime());
        if (overlapEnd > overlapStart) {
            coveredMs += overlapEnd - overlapStart;
        }
    }
    const coveragePct = totalMs > 0 ? (coveredMs / totalMs) * 100 : 0;

    return {
        source,
        requestedRange: { start: requestedStart, end: requestedEnd },
        cachedRanges,
        gaps,
        coveragePct: Math.min(100, coveragePct),
    };
}

/**
 * Source-specific filename prefixes and data directories.
 */
function getSourceConfig(source: Source): { dataDir: string; prefix: string } {
    switch (source) {
        case 'binance':
            return { dataDir: path.join(DATA_ROOT, 'binance'), prefix: 'BTCUSDT_1m_' };
        case 'chainlink':
            return { dataDir: path.join(DATA_ROOT, 'chainlink'), prefix: 'chainlink_BTC_' };
        case 'deribit':
            return { dataDir: path.join(DATA_ROOT, 'deribit'), prefix: 'dvol_BTC_' };
        case 'polymarket':
            return { dataDir: path.join(DATA_ROOT, 'polymarket'), prefix: 'markets_' };
    }
}

// =============================================================================
// POLYMARKET PRICE GAP ANALYSIS
// =============================================================================

/**
 * Analyze which market tokenIds have price data cached.
 */
function analyzePolymarketPrices(
    markets: HistoricalMarket[],
    dataDir: string,
): PolymarketPriceAnalysis {
    // Get all price cache files
    const priceFiles = fs.existsSync(dataDir)
        ? fs.readdirSync(dataDir).filter(f => f.startsWith('prices_') && f.endsWith('.json'))
        : [];

    // Build set of cached tokenId prefixes
    const cachedPrefixes = new Set<string>();
    for (const file of priceFiles) {
        // prices_{shortTokenId(16)}_{start}_{end}_f1.json
        const match = file.match(/^prices_(\d+)_/);
        if (match) {
            cachedPrefixes.add(match[1]);
        }
    }

    const missing: Array<{ tokenId: string; startTime: number; endTime: number }> = [];
    const partial: Array<{ tokenId: string; startTime: number; endTime: number }> = [];
    let complete = 0;

    for (const market of markets) {
        const yesTokenId = market.tokenIds[0];
        const shortId = yesTokenId.slice(0, 16);

        if (cachedPrefixes.has(shortId)) {
            complete++;
        } else {
            missing.push({
                tokenId: yesTokenId,
                startTime: market.startTime,
                endTime: market.endTime,
            });
        }
    }

    return {
        totalMarkets: markets.length,
        totalTokenIds: markets.length, // YES token per market
        completeTokenIds: complete,
        missingTokenIds: missing,
        partialTokenIds: partial,
        estimatedFetchCount: missing.length + partial.length,
    };
}

// =============================================================================
// FETCH ORCHESTRATOR
// =============================================================================

/**
 * Fetch gaps for a single source using existing fetchers.
 */
async function fetchSourceGaps(
    source: Source,
    gaps: Array<{ start: Date; end: Date }>,
    dryRun: boolean,
): Promise<FetchResult> {
    const startTime = Date.now();
    const result: FetchResult = {
        source,
        gapsFound: gaps.length,
        gapsFilled: 0,
        gapsFailed: 0,
        pointsFetched: 0,
        timeMs: 0,
        errors: [],
    };

    if (gaps.length === 0) {
        result.timeMs = Date.now() - startTime;
        return result;
    }

    if (dryRun) {
        result.timeMs = Date.now() - startTime;
        return result;
    }

    for (const gap of gaps) {
        const gapStartMs = gap.start.getTime();
        const gapEndMs = gap.end.getTime();
        const gapDays = ((gapEndMs - gapStartMs) / 86400000).toFixed(0);

        console.log(`   [${source}] Fetching gap: ${gap.start.toISOString().split('T')[0]} -> ${gap.end.toISOString().split('T')[0]} (${gapDays} days)...`);

        try {
            switch (source) {
                case 'binance': {
                    const fetcher = new BinanceHistoricalFetcher('BTCUSDT', '1m');
                    const data = await fetcher.fetch(gapStartMs, gapEndMs);
                    result.pointsFetched += data.length;
                    break;
                }
                case 'chainlink': {
                    const fetcher = new ChainlinkHistoricalFetcher();
                    const data = await fetcher.fetch(gapStartMs, gapEndMs);
                    result.pointsFetched += data.length;
                    break;
                }
                case 'deribit': {
                    const fetcher = new DeribitVolFetcher('BTC', 60);
                    const data = await fetcher.fetch(gapStartMs, gapEndMs);
                    result.pointsFetched += data.length;
                    break;
                }
                case 'polymarket': {
                    // Markets only — prices handled separately
                    const fetcher = new PolymarketMarketsFetcher();
                    const data = await fetcher.fetch(gapStartMs, gapEndMs);
                    result.pointsFetched += data.length;
                    break;
                }
            }
            result.gapsFilled++;
        } catch (err: any) {
            console.error(`   [${source}] Error: ${err.message}`);
            result.errors.push(`${gap.start.toISOString().split('T')[0]}-${gap.end.toISOString().split('T')[0]}: ${err.message}`);
            result.gapsFailed++;
        }
    }

    result.timeMs = Date.now() - startTime;
    return result;
}

/**
 * Fetch missing Polymarket prices with bounded concurrency.
 * Reuses the batch pattern from polymarket-markets.ts.
 */
async function fetchPolymarketPrices_Concurrent(
    missingTokens: Array<{ tokenId: string; startTime: number; endTime: number }>,
    concurrency: number,
    dryRun: boolean,
): Promise<FetchResult> {
    const startTime = Date.now();
    const result: FetchResult = {
        source: 'polymarket-prices',
        gapsFound: missingTokens.length,
        gapsFilled: 0,
        gapsFailed: 0,
        pointsFetched: 0,
        timeMs: 0,
        errors: [],
    };

    if (missingTokens.length === 0 || dryRun) {
        result.timeMs = Date.now() - startTime;
        return result;
    }

    let fetched = 0;
    let cached = 0;

    // Process in batches (same pattern as polymarket-markets.ts)
    for (let i = 0; i < missingTokens.length; i += concurrency) {
        const batch = missingTokens.slice(i, i + concurrency);

        const batchResults = await Promise.allSettled(
            batch.map(async (token) => {
                const prices = await fetchPolymarketPrices(
                    token.tokenId,
                    token.startTime,
                    token.endTime,
                    1, // 1-min fidelity
                );
                return prices.length;
            })
        );

        for (const batchResult of batchResults) {
            if (batchResult.status === 'fulfilled') {
                if (batchResult.value > 0) {
                    fetched++;
                    result.pointsFetched += batchResult.value;
                } else {
                    cached++;
                }
                result.gapsFilled++;
            } else {
                result.gapsFailed++;
                result.errors.push(batchResult.reason?.message || 'Unknown error');
            }
        }

        const total = i + batch.length;
        if (total % 10 === 0 || total === missingTokens.length) {
            const pct = ((total / missingTokens.length) * 100).toFixed(0);
            console.log(`   [Polymarket Prices] ${total}/${missingTokens.length} (${pct}%) — ${fetched} fetched, ${cached} from cache, ${result.gapsFailed} errors`);
        }

        // Small delay between batches
        if (i + concurrency < missingTokens.length) {
            await new Promise(r => setTimeout(r, 50));
        }
    }

    result.timeMs = Date.now() - startTime;
    return result;
}

// =============================================================================
// COVERAGE REPORT
// =============================================================================

function getDirectoryStats(dir: string, prefix: string): { fileCount: number; totalSizeMb: number; earliest: Date | null; latest: Date | null } {
    if (!fs.existsSync(dir)) {
        return { fileCount: 0, totalSizeMb: 0, earliest: null, latest: null };
    }

    const files = fs.readdirSync(dir).filter(f => f.startsWith(prefix) && f.endsWith('.json'));
    let totalSize = 0;
    let earliest: Date | null = null;
    let latest: Date | null = null;

    for (const file of files) {
        const stat = fs.statSync(path.join(dir, file));
        totalSize += stat.size;

        const parsed = parseDatesFromFilename(file);
        if (parsed) {
            if (!earliest || parsed.start < earliest) earliest = parsed.start;
            if (!latest || parsed.end > latest) latest = parsed.end;
        }
    }

    return { fileCount: files.length, totalSizeMb: totalSize / (1024 * 1024), earliest, latest };
}

function generateCoverageReport(
    args: CliArgs,
    analyses: Map<string, GapAnalysis>,
    polyPriceAnalysis: PolymarketPriceAnalysis | null,
): CoverageReport {
    const sources: SourceCoverage[] = [];
    const sourceRanges: Array<{ start: Date; end: Date }> = [];

    for (const source of ['binance', 'chainlink', 'deribit', 'polymarket'] as Source[]) {
        const config = getSourceConfig(source);
        const prefix = source === 'polymarket' ? 'markets_' : config.prefix;
        const stats = getDirectoryStats(config.dataDir, prefix);

        const analysis = analyses.get(source);
        const gaps = analysis ? analysis.gaps.map(g => ({
            start: g.start,
            end: g.end,
            durationHours: (g.end.getTime() - g.start.getTime()) / (3600 * 1000),
        })) : [];

        const warnings: string[] = [];
        if (source === 'chainlink') {
            for (const gap of gaps) {
                if (gap.durationHours > 0.1 && gap.durationHours < 24) {
                    warnings.push(`${gap.durationHours.toFixed(1)}h gap: ${gap.start.toISOString().slice(0, 16)} -> ${gap.end.toISOString().slice(0, 16)}`);
                }
            }
        }

        sources.push({
            source,
            earliestDate: stats.earliest,
            latestDate: stats.latest,
            fileCount: stats.fileCount,
            totalSizeMb: stats.totalSizeMb,
            gaps,
            warnings,
        });

        if (stats.earliest && stats.latest) {
            sourceRanges.push({ start: stats.earliest, end: stats.latest });
        }
    }

    // Compute intersection of all 4 sources
    let intersection: { start: Date; end: Date; days: number } | null = null;
    if (sourceRanges.length === 4) {
        const intStart = new Date(Math.max(...sourceRanges.map(r => r.start.getTime())));
        const intEnd = new Date(Math.min(...sourceRanges.map(r => r.end.getTime())));
        if (intEnd > intStart) {
            const days = Math.floor((intEnd.getTime() - intStart.getTime()) / 86400000);
            intersection = { start: intStart, end: intEnd, days };
        }
    }

    // Polymarket stats
    const polyStats = polyPriceAnalysis ? {
        totalMarkets: polyPriceAnalysis.totalMarkets,
        marketsWithPrices: polyPriceAnalysis.completeTokenIds,
        marketsMissingPrices: polyPriceAnalysis.missingTokenIds.length,
        coveragePct: polyPriceAnalysis.totalMarkets > 0
            ? (polyPriceAnalysis.completeTokenIds / polyPriceAnalysis.totalMarkets) * 100
            : 0,
    } : { totalMarkets: 0, marketsWithPrices: 0, marketsMissingPrices: 0, coveragePct: 0 };

    // Recommendations
    const recommendations: string[] = [];
    if (intersection) {
        if (intersection.days < 60) {
            // Find the bottleneck source
            const bottleneck = sources.reduce((a, b) => {
                if (!a.earliestDate) return b;
                if (!b.earliestDate) return a;
                return a.earliestDate > b.earliestDate ? a : b;
            });
            recommendations.push(`Extend ${bottleneck.source} backward to reach 60-day intersection (currently ${intersection.days} days)`);
        }
        if (intersection.days >= 60 && intersection.days < 90) {
            recommendations.push(`Intersection is ${intersection.days} days. Consider extending to 90 days for robust out-of-sample validation.`);
        }
        if (intersection.days >= 90) {
            recommendations.push(`Intersection is ${intersection.days} days. Sufficient for optimizer with out-of-sample validation.`);
        }
    } else {
        recommendations.push('Not all 4 sources have data. Run fetch-range for missing sources.');
    }

    for (const s of sources) {
        if (s.gaps.length > 0) {
            const totalGapHours = s.gaps.reduce((sum, g) => sum + g.durationHours, 0);
            if (totalGapHours > 1) {
                recommendations.push(`${s.source} has ${s.gaps.length} gap(s) totaling ${totalGapHours.toFixed(1)}h. Re-run fetch-range.`);
            }
        }
    }

    if (polyStats.coveragePct < 95 && polyStats.totalMarkets > 0) {
        recommendations.push(`Polymarket price coverage ${polyStats.coveragePct.toFixed(1)}%. Re-run: --sources polymarket`);
    }

    return {
        generatedAt: new Date(),
        requestedRange: { start: args.from, end: args.to },
        sources,
        intersection,
        polymarket: polyStats,
        recommendations,
    };
}

function saveReport(report: CoverageReport): void {
    // JSON report
    const jsonPath = path.join(DATA_ROOT, 'coverage-report.json');
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

    // Markdown report
    const mdPath = path.join(DATA_ROOT, 'coverage-report.md');
    const md = generateMarkdownReport(report);
    fs.writeFileSync(mdPath, md);

    console.log(`   Reports saved: data/coverage-report.md, data/coverage-report.json`);
}

function generateMarkdownReport(report: CoverageReport): string {
    const lines: string[] = [];
    lines.push('# Data Coverage Report');
    lines.push(`Generated: ${report.generatedAt.toISOString()}\n`);

    lines.push('## Summary');
    const startStr = report.requestedRange.start.toISOString().split('T')[0];
    const endStr = report.requestedRange.end.toISOString().split('T')[0];
    const reqDays = Math.floor((report.requestedRange.end.getTime() - report.requestedRange.start.getTime()) / 86400000);
    lines.push(`Requested range: ${startStr} -> ${endStr} (${reqDays} days)`);

    if (report.intersection) {
        const intStart = report.intersection.start.toISOString().split('T')[0];
        const intEnd = report.intersection.end.toISOString().split('T')[0];
        lines.push(`Effective intersection: ${intStart} -> ${intEnd} (${report.intersection.days} days)\n`);
    } else {
        lines.push('Effective intersection: N/A (not all sources have data)\n');
    }

    lines.push('## Source Coverage\n');
    lines.push('| Source | Range | Files | Size | Gaps | Status |');
    lines.push('|--------|-------|-------|------|------|--------|');

    for (const s of report.sources) {
        const range = s.earliestDate && s.latestDate
            ? `${s.earliestDate.toISOString().split('T')[0]} -> ${s.latestDate.toISOString().split('T')[0]}`
            : 'No data';
        const gaps = s.gaps.length === 0 ? '0' : `${s.gaps.length}`;
        const status = s.gaps.length === 0 ? 'Complete' : `${s.gaps.length} gap(s)`;
        const statusIcon = s.gaps.length === 0 ? '✅' : '⚠️';
        lines.push(`| ${s.source} | ${range} | ${s.fileCount} | ${s.totalSizeMb.toFixed(1)} MB | ${gaps} | ${statusIcon} ${status} |`);
    }

    if (report.sources.some(s => s.warnings.length > 0)) {
        lines.push('\n## Gaps Detail');
        for (const s of report.sources) {
            for (const w of s.warnings) {
                lines.push(`- ${s.source}: ${w}`);
            }
        }
    }

    lines.push('\n## Polymarket Markets');
    lines.push(`- Total markets in range: ${report.polymarket.totalMarkets}`);
    lines.push(`- Markets with price data: ${report.polymarket.marketsWithPrices} (${report.polymarket.coveragePct.toFixed(1)}%)`);
    lines.push(`- Markets missing prices: ${report.polymarket.marketsMissingPrices}`);

    if (report.recommendations.length > 0) {
        lines.push('\n## Recommendations');
        for (let i = 0; i < report.recommendations.length; i++) {
            lines.push(`${i + 1}. ${report.recommendations[i]}`);
        }
    }

    return lines.join('\n') + '\n';
}

function printSummary(report: CoverageReport): void {
    console.log('\n' + '='.repeat(50));
    console.log('  Coverage Report');
    console.log('='.repeat(50) + '\n');

    for (const s of report.sources) {
        const range = s.earliestDate && s.latestDate
            ? `${s.earliestDate.toISOString().split('T')[0]} -> ${s.latestDate.toISOString().split('T')[0]}`
            : 'No data';
        const gapInfo = s.gaps.length > 0 ? `, ${s.gaps.length} gap(s)` : '';
        const icon = s.gaps.length === 0 && s.earliestDate ? '✅' : s.earliestDate ? '⚠️' : '❌';
        const padded = (s.source + ':').padEnd(14);
        console.log(`   ${padded}${range} ${icon}${gapInfo}`);
    }

    if (report.polymarket.totalMarkets > 0) {
        const padded = 'Poly prices:'.padEnd(14);
        const icon = report.polymarket.coveragePct >= 99 ? '✅' : '⚠️';
        console.log(`   ${padded}${report.polymarket.marketsWithPrices}/${report.polymarket.totalMarkets} markets (${report.polymarket.coveragePct.toFixed(1)}%) ${icon}`);
    }

    if (report.intersection) {
        const intStart = report.intersection.start.toISOString().split('T')[0];
        const intEnd = report.intersection.end.toISOString().split('T')[0];
        console.log(`\n   Effective intersection: ${intStart} -> ${intEnd} (${report.intersection.days} days)`);
    }

    console.log(`\n   Full report: data/coverage-report.md`);
}

// =============================================================================
// DRY RUN DISPLAY
// =============================================================================

function printFetchPlan(
    analyses: Map<string, GapAnalysis>,
    polyPriceAnalysis: PolymarketPriceAnalysis | null,
    dryRun: boolean,
): void {
    if (dryRun) {
        console.log('\n   DRY RUN — Data Fetch Plan');
    } else {
        console.log('\n   Fetch Plan');
    }
    console.log('   ' + '='.repeat(50) + '\n');

    let nothingToFetch = true;

    for (const [source, analysis] of analyses) {
        const hasGaps = analysis.gaps.length > 0;
        if (hasGaps) nothingToFetch = false;

        console.log(`   ${source}:`);
        if (analysis.cachedRanges.length > 0) {
            const union = unionRanges(analysis.cachedRanges);
            for (const r of union) {
                console.log(`     ✅ Cached: ${r.start.toISOString().split('T')[0]} -> ${r.end.toISOString().split('T')[0]}`);
            }
        } else {
            console.log('     ❌ No cached data');
        }

        for (const gap of analysis.gaps) {
            const days = Math.ceil((gap.end.getTime() - gap.start.getTime()) / 86400000);
            const label = dryRun ? 'would fetch' : 'to fetch';
            console.log(`     🔲 Gap: ${gap.start.toISOString().split('T')[0]} -> ${gap.end.toISOString().split('T')[0]} (${days} days) — ${label}`);
        }

        if (source === 'chainlink' && hasGaps) {
            const totalDays = analysis.gaps.reduce((sum, g) =>
                sum + (g.end.getTime() - g.start.getTime()) / 86400000, 0);
            if (totalDays > 7) {
                console.log(`     ⏱️  Estimated time: ~${Math.ceil(totalDays * 0.8)}-${Math.ceil(totalDays * 1.2)} hours (Chainlink is slow)`);
            }
        }

        console.log('');
    }

    if (polyPriceAnalysis) {
        const hasMissing = polyPriceAnalysis.missingTokenIds.length > 0;
        if (hasMissing) nothingToFetch = false;

        console.log('   Polymarket Prices:');
        console.log(`     Total markets:  ${polyPriceAnalysis.totalMarkets}`);
        console.log(`     Already cached: ${polyPriceAnalysis.completeTokenIds} (${polyPriceAnalysis.totalMarkets > 0 ? ((polyPriceAnalysis.completeTokenIds / polyPriceAnalysis.totalMarkets) * 100).toFixed(0) : 0}%)`);
        console.log(`     Missing:        ${polyPriceAnalysis.missingTokenIds.length}`);
        if (hasMissing) {
            const estMinutes = Math.ceil(polyPriceAnalysis.missingTokenIds.length / 10);
            console.log(`     Estimated time: ~${estMinutes} minutes`);
        }
        console.log('');
    }

    if (nothingToFetch) {
        console.log('   Nothing to fetch. All data is cached.\n');
    }
}

// =============================================================================
// MAIN
// =============================================================================

async function main(): Promise<void> {
    const args = parseArgs();

    console.log('\n' + '='.repeat(50));
    console.log('  Data Fetch & Merge Tool');
    console.log('='.repeat(50));
    console.log(`\n   Range: ${args.from.toISOString().split('T')[0]} -> ${args.to.toISOString().split('T')[0]}`);
    console.log(`   Sources: ${args.sources.join(', ')}`);
    if (args.dryRun) console.log('   Mode: DRY RUN');
    if (args.reportOnly) console.log('   Mode: REPORT ONLY');
    console.log('');

    // Step 1: Analyze existing cache for all sources
    console.log('   Analyzing cached data...\n');
    const analyses = new Map<string, GapAnalysis>();

    for (const source of args.sources) {
        const config = getSourceConfig(source);
        const analysis = analyzeCacheGaps(
            source,
            config.dataDir,
            config.prefix,
            args.from,
            args.to,
        );
        analyses.set(source, analysis);
    }

    // Step 2: Analyze Polymarket prices (if polymarket is in sources)
    let polyPriceAnalysis: PolymarketPriceAnalysis | null = null;
    if (args.sources.includes('polymarket')) {
        // Load markets from cache to get tokenId universe
        const polyDir = path.join(DATA_ROOT, 'polymarket');
        const marketsFetcher = new PolymarketMarketsFetcher();
        const markets = await marketsFetcher.fetch(args.from.getTime(), args.to.getTime());
        polyPriceAnalysis = analyzePolymarketPrices(markets, polyDir);
    }

    // Step 3: Show plan
    printFetchPlan(analyses, polyPriceAnalysis, args.dryRun);

    if (args.dryRun || args.reportOnly) {
        // Generate report without fetching
        const report = generateCoverageReport(args, analyses, polyPriceAnalysis);
        saveReport(report);
        printSummary(report);
        return;
    }

    // Step 4: Fetch gaps for each source (ordered: fast first, slow last)
    const fetchOrder: Source[] = ['binance', 'deribit', 'polymarket', 'chainlink']
        .filter(s => args.sources.includes(s as Source)) as Source[];

    const allResults: FetchResult[] = [];

    for (const source of fetchOrder) {
        const analysis = analyses.get(source);
        if (!analysis || analysis.gaps.length === 0) {
            console.log(`   [${source}] ✅ Complete (0 gaps)`);
            continue;
        }

        const result = await fetchSourceGaps(source, analysis.gaps, args.dryRun);
        allResults.push(result);
        console.log(`   [${source}] Done: ${result.gapsFilled}/${result.gapsFound} gaps filled (${(result.timeMs / 1000).toFixed(1)}s)`);
    }

    // Step 5: Fetch missing Polymarket prices
    if (polyPriceAnalysis && polyPriceAnalysis.missingTokenIds.length > 0) {
        console.log(`\n   [Polymarket Prices] Fetching ${polyPriceAnalysis.missingTokenIds.length} missing tokenIds...`);
        const priceResult = await fetchPolymarketPrices_Concurrent(
            polyPriceAnalysis.missingTokenIds,
            args.concurrency,
            args.dryRun,
        );
        allResults.push(priceResult);
        console.log(`   [Polymarket Prices] Done: ${priceResult.gapsFilled}/${priceResult.gapsFound} (${(priceResult.timeMs / 1000).toFixed(1)}s)`);
    }

    // Step 6: Re-analyze and generate report
    console.log('\n   Re-analyzing cache after fetch...');
    const finalAnalyses = new Map<string, GapAnalysis>();
    for (const source of args.sources) {
        const config = getSourceConfig(source);
        const analysis = analyzeCacheGaps(
            source,
            config.dataDir,
            config.prefix,
            args.from,
            args.to,
        );
        finalAnalyses.set(source, analysis);
    }

    // Re-check Polymarket prices
    let finalPolyPriceAnalysis: PolymarketPriceAnalysis | null = null;
    if (args.sources.includes('polymarket')) {
        const polyDir = path.join(DATA_ROOT, 'polymarket');
        const marketsFetcher = new PolymarketMarketsFetcher();
        const markets = await marketsFetcher.fetch(args.from.getTime(), args.to.getTime());
        finalPolyPriceAnalysis = analyzePolymarketPrices(markets, polyDir);
    }

    const report = generateCoverageReport(args, finalAnalyses, finalPolyPriceAnalysis);
    saveReport(report);
    printSummary(report);

    // Print errors if any
    const errors = allResults.flatMap(r => r.errors);
    if (errors.length > 0) {
        console.log(`\n   Errors (${errors.length}):`);
        for (const err of errors.slice(0, 10)) {
            console.log(`     - ${err}`);
        }
        if (errors.length > 10) {
            console.log(`     ... and ${errors.length - 10} more`);
        }
    }
}

main().catch((err) => {
    console.error('Fatal error:', err.message);
    process.exit(1);
});
