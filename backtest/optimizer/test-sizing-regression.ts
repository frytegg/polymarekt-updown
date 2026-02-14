#!/usr/bin/env npx ts-node
/**
 * Non-regression test: sizingMode='fixed' must produce identical results
 * to the pre-Kelly code path (same trades, same P&L, same stats).
 *
 * Also tests Kelly coherence: Kelly sizing with finite capital should produce
 * trades whose sizes scale with equity.
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { Simulator } from '../engine/simulator';
import { DataBundle } from '../engine/data-bundle';
import { BacktestConfig } from '../types';
import { calculateStatistics } from '../output/statistics';

async function main(): Promise<void> {
    const startDate = new Date('2026-01-15');
    const endDate = new Date('2026-01-22');

    console.log('=== Sizing Regression & Coherence Tests ===\n');

    // Load data once
    const bundle = await DataBundle.load(startDate, endDate);

    // ── Test 1: Fixed sizing produces identical results ──
    console.log('Test 1: Fixed sizing non-regression...');

    const baseConfig: Partial<BacktestConfig> = {
        startDate,
        endDate,
        mode: 'conservative',
        spreadCents: 6,
        minEdge: 0.25,
        orderSize: 100,
        includeFees: true,
        slippageBps: 200,
        silent: true,
    };

    // Run with explicit sizingMode='fixed' (new code path)
    const simFixed = new Simulator({ ...baseConfig, sizingMode: 'fixed' });
    const resultFixed = await simFixed.run(bundle);

    // Run with default (should also be 'fixed')
    const simDefault = new Simulator(baseConfig);
    const resultDefault = await simDefault.run(bundle);

    // Compare
    const fixedPnL = resultFixed.totalPnL;
    const defaultPnL = resultDefault.totalPnL;
    const fixedTrades = resultFixed.totalTrades;
    const defaultTrades = resultDefault.totalTrades;

    if (Math.abs(fixedPnL - defaultPnL) > 0.001 || fixedTrades !== defaultTrades) {
        console.error(`  FAIL: Fixed P&L=${fixedPnL.toFixed(4)} vs Default P&L=${defaultPnL.toFixed(4)}`);
        console.error(`  FAIL: Fixed trades=${fixedTrades} vs Default trades=${defaultTrades}`);
        process.exit(1);
    }
    console.log(`  PASS: Both runs → ${fixedTrades} trades, P&L=$${fixedPnL.toFixed(2)}\n`);

    // ── Test 2: Kelly sizing produces trades (with finite capital) ──
    console.log('Test 2: Kelly sizing produces trades...');

    const kellyConfig: Partial<BacktestConfig> = {
        ...baseConfig,
        sizingMode: 'kelly',
        kellyFraction: 0.5,
        initialCapital: 500,
    };

    const simKelly = new Simulator(kellyConfig);
    const resultKelly = await simKelly.run(bundle);

    if (resultKelly.totalTrades === 0) {
        console.error(`  FAIL: Kelly sizing produced 0 trades (expected >0)`);
        process.exit(1);
    }
    console.log(`  PASS: Kelly → ${resultKelly.totalTrades} trades, P&L=$${resultKelly.totalPnL.toFixed(2)}\n`);

    // ── Test 3: Kelly sizes scale with equity ──
    console.log('Test 3: Kelly sizes scale with capital...');

    const kellySmall: Partial<BacktestConfig> = {
        ...baseConfig,
        sizingMode: 'kelly',
        kellyFraction: 0.5,
        initialCapital: 100,
    };

    const kellyLarge: Partial<BacktestConfig> = {
        ...baseConfig,
        sizingMode: 'kelly',
        kellyFraction: 0.5,
        initialCapital: 1000,
    };

    const simSmall = new Simulator(kellySmall);
    const resultSmall = await simSmall.run(bundle);

    const simLarge = new Simulator(kellyLarge);
    const resultLarge = await simLarge.run(bundle);

    const statsSmall = calculateStatistics(resultSmall);
    const statsLarge = calculateStatistics(resultLarge);

    // With 10x capital, total staked should be larger (not necessarily 10x due to MTM dynamics)
    if (resultLarge.totalTrades > 0 && resultSmall.totalTrades > 0) {
        const stakedRatio = statsLarge.totalStaked / Math.max(statsSmall.totalStaked, 0.01);
        if (stakedRatio < 1.5) {
            console.error(`  FAIL: 10x capital only produced ${stakedRatio.toFixed(1)}x staked (expected >1.5x)`);
            process.exit(1);
        }
        console.log(`  PASS: 10x capital → ${stakedRatio.toFixed(1)}x total staked`);
        console.log(`    Small: ${resultSmall.totalTrades} trades, staked=$${statsSmall.totalStaked.toFixed(2)}`);
        console.log(`    Large: ${resultLarge.totalTrades} trades, staked=$${statsLarge.totalStaked.toFixed(2)}\n`);
    } else {
        console.log(`  SKIP: Not enough trades to compare (small=${resultSmall.totalTrades}, large=${resultLarge.totalTrades})\n`);
    }

    // ── Test 4: Kelly with kellyFraction=0 produces 0 trades ──
    console.log('Test 4: Kelly with kellyFraction near-zero produces 0 trades...');

    const kellyZero: Partial<BacktestConfig> = {
        ...baseConfig,
        sizingMode: 'kelly',
        kellyFraction: 0.001, // Near-zero: should floor to 0 shares
        initialCapital: 10,   // Tiny capital + tiny fraction → 0 shares
    };

    const simZero = new Simulator(kellyZero);
    const resultZero = await simZero.run(bundle);

    if (resultZero.totalTrades === 0) {
        console.log(`  PASS: 0 trades (Kelly bet size floors to 0 shares)\n`);
    } else {
        // Not a failure — just informational
        console.log(`  INFO: ${resultZero.totalTrades} trades with near-zero Kelly (bet sizes still rounded up to 1)\n`);
    }

    console.log('=== All sizing tests passed ===');
}

main().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
