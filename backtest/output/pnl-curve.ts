/**
 * P&L Curve Generator
 * Creates P&L curve data and exports for visualization
 */

import * as fs from 'fs';
import * as path from 'path';
import { PnLPoint, MarketResolution, Trade } from '../types';

const OUTPUT_DIR = path.join(__dirname, '../../data/output');

/**
 * Ensure output directory exists
 */
function ensureOutputDir(): void {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

/**
 * Generate P&L curve from market resolutions
 * Each point represents cumulative P&L after a market resolves
 */
export function generatePnLCurveFromResolutions(resolutions: MarketResolution[]): PnLPoint[] {
  const curve: PnLPoint[] = [];
  let cumulativePnL = 0;

  // Sort by timestamp (assuming marketId contains or correlates with time)
  // In practice, we'd want actual resolution timestamps
  for (let i = 0; i < resolutions.length; i++) {
    cumulativePnL += resolutions[i].pnl;
    
    curve.push({
      timestamp: Date.now() - (resolutions.length - i) * 15 * 60 * 1000, // Approximate
      cumulativePnL,
      realizedPnL: cumulativePnL,
      unrealizedPnL: 0,
    });
  }

  return curve;
}

/**
 * Generate detailed P&L curve from trades
 */
export function generatePnLCurveFromTrades(
  trades: Trade[],
  resolutions: MarketResolution[]
): PnLPoint[] {
  const curve: PnLPoint[] = [];
  
  // Create a map of market resolutions
  const resolutionMap = new Map<string, MarketResolution>();
  for (const r of resolutions) {
    resolutionMap.set(r.marketId, r);
  }

  // Track positions and costs per market
  const positions = new Map<string, { yesShares: number; noShares: number; cost: number }>();
  let realizedPnL = 0;

  // Sort trades by timestamp
  const sortedTrades = [...trades].sort((a, b) => a.timestamp - b.timestamp);

  // Track which markets have been resolved
  const resolvedMarkets = new Set<string>();

  for (const trade of sortedTrades) {
    // Update position
    let pos = positions.get(trade.marketId);
    if (!pos) {
      pos = { yesShares: 0, noShares: 0, cost: 0 };
      positions.set(trade.marketId, pos);
    }

    if (trade.action === 'BUY') {
      if (trade.side === 'YES') {
        pos.yesShares += trade.size;
      } else {
        pos.noShares += trade.size;
      }
      pos.cost += trade.cost;
    } else {
      if (trade.side === 'YES') {
        pos.yesShares -= trade.size;
      } else {
        pos.noShares -= trade.size;
      }
      pos.cost += trade.cost; // Negative for sells
    }

    // Check if this trade's market has been resolved
    const resolution = resolutionMap.get(trade.marketId);
    if (resolution && !resolvedMarkets.has(trade.marketId)) {
      // Check if all trades for this market are done
      const marketTrades = sortedTrades.filter(t => t.marketId === trade.marketId);
      const lastMarketTrade = marketTrades[marketTrades.length - 1];
      
      if (trade === lastMarketTrade) {
        // Resolve this market
        realizedPnL += resolution.pnl;
        resolvedMarkets.add(trade.marketId);
      }
    }

    // Calculate unrealized P&L (simplified - assume 50% value for open positions)
    let unrealizedPnL = 0;
    const positionEntries = Array.from(positions.entries());
    for (const [marketId, p] of positionEntries) {
      if (!resolvedMarkets.has(marketId)) {
        // Open position - estimate value at 50%
        unrealizedPnL += (p.yesShares + p.noShares) * 0.5 - p.cost;
      }
    }

    curve.push({
      timestamp: trade.timestamp,
      cumulativePnL: realizedPnL + unrealizedPnL,
      realizedPnL,
      unrealizedPnL,
    });
  }

  return curve;
}

/**
 * Export P&L curve to CSV
 */
export function exportPnLCurveToCsv(curve: PnLPoint[], filename: string = 'pnl_curve.csv'): string {
  ensureOutputDir();
  
  const filepath = path.join(OUTPUT_DIR, filename);
  
  const headers = ['timestamp', 'datetime', 'cumulativePnL', 'realizedPnL', 'unrealizedPnL'];
  
  const rows = curve.map(p => [
    p.timestamp,
    new Date(p.timestamp).toISOString(),
    p.cumulativePnL.toFixed(4),
    p.realizedPnL.toFixed(4),
    p.unrealizedPnL.toFixed(4),
  ]);
  
  const csv = [
    headers.join(','),
    ...rows.map(r => r.join(',')),
  ].join('\n');
  
  fs.writeFileSync(filepath, csv);
  console.log(`📄 Exported P&L curve to ${filename}`);
  
  return filepath;
}

/**
 * Export P&L curve to JSON
 */
export function exportPnLCurveToJson(curve: PnLPoint[], filename: string = 'pnl_curve.json'): string {
  ensureOutputDir();
  
  const filepath = path.join(OUTPUT_DIR, filename);
  
  const data = curve.map(p => ({
    ...p,
    datetime: new Date(p.timestamp).toISOString(),
  }));
  
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  console.log(`📄 Exported P&L curve to ${filename}`);
  
  return filepath;
}

/**
 * Generate ASCII chart of P&L curve
 */
export function generateAsciiChart(curve: PnLPoint[], width: number = 60, height: number = 15): string {
  if (curve.length === 0) return 'No data';

  const values = curve.map(p => p.cumulativePnL);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  // Sample points to fit width
  const step = Math.max(1, Math.floor(curve.length / width));
  const sampledValues: number[] = [];
  for (let i = 0; i < curve.length; i += step) {
    sampledValues.push(values[i]);
  }

  // Build chart
  const lines: string[] = [];
  
  // Y-axis labels
  const yLabelWidth = Math.max(max.toFixed(2).length, min.toFixed(2).length) + 1;
  
  for (let row = 0; row < height; row++) {
    const threshold = max - (row / (height - 1)) * range;
    
    // Y-axis label (only for top, middle, bottom)
    let yLabel = '';
    if (row === 0) yLabel = max.toFixed(2);
    else if (row === height - 1) yLabel = min.toFixed(2);
    else if (row === Math.floor(height / 2)) yLabel = ((max + min) / 2).toFixed(2);
    
    let line = yLabel.padStart(yLabelWidth) + ' │';
    
    for (let col = 0; col < sampledValues.length; col++) {
      const val = sampledValues[col];
      const nextVal = sampledValues[col + 1] ?? val;
      
      // Check if this cell should be filled
      const cellMin = Math.min(val, nextVal);
      const cellMax = Math.max(val, nextVal);
      const rowMin = max - ((row + 1) / (height - 1)) * range;
      const rowMax = max - (row / (height - 1)) * range;
      
      if (val >= threshold) {
        line += '█';
      } else if (val >= rowMin && val < rowMax) {
        line += '▄';
      } else {
        line += ' ';
      }
    }
    
    lines.push(line);
  }
  
  // X-axis
  lines.push(' '.repeat(yLabelWidth) + ' └' + '─'.repeat(sampledValues.length));
  
  // X-axis labels
  const startDate = new Date(curve[0].timestamp).toLocaleDateString();
  const endDate = new Date(curve[curve.length - 1].timestamp).toLocaleDateString();
  lines.push(' '.repeat(yLabelWidth + 2) + startDate + ' '.repeat(Math.max(0, sampledValues.length - startDate.length - endDate.length)) + endDate);
  
  return lines.join('\n');
}

/**
 * Print P&L curve to console
 */
export function printPnLCurve(curve: PnLPoint[]): void {
  console.log('\n📈 P&L Curve\n');
  console.log(generateAsciiChart(curve));
  
  if (curve.length > 0) {
    const first = curve[0];
    const last = curve[curve.length - 1];
    const change = last.cumulativePnL - first.cumulativePnL;
    const changeStr = change >= 0 ? `+$${change.toFixed(2)}` : `-$${Math.abs(change).toFixed(2)}`;
    
    console.log(`\n   Start: $${first.cumulativePnL.toFixed(2)} → End: $${last.cumulativePnL.toFixed(2)} (${changeStr})`);
  }
}

/**
 * Calculate drawdown curve
 */
export function calculateDrawdownCurve(curve: PnLPoint[]): { timestamp: number; drawdown: number; drawdownPct: number }[] {
  const result: { timestamp: number; drawdown: number; drawdownPct: number }[] = [];
  
  let peak = 0;
  
  for (const point of curve) {
    peak = Math.max(peak, point.cumulativePnL);
    const drawdown = peak - point.cumulativePnL;
    const drawdownPct = peak > 0 ? drawdown / peak : 0;
    
    result.push({
      timestamp: point.timestamp,
      drawdown,
      drawdownPct,
    });
  }
  
  return result;
}

/**
 * Print drawdown analysis
 */
export function printDrawdownAnalysis(curve: PnLPoint[]): void {
  const drawdowns = calculateDrawdownCurve(curve);
  
  if (drawdowns.length === 0) {
    console.log('\nNo drawdown data');
    return;
  }
  
  const maxDrawdown = Math.max(...drawdowns.map(d => d.drawdown));
  const maxDrawdownPoint = drawdowns.find(d => d.drawdown === maxDrawdown);
  
  console.log('\n📉 Drawdown Analysis\n');
  console.log('─'.repeat(40));
  console.log(`   Max Drawdown:     $${maxDrawdown.toFixed(2)}`);
  
  if (maxDrawdownPoint) {
    console.log(`   Max DD Date:      ${new Date(maxDrawdownPoint.timestamp).toISOString()}`);
    console.log(`   Max DD Percent:   ${(maxDrawdownPoint.drawdownPct * 100).toFixed(2)}%`);
  }
  
  // Calculate average drawdown
  const avgDrawdown = drawdowns.reduce((sum, d) => sum + d.drawdown, 0) / drawdowns.length;
  console.log(`   Avg Drawdown:     $${avgDrawdown.toFixed(2)}`);
  
  // Time in drawdown
  const inDrawdown = drawdowns.filter(d => d.drawdown > 0).length;
  const timeInDrawdown = (inDrawdown / drawdowns.length) * 100;
  console.log(`   Time in Drawdown: ${timeInDrawdown.toFixed(1)}%`);
  
  console.log('─'.repeat(40));
}

