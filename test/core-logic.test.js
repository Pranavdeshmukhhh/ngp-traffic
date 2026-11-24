'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { LruCache } = require('../src/lru');
const { loadConfig, redactSecrets, safeFetch } = require('../src/security');
const {
  predictDeployments,
  computeTrend,
  computeFreshness,
  isValidTileCoord,
  haversineMeters,
  findNearestPoliceStation,
  describeWeatherCode,
  extractIncidentPoint
} = require('../server');

const stations = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'police-stations.json'), 'utf8')
);

const baseJunction = {
  id: 'J001',
  name: 'Variety Square',
  lat: 21.1458,
  lng: 79.0882,
  roadType: 'major_intersection',
  roadClosure: false
};

test('LruCache promotes accessed entries and evicts least-recently-used key', () => {
  const cache = new LruCache({ maxEntries: 2, defaultTtlMs: 10_000 });
  cache.set('a', 1);
  cache.set('b', 2);
  // Access 'a' so 'b' becomes LRU
  assert.equal(cache.get('a'), 1);
  cache.set('c', 3);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('c'), 3);
});

test('LruCache.dedupeFetch coalesces concurrent identical requests into one upstream call', async () => {
  const cache = new LruCache({ maxEntries: 10, defaultTtlMs: 10_000 });
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 20));
    return Buffer.from('tile-bytes');
  };

  const results = await Promise.all([
    cache.dedupeFetch('13/1/1', fetcher),
    cache.dedupeFetch('13/1/1', fetcher),
    cache.dedupeFetch('13/1/1', fetcher),
    cache.dedupeFetch('13/1/1', fetcher),
    cache.dedupeFetch('13/1/1', fetcher)
  ]);

  assert.equal(calls, 1);
  assert.equal(results.filter((r) => r.fromCache === false).length, 1);
  assert.equal(results.filter((r) => r.fromCache === true).length, 4);
});

test('loadConfig fails closed in production when ALLOWED_ORIGIN is wildcard or key missing', () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: 'production', ALLOWED_ORIGIN: '*', TOMTOM_API_KEY: 'abc123' }),
    /ALLOWED_ORIGIN/
  );
  assert.throws(
    () => loadConfig({ NODE_ENV: 'production', ALLOWED_ORIGIN: 'https://ngp.example.in' }),
    /TOMTOM_API_KEY/
  );
  const ok = loadConfig({
    NODE_ENV: 'production',
    ALLOWED_ORIGIN: 'https://ngp.example.in,https://admin.example.in',
    TOMTOM_API_KEY: 'secret_key_value'
  });
  assert.deepEqual(ok.allowedOrigins, ['https://ngp.example.in', 'https://admin.example.in']);
});

test('redactSecrets strips API keys from URLs and text', () => {
  const raw = 'Error calling https://api.tomtom.com/x?key=supersecret123&z=1';
  const clean = redactSecrets(raw, 'supersecret123');
  assert.equal(clean.includes('supersecret123'), false);
  assert.equal(clean.includes('[REDACTED]'), true);
});

test('safeFetch rejects disallowed hosts and non-HTTPS URLs (SSRF guard)', async () => {
  await assert.rejects(
    () => safeFetch('http://169.254.169.254/latest/meta-data'),
    /Disallowed upstream host/
  );
  await assert.rejects(
    () => safeFetch('https://evil.example.com/steal'),
    /Disallowed upstream host/
  );
});

test('computeFreshness keeps updatedAt null and marks stale=true when all fetches fail', () => {
  const res = computeFreshness({
    lastSuccessAt: { flow: null, incidents: null, weather: null },
    lastAttemptFailed: { flow: true, incidents: true, weather: true },
    tomtomConfigured: true,
    hasAttemptedRefresh: true,
    nowMs: 1_700_000_000_000
  });
  assert.equal(res.updatedAt, null);
  assert.equal(res.stale, true);
  assert.deepEqual(res.staleSources, ['flow', 'incidents', 'weather']);
});

test('computeFreshness flags expired/failed sources while preserving lastSuccessAt', () => {
  const nowMs = Date.parse('2026-11-24T10:15:00.000Z');
  const res = computeFreshness({
    lastSuccessAt: {
      flow: '2026-11-24T10:05:00.000Z',
      incidents: '2026-11-24T10:10:00.000Z',
      weather: '2026-11-24T10:14:00.000Z'
    },
    lastAttemptFailed: { flow: true, incidents: false, weather: false },
    tomtomConfigured: true,
    hasAttemptedRefresh: true,
    nowMs
  });
  assert.equal(res.updatedAt, '2026-11-24T10:14:00.000Z');
  assert.equal(res.stale, true);
  assert.deepEqual(res.staleSources, ['flow']);
});

test('isValidTileCoord enforces z in [0,19] and x,y in [0, 2^z)', () => {
  assert.equal(isValidTileCoord(0, 0, 0), true);
  assert.equal(isValidTileCoord(1, 2, 0), false);
  assert.equal(isValidTileCoord(20, 0, 0), false);
});

test('Geo, weather, and incident geometry helpers work accurately', () => {
  const d = haversineMeters(21.1458, 79.0882, 21.14358, 79.08063);
  assert.equal(d > 700 && d < 950, true);
  const nearest = findNearestPoliceStation(21.1458, 79.0882, stations);
  assert.equal(nearest?.shortName, 'Sitabuldi PS');
  assert.equal(describeWeatherCode(0), 'Clear');
  assert.equal(describeWeatherCode(95), 'Thunderstorm');
  assert.deepEqual(extractIncidentPoint({ type: 'Point', coordinates: [79.08, 21.14] }), {
    lat: 21.14,
    lng: 79.08
  });
});

test('predictDeployments eliminates false positives and ranks by composite severityScore', () => {
  const emptyHistory = new Map();
  // Full speed with closure 300m away -> 0 alerts
  assert.equal(
    predictDeployments(
      [{ ...baseJunction, currentSpeed: 32, freeFlowSpeed: 32 }],
      [{ lat: 21.1485, lng: 79.0882, iconCategory: 8, description: 'Side street closed' }],
      { precipitation: 0 },
      stations,
      emptyHistory
    ).length,
    0
  );

  // Roadworks <= 150m + >= 25% congestion -> Clearing Needed
  const clearing = predictDeployments(
    [{ ...baseJunction, currentSpeed: 30, freeFlowSpeed: 45 }],
    [{ lat: 21.1466, lng: 79.0882, iconCategory: 9, description: 'Roadworks' }],
    { precipitation: 0 },
    stations,
    emptyHistory
  );
  assert.equal(clearing.length, 1);
  assert.equal(clearing[0].badge, 'Clearing Needed');

  // Severity score sorting + trends
  const hist = new Map([
    ['A', [30, 50, 70]],
    ['B', [65, 55, 45]]
  ]);
  assert.equal(computeTrend([30, 50, 70]), 'worsening');
  assert.equal(computeTrend([65, 55, 45]), 'improving');

  const ranked = predictDeployments(
    [
      { ...baseJunction, id: 'B', name: 'B', currentSpeed: 25, freeFlowSpeed: 45 },
      {
        ...baseJunction,
        id: 'A',
        name: 'A',
        currentSpeed: 12,
        freeFlowSpeed: 45,
        currentTravelTime: 360,
        freeFlowTravelTime: 60
      }
    ],
    [{ lat: 21.1459, lng: 79.0883, iconCategory: 1, description: 'Accident' }],
    { precipitation: 4 },
    stations,
    hist
  );
  assert.deepEqual(
    ranked.map((r) => r.id),
    ['A', 'B']
  );
  assert.equal(ranked[0].trend, 'worsening');
  assert.equal(ranked[1].trend, 'improving');
});
