/**
 * DataBundle — Pre-loaded data container for sharing across Simulator instances.
 *
 * Fetches all heavy data (markets, klines, DVOL, Chainlink) once,
 * then injects into multiple Simulator.run() calls to avoid redundant I/O.
 * Primary use case: sweep/optimizer modes that run many configs on the same date range.
 */

import { BinanceKline, HistoricalMarket, DeribitVolPoint } from '../types';
import { ChainlinkPricePoint } from '../fetchers/chainlink-historical';
import { BinanceHistoricalFetcher } from '../fetchers/binance-historical';
import { PolymarketMarketsFetcher } from '../fetchers/polymarket-markets';
import { DeribitVolFetcher } from '../fetchers/deribit-vol';
import { ChainlinkHistoricalFetcher } from '../fetchers/chainlink-historical';

/**
 * Immutable container holding all pre-fetched data arrays.
 * Once created via DataBundle.load(), the data is frozen and read-only.
 */
export interface DataBundleData {
    readonly markets: HistoricalMarket[];
    readonly btcKlines: BinanceKline[];
    readonly volPoints: DeribitVolPoint[];
    readonly chainlinkPrices: ChainlinkPricePoint[];
    readonly startTs: number;
    readonly endTs: number;
}

/**
 * Pre-loaded data bundle for sharing across multiple Simulator instances.
 *
 * Usage:
 *   const bundle = await DataBundle.load(startDate, endDate);
 *   const sim1 = new Simulator({ minEdge: 0.02 });
 *   const result1 = await sim1.run(bundle);
 *   const sim2 = new Simulator({ minEdge: 0.04 });
 *   const result2 = await sim2.run(bundle);
 */
export class DataBundle {
    readonly data: DataBundleData;

    private constructor(data: DataBundleData) {
        this.data = data;
    }

    /**
     * Load all data for a date range using existing fetchers.
     * Logs progress to console (this is a one-time operation, not silenced).
     */
    static async load(startDate: Date, endDate: Date): Promise<DataBundle> {
        const startTs = startDate.getTime();
        const endTs = endDate.getTime();

        console.log('📦 DataBundle: Loading shared data...');

        // Step 1: Markets
        console.log('   📡 Fetching historical markets...');
        const marketsFetcher = new PolymarketMarketsFetcher();
        const markets = await marketsFetcher.fetch(startTs, endTs);
        console.log(`   ✅ ${markets.length} markets`);

        // Step 2: Binance klines
        console.log('   📡 Fetching Binance BTC prices...');
        const binanceFetcher = new BinanceHistoricalFetcher('BTCUSDT', '1m');
        const btcKlines = await binanceFetcher.fetch(startTs, endTs);
        console.log(`   ✅ ${btcKlines.length} klines`);

        // Step 3: Deribit DVOL
        console.log('   📡 Fetching Deribit DVOL...');
        const volFetcher = new DeribitVolFetcher('BTC', 60);
        const volPoints = await volFetcher.fetch(startTs, endTs);
        console.log(`   ✅ ${volPoints.length} vol points`);

        // Step 4: Chainlink oracle prices
        console.log('   📡 Fetching Chainlink oracle prices...');
        const chainlinkFetcher = new ChainlinkHistoricalFetcher();
        const chainlinkPrices = await chainlinkFetcher.fetch(startTs, endTs);
        console.log(`   ✅ ${chainlinkPrices.length} Chainlink points`);

        console.log('📦 DataBundle: All data loaded.\n');

        return new DataBundle({
            markets,
            btcKlines,
            volPoints,
            chainlinkPrices,
            startTs,
            endTs,
        });
    }

    /** Number of markets in the bundle */
    get marketCount(): number {
        return this.data.markets.length;
    }

    /** Number of BTC klines in the bundle */
    get klineCount(): number {
        return this.data.btcKlines.length;
    }
}
