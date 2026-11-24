'use strict';

const { z } = require('zod');

const ALLOWED_UPSTREAM_HOSTS = new Set([
  'api.tomtom.com',
  'api.open-meteo.com',
  'air-quality-api.open-meteo.com'
]);

const DEFAULT_UPSTREAM_TIMEOUT_MS = 8000;

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  TOMTOM_API_KEY: z.string().optional().default('').transform((v) => v.trim()),
  ALLOWED_ORIGIN: z
    .string()
    .optional()
    .default('*')
    .transform((v) => v.trim() || '*'),
  DAILY_TOMTOM_NON_TILE_BUDGET: z.coerce.number().int().min(10).max(100_000).default(2000),
  DAILY_TOMTOM_TILE_BUDGET: z.coerce.number().int().min(50).max(500_000).default(45_000),
  ALLOW_KEYLESS_START: z.string().optional().default(''),
  FEATURE_WEATHER_RISK: z.string().optional().default('true')
});

/**
 * Parse and fail-closed validate environment configuration.
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 */
function loadConfig(env = process.env) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${msg}`);
  }

  const data = parsed.data;
  if (data.NODE_ENV === 'production') {
    if (data.ALLOWED_ORIGIN === '*') {
      throw new Error(
        'Fail-closed config error: ALLOWED_ORIGIN must be explicitly set (not "*") in production'
      );
    }
    if (!data.TOMTOM_API_KEY && data.ALLOW_KEYLESS_START !== 'true') {
      throw new Error(
        'Fail-closed config error: TOMTOM_API_KEY is required in production (or set ALLOW_KEYLESS_START=true)'
      );
    }
  }

  const allowedOrigins =
    data.ALLOWED_ORIGIN === '*'
      ? '*'
      : data.ALLOWED_ORIGIN.split(',')
          .map((s) => s.trim())
          .filter(Boolean);

  if (Array.isArray(allowedOrigins) && allowedOrigins.length === 0) {
    throw new Error('Fail-closed config error: ALLOWED_ORIGIN resolved to an empty list');
  }

  return {
    nodeEnv: data.NODE_ENV,
    port: data.PORT,
    tomtomApiKey: data.TOMTOM_API_KEY,
    allowedOriginRaw: data.ALLOWED_ORIGIN,
    allowedOrigins,
    dailyTomTomNonTileBudget: data.DAILY_TOMTOM_NON_TILE_BUDGET,
    dailyTomTomTileBudget: data.DAILY_TOMTOM_TILE_BUDGET,
    featureWeatherRisk: data.FEATURE_WEATHER_RISK !== 'false' && data.FEATURE_WEATHER_RISK !== '0'
  };
}

const tileParamsSchema = z
  .object({
    z: z.coerce.number().int().min(0).max(19),
    x: z.coerce.number().int().min(0),
    y: z.coerce.number().int().min(0)
  })
  .strict()
  .refine(({ z: zoom, x, y }) => x < Math.pow(2, zoom) && y < Math.pow(2, zoom), {
    message: 'Tile coordinates out of bounds for zoom level'
  });

const tileQuerySchema = z
  .object({
    theme: z.enum(['light', 'dark']).optional(),
    v: z.string().max(32).optional()
  })
  .strict();

const searchQuerySchema = z
  .object({
    q: z.string().trim().min(2).max(100)
  })
  .strict();

// Nagpur / Vidarbha corridor bounding box so callers cannot abuse TomTom routing globally
const routeQuerySchema = z
  .object({
    fromLat: z.coerce.number().min(20.5).max(21.8),
    fromLng: z.coerce.number().min(78.4).max(79.8),
    toLat: z.coerce.number().min(20.5).max(21.8),
    toLng: z.coerce.number().min(78.4).max(79.8)
  })
  .strict();

/**
 * Redact API keys and query credentials from logs or error messages.
 * @param {unknown} input
 * @param {string} [extraSecret]
 */
function redactSecrets(input, extraSecret = '') {
  let out = String(input ?? '').replace(/(key|api_key|apikey|token)=([^&\s"']+)/gi, '$1=[REDACTED]');
  if (extraSecret && extraSecret.length >= 4) {
    out = out.replaceAll(extraSecret, '[REDACTED]');
  }
  return out;
}

/**
 * SSRF-guarded fetch wrapper restricted to HTTPS and allow-listed upstream hosts.
 * @param {string} urlString
 * @param {RequestInit & { timeoutMs?: number }} [options]
 * @param {typeof fetch} [fetchImpl]
 */
async function safeFetch(urlString, options = {}, fetchImpl = globalThis.fetch) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error('Invalid upstream URL');
  }

  if (parsed.protocol !== 'https:' || !ALLOWED_UPSTREAM_HOSTS.has(parsed.hostname)) {
    throw new Error(`Disallowed upstream host: ${parsed.hostname}`);
  }

  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_UPSTREAM_TIMEOUT_MS;
  const fetchOptions = { ...options };
  delete fetchOptions.timeoutMs;
  if (!fetchOptions.signal) {
    fetchOptions.signal = AbortSignal.timeout(timeoutMs);
  }

  return fetchImpl(parsed.toString(), fetchOptions);
}

/**
 * Resolve normalized client IP address from an Express request.
 * @param {import('express').Request} req
 */
function getClientIp(req) {
  return String(req.ip || req.socket?.remoteAddress || 'unknown');
}

/**
 * Fixed-window per-IP rate limiter middleware with bounded memory table.
 * @param {{ windowMs: number, max: number, name?: string }} options
 */
function createRateLimiter({ windowMs, max, name = 'api' }) {
  /** @type {Map<string, { count: number, resetAt: number }>} */
  const buckets = new Map();
  const maxTrackedIps = 5000;

  /**
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  function middleware(req, res, next) {
    const now = Date.now();
    const ip = getClientIp(req);
    let bucket = buckets.get(ip);

    if (!bucket || bucket.resetAt <= now) {
      if (!bucket && buckets.size >= maxTrackedIps) {
        const oldestKey = buckets.keys().next().value;
        if (oldestKey !== undefined) buckets.delete(oldestKey);
      }
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(ip, bucket);
    }

    bucket.count += 1;
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - bucket.count)));

    if (bucket.count > max) {
      const retrySec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retrySec));
      return res.status(429).json({
        error: `Rate limit exceeded for ${name}`,
        retryAfterSec: retrySec
      });
    }

    return next();
  }

  middleware.reset = () => buckets.clear();
  return middleware;
}

/**
 * Global daily upstream call budget tracker (UTC day rollover).
 */
class UpstreamBudget {
  /**
   * @param {{ tomtomNonTileLimit: number, tomtomTileLimit: number }} limits
   */
  constructor({ tomtomNonTileLimit, tomtomTileLimit }) {
    this.tomtomNonTileLimit = tomtomNonTileLimit;
    this.tomtomTileLimit = tomtomTileLimit;
    this.day = new Date().toISOString().slice(0, 10);
    this.counts = {
      tomtomNonTile: 0,
      tomtomTile: 0,
      openMeteo: 0
    };
  }

  _rolloverIfNeeded(now = new Date()) {
    const today = now.toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.counts = { tomtomNonTile: 0, tomtomTile: 0, openMeteo: 0 };
    }
  }

  /**
   * Attempt to reserve `amount` upstream calls for a bucket.
   * @param {'tomtomNonTile' | 'tomtomTile' | 'openMeteo'} kind
   * @param {number} [amount]
   */
  tryConsume(kind, amount = 1) {
    this._rolloverIfNeeded();
    if (kind === 'tomtomNonTile') {
      if (this.counts.tomtomNonTile + amount > this.tomtomNonTileLimit) return false;
      this.counts.tomtomNonTile += amount;
      return true;
    }
    if (kind === 'tomtomTile') {
      if (this.counts.tomtomTile + amount > this.tomtomTileLimit) return false;
      this.counts.tomtomTile += amount;
      return true;
    }
    this.counts.openMeteo += amount;
    return true;
  }

  reset() {
    this.day = new Date().toISOString().slice(0, 10);
    this.counts = { tomtomNonTile: 0, tomtomTile: 0, openMeteo: 0 };
  }

  snapshot() {
    this._rolloverIfNeeded();
    return {
      day: this.day,
      ...this.counts,
      limits: {
        tomtomNonTile: this.tomtomNonTileLimit,
        tomtomTile: this.tomtomTileLimit
      }
    };
  }
}

/**
 * Bounded circular latency tracker reporting p95 response times.
 */
class LatencyTracker {
  /**
   * @param {number} [capacity]
   */
  constructor(capacity = 500) {
    this.capacity = Math.max(10, capacity);
    /** @type {number[]} */
    this.samples = [];
  }

  /**
   * @param {number} ms
   */
  record(ms) {
    if (!Number.isFinite(ms) || ms < 0) return;
    if (this.samples.length >= this.capacity) {
      this.samples.shift();
    }
    this.samples.push(ms);
  }

  p95Ms() {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
    return Math.round(sorted[idx] * 10) / 10;
  }

  reset() {
    this.samples = [];
  }
}

module.exports = {
  ALLOWED_UPSTREAM_HOSTS,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  loadConfig,
  tileParamsSchema,
  tileQuerySchema,
  searchQuerySchema,
  routeQuerySchema,
  redactSecrets,
  safeFetch,
  getClientIp,
  createRateLimiter,
  UpstreamBudget,
  LatencyTracker
};
