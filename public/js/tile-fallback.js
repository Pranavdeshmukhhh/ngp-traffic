/* global module */
'use strict';

const DEFAULT_TILE_FALLBACK_THRESHOLD = 6;
const DEFAULT_TILE_FALLBACK_WINDOW_MS = 15_000;

/**
 * Tracks tile loading errors inside a sliding time window and triggers fallback
 * once `threshold` errors occur within `windowMs`.
 *
 * @param {{ threshold?: number, windowMs?: number }} [options]
 */
function createTileErrorTracker({
  threshold = DEFAULT_TILE_FALLBACK_THRESHOLD,
  windowMs = DEFAULT_TILE_FALLBACK_WINDOW_MS
} = {}) {
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new RangeError('threshold must be a positive integer');
  }
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new RangeError('windowMs must be a positive finite number');
  }

  /** @type {number[]} */
  let errorTimestamps = [];
  let triggered = false;

  return {
    /**
     * Records a tile error at `nowMs`. Returns true exactly once when the
     * threshold inside the sliding window is reached.
     *
     * @param {number} [nowMs]
     * @returns {boolean}
     */
    recordError(nowMs = Date.now()) {
      if (triggered) return false;
      errorTimestamps = errorTimestamps.filter((ts) => nowMs - ts <= windowMs);
      errorTimestamps.push(nowMs);
      if (errorTimestamps.length >= threshold) {
        triggered = true;
        return true;
      }
      return false;
    },

    /** @returns {boolean} */
    isTriggered() {
      return triggered;
    },

    /**
     * @param {number} [nowMs]
     * @returns {number}
     */
    recentCount(nowMs = Date.now()) {
      errorTimestamps = errorTimestamps.filter((ts) => nowMs - ts <= windowMs);
      return errorTimestamps.length;
    },

    reset() {
      errorTimestamps = [];
      triggered = false;
    }
  };
}

const api = {
  DEFAULT_TILE_FALLBACK_THRESHOLD,
  DEFAULT_TILE_FALLBACK_WINDOW_MS,
  createTileErrorTracker
};

if (typeof globalThis !== 'undefined') {
  /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (globalThis)).NGP_TILE_FALLBACK = api;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
