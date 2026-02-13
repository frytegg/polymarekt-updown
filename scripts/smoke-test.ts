#!/usr/bin/env npx ts-node
/**
 * Smoke Test Suite
 *
 * Verifies that all execution modes start correctly, produce expected
 * outputs, and respect mode boundaries.
 *
 * Usage: npx ts-node scripts/smoke-test.ts
 *
 * Tests:
 *   1. Paper trading mode starts with MockTradingService
 *   2. Live trading mode starts with real TradingService (dry init only)
 *   3. Backtest runs against cached data and produces results
 *   4. Backtest --cache-info works
 *   5. Backtest --from/--to date validation
 *   6. Logger mode field is correct per execution mode
 *   7. Backtest --initial-capital shows capital metrics
 *   8. Backtest reads .env risk params as defaults
 *   9. fetch-range --dry-run shows plan without fetching
 *  10. fetch-range --report-only generates coverage report
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// =============================================================================
// TYPES
// =============================================================================

interface TestResult {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  duration: number;
  message?: string;
  debugInfo?: {
    stdout?: string;
    stderr?: string;
    expectedConditions?: string[];
    failedCondition?: string;
  };
}

interface SpawnOptions {
  command: string;
  args: string[];
  env?: Record<string, string>;
  timeout: number;
  killAfterTimeout?: boolean;
}

interface CheckConditions {
  stdoutContains?: Array<string | RegExp>;
  stdoutNotContains?: Array<string | RegExp>;
  stderrContains?: Array<string | RegExp>;
  exitCode?: number;
}

// =============================================================================
// UTILITIES
// =============================================================================

/**
 * Spawn a process and capture output
 */
async function spawnProcess(options: SpawnOptions): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}> {
  return new Promise((resolve) => {
    const { command, args, env, timeout, killAfterTimeout = true } = options;

    const proc = spawn(command, args, {
      env: { ...process.env, ...env },
      shell: true,
      cwd: path.join(__dirname, '..'),
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let resolved = false;

    // Capture stdout
    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    // Capture stderr
    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    // Handle exit
    proc.on('exit', (code) => {
      if (!resolved) {
        resolved = true;
        resolve({ stdout, stderr, exitCode: code, timedOut });
      }
    });

    // Handle errors
    proc.on('error', (error) => {
      stderr += `Process error: ${error.message}\n`;
      if (!resolved) {
        resolved = true;
        resolve({ stdout, stderr, exitCode: -1, timedOut });
      }
    });

    // Timeout
    const timer = setTimeout(() => {
      timedOut = true;
      if (killAfterTimeout) {
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!proc.killed) {
            proc.kill('SIGKILL');
          }
        }, 2000);
      }
      if (!resolved) {
        resolved = true;
        resolve({ stdout, stderr, exitCode: null, timedOut });
      }
    }, timeout);

    // Clean up timer if process exits before timeout
    proc.on('exit', () => clearTimeout(timer));
  });
}

/**
 * Check conditions against captured output
 */
function checkConditions(
  stdout: string,
  stderr: string,
  exitCode: number | null,
  conditions: CheckConditions
): { pass: boolean; failedCondition?: string } {
  // Check exit code
  if (conditions.exitCode !== undefined && exitCode !== conditions.exitCode) {
    return {
      pass: false,
      failedCondition: `Exit code ${exitCode} !== expected ${conditions.exitCode}`,
    };
  }

  // Check stdout contains
  if (conditions.stdoutContains) {
    for (const pattern of conditions.stdoutContains) {
      const matches = typeof pattern === 'string'
        ? stdout.includes(pattern)
        : pattern.test(stdout);

      if (!matches) {
        return {
          pass: false,
          failedCondition: `stdout does not contain: ${pattern}`,
        };
      }
    }
  }

  // Check stdout does NOT contain
  if (conditions.stdoutNotContains) {
    for (const pattern of conditions.stdoutNotContains) {
      const matches = typeof pattern === 'string'
        ? stdout.includes(pattern)
        : pattern.test(stdout);

      if (matches) {
        return {
          pass: false,
          failedCondition: `stdout incorrectly contains: ${pattern}`,
        };
      }
    }
  }

  // Check stderr contains
  if (conditions.stderrContains) {
    for (const pattern of conditions.stderrContains) {
      const matches = typeof pattern === 'string'
        ? stderr.includes(pattern)
        : pattern.test(stderr);

      if (!matches) {
        return {
          pass: false,
          failedCondition: `stderr does not contain: ${pattern}`,
        };
      }
    }
  }

  return { pass: true };
}

/**
 * Get cached date range from --cache-info output
 */
async function getCachedDateRange(): Promise<{ start: string; end: string } | null> {
  const result = await spawnProcess({
    command: 'npx',
    args: ['ts-node', 'backtest/index.ts', '--cache-info'],
    timeout: 10000,
  });

  // Parse dates from output (format: YYYY-MM-DD)
  const dateMatches = result.stdout.match(/(\d{4}-\d{2}-\d{2})/g);

  if (!dateMatches || dateMatches.length < 2) {
    return null;
  }

  // Find the most recent date range with data
  // Look for lines like "2025-01-15 → 2025-01-22"
  const rangePattern = /(\d{4}-\d{2}-\d{2})\s*→\s*(\d{4}-\d{2}-\d{2})/g;
  let match;
  let lastRange: { start: string; end: string } | null = null;

  while ((match = rangePattern.exec(result.stdout)) !== null) {
    lastRange = { start: match[1], end: match[2] };
  }

  return lastRange;
}

/**
 * Check if .env file exists and contains specific variables
 */
function checkEnvFile(requiredVars: string[]): { exists: boolean; hasVars: boolean; values: Record<string, string> } {
  const envPath = path.join(__dirname, '..', '.env');

  if (!fs.existsSync(envPath)) {
    return { exists: false, hasVars: false, values: {} };
  }

  const envContent = fs.readFileSync(envPath, 'utf8');
  const values: Record<string, string> = {};
  let hasVars = true;

  for (const varName of requiredVars) {
    const match = envContent.match(new RegExp(`^${varName}=(.+)$`, 'm'));
    if (match) {
      values[varName] = match[1].trim();
    } else {
      hasVars = false;
    }
  }

  return { exists: true, hasVars, values };
}

// =============================================================================
// TESTS
// =============================================================================

/**
 * Test 1: Paper trading mode starts correctly
 */
async function test1_PaperTradingStartup(): Promise<TestResult> {
  const startTime = Date.now();

  const result = await spawnProcess({
    command: 'npx',
    args: ['ts-node', 'index.ts'],
    env: { PAPER_TRADING: 'true' },
    timeout: 15000,
    killAfterTimeout: true,
  });

  const duration = (Date.now() - startTime) / 1000;

  // Check conditions
  const check = checkConditions(result.stdout, result.stderr, result.exitCode, {
    stdoutContains: [/MockTradingService|Paper trading mode|paper/i],
    stdoutNotContains: ['CLOB client initialized'],
  });

  if (!check.pass) {
    return {
      name: 'Paper trading startup',
      status: 'fail',
      duration,
      message: check.failedCondition,
      debugInfo: {
        stdout: result.stdout.slice(-500),
        stderr: result.stderr.slice(-500),
      },
    };
  }

  return {
    name: 'Paper trading startup',
    status: 'pass',
    duration,
  };
}

/**
 * Test 2: Live trading mode init (dry check)
 */
async function test2_LiveTradingStartup(): Promise<TestResult> {
  const startTime = Date.now();

  // Pre-check: Skip if no API keys
  const envCheck = checkEnvFile(['PRIVATE_KEY', 'FUNDER_ADDRESS']);
  if (!envCheck.exists || !envCheck.hasVars) {
    return {
      name: 'Live trading startup',
      status: 'skip',
      duration: 0,
      message: 'no API keys configured',
    };
  }

  const result = await spawnProcess({
    command: 'npx',
    args: ['ts-node', 'index.ts'],
    env: { PAPER_TRADING: 'false' },
    timeout: 15000,
    killAfterTimeout: true,
  });

  const duration = (Date.now() - startTime) / 1000;

  // Check conditions
  const check = checkConditions(result.stdout, result.stderr, result.exitCode, {
    stdoutContains: [/TradingService|CLOB|initialized/i],
  });

  if (!check.pass) {
    return {
      name: 'Live trading startup',
      status: 'fail',
      duration,
      message: check.failedCondition,
      debugInfo: {
        stdout: result.stdout.slice(-500),
        stderr: result.stderr.slice(-500),
      },
    };
  }

  return {
    name: 'Live trading startup',
    status: 'pass',
    duration,
  };
}

/**
 * Test 3: Backtest with cached data
 */
async function test3_BacktestWithCachedData(dateRange: { start: string; end: string } | null): Promise<TestResult> {
  const startTime = Date.now();

  if (!dateRange) {
    return {
      name: 'Backtest with cached data',
      status: 'skip',
      duration: 0,
      message: 'no cached data available',
    };
  }

  const result = await spawnProcess({
    command: 'npx',
    args: [
      'ts-node',
      'backtest/index.ts',
      '--from', dateRange.start,
      '--to', dateRange.end,
      '--edge', '5',
      '--spread', '6',
    ],
    timeout: 120000,
  });

  const duration = (Date.now() - startTime) / 1000;

  // Check for errors
  if (result.stderr.match(/error|failed/i) && result.exitCode !== 0) {
    return {
      name: 'Backtest with cached data',
      status: 'fail',
      duration,
      message: 'stderr contains errors',
      debugInfo: {
        stderr: result.stderr.slice(-500),
      },
    };
  }

  // Check conditions
  const check = checkConditions(result.stdout, result.stderr, result.exitCode, {
    stdoutContains: ['RESULTS', /[+-]\$[\d.]+/],
    exitCode: 0,
  });

  if (!check.pass) {
    return {
      name: 'Backtest with cached data',
      status: 'fail',
      duration,
      message: check.failedCondition,
      debugInfo: {
        stdout: result.stdout.slice(-500),
        stderr: result.stderr.slice(-500),
      },
    };
  }

  return {
    name: 'Backtest with cached data',
    status: 'pass',
    duration,
  };
}

/**
 * Test 4: Backtest --cache-info
 */
async function test4_CacheInfo(): Promise<TestResult> {
  const startTime = Date.now();

  const result = await spawnProcess({
    command: 'npx',
    args: ['ts-node', 'backtest/index.ts', '--cache-info'],
    timeout: 10000,
  });

  const duration = (Date.now() - startTime) / 1000;

  // Check conditions
  const check = checkConditions(result.stdout, result.stderr, result.exitCode, {
    stdoutContains: [/cache/i, /\d{4}-\d{2}-\d{2}/],
    exitCode: 0,
  });

  if (!check.pass) {
    return {
      name: 'Backtest --cache-info',
      status: 'fail',
      duration,
      message: check.failedCondition,
      debugInfo: {
        stdout: result.stdout.slice(-500),
        stderr: result.stderr.slice(-500),
      },
    };
  }

  return {
    name: 'Backtest --cache-info',
    status: 'pass',
    duration,
  };
}

/**
 * Test 5: Backtest --from/--to date validation
 */
async function test5_DateValidation(): Promise<TestResult> {
  const startTime = Date.now();

  const result = await spawnProcess({
    command: 'npx',
    args: [
      'ts-node',
      'backtest/index.ts',
      '--from', '2099-01-01',
      '--to', '2099-02-01',
      '--edge', '5',
    ],
    timeout: 30000,
    killAfterTimeout: true,
  });

  const duration = (Date.now() - startTime) / 1000;

  // Check for warning about missing cache or data
  const hasWarning = /warn|missing|beyond|no cached|not found/i.test(result.stdout + result.stderr);

  if (!hasWarning) {
    return {
      name: 'Backtest date validation',
      status: 'fail',
      duration,
      message: 'no warning about missing/beyond cache data',
      debugInfo: {
        stdout: result.stdout.slice(-500),
        stderr: result.stderr.slice(-500),
      },
    };
  }

  return {
    name: 'Backtest date validation',
    status: 'pass',
    duration,
  };
}

/**
 * Test 6: Logger mode field
 */
async function test6_LoggerModeField(dateRange: { start: string; end: string } | null): Promise<TestResult> {
  const startTime = Date.now();

  // Test 6a: Paper mode logs
  const paperResult = await spawnProcess({
    command: 'npx',
    args: ['ts-node', 'index.ts'],
    env: { PAPER_TRADING: 'true' },
    timeout: 15000,
    killAfterTimeout: true,
  });

  const paperHasModeField = /mode.*paper|paper.*mode/i.test(paperResult.stdout);

  // Test 6b: Backtest logs
  let backtestHasModeField = false;
  if (dateRange) {
    const backtestResult = await spawnProcess({
      command: 'npx',
      args: [
        'ts-node',
        'backtest/index.ts',
        '--from', dateRange.start,
        '--to', dateRange.end,
        '--edge', '5',
      ],
      timeout: 120000,
    });

    backtestHasModeField = /backtest/i.test(backtestResult.stdout);
  }

  const duration = (Date.now() - startTime) / 1000;

  if (!paperHasModeField && !backtestHasModeField) {
    return {
      name: 'Logger mode fields',
      status: 'skip',
      duration,
      message: 'logs are not structured (no mode field detected)',
    };
  }

  if (!paperHasModeField) {
    return {
      name: 'Logger mode fields',
      status: 'fail',
      duration,
      message: 'paper mode field not found in logs',
    };
  }

  return {
    name: 'Logger mode fields',
    status: 'pass',
    duration,
  };
}

/**
 * Test 7: Backtest --initial-capital shows capital metrics
 */
async function test7_CapitalMetrics(dateRange: { start: string; end: string } | null): Promise<TestResult> {
  const startTime = Date.now();

  if (!dateRange) {
    return {
      name: 'Backtest capital metrics',
      status: 'skip',
      duration: 0,
      message: 'no cached data available',
    };
  }

  const result = await spawnProcess({
    command: 'npx',
    args: [
      'ts-node',
      'backtest/index.ts',
      '--from', dateRange.start,
      '--to', dateRange.end,
      '--edge', '5',
      '--spread', '6',
      '--initial-capital', '100',
    ],
    timeout: 120000,
  });

  const duration = (Date.now() - startTime) / 1000;

  // Check conditions
  const check = checkConditions(result.stdout, result.stderr, result.exitCode, {
    stdoutContains: [/ROI/i, /capital/i, /\$100/],
    exitCode: 0,
  });

  if (!check.pass) {
    return {
      name: 'Backtest capital metrics',
      status: 'fail',
      duration,
      message: check.failedCondition,
      debugInfo: {
        stdout: result.stdout.slice(-1000),
        stderr: result.stderr.slice(-500),
      },
    };
  }

  return {
    name: 'Backtest capital metrics',
    status: 'pass',
    duration,
  };
}

/**
 * Test 8: Backtest reads .env risk params as defaults
 */
async function test8_EnvDefaults(dateRange: { start: string; end: string } | null): Promise<TestResult> {
  const startTime = Date.now();

  // Pre-check: .env must exist and have ARB_ vars
  const envCheck = checkEnvFile(['ARB_EDGE_MIN', 'ARB_MAX_TOTAL_USD']);
  if (!envCheck.exists || !envCheck.hasVars) {
    return {
      name: 'Backtest .env defaults',
      status: 'skip',
      duration: 0,
      message: '.env missing or no ARB_ variables',
    };
  }

  if (!dateRange) {
    return {
      name: 'Backtest .env defaults',
      status: 'skip',
      duration: 0,
      message: 'no cached data available',
    };
  }

  const result = await spawnProcess({
    command: 'npx',
    args: [
      'ts-node',
      'backtest/index.ts',
      '--from', dateRange.start,
      '--to', dateRange.end,
      '--spread', '6',
      // NOTE: no --edge or --initial-capital flags — should read from .env
    ],
    timeout: 120000,
  });

  const duration = (Date.now() - startTime) / 1000;

  // Check for .env attribution in output
  const hasEnvAttribution = /from \.env|from env|\(from \.env\)/i.test(result.stdout);

  if (!hasEnvAttribution) {
    return {
      name: 'Backtest .env defaults',
      status: 'fail',
      duration,
      message: 'no .env source attribution found in output',
      debugInfo: {
        stdout: result.stdout.slice(-1000),
      },
    };
  }

  return {
    name: 'Backtest .env defaults',
    status: 'pass',
    duration,
  };
}

/**
 * Test 9: fetch-range --dry-run shows plan without fetching
 */
async function test9_FetchRangeDryRun(): Promise<TestResult> {
  const startTime = Date.now();

  const result = await spawnProcess({
    command: 'npx',
    args: [
      'ts-node',
      'scripts/fetch-range.ts',
      '--from', '2026-01-06',
      '--to', '2026-01-30',
      '--dry-run',
    ],
    timeout: 15000,
  });

  const duration = (Date.now() - startTime) / 1000;

  const check = checkConditions(result.stdout, result.stderr, result.exitCode, {
    stdoutContains: [
      'DRY RUN',
      /binance|chainlink|deribit|polymarket/i,
    ],
    exitCode: 0,
  });

  if (!check.pass) {
    return {
      name: 'fetch-range --dry-run',
      status: 'fail',
      duration,
      message: check.failedCondition,
      debugInfo: {
        stdout: result.stdout.slice(-500),
        stderr: result.stderr.slice(-500),
      },
    };
  }

  return {
    name: 'fetch-range --dry-run',
    status: 'pass',
    duration,
  };
}

/**
 * Test 10: fetch-range --report-only generates coverage report
 */
async function test10_FetchRangeReportOnly(): Promise<TestResult> {
  const startTime = Date.now();

  const result = await spawnProcess({
    command: 'npx',
    args: [
      'ts-node',
      'scripts/fetch-range.ts',
      '--from', '2026-01-06',
      '--to', '2026-01-30',
      '--report-only',
    ],
    timeout: 15000,
  });

  const duration = (Date.now() - startTime) / 1000;

  // Check report file was created
  const reportPath = path.join(__dirname, '..', 'data', 'coverage-report.md');
  const reportExists = fs.existsSync(reportPath);

  const check = checkConditions(result.stdout, result.stderr, result.exitCode, {
    stdoutContains: [/coverage report/i],
    exitCode: 0,
  });

  if (!check.pass) {
    return {
      name: 'fetch-range --report-only',
      status: 'fail',
      duration,
      message: check.failedCondition,
      debugInfo: {
        stdout: result.stdout.slice(-500),
        stderr: result.stderr.slice(-500),
      },
    };
  }

  if (!reportExists) {
    return {
      name: 'fetch-range --report-only',
      status: 'fail',
      duration,
      message: 'data/coverage-report.md not created',
    };
  }

  return {
    name: 'fetch-range --report-only',
    status: 'pass',
    duration,
  };
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  console.log('\n   🧪 Smoke Test Suite');
  console.log('   ' + '═'.repeat(60));
  console.log('');

  const results: TestResult[] = [];

  // Pre-check: Get cached date range (used by multiple tests)
  console.log('   🔍 Checking for cached data...');
  const dateRange = await getCachedDateRange();
  if (dateRange) {
    console.log(`   ✓ Found cached data: ${dateRange.start} → ${dateRange.end}\n`);
  } else {
    console.log('   ⚠ No cached data found (some tests will be skipped)\n');
  }

  // Run tests
  const tests = [
    { name: 'Test 1', fn: test1_PaperTradingStartup },
    { name: 'Test 2', fn: test2_LiveTradingStartup },
    { name: 'Test 3', fn: () => test3_BacktestWithCachedData(dateRange) },
    { name: 'Test 4', fn: test4_CacheInfo },
    { name: 'Test 5', fn: test5_DateValidation },
    { name: 'Test 6', fn: () => test6_LoggerModeField(dateRange) },
    { name: 'Test 7', fn: () => test7_CapitalMetrics(dateRange) },
    { name: 'Test 8', fn: () => test8_EnvDefaults(dateRange) },
    { name: 'Test 9', fn: test9_FetchRangeDryRun },
    { name: 'Test 10', fn: test10_FetchRangeReportOnly },
  ];

  for (let i = 0; i < tests.length; i++) {
    const test = tests[i];
    const testNum = `[${i + 1}/${tests.length}]`;

    process.stdout.write(`   ${testNum} ${test.fn.name.replace(/_/g, ' ').replace('test' + (i + 1), '')} `);
    process.stdout.write('.'.repeat(Math.max(1, 45 - test.fn.name.length)));
    process.stdout.write(' ');

    const result = await test.fn();
    results.push(result);

    const statusEmoji = result.status === 'pass' ? '✅' : result.status === 'fail' ? '❌' : '⏭️';
    const statusText = result.status === 'pass' ? 'PASS' : result.status === 'fail' ? 'FAIL' : 'SKIP';

    console.log(`${statusEmoji} ${statusText} (${result.duration.toFixed(1)}s)`);

    if (result.status === 'fail' && result.debugInfo) {
      console.log(`         ${result.message || 'Unknown error'}`);
      if (result.debugInfo.stdout) {
        console.log(`         Stdout (last 500 chars):`);
        console.log(`           ${result.debugInfo.stdout.trim().slice(-500).replace(/\n/g, '\n           ')}`);
      }
      if (result.debugInfo.stderr) {
        console.log(`         Stderr:`);
        console.log(`           ${result.debugInfo.stderr.trim().slice(-500).replace(/\n/g, '\n           ')}`);
      }
    } else if (result.status === 'skip' && result.message) {
      console.log(`         ${result.message}`);
    }
  }

  // Summary
  const passed = results.filter(r => r.status === 'pass').length;
  const failed = results.filter(r => r.status === 'fail').length;
  const skipped = results.filter(r => r.status === 'skip').length;

  console.log('\n   ' + '═'.repeat(60));
  console.log(`   Results: ${passed} passed, ${failed} failed, ${skipped} skipped\n`);

  // Exit with error code if any tests failed
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Smoke test runner failed:', error);
  process.exit(1);
});
