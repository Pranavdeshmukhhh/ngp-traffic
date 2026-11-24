'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  app,
  setTestOverrides,
  resetStateForTests,
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
  const httpServer = app.listen(0);
  await new Promise((resolve) => httpServer.once('listening', resolve));
  const { port } = httpServer.address();
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
});
