/**
 * Central Logger
 *
 * Leveled, timestamped, structured logging with redaction and rate limiting.
 * See docs/logging.md for the full contract.
 *
 * Env vars:
 *   LOG_LEVEL  = error | warn | info | debug | trace  (default: info)
 *   LOG_FORMAT = pretty | json                        (default: pretty)
 *   LOG_MODE   = dev | live-test | prod               (default: dev)
 *
 * Usage:
 *   import { createLogger } from './logger';
 *   const log = createLogger('ArbTrader');
 *   log.info('trade.filled', { side: 'YES', price: 0.42, latencyMs: 120 });
 */

import * as crypto from 'crypto';

// =============================================================================
// TYPES
// =============================================================================

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';
export type LogFormat = 'pretty' | 'json';
export type LogMode = 'dev' | 'live-test' | 'prod';

type LogData = Record<string, unknown>;
type LogFn = (event: string, data?: LogData) => void;

export interface Logger {
  error: LogFn;
  warn: LogFn;
  info: LogFn;
  debug: LogFn;
  trace: LogFn;
  isEnabled: (level: LogLevel) => boolean;
  /** Create a child logger with additional default fields */
  child: (fields: LogData) => Logger;
}

// =============================================================================
// LEVEL ORDERING
// =============================================================================

const LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

// =============================================================================
// REDACTION
// =============================================================================

const REDACT_KEYS = new Set([
  'authorization', 'cookie', 'apikey', 'secret', 'token',
  'signature', 'passphrase', 'privatekey', 'key', 'password',
]);

const MAX_STRING_LENGTH = 200;
const MAX_DEPTH = 3;

function shouldRedact(key: string): boolean {
  return REDACT_KEYS.has(key.toLowerCase());
}

function sanitizeValue(key: string, value: unknown, depth: number): unknown {
  if (shouldRedact(key)) return '[REDACTED]';
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH) {
      return value.slice(0, MAX_STRING_LENGTH - 12) + ' [truncated]';
    }
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (depth >= MAX_DEPTH) return '[depth limit]';

  if (Array.isArray(value)) {
    return value.slice(0, 10).map((v, i) => sanitizeValue(String(i), v, depth + 1));
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [k, v] of entries.slice(0, 20)) {
      result[k] = sanitizeValue(k, v, depth + 1);
    }
    if (entries.length > 20) {
      result['...'] = `${entries.length - 20} more keys`;
    }
    return result;
  }

  return String(value);
}

function sanitizeData(data: LogData): LogData {
  const result: LogData = {};
  for (const [k, v] of Object.entries(data)) {
    result[k] = sanitizeValue(k, v, 0);
  }
  return result;
}

// =============================================================================
// CONFIGURATION
// =============================================================================

const MODE_PRESETS: Record<LogMode, { level: LogLevel; format: LogFormat }> = {
  dev:         { level: 'debug', format: 'pretty' },
  'live-test': { level: 'info',  format: 'pretty' },
  prod:        { level: 'info',  format: 'json' },
};

function resolveMode(): LogMode {
  const env = (process.env.LOG_MODE || 'dev').toLowerCase();
  if (env in MODE_PRESETS) return env as LogMode;
  return 'dev';
}

function resolveLevel(mode: LogMode): LogLevel {
  const explicit = process.env.LOG_LEVEL?.toLowerCase();
  if (explicit && explicit in LEVEL_ORDER) return explicit as LogLevel;
  return MODE_PRESETS[mode].level;
}

function resolveFormat(mode: LogMode): LogFormat {
  const explicit = process.env.LOG_FORMAT?.toLowerCase();
  if (explicit === 'pretty' || explicit === 'json') return explicit;
  return MODE_PRESETS[mode].format;
}

const mode = resolveMode();
let currentThreshold: number = LEVEL_ORDER[resolveLevel(mode)];
const currentFormat: LogFormat = resolveFormat(mode);

/** Process-scoped run ID for correlation */
export const RUN_ID: string = crypto.randomUUID().slice(0, 8);

/**
 * Override the log level at runtime.
 * Returns the previous level.
 */
export function setLogLevel(level: LogLevel): LogLevel {
  const prev = Object.entries(LEVEL_ORDER).find(
    ([, v]) => v === currentThreshold
  )?.[0] as LogLevel;
  currentThreshold = LEVEL_ORDER[level];
  return prev;
}

// =============================================================================
// FORMATTING
// =============================================================================

function isoNow(): string {
  return new Date().toISOString();
}

const LEVEL_TAG: Record<LogLevel, string> = {
  error: 'ERR ',
  warn:  'WARN',
  info:  'INFO',
  debug: 'DBG ',
  trace: 'TRC ',
};

function formatPretty(
  ts: string,
  level: LogLevel,
  module: string,
  event: string,
  data: LogData | undefined,
): string {
  let line = `${ts} [${LEVEL_TAG[level]}] [${module}] ${event}`;

  if (data) {
    const pairs = Object.entries(data)
      .map(([k, v]) => {
        if (v === undefined || v === null) return null;
        const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
        return `${k}=${s}`;
      })
      .filter(Boolean);
    if (pairs.length > 0) {
      line += ' | ' + pairs.join(' ');
    }
  }

  return line;
}

function formatJson(
  ts: string,
  level: LogLevel,
  module: string,
  event: string,
  data: LogData | undefined,
): string {
  const entry: LogData = {
    ts,
    level,
    module,
    event,
    runId: RUN_ID,
    ...data,
  };
  return JSON.stringify(entry);
}

// =============================================================================
// RATE LIMITING
// =============================================================================

const rateLimitState = new Map<string, { last: number; suppressed: number }>();

/**
 * Check if a rate-limited message should be emitted.
 * If suppressed messages exist and the interval has elapsed, emits a suppression notice.
 */
function checkRateLimit(key: string, intervalMs: number): { emit: boolean; suppressed: number } {
  const now = Date.now();
  const state = rateLimitState.get(key);

  if (!state || now - state.last >= intervalMs) {
    const suppressed = state?.suppressed ?? 0;
    rateLimitState.set(key, { last: now, suppressed: 0 });
    return { emit: true, suppressed };
  }

  state.suppressed++;
  return { emit: false, suppressed: 0 };
}

// =============================================================================
// CORE EMIT
// =============================================================================

function emit(
  level: LogLevel,
  module: string,
  event: string,
  baseFields: LogData,
  data?: LogData,
): void {
  if (LEVEL_ORDER[level] > currentThreshold) return;

  const ts = isoNow();
  const merged = data ? { ...baseFields, ...sanitizeData(data) } : baseFields;

  // Add runId to all entries
  merged.runId = RUN_ID;

  const line = currentFormat === 'json'
    ? formatJson(ts, level, module, event, merged)
    : formatPretty(ts, level, module, event, merged);

  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

// =============================================================================
// FACTORY
// =============================================================================

function makeLogger(module: string, baseFields: LogData): Logger {
  const logFn = (level: LogLevel): LogFn =>
    (event, data) => emit(level, module, event, { ...baseFields }, data);

  return {
    error: logFn('error'),
    warn: logFn('warn'),
    info: logFn('info'),
    debug: logFn('debug'),
    trace: logFn('trace'),
    isEnabled: (level) => LEVEL_ORDER[level] <= currentThreshold,
    child: (fields) => makeLogger(module, { ...baseFields, ...fields }),
  };
}

/**
 * Create a child logger scoped to a module name.
 */
export function createLogger(module: string, fields?: LogData): Logger {
  return makeLogger(module, fields ?? {});
}

// =============================================================================
// RATE-LIMITED LOGGING
// =============================================================================

/**
 * Emit a log only if the rate limit interval has passed for the given key.
 * When suppressed messages are released, logs the count.
 */
export function rateLimitedLog(
  logger: Logger,
  level: LogLevel,
  key: string,
  intervalMs: number,
  event: string,
  data?: LogData,
): void {
  if (!logger.isEnabled(level)) return;

  const { emit: shouldEmit, suppressed } = checkRateLimit(key, intervalMs);
  if (shouldEmit) {
    const logData = suppressed > 0
      ? { ...data, suppressedCount: suppressed }
      : data;
    logger[level](event, logData);
  }
}

// =============================================================================
// SAFE ERROR EXTRACTION
// =============================================================================

/**
 * Extract structured error info from an Axios error or generic Error.
 * Never dumps raw response bodies. Use instead of JSON.stringify(err.response.data).
 */
export function safeErrorData(err: unknown): LogData {
  if (err === null || err === undefined) return { error: 'unknown' };

  if (err instanceof Error) {
    const result: LogData = { error: err.message.slice(0, 200) };

    // Axios-style error
    const axiosErr = err as any;
    if (axiosErr.response) {
      result.httpStatus = axiosErr.response.status;
      if (typeof axiosErr.response.data === 'object' && axiosErr.response.data !== null) {
        result.responseMessage = String(axiosErr.response.data.message ?? axiosErr.response.data.error ?? '').slice(0, 200);
        result.responseCode = axiosErr.response.data.code;
      }
    }
    if (axiosErr.config?.url) {
      result.url = String(axiosErr.config.url).slice(0, 200);
    }
    if (axiosErr.code) {
      result.errorCode = axiosErr.code;
    }
    return result;
  }

  if (typeof err === 'string') return { error: err.slice(0, 200) };

  return { error: String(err).slice(0, 200) };
}
