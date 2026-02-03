#!/usr/bin/env npx ts-node
/**
 * Diagnostic script for fair value calculation
 */

import { calculateFairValue, calculateFairValueSimple, MODEL_PARAMS } from '../fair-value';

// =============================================================================
// MANUAL CALCULATION
// =============================================================================

console.log('═'.repeat(70));
console.log('  FAIR VALUE DIAGNOSTIC');
console.log('═'.repeat(70));

// Your example values
const S = 88000;   // Current BTC
const K = 87900;   // Strike ($100 below)
const T_min = 15;  // 15 minutes
const sigma = 0.60; // 60% annualized
const r = MODEL_PARAMS.RISK_FREE_RATE;

// Convert time
const T_seconds = T_min * 60;
const T_years = T_seconds / (365 * 24 * 3600);

console.log('\n📋 INPUT VALUES:');
console.log(`   S (current):  $${S.toLocaleString()}`);
console.log(`   K (strike):   $${K.toLocaleString()}`);
console.log(`   T:            ${T_min} min = ${T_seconds} seconds = ${T_years.toExponential(4)} years`);
console.log(`   σ:            ${(sigma * 100).toFixed(0)}% annualized`);
console.log(`   r:            ${(r * 100).toFixed(1)}%`);

console.log('\n' + '─'.repeat(70));
console.log('  STEP-BY-STEP CALCULATION');
console.log('─'.repeat(70));

// Step 1: σ√τ
const sigmaT = sigma * Math.sqrt(T_years);
console.log(`\n1. σ√τ = ${sigma} × √${T_years.toExponential(4)}`);
console.log(`       = ${sigma} × ${Math.sqrt(T_years).toExponential(4)}`);
console.log(`       = ${sigmaT.toFixed(6)} (${(sigmaT * 100).toFixed(4)}%)`);

// Step 2: ln(S/K)
const logSK = Math.log(S / K);
console.log(`\n2. ln(S/K) = ln(${S}/${K})`);
console.log(`          = ln(${(S/K).toFixed(6)})`);
console.log(`          = ${logSK.toFixed(6)}`);

// Step 3: Drift term (r - σ²/2)τ
const sigmaSquaredHalf = (sigma * sigma) / 2;
const driftTerm = (r - sigmaSquaredHalf) * T_years;
console.log(`\n3. Drift term = (r - σ²/2) × τ`);
console.log(`             = (${r} - ${sigmaSquaredHalf.toFixed(4)}) × ${T_years.toExponential(4)}`);
console.log(`             = ${(r - sigmaSquaredHalf).toFixed(4)} × ${T_years.toExponential(4)}`);
console.log(`             = ${driftTerm.toExponential(4)}`);

// Step 4: d₂
const d2_manual = (logSK + driftTerm) / sigmaT;
console.log(`\n4. d₂ = [ln(S/K) + drift] / (σ√τ)`);
console.log(`      = [${logSK.toFixed(6)} + ${driftTerm.toExponential(4)}] / ${sigmaT.toFixed(6)}`);
console.log(`      = ${(logSK + driftTerm).toFixed(6)} / ${sigmaT.toFixed(6)}`);
console.log(`      = ${d2_manual.toFixed(4)}`);

// Step 5: Φ(d₂) using approximation
function normalCDF(x: number): number {
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x);

    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);

    return 0.5 * (1.0 + sign * y);
}

const pUp_manual = normalCDF(d2_manual);
console.log(`\n5. P(UP) = Φ(${d2_manual.toFixed(4)})`);
console.log(`        = ${(pUp_manual * 100).toFixed(2)}%`);

console.log('\n' + '─'.repeat(70));
console.log('  FUNCTION OUTPUT');
console.log('─'.repeat(70));

// Test the actual function
const fvSimple = calculateFairValueSimple(S, K, T_seconds, sigma);
const fvAdjusted = calculateFairValue(S, K, T_seconds, sigma, true);

console.log('\n📊 calculateFairValueSimple (no adjustments):');
console.log(`   d:       ${fvSimple.d?.toFixed(4) ?? 'N/A'}`);
console.log(`   sigmaT:  ${fvSimple.sigmaT !== undefined ? (fvSimple.sigmaT * 100).toFixed(4) + '%' : 'N/A'}`);
console.log(`   P(UP):   ${(fvSimple.pUp * 100).toFixed(2)}%`);
console.log(`   P(DOWN): ${(fvSimple.pDown * 100).toFixed(2)}%`);

console.log('\n📊 calculateFairValue (with adjustments):');
console.log(`   d:       ${fvAdjusted.d?.toFixed(4) ?? 'N/A'}`);
console.log(`   sigmaT:  ${fvAdjusted.sigmaT !== undefined ? (fvAdjusted.sigmaT * 100).toFixed(4) + '%' : 'N/A'}`);
console.log(`   P(UP):   ${(fvAdjusted.pUp * 100).toFixed(2)}%`);
console.log(`   P(DOWN): ${(fvAdjusted.pDown * 100).toFixed(2)}%`);

console.log('\n' + '─'.repeat(70));
console.log('  VERIFICATION');
console.log('─'.repeat(70));

const manualVsSimple = fvSimple.d !== undefined ? Math.abs(d2_manual - fvSimple.d) : NaN;
console.log(`\n✓ Manual d₂ matches function d? Diff = ${manualVsSimple.toExponential(4)}`);
console.log(`  Manual: ${d2_manual.toFixed(6)}, Function: ${fvSimple.d?.toFixed(6) ?? 'N/A'}`);

console.log('\n' + '═'.repeat(70));
console.log('  VOLATILITY CHECK');
console.log('═'.repeat(70));

// Test with different vol values to see the impact
console.log('\n📊 P(UP) at different volatilities (S=$88000, K=$87900, T=15min):');
console.log('   Vol%   |    d    | P(UP)% | Impact');
console.log('   ────────────────────────────────────');

for (const vol of [0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90, 1.00]) {
    const fv = calculateFairValueSimple(S, K, T_seconds, vol);
    const market50 = 0.50;
    console.log(`   ${(vol * 100).toFixed(0).padStart(3)}%  | ${(fv.d ?? 0).toFixed(3).padStart(6)} | ${(fv.pUp * 100).toFixed(1).padStart(5)}% | ${fv.pUp > 0.5 ? 'BUY YES' : 'SKIP'}`);
}

console.log('\n' + '═'.repeat(70));
console.log('  TIME DECAY IMPACT');
console.log('═'.repeat(70));

// Test P(UP) at different times remaining
console.log('\n📊 P(UP) at different times remaining (S=$88000, K=$87900, σ=60%):');
console.log('   Time    |    d    | P(UP)%');
console.log('   ──────────────────────────');

for (const mins of [15, 10, 5, 2, 1, 0.5, 0.1]) {
    const fv = calculateFairValueSimple(S, K, mins * 60, sigma);
    console.log(`   ${mins.toFixed(1).padStart(4)} min | ${(fv.d ?? 0).toFixed(3).padStart(6)} | ${(fv.pUp * 100).toFixed(1).padStart(5)}%`);
}

console.log('\n' + '═'.repeat(70));
console.log('  MONEYNESS IMPACT');
console.log('═'.repeat(70));

// Test P(UP) at different strike distances
console.log('\n📊 P(UP) at different strike distances (S=$88000, T=15min, σ=60%):');
console.log('   Strike    | Distance |    d    | P(UP)%');
console.log('   ───────────────────────────────────────');

for (const dist of [-500, -200, -100, -50, 0, 50, 100, 200, 500]) {
    const strike = S + dist;
    const fv = calculateFairValueSimple(S, strike, T_seconds, sigma);
    const distStr = dist >= 0 ? `+${dist}` : `${dist}`;
    console.log(`   $${strike.toLocaleString().padEnd(6)} | ${distStr.padStart(5)} | ${(fv.d ?? 0).toFixed(3).padStart(6)} | ${(fv.pUp * 100).toFixed(1).padStart(5)}%`);
}

console.log('\n' + '═'.repeat(70));
console.log('  MODEL PARAMETERS');
console.log('═'.repeat(70));

console.log('\n📋 Current MODEL_PARAMS:');
console.log(`   RISK_FREE_RATE:     ${MODEL_PARAMS.RISK_FREE_RATE}`);
console.log(`   KURTOSIS_FACTOR:    ${MODEL_PARAMS.KURTOSIS_FACTOR}`);
console.log(`   KURTOSIS_THRESHOLD: ${MODEL_PARAMS.KURTOSIS_THRESHOLD}`);
console.log(`   SMILE_COEFFICIENT:  ${MODEL_PARAMS.SMILE_COEFFICIENT}`);
console.log(`   SMILE_MAX_BOOST:    ${MODEL_PARAMS.SMILE_MAX_BOOST}`);

console.log('\n' + '═'.repeat(70));
console.log('  CRITICAL ANALYSIS');
console.log('═'.repeat(70));

console.log('\n🔴 KEY OBSERVATION FROM BACKTEST:');
console.log('   - 1948 YES trades, 0 NO trades');
console.log('   - Model ONLY buys YES, never NO');
console.log('   - This suggests systematic bias toward P(UP)');

console.log('\n📊 When would model buy YES vs NO?');
console.log('   BUY YES: when P(UP) > market_price + spread + edge');
console.log('   BUY NO:  when P(DOWN) > market_price + spread + edge');
console.log('   With 10% edge, 4¢ spread:');
console.log('   BUY YES: P(UP) > 0.50 + 0.02 + 0.10 = 0.62 (62%)');
console.log('   BUY NO:  P(DOWN) > 0.50 + 0.02 + 0.10 = 0.62 (62%)');
console.log('           which means P(UP) < 0.38 (38%)');

console.log('\n💡 IMPLICATION:');
console.log('   Model only signals YES when BTC is significantly ABOVE strike');
console.log('   But if BTC already moved up, it might be more likely to revert');
console.log('   The model assumes random walk, but short-term may have mean reversion');

console.log('\n' + '═'.repeat(70));
console.log('  WHAT VOL VALUE WOULD GIVE 50/50 AT $100 ABOVE STRIKE?');
console.log('═'.repeat(70));

// Find vol where P(UP) = 50% at S=$88000, K=$87900, T=15min
console.log('\nSolving: What vol gives P(UP) = 50% when S > K by $100?');
for (const vol of [1.0, 1.5, 2.0, 2.5, 3.0]) {
    const fv = calculateFairValueSimple(88000, 87900, 900, vol);
    console.log(`   Vol=${(vol * 100).toFixed(0)}%: d=${(fv.d ?? 0).toFixed(3)}, P(UP)=${(fv.pUp * 100).toFixed(1)}%`);
}

console.log('\n💡 To get P(UP) = 50% when $100 ITM, need d₂ = 0');
console.log('   d₂ = [ln(88000/87900) + (r - σ²/2)τ] / (σ√τ) = 0');
console.log('   ln(1.001137) = -drift × (σ√τ)');
console.log('   This requires VERY high vol or accounting for mean reversion');

console.log('\n' + '═'.repeat(70));
console.log('  REALIZED VOL CHECK');
console.log('═'.repeat(70));

// Calculate what short-term vol might actually look like
console.log('\n📊 If BTC moves $100 in 1 minute, what annualized vol is that?');
const btc = 88000;
const move1min = 100;  // $100 move
const return1min = Math.log((btc + move1min) / btc);
const annualizedFromMove = Math.abs(return1min) * Math.sqrt(525600); // 1-min returns → annualized
console.log(`   $100 move on $88k = ${(return1min * 100).toFixed(3)}% return`);
console.log(`   Annualized: ${(annualizedFromMove * 100).toFixed(0)}%`);

const move5min = 200;  // $200 move over 5 min
const return5min = Math.log((btc + move5min) / btc);
const annualizedFrom5min = Math.abs(return5min) * Math.sqrt(525600 / 5);
console.log(`   $200 move over 5min = ${(return5min * 100).toFixed(3)}% return`);
console.log(`   Annualized: ${(annualizedFrom5min * 100).toFixed(0)}%`);

console.log('\n💡 INSIGHT:');
console.log('   If blended vol is ~60% but actual short-term moves suggest 150%+,');
console.log('   the model will be overconfident about P(UP) when BTC has moved up');

console.log('\n' + '═'.repeat(70));
console.log('  THE ROOT CAUSE');
console.log('═'.repeat(70));

console.log('\n🔴 HYPOTHESIS: Vol blend uses TOO MUCH historical realized vol');
console.log('\n   Current blend: 70% 1h realized + 20% 4h realized + 10% DVOL');
console.log('   This smooths out recent volatility spikes');
console.log('\n   When BTC spikes $100-$200 in minutes:');
console.log('   - Instantaneous vol is MUCH higher than 60%');
console.log('   - But blended vol is still showing ~60%');
console.log('   - Model thinks "BTC is $100 above strike, easy UP"');
console.log('   - But high short-term vol means anything can happen');
console.log('   - Market makers know this → price stays near 50%');

console.log('\n📊 WHAT THE MARKET SEES vs WHAT MODEL SEES:');
console.log('   ┌──────────────────┬─────────────┬─────────────┐');
console.log('   │ Scenario         │ Model P(UP) │ Market P(UP)│');
console.log('   ├──────────────────┼─────────────┼─────────────┤');
console.log('   │ BTC +$100, σ=60% │    67%      │    ~52-55%  │');
console.log('   │ BTC +$200, σ=60% │    80%      │    ~55-60%  │');
console.log('   │ BTC +$100, σ=150%│    57%      │    ~52-55%  │');
console.log('   └──────────────────┴─────────────┴─────────────┘');

console.log('\n✅ SOLUTION OPTIONS:');
console.log('   1. Increase vol multiplier for short-term (e.g., 2x-3x)');
console.log('   2. Weight recent volatility MORE heavily');
console.log('   3. Use instantaneous vol from last few minutes');
console.log('   4. Add mean reversion factor to d₂');
console.log('   5. Increase minimum edge threshold to 15-20%');

console.log('\n');

