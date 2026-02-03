/**
 * Fetch 1 month of historical data for backtesting
 * January 3 - February 2, 2026 (30 days)
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { fetchBinanceKlines } from './fetchers/binance-historical';
import { fetchChainlinkPrices } from './fetchers/chainlink-historical';

const START = new Date('2026-01-03T00:00:00Z').getTime();
const END = new Date('2026-02-02T23:59:59Z').getTime();

async function main() {
  console.log('═'.repeat(80));
  console.log('  📥 FETCHING 1 MONTH OF HISTORICAL DATA');
  console.log('═'.repeat(80));
  console.log(`\n📅 Date range: ${new Date(START).toISOString()} to ${new Date(END).toISOString()}`);
  console.log(`   Duration: ~30 days\n`);

  // Step 1: Fetch Binance data (fast - ~2-5 minutes)
  console.log('═'.repeat(80));
  console.log('  STEP 1: BINANCE KLINES');
  console.log('═'.repeat(80));
  console.log(`\n⏳ Starting Binance fetch at ${new Date().toISOString()}`);

  try {
    const binanceStart = Date.now();
    const klines = await fetchBinanceKlines('BTCUSDT', '1m', START, END, true);
    const binanceElapsed = (Date.now() - binanceStart) / 1000;

    console.log(`\n✅ BINANCE COMPLETE`);
    console.log(`   Klines fetched: ${klines.length}`);
    console.log(`   Time elapsed: ${binanceElapsed.toFixed(1)}s`);
    console.log(`   First: ${new Date(klines[0]?.timestamp).toISOString()}`);
    console.log(`   Last: ${new Date(klines[klines.length - 1]?.timestamp).toISOString()}`);
  } catch (err: any) {
    console.error(`\n❌ BINANCE ERROR: ${err.message}`);
  }

  // Step 2: Fetch Chainlink data (slow - 4-8 hours)
  console.log('\n' + '═'.repeat(80));
  console.log('  STEP 2: CHAINLINK PRICES (this takes 4-8 hours)');
  console.log('═'.repeat(80));
  console.log(`\n⏳ Starting Chainlink fetch at ${new Date().toISOString()}`);
  console.log(`   This will fetch ~60,000+ rounds from the blockchain`);
  console.log(`   Estimated time: 4-8 hours`);
  console.log(`   Progress will be logged every 100 rounds\n`);

  try {
    const chainlinkStart = Date.now();
    const prices = await fetchChainlinkPrices(START, END, true);
    const chainlinkElapsed = (Date.now() - chainlinkStart) / 1000;
    const hours = Math.floor(chainlinkElapsed / 3600);
    const mins = Math.floor((chainlinkElapsed % 3600) / 60);

    console.log(`\n✅ CHAINLINK COMPLETE`);
    console.log(`   Prices fetched: ${prices.length}`);
    console.log(`   Time elapsed: ${hours}h ${mins}m`);
    console.log(`   First: ${new Date(prices[0]?.timestamp).toISOString()}`);
    console.log(`   Last: ${new Date(prices[prices.length - 1]?.timestamp).toISOString()}`);
  } catch (err: any) {
    console.error(`\n❌ CHAINLINK ERROR: ${err.message}`);
  }

  // Summary
  console.log('\n' + '═'.repeat(80));
  console.log('  ✅ DATA FETCH COMPLETE');
  console.log('═'.repeat(80));
  console.log(`\nFinished at: ${new Date().toISOString()}`);
  console.log(`\nData files saved to:`);
  console.log(`   ./data/binance/`);
  console.log(`   ./data/chainlink/`);
}

main().catch(console.error);
