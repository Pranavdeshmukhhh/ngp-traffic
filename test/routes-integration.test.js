'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  server,
  io,
  setTestOverrides,
  resetStateForTests,
  routeSchemasByCity,
  refreshCityState,
  startPollingLoops,
  stopPollingLoops,
  getActiveTimerCount,
  basemapTileCache,
  upstreamBudget
} = require('../server');

const TEST_TOMTOM_KEY = 'mock_tomtom_key_99999';

function makeJsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function makePngResponse(bytes = 'mock-png-bytes', status = 200) {
  return new Response(Buffer.from(bytes), {
    status,
    headers: { 'content-type': 'image/png' }
  });
}

test('Integration suite: routes, mocked upstreams, failure paths, rate limits & CSP', async (t) => {
  const httpServer = server.listen(0);
  await new Promise((resolve) => httpServer.once('listening', resolve));
  const addr = httpServer.address();
  assert.ok(addr && typeof addr === 'object');
  const { port } = addr;
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(async () => {
    resetStateForTests();
    await new Promise((resolve) => httpServer.close(resolve));
  });

  await t.test('GET /api/health returns security metrics and CSP headers', async () => {
    resetStateForTests();
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);

    const csp = res.headers.get('content-security-policy') || '';
    assert.equal(csp.includes("script-src 'self' https://unpkg.com"), true);
    assert.equal(csp.includes("'unsafe-inline'") && csp.split('script-src')[1].split(';')[0].includes("'unsafe-inline'"), false);
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');

    const homeRes = await fetch(`${baseUrl}/`);
    assert.equal(homeRes.status, 200);
    assert.equal(homeRes.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');

    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.metrics.p95LatencyMs, 'number');
    assert.ok(body.metrics.trafficTileCache);
    assert.ok(body.metrics.upstreamToday);
  });

  await t.test('GET /api/search validates strict schema and handles mocked success + 502 error', async () => {
    resetStateForTests();
    setTestOverrides({
      config: { tomtomApiKey: TEST_TOMTOM_KEY },
      fetch: async () =>
        makeJsonResponse({
          results: [
            {
              poi: { name: 'Sitabuldi' },
              address: { freeformAddress: 'Sitabuldi, Nagpur' },
              position: { lat: 21.1436, lon: 79.0806 }
            }
          ]
        })
    });

    // Reject unknown query field & short query
    const extraField = await fetch(`${baseUrl}/api/search?q=Sitabuldi&evil=1`);
    assert.equal(extraField.status, 400);
    const shortQ = await fetch(`${baseUrl}/api/search?q=a`);
    assert.equal(shortQ.status, 400);

    // Mocked success
    const okRes = await fetch(`${baseUrl}/api/search?q=Sitabuldi`);
    assert.equal(okRes.status, 200);
    const okBody = await okRes.json();
    assert.equal(okBody.results[0].name, 'Sitabuldi');

    // Upstream 500 -> clean 502 without leaking key
    setTestOverrides({
      fetch: async () => new Response(`fail key=${TEST_TOMTOM_KEY}`, { status: 500 })
    });
    const failRes = await fetch(`${baseUrl}/api/search?q=Dharampeth`);
    assert.equal(failRes.status, 502);
    const failBody = await failRes.json();
    assert.equal(JSON.stringify(failBody).includes(TEST_TOMTOM_KEY), false);
  });

  await t.test('GET /api/route rejects out-of-Nagpur coords and returns parallel mocked routes', async () => {
    resetStateForTests();
    setTestOverrides({
      config: { tomtomApiKey: TEST_TOMTOM_KEY },
      fetch: async (url) => {
        const isFastest = String(url).includes('routeType=fastest');
        return makeJsonResponse({
          routes: [
            {
              summary: {
                lengthInMeters: isFastest ? 8400 : 7100,
                travelTimeInSeconds: isFastest ? 1080 : 1440,
                trafficDelayInSeconds: isFastest ? 180 : 540
              },
              legs: [
                {
                  points: [
                    { latitude: 21.1458, longitude: 79.0882 },
                    { latitude: 21.1068, longitude: 79.0634 }
                  ]
                }
              ]
            }
          ]
        });
      }
    });

    // Reject coordinates outside Nagpur/Vidarbha bounding box
    const outside = await fetch(
      `${baseUrl}/api/route?fromLat=28.61&fromLng=77.20&toLat=28.62&toLng=77.21`
    );
    assert.equal(outside.status, 400);

    const okRes = await fetch(
      `${baseUrl}/api/route?fromLat=21.1458&fromLng=79.0882&toLat=21.1068&toLng=79.0634`
    );
    assert.equal(okRes.status, 200);
    const data = await okRes.json();
    assert.equal(data.fastest.distanceKm, 8.4);
    assert.equal(data.shortest.distanceKm, 7.1);

    // Upstream failure -> 502
    setTestOverrides({
      fetch: async () => {
        throw new Error('Upstream timeout');
      }
    });
    const errRes = await fetch(
      `${baseUrl}/api/route?fromLat=21.1458&fromLng=79.0882&toLat=21.1068&toLng=79.0634`
    );
    assert.equal(errRes.status, 502);
  });

  await t.test('Tile proxies validate bounds, dedupe in-flight fetches, and handle upstream 500', async () => {
    resetStateForTests();
    let fetchCount = 0;
    setTestOverrides({
      config: { tomtomApiKey: TEST_TOMTOM_KEY },
      fetch: async () => {
        fetchCount += 1;
        await new Promise((r) => setTimeout(r, 20));
        return makePngResponse('png-data-ok');
      }
    });

    // Concurrent identical requests coalesce to 1 upstream call
    const [r1, r2, r3] = await Promise.all([
      fetch(`${baseUrl}/tiles/traffic/13/5897/3585.png?theme=dark`),
      fetch(`${baseUrl}/tiles/traffic/13/5897/3585.png?theme=dark`),
      fetch(`${baseUrl}/tiles/traffic/13/5897/3585.png?theme=dark`)
    ]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(r3.status, 200);
    assert.equal(fetchCount, 1);

    // Unknown query parameter rejected
    const badParam = await fetch(`${baseUrl}/tiles/basemap/13/5897/3585.png?foo=bar`);
    assert.equal(badParam.status, 400);

    // Upstream 500 -> 502 cleanly
    setTestOverrides({
      fetch: async () => new Response(`upstream error ${TEST_TOMTOM_KEY}`, { status: 500 })
    });
    const badTile = await fetch(`${baseUrl}/tiles/basemap/13/5897/3586.png?theme=light`);
    assert.equal(badTile.status, 502);
  });

  await t.test('Tile limiters allow >300 req/min/IP per layer without blocking panning', async () => {
    resetStateForTests();
    let fetchCount = 0;
    setTestOverrides({
      config: { tomtomApiKey: TEST_TOMTOM_KEY },
      fetch: async () => {
        fetchCount += 1;
        return makePngResponse('png-tile-ok');
      }
    });

    // Warm basemap cache then issue 305 total basemap tile requests (> old 300/min limit)
    for (let batch = 0; batch < 305; batch += 25) {
      const count = Math.min(25, 305 - batch);
      const responses = await Promise.all(
        Array.from({ length: count }, () =>
          fetch(`${baseUrl}/tiles/basemap/13/5897/3585.png?theme=light`)
        )
      );
      for (const tileRes of responses) {
        assert.equal(tileRes.status, 200);
      }
    }
    assert.equal(fetchCount, 1);

    // Traffic tile route uses an independent limiter
    const trafficRes = await fetch(`${baseUrl}/tiles/traffic/13/5897/3585.png?theme=light`);
    assert.equal(trafficRes.status, 200);
    assert.equal(fetchCount, 2);
  });

  await t.test('Rate limiter returns 429 and daily budget guard returns 503', async () => {
    resetStateForTests();
    setTestOverrides({
      config: { tomtomApiKey: TEST_TOMTOM_KEY },
      fetch: async () => makeJsonResponse({ results: [] })
    });

    // Budget guard test (limit to 1 call temporarily)
    const origLimit = upstreamBudget.tomtomNonTileLimit;
    upstreamBudget.tomtomNonTileLimit = 1;
    try {
      const first = await fetch(`${baseUrl}/api/search?q=Sitabuldi`);
      assert.equal(first.status, 200);
      const second = await fetch(`${baseUrl}/api/search?q=Dharampeth`);
      assert.equal(second.status, 503);
    } finally {
      upstreamBudget.tomtomNonTileLimit = origLimit;
    }

    // Rate limiter test on /api/route (max 20/min/IP)
    resetStateForTests();
    setTestOverrides({
      config: { tomtomApiKey: TEST_TOMTOM_KEY },
      fetch: async () =>
        makeJsonResponse({
          routes: [
            { summary: { lengthInMeters: 1000, travelTimeInSeconds: 120, trafficDelayInSeconds: 0 }, legs: [] }
          ]
        })
    });

    let lastStatus = 200;
    let retryAfter = null;
    for (let i = 0; i < 21; i++) {
      const res = await fetch(
        `${baseUrl}/api/route?fromLat=21.1458&fromLng=79.0882&toLat=21.1068&toLng=79.0634`
      );
      lastStatus = res.status;
      retryAfter = res.headers.get('retry-after');
    }
    assert.equal(lastStatus, 429);
    assert.ok(Number(retryAfter) >= 1);
  });

  await t.test('Proxy-aware rate limiter blocks spoofed X-Forwarded-For rotation and isolates real clients', async () => {
    const routeMock = async () =>
      makeJsonResponse({
        routes: [
          { summary: { lengthInMeters: 1000, travelTimeInSeconds: 120, trafficDelayInSeconds: 0 }, legs: [] }
        ]
      });

    // 1) trustProxy=0: rotating spoofed X-Forwarded-For headers still shares the peer IP bucket and hits 429
    resetStateForTests();
    setTestOverrides({
      config: { tomtomApiKey: TEST_TOMTOM_KEY, trustProxy: 0 },
      fetch: routeMock
    });

    let directLast = 200;
    for (let i = 0; i < 21; i++) {
      const res = await fetch(
        `${baseUrl}/api/route?fromLat=21.1458&fromLng=79.0882&toLat=21.1068&toLng=79.0634`,
        { headers: { 'x-forwarded-for': `198.51.100.${i + 1}` } }
      );
      directLast = res.status;
    }
    assert.equal(directLast, 429);

    // 2) trustProxy=1: attacker rotating leftmost XFF cannot bypass cap for client .50, while client .51 is unaffected
    resetStateForTests();
    setTestOverrides({
      config: { tomtomApiKey: TEST_TOMTOM_KEY, trustProxy: 1 },
      fetch: routeMock
    });

    let proxiedLast = 200;
    for (let i = 0; i < 21; i++) {
      const res = await fetch(
        `${baseUrl}/api/route?fromLat=21.1458&fromLng=79.0882&toLat=21.1068&toLng=79.0634`,
        { headers: { 'x-forwarded-for': `203.0.113.${i + 1}, 198.51.100.50` } }
      );
      proxiedLast = res.status;
    }
    assert.equal(proxiedLast, 429);

    const otherClient = await fetch(
      `${baseUrl}/api/route?fromLat=21.1458&fromLng=79.0882&toLat=21.1068&toLng=79.0634`,
      { headers: { 'x-forwarded-for': '198.51.100.51' } }
    );
    assert.equal(otherClient.status, 200);

    // 3) >4 KB spoofed X-Forwarded-For prefix fails closed to peer IP instead of truncating the right end
    resetStateForTests();
    setTestOverrides({
      config: { tomtomApiKey: TEST_TOMTOM_KEY, trustProxy: 1 },
      fetch: routeMock
    });

    let hugeHeaderLast = 200;
    for (let i = 0; i < 21; i++) {
      const spoofedPrefix = `203.0.113.${(i % 200) + 1}, `.repeat(320);
      const hugeXff = `${spoofedPrefix}198.51.100.${i + 10}`;
      assert.ok(hugeXff.length > 4096);
      const res = await fetch(
        `${baseUrl}/api/route?fromLat=21.1458&fromLng=79.0882&toLat=21.1068&toLng=79.0634`,
        { headers: { 'x-forwarded-for': hugeXff } }
      );
      hugeHeaderLast = res.status;
    }
    assert.equal(hugeHeaderLast, 429);
  });

  await t.test('Socket.IO per-IP connection cap enforces trustProxy hops and fails closed on >4 KB XFF', async () => {
    resetStateForTests();
    setTestOverrides({ config: { trustProxy: 1 } });

    /** @param {string} xff */
    async function connectSocketPolling(xff) {
      const openRes = await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling`, {
        headers: { 'x-forwarded-for': xff }
      });
      const openText = await openRes.text();
      const sid = JSON.parse(openText.slice(1)).sid;

      await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${encodeURIComponent(sid)}`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=UTF-8', 'x-forwarded-for': xff },
        body: '40'
      });

      const pollRes = await fetch(
        `${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${encodeURIComponent(sid)}`,
        { headers: { 'x-forwarded-for': xff } }
      );
      return pollRes.text();
    }

    try {
      // Open 8 allowed sockets from 203.0.113.5 (with varying spoofed leftmost XFF)
      for (let i = 0; i < 8; i++) {
        const body = await connectSocketPolling(`1.1.1.${i + 1}, 203.0.113.5`);
        assert.equal(body.includes('40{'), true, `Socket ${i + 1} expected connect ack, got ${body}`);
      }

      // 9th socket from same resolved IP must be rejected even with a new spoofed leftmost IP
      const ninth = await connectSocketPolling('9.9.9.9, 203.0.113.5');
      assert.equal(ninth.includes('Too many concurrent connections'), true);

      // Different real client IP behind same proxy is still accepted
      const other = await connectSocketPolling('203.0.113.6');
      assert.equal(other.includes('40{'), true);

      // Oversized (>4 KB) X-Forwarded-For fails closed to peer IP (127.0.0.1), pinning all 8 sockets on peer
      io.disconnectSockets(true);
      resetStateForTests();
      setTestOverrides({ config: { trustProxy: 1 } });

      for (let i = 0; i < 8; i++) {
        const spoofedPrefix = `203.0.113.${(i % 200) + 1}, `.repeat(320);
        const hugeXff = `${spoofedPrefix}198.51.100.${i + 20}`;
        assert.ok(hugeXff.length > 4096);
        const body = await connectSocketPolling(hugeXff);
        assert.equal(body.includes('40{'), true, `Oversized XFF socket ${i + 1} expected connect ack, got ${body}`);
      }
      const hugeNinth = await connectSocketPolling(`${'203.0.113.9, '.repeat(350)}198.51.100.99`);
      assert.equal(hugeNinth.includes('Too many concurrent connections'), true);
    } finally {
      io.disconnectSockets(true);
    }
  });

  await t.test('Multi-city metadata, state, and ?city= scoping with zero raw echo and zero wasted quota', async () => {
    resetStateForTests();

    // GET /api/cities returns catalog summary
    const citiesRes = await fetch(`${baseUrl}/api/cities`);
    assert.equal(citiesRes.status, 200);
    const citiesBody = await citiesRes.json();
    assert.equal(citiesBody.defaultCityId, 'nagpur');
    assert.equal(citiesBody.maxActiveCities, 1);
    assert.equal(citiesBody.cities.length, 3);
    const puneSummary = citiesBody.cities.find((c) => c.id === 'pune');
    assert.ok(puneSummary);
    assert.equal(puneSummary.monitoredJunctionCount, 10);

    // GET /api/cities/:id returns full config for valid city, 404 with no raw echo otherwise
    const puneRes = await fetch(`${baseUrl}/api/cities/pune`);
    assert.equal(puneRes.status, 200);
    const puneDetail = await puneRes.json();
    assert.equal(puneDetail.id, 'pune');
    assert.equal(puneDetail.junctions.length, 10);

    const badCityRes = await fetch(`${baseUrl}/api/cities/atlantis`);
    assert.equal(badCityRes.status, 404);
    assert.equal((await badCityRes.text()).includes('atlantis'), false);

    const traversalCityRes = await fetch(`${baseUrl}/api/cities/..%2F..%2Fetc%2Fpasswd`);
    assert.equal(traversalCityRes.status, 404);
    assert.equal((await traversalCityRes.text()).includes('passwd'), false);

    // GET /api/state returns per-city state and rejects unknown/invalid city without echo
    const defaultStateRes = await fetch(`${baseUrl}/api/state`);
    assert.equal(defaultStateRes.status, 200);
    assert.equal((await defaultStateRes.json()).cityId, 'nagpur');

    const puneStateRes = await fetch(`${baseUrl}/api/state?city=pune`);
    assert.equal(puneStateRes.status, 200);
    assert.equal((await puneStateRes.json()).cityId, 'pune');

    const unknownStateRes = await fetch(`${baseUrl}/api/state?city=unknown_xyz`);
    assert.equal(unknownStateRes.status, 400);
    assert.equal((await unknownStateRes.text()).includes('unknown_xyz'), false);

    const traversalStateRes = await fetch(`${baseUrl}/api/state?city=../../etc/passwd`);
    assert.equal(traversalStateRes.status, 400);
    assert.equal((await traversalStateRes.text()).includes('passwd'), false);

    // Unknown ?city= consumes 0 upstream quota across /api/search, /api/route, /api/health, /tiles/basemap
    let fetchedUrls = [];
    setTestOverrides({
      config: { tomtomApiKey: TEST_TOMTOM_KEY },
      fetch: async (url) => {
        fetchedUrls.push(String(url));
        if (String(url).includes('/map/1/tile/')) {
          return makePngResponse('tile-ok');
        }
        if (String(url).includes('/search/2/search/')) {
          return makeJsonResponse({
            results: [
              {
                poi: { name: 'Shaniwar Wada' },
                address: { freeformAddress: 'Pune, Maharashtra' },
                position: { lat: 18.5191, lon: 73.8555 }
              }
            ]
          });
        }
        return makeJsonResponse({
          routes: [
            {
              summary: { lengthInMeters: 5200, travelTimeInSeconds: 780, trafficDelayInSeconds: 120 },
              legs: []
            }
          ]
        });
      }
    });

    const beforeBudget = upstreamBudget.snapshot().tomtomNonTile;
    for (const badPath of [
      '/api/search?q=Shaniwar&city=unknown_xyz',
      '/api/route?city=unknown_xyz&fromLat=18.52&fromLng=73.85&toLat=18.53&toLng=73.86',
      '/api/health?city=unknown_xyz',
      '/tiles/basemap/13/5897/3585.png?city=unknown_xyz'
    ]) {
      const r = await fetch(`${baseUrl}${badPath}`);
      assert.equal(r.status, 400, `Expected 400 for ${badPath}`);
      assert.equal((await r.text()).includes('unknown_xyz'), false);
    }
    assert.equal(upstreamBudget.snapshot().tomtomNonTile, beforeBudget);
    assert.equal(fetchedUrls.length, 0);

    // ?city=pune search bias & pre-built routeSchemasByCity
    assert.equal(routeSchemasByCity.has('nagpur'), true);
    assert.equal(routeSchemasByCity.has('pune'), true);
    assert.equal(routeSchemasByCity.has('bengaluru'), true);

    const searchPuneRes = await fetch(`${baseUrl}/api/search?q=Shaniwar&city=pune`);
    assert.equal(searchPuneRes.status, 200);
    const searchUrl = fetchedUrls.find((u) => u.includes('/search/2/search/'));
    assert.ok(searchUrl);
    assert.equal(searchUrl.includes('lat=18.521111'), true);
    assert.equal(searchUrl.includes('lon=73.855278'), true);
    assert.equal(searchUrl.includes('radius=30000'), true);

    // Pune coordinates allowed on ?city=pune, rejected on default Nagpur
    const puneRouteOk = await fetch(
      `${baseUrl}/api/route?city=pune&fromLat=18.52&fromLng=73.85&toLat=18.59&toLng=73.74`
    );
    assert.equal(puneRouteOk.status, 200);
    const puneRouteOnNagpur = await fetch(
      `${baseUrl}/api/route?fromLat=18.52&fromLng=73.85&toLat=18.59&toLng=73.74`
    );
    assert.equal(puneRouteOnNagpur.status, 400);

    // Basemap tile cache key includes viewTag (e.g. IN/light/z/x/y)
    const tileRes = await fetch(`${baseUrl}/tiles/basemap/13/5897/3585.png?theme=light&city=pune`);
    assert.equal(tileRes.status, 200);
    assert.ok(basemapTileCache.get('IN/light/13/5897/3585'));

    // Health ?city=pune reflects Pune junction count
    const puneHealth = await (await fetch(`${baseUrl}/api/health?city=pune`)).json();
    assert.equal(puneHealth.city, 'pune');
    assert.equal(puneHealth.monitoredJunctions, 10);
  });

  await t.test('Per-city freshness isolation and polling timer cleanup', async () => {
    resetStateForTests();
    setTestOverrides({
      config: { tomtomApiKey: TEST_TOMTOM_KEY },
      fetch: async (url) => {
        const u = String(url);
        if (u.includes('api.open-meteo.com')) {
          return makeJsonResponse({
            current: { temperature_2m: 31, precipitation: 0, weather_code: 0 }
          });
        }
        if (u.includes('flowSegmentData')) {
          // Pune points start around lat 18.x; Nagpur around 21.x
          if (u.includes('point=18.')) {
            return new Response('pune flow down', { status: 500 });
          }
          return makeJsonResponse({
            flowSegmentData: {
              currentSpeed: 28,
              freeFlowSpeed: 50,
              currentTravelTime: 180,
              freeFlowTravelTime: 100,
              confidence: 0.9,
              roadClosure: false
            }
          });
        }
        if (u.includes('incidentDetails')) {
          return makeJsonResponse({ incidents: [] });
        }
        return makeJsonResponse({});
      }
    });

    await refreshCityState('nagpur', { forceFlow: true, forceIncidents: true, forceWeather: true });
    await refreshCityState('pune', { forceFlow: true, forceIncidents: true, forceWeather: true });

    const nagpurState = await (await fetch(`${baseUrl}/api/state?city=nagpur`)).json();
    const puneState = await (await fetch(`${baseUrl}/api/state?city=pune`)).json();

    assert.equal(nagpurState.cityId, 'nagpur');
    assert.equal(nagpurState.stale, false);
    assert.equal(nagpurState.junctions.length, 16);

    assert.equal(puneState.cityId, 'pune');
    assert.equal(puneState.stale, true);
    assert.equal(puneState.staleSources.includes('flow'), true);
    assert.equal(puneState.junctions.length, 0);

    // Calling startPollingLoops twice does not leak duplicate timers; stopPollingLoops clears all
    startPollingLoops();
    startPollingLoops();
    assert.equal(getActiveTimerCount(), 3);
    stopPollingLoops();
    assert.equal(getActiveTimerCount(), 0);
  });
});
