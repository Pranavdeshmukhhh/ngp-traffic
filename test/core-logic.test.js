'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { LruCache } = require('../src/lru');
const {
  computeBudgetAwarePollIntervals,
  projectDailyNonTileCalls,
  DAY_MS
} = require('../src/pollBudget');
const {
  loadConfig,
  isValidBearerToken,
  redactSecrets,
  safeFetch,
  normalizeIp,
  resolveClientIp,
  createSocketIpLimiter
} = require('../src/security');
const { getCity, DEFAULT_CITY_ID } = require('../src/cityRegistry');
const {
  createTileErrorTracker,
  DEFAULT_TILE_FALLBACK_THRESHOLD,
  DEFAULT_TILE_FALLBACK_WINDOW_MS
} = require('../public/js/tile-fallback');
const {
  predictDeployments,
  computeTrend,
  computeFreshness,
  computeStaleThresholdMs,
  STALE_GRACE_MS,
  cityStates,
  getCityStateSnapshot,
  setTestOverrides,
  resetStateForTests,
  isValidTileCoord,
  haversineMeters,
  findNearestPoliceStation,
  describeWeatherCode,
  extractIncidentPoint
} = require('../server');

const stations = getCity(DEFAULT_CITY_ID).policeStations;

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

test('createTileErrorTracker switches only after threshold errors within sliding window', () => {
  assert.equal(DEFAULT_TILE_FALLBACK_THRESHOLD, 6);
  assert.equal(DEFAULT_TILE_FALLBACK_WINDOW_MS, 15_000);

  const tracker = createTileErrorTracker();

  // Single transient error must not switch to fallback
  assert.equal(tracker.recordError(1_000), false);
  assert.equal(tracker.isTriggered(), false);

  // Up to 5 errors inside 15s window still do not trigger
  assert.equal(tracker.recordError(2_000), false);
  assert.equal(tracker.recordError(3_000), false);
  assert.equal(tracker.recordError(4_000), false);
  assert.equal(tracker.recordError(5_000), false);
  assert.equal(tracker.recentCount(5_000), 5);
  assert.equal(tracker.isTriggered(), false);

  // 6th error inside 15s triggers fallback once
  assert.equal(tracker.recordError(6_000), true);
  assert.equal(tracker.isTriggered(), true);

  // Subsequent errors stay triggered without re-triggering
  assert.equal(tracker.recordError(6_500), false);
  assert.equal(tracker.isTriggered(), true);

  tracker.reset();
  assert.equal(tracker.isTriggered(), false);
  assert.equal(tracker.recentCount(7_000), 0);
});

test('createTileErrorTracker expires old errors outside sliding window and validates options', () => {
  const tracker = createTileErrorTracker({ threshold: 6, windowMs: 15_000 });

  // 5 errors at t = 0..4000ms
  for (let i = 0; i < 5; i++) {
    assert.equal(tracker.recordError(i * 1_000), false);
  }

  // At t = 16000ms, the t = 0 error has aged out (> 15000ms), so 5 remain in window
  assert.equal(tracker.recordError(16_000), false);
  assert.equal(tracker.recentCount(16_000), 5);
  assert.equal(tracker.isTriggered(), false);

  // Another error at t = 16500ms still sees t = 1000..4000 expired if > 15000ms:
  // t=1000 expired at 16500 (15500 > 15000), so count is t=2000,3000,4000,16000,16500 => 5
  assert.equal(tracker.recordError(16_500), false);
  assert.equal(tracker.recentCount(16_500), 5);

  // Immediate burst within the new window hits 6 inside 15s and triggers
  assert.equal(tracker.recordError(16_600), true);
  assert.equal(tracker.isTriggered(), true);

  assert.throws(() => createTileErrorTracker({ threshold: 0 }), RangeError);
  assert.throws(() => createTileErrorTracker({ threshold: 1.5 }), RangeError);
  assert.throws(() => createTileErrorTracker({ windowMs: 0 }), RangeError);
  assert.throws(() => createTileErrorTracker({ windowMs: Infinity }), RangeError);
});

test('loadConfig validates TRUST_PROXY as integer hops 0-5 and rejects booleans/invalid values', () => {
  assert.equal(loadConfig({}).trustProxy, 0);
  assert.equal(loadConfig({ TRUST_PROXY: '' }).trustProxy, 0);
  assert.equal(loadConfig({ TRUST_PROXY: '1' }).trustProxy, 1);
  assert.equal(loadConfig({ TRUST_PROXY: '5' }).trustProxy, 5);

  for (const bad of ['true', 'false', '-1', '1.5', '6', 'loopback']) {
    assert.throws(() => loadConfig({ TRUST_PROXY: bad }), /TRUST_PROXY/);
  }
});

test('normalizeIp and resolveClientIp ignore spoofed headers and fail closed on oversized XFF', () => {
  assert.equal(normalizeIp('::ffff:203.0.113.10'), '203.0.113.10');
  assert.equal(normalizeIp('2001:DB8::1'), '2001:db8::1');
  assert.equal(normalizeIp('not-an-ip'), '');

  // trustProxyHops=0 ignores X-Forwarded-For completely
  assert.equal(
    resolveClientIp({
      remoteAddress: '::ffff:127.0.0.1',
      xForwardedFor: '1.2.3.4',
      trustProxyHops: 0
    }),
    '127.0.0.1'
  );

  // trustProxyHops=1 picks rightmost proxy-appended IP, ignoring spoofed leftmost header
  assert.equal(
    resolveClientIp({
      remoteAddress: '10.0.0.1',
      xForwardedFor: '1.1.1.1, 198.51.100.7',
      trustProxyHops: 1
    }),
    '198.51.100.7'
  );

  // trustProxyHops=2 walks 2 hops back from peer
  assert.equal(
    resolveClientIp({
      remoteAddress: '10.0.0.5',
      xForwardedFor: '9.9.9.9, 198.51.100.7, 172.68.0.1',
      trustProxyHops: 2
    }),
    '198.51.100.7'
  );

  // Malformed header fails closed to peer IP
  assert.equal(
    resolveClientIp({
      remoteAddress: '10.0.0.1',
      xForwardedFor: '<script>alert(1)</script>',
      trustProxyHops: 1
    }),
    '10.0.0.1'
  );

  // Oversized X-Forwarded-For (> 2048 chars, e.g. >4 KB spoofed prefix) fails closed to peer IP
  const hugeSpoofedPrefix = '203.0.113.9, '.repeat(350);
  const hugeXff = `${hugeSpoofedPrefix}198.51.100.77`;
  assert.ok(hugeXff.length > 4096);
  assert.equal(
    resolveClientIp({
      remoteAddress: '10.0.0.1',
      xForwardedFor: hugeXff,
      trustProxyHops: 1
    }),
    '10.0.0.1'
  );
});

test('createSocketIpLimiter isolates clients behind proxy and blocks spoofed bypass', () => {
  const limiter = createSocketIpLimiter({ maxPerIp: 2, getTrustProxy: () => 1 });
  const disconnectHandlers = [];

  /** @param {string} xff */
  const makeSocket = (xff) =>
    /** @type {any} */ ({
      handshake: { address: '10.0.0.1', headers: { 'x-forwarded-for': xff } },
      once(evt, fn) {
        if (evt === 'disconnect') disconnectHandlers.push(fn);
      }
    });

  const results = [];
  limiter(makeSocket('1.1.1.1, 203.0.113.10'), (err) => results.push(err || null));
  limiter(makeSocket('2.2.2.2, 203.0.113.10'), (err) => results.push(err || null));
  // 3rd attempt from same resolved client with different spoofed leftmost IP is rejected
  limiter(makeSocket('3.3.3.3, 203.0.113.10'), (err) => results.push(err || null));
  // Different real client behind same proxy succeeds
  limiter(makeSocket('203.0.113.11'), (err) => results.push(err || null));

  assert.equal(results[0], null);
  assert.equal(results[1], null);
  assert.match(String(results[2]), /Too many concurrent connections/);
  assert.equal(results[3], null);
  assert.equal(limiter.getCount('203.0.113.10'), 2);

  // Disconnecting frees slot
  disconnectHandlers[0]();
  assert.equal(limiter.getCount('203.0.113.10'), 1);
});

test('computeBudgetAwarePollIntervals reserves 20% budget and enforces round-robin incident cadence', () => {
  // Single-city Nagpur default (16 key junctions, dailyBudget=2000 => 1600 polling budget)
  const nagpurPlan = computeBudgetAwarePollIntervals({
    dailyBudget: 2000,
    keyJunctionCounts: [16]
  });
  assert.equal(nagpurPlan.pollingBudget, 1600);
  assert.equal(nagpurPlan.reservedOnDemandBudget, 400);
  assert.equal(nagpurPlan.budgetConstrained, true);
  assert.equal(nagpurPlan.flowIntervalMs > 240_000, true);
  assert.equal(nagpurPlan.projectedDailyCalls <= 1600, true);
  assert.equal(nagpurPlan.perCityIncidentsIntervalMs, 3 * nagpurPlan.flowIntervalMs);
  assert.equal('incidentsIntervalMs' in nagpurPlan, false);

  // Generous budget keeps base 4m / 12m intervals unconstrained
  const unconstrained = computeBudgetAwarePollIntervals({
    dailyBudget: 10_000,
    keyJunctionCounts: [16]
  });
  assert.equal(unconstrained.budgetConstrained, false);
  assert.equal(unconstrained.flowIntervalMs, 240_000);
  assert.equal(unconstrained.perCityIncidentsIntervalMs, 720_000);
  assert.equal(unconstrained.projectedDailyCalls <= unconstrained.pollingBudget, true);

  // Round-robin over 3 cities with MAX_ACTIVE_CITIES=1 enforces perCityIncidentsIntervalMs >= 3 * cityTurnIntervalMs
  const roundRobin = computeBudgetAwarePollIntervals({
    dailyBudget: 2000,
    keyJunctionCounts: [16, 10, 10],
    activeCities: 1,
    occupiedCities: 3
  });
  assert.equal(roundRobin.roundsPerCity, 3);
  assert.equal(roundRobin.cityTurnIntervalMs, 3 * roundRobin.flowIntervalMs);
  assert.equal(roundRobin.perCityIncidentsIntervalMs >= 3 * roundRobin.cityTurnIntervalMs, true);
  assert.equal(roundRobin.projectedDailyCalls <= 1600, true);
  const crossCheck = projectDailyNonTileCalls({
    flowIntervalMs: roundRobin.flowIntervalMs,
    perCityIncidentsIntervalMs: roundRobin.perCityIncidentsIntervalMs,
    keyJunctionCounts: [16, 10, 10],
    activeCities: 1,
    occupiedCities: 3
  });
  assert.equal(crossCheck.totalCallsPerDay, roundRobin.projectedDailyCalls);

  // Extreme low budget caps at DAY_MS and flags cappedAtMaxInterval
  const tiny = computeBudgetAwarePollIntervals({
    dailyBudget: 10,
    keyJunctionCounts: [16]
  });
  assert.equal(tiny.flowIntervalMs <= DAY_MS, true);
  assert.equal(tiny.cappedAtMaxInterval, true);

  assert.throws(
    () => computeBudgetAwarePollIntervals({ dailyBudget: 0, keyJunctionCounts: [16] }),
    RangeError
  );
  assert.throws(
    () =>
      computeBudgetAwarePollIntervals({
        dailyBudget: 2000,
        pollBudgetRatio: 1.5,
        keyJunctionCounts: [16]
      }),
    RangeError
  );
});

test('loadConfig validates MAX_ACTIVE_CITIES in [1, 10] with default 1', () => {
  assert.equal(loadConfig({}).maxActiveCities, 1);
  assert.equal(loadConfig({ MAX_ACTIVE_CITIES: '1' }).maxActiveCities, 1);
  assert.equal(loadConfig({ MAX_ACTIVE_CITIES: '10' }).maxActiveCities, 10);

  for (const bad of ['0', '11', '', 'abc']) {
    assert.throws(() => loadConfig({ MAX_ACTIVE_CITIES: bad }), /MAX_ACTIVE_CITIES/);
  }
});

test('isValidBearerToken enforces constant-time bearer matching and fails closed', () => {
  assert.equal(isValidBearerToken('Bearer my-secret', ''), false);
  assert.equal(isValidBearerToken(undefined, 'my-secret'), false);
  assert.equal(isValidBearerToken('Basic my-secret', 'my-secret'), false);
  assert.equal(isValidBearerToken('Bearer wrong', 'my-secret'), false);
  assert.equal(isValidBearerToken('Bearer my-secret', 'my-secret'), true);
});

test('Stale threshold follows 2 * actual interval + 60s grace across budget-constrained and unconstrained modes', (t) => {
  const startMs = Date.parse('2026-11-26T00:00:00.000Z');
  t.mock.timers.enable({ apis: ['Date'], now: startMs });

  try {
    // 1) Default budget (2000 -> flowIntervalMs=873000): 1.5 intervals is fresh, 2.5 intervals is stale
    resetStateForTests();
    const constrainedIntervalMs = 873_000;
    assert.equal(
      computeStaleThresholdMs(constrainedIntervalMs),
      2 * constrainedIntervalMs + STALE_GRACE_MS
    );

    setTestOverrides({
      config: { tomtomApiKey: 'mock_key_1234', dailyTomTomNonTileBudget: 2000 }
    });
    const nagpurState = cityStates.get('nagpur');
    assert.ok(nagpurState);
    const t0Iso = new Date(startMs).toISOString();
    nagpurState.polled = true;
    nagpurState.hasAttemptedRefresh = true;
    nagpurState.liveState.lastSuccessAt = { flow: t0Iso, incidents: t0Iso, weather: t0Iso };

    // Advance 1.5 flow intervals (1,309,500 ms < 2*873000 + 60000 = 1,806,000 ms)
    t.mock.timers.tick(1.5 * constrainedIntervalMs);
    const midSnap = getCityStateSnapshot('nagpur');
    assert.equal(midSnap.stale, false);
    assert.deepEqual(midSnap.staleSources, []);

    // Advance to 2.5 flow intervals total (2,182,500 ms > 1,806,000 ms)
    t.mock.timers.tick(1.0 * constrainedIntervalMs);
    const lateSnap = getCityStateSnapshot('nagpur');
    assert.equal(lateSnap.stale, true);
    assert.equal(lateSnap.staleSources.includes('flow'), true);

    // 2) Single-city unconstrained (budget=10000 -> flowIntervalMs=240000): threshold 2*240000 + 60000 = 540000
    resetStateForTests();
    const now2 = Date.now();
    const unconstrainedIntervalMs = 240_000;
    setTestOverrides({
      config: { tomtomApiKey: 'mock_key_1234', dailyTomTomNonTileBudget: 10_000 }
    });
    const state2 = cityStates.get('nagpur');
    assert.ok(state2);
    const t2Iso = new Date(now2).toISOString();
    state2.polled = true;
    state2.hasAttemptedRefresh = true;
    state2.liveState.lastSuccessAt = { flow: t2Iso, incidents: t2Iso, weather: t2Iso };

    t.mock.timers.tick(1.5 * unconstrainedIntervalMs);
    assert.equal(getCityStateSnapshot('nagpur').stale, false);

    t.mock.timers.tick(1.0 * unconstrainedIntervalMs);
    const stale2 = getCityStateSnapshot('nagpur');
    assert.equal(stale2.stale, true);
    assert.equal(stale2.staleSources.includes('flow'), true);
  } finally {
    t.mock.timers.reset();
    resetStateForTests();
  }
});
