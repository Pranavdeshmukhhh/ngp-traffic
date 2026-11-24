'use strict';

/**
 * Bounded TTL LRU cache with in-flight request coalescing (dedupe).
 */
class LruCache {
  /**
   * @param {{ maxEntries?: number, defaultTtlMs?: number }} [options]
   */
  constructor({ maxEntries = 500, defaultTtlMs = 120_000 } = {}) {
    this.maxEntries = Math.max(1, maxEntries);
    this.defaultTtlMs = Math.max(1, defaultTtlMs);
    /** @type {Map<string, { value: unknown, expiresAt: number }>} */
    this.store = new Map();
    /** @type {Map<string, Promise<unknown>>} */
    this.inFlight = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Retrieve a cached value and promote it to most-recently-used.
   * @param {string} key
   * @param {number} [nowMs]
   */
  get(key, nowMs = Date.now()) {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= nowMs) {
      this.store.delete(key);
      this.misses += 1;
      return undefined;
    }
    // Promote to MRU by re-inserting
    this.store.delete(key);
    this.store.set(key, entry);
    this.hits += 1;
    return entry.value;
  }

  /**
   * Insert or update a cache entry, evicting the least-recently-used key when full.
   * @param {string} key
   * @param {unknown} value
   * @param {number} [ttlMs]
   * @param {number} [nowMs]
   */
  set(key, value, ttlMs = this.defaultTtlMs, nowMs = Date.now()) {
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxEntries) {
      const lruKey = this.store.keys().next().value;
      if (lruKey !== undefined) {
        this.store.delete(lruKey);
      }
    }
    this.store.set(key, {
      value,
      expiresAt: nowMs + Math.max(1, ttlMs)
    });
  }

  /**
   * Clear all cached entries and metrics (useful for deterministic tests).
   */
  clear() {
    this.store.clear();
    this.inFlight.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Return cached value or coalesce concurrent identical async fetches into one upstream call.
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} fetcher
   * @param {number} [ttlMs]
   * @returns {Promise<{ value: T, fromCache: boolean }>}
   */
  async dedupeFetch(key, fetcher, ttlMs = this.defaultTtlMs) {
    const cached = this.get(key);
    if (cached !== undefined) {
      return { value: /** @type {T} */ (cached), fromCache: true };
    }

    const existing = this.inFlight.get(key);
    if (existing) {
      const shared = await existing;
      return { value: /** @type {T} */ (shared), fromCache: true };
    }

    const promise = (async () => {
      const result = await fetcher();
      this.set(key, result, ttlMs);
      return result;
    })();

    this.inFlight.set(key, promise);
    try {
      const value = await promise;
      return { value, fromCache: false };
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * Snapshot cache occupancy and hit ratio.
   */
  stats() {
    const total = this.hits + this.misses;
    return {
      size: this.store.size,
      maxEntries: this.maxEntries,
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : Math.round((this.hits / total) * 1000) / 1000
    };
  }
}

module.exports = { LruCache };
