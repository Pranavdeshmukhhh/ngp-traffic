/**
 * NGP-TRAFFIC Test Suite
 * Run: node test/test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  app,
  predictDeployments,
  computeTrend,
  haversineMeters,
  findNearestPoliceStation,
  describeWeatherCode,
  extractIncidentPoint
} = require('../server');

let passed = 0;
let failed = 0;
let total = 0;

async function test(name, fn) {
  total++;
  try {
    await fn();
    passed++;
    console.log('  [PASS] ' + name);
  } catch (err) {
    failed++;
    console.error('  [FAIL] ' + name + ' -- ' + err.message);
  }
}

async function run() {
  const rootDir = path.join(__dirname, '..');
  const junctions = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'data', 'nagpur-junctions.json'), 'utf8')
  );
  const stations = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'data', 'police-stations.json'), 'utf8')
  );

  console.log('\n=== NGP-TRAFFIC Test Suite ===\n');

  console.log('Data & Cleanup Integrity:');
  await test('50 Nagpur junctions loaded with valid coordinates', () => {
    assert.strictEqual(junctions.length, 50);
    for (const j of junctions) {
      assert(j.lat > 20.8 && j.lat < 21.4, `${j.id} invalid lat`);
      assert(j.lng > 78.8 && j.lng < 79.4, `${j.id} invalid lng`);
    }
  });

  await test('16 key junctions marked for free-tier polling and no synthetic fields remain', () => {
    const keyJunctions = junctions.filter((j) => j.key === true);
    assert.strictEqual(keyJunctions.length, 16);
    const forbidden = [
      'trafficByHour',
      'accidentHistory',
      'avgDailyTraffic',
      'baselineOfficer',
      'laneCount'
    ];
    for (const j of junctions) {
      for (const field of forbidden) {
        assert(!(field in j), `Synthetic field ${field} still present in ${j.id}`);
      }
    }
  });

  await test('10 Nagpur police stations loaded', () => {
    assert.strictEqual(stations.length, 10);
  });

  await test('Deleted mock and unused files do not exist', () => {
    const removedFiles = [
      'public/simulation.html',
      'public/js/simulation.js',
      'public/officer.html',
      'public/citizen.html',
      'data/officer-credentials.json',
      'data/officers.json',
      'data/preset-incidents.json',
      'data/road-segments.json',
      'ml-engine.js',
      'training_data.csv',
      'routing-engine.js'
    ];
    for (const rel of removedFiles) {
      assert(!fs.existsSync(path.join(rootDir, rel)), `Expected deleted file exists: ${rel}`);
    }
  });

  console.log('\nGeo & Weather Helpers:');
  await test('haversineMeters computes accurate Nagpur distances', () => {
    const d = haversineMeters(21.1458, 79.0882, 21.14358, 79.08063);
    assert(d > 700 && d < 950, `Unexpected distance: ${d}`);
  });

  await test('findNearestPoliceStation resolves Sitabuldi PS for Variety Square', () => {
    const nearest = findNearestPoliceStation(21.1458, 79.0882, stations);
    assert(nearest, 'Expected nearest station');
    assert.strictEqual(nearest.id, 'PS01');
    assert.strictEqual(nearest.shortName, 'Sitabuldi PS');
    assert(nearest.distanceKm >= 0 && nearest.distanceKm < 2);
  });

  await test('describeWeatherCode and extractIncidentPoint handle Point and LineString', () => {
    assert.strictEqual(describeWeatherCode(0), 'Clear');
    assert.strictEqual(describeWeatherCode(95), 'Thunderstorm');
    assert.deepStrictEqual(
      extractIncidentPoint({ type: 'Point', coordinates: [79.08, 21.14] }),
      { lat: 21.14, lng: 79.08 }
    );
    assert.deepStrictEqual(
      extractIncidentPoint({
        type: 'LineString',
        coordinates: [
          [79.07, 21.13],
          [79.08, 21.14],
          [79.09, 21.15]
        ]
      }),
      { lat: 21.14, lng: 79.08 }
    );
  });

  console.log('\npredictDeployments() & False-Positive Guards:');
  const baseJunction = {
    id: 'J001',
    name: 'Variety Square',
    lat: 21.1458,
    lng: 79.0882,
    roadType: 'major_intersection',
    roadClosure: false
  };
  const emptyHistory = new Map();

  await test('Smooth traffic produces zero alerts', () => {
    const res = predictDeployments(
      [{ ...baseJunction, currentSpeed: 42, freeFlowSpeed: 45 }],
      [],
      { precipitation: 0 },
      stations,
      emptyHistory
    );
    assert.strictEqual(res.length, 0);
  });

  await test('Full speed (32 vs 32 km/h) with closure 300m away is NOT falsely flagged as Closed', () => {
    // ~300m north of Variety Square
    const closure300m = [{ lat: 21.1485, lng: 79.0882, iconCategory: 8, description: 'Side street closed' }];
    const res = predictDeployments(
      [{ ...baseJunction, currentSpeed: 32, freeFlowSpeed: 32, roadClosure: false }],
      closure300m,
      { precipitation: 0 },
      stations,
      emptyHistory
    );
    assert.strictEqual(res.length, 0);
  });

  await test('Free-flow guard skips roadworks within 150m when congestion < 15%, but flags verified accident <= 100m', () => {
    const roadworks80m = [{ lat: 21.1465, lng: 79.0882, iconCategory: 9, description: 'Minor roadworks' }];
    const skipped = predictDeployments(
      [{ ...baseJunction, currentSpeed: 42, freeFlowSpeed: 45 }],
      roadworks80m,
      { precipitation: 0 },
      stations,
      emptyHistory
    );
    assert.strictEqual(skipped.length, 0);

    const accident80m = [{ lat: 21.1465, lng: 79.0882, iconCategory: 1, description: 'Collision' }];
    const flagged = predictDeployments(
      [{ ...baseJunction, currentSpeed: 42, freeFlowSpeed: 45 }],
      accident80m,
      { precipitation: 0 },
      stations,
      emptyHistory
    );
    assert.strictEqual(flagged.length, 1);
    assert.strictEqual(flagged[0].severity, 'HIGH');
    assert.strictEqual(flagged[0].badge, 'Officer Needed');
  });

  await test('Handles edge cases: currentSpeed > freeFlowSpeed and freeFlowSpeed = 0', () => {
    const res = predictDeployments(
      [
        { ...baseJunction, id: 'J_FAST', currentSpeed: 55, freeFlowSpeed: 45 },
        { ...baseJunction, id: 'J_ZERO', currentSpeed: 0, freeFlowSpeed: 0 }
      ],
      [],
      { precipitation: 0 },
      stations,
      emptyHistory
    );
    assert.strictEqual(res.length, 1);
    assert.strictEqual(res[0].id, 'J_ZERO');
    assert.strictEqual(res[0].congestionPct, 100);
  });

  await test('roadClosure=true triggers Road Clearing Needed (HIGH) with nearest station', () => {
    const res = predictDeployments(
      [{ ...baseJunction, currentSpeed: 30, freeFlowSpeed: 45, roadClosure: true }],
      [],
      { precipitation: 0 },
      stations,
      emptyHistory
    );
    assert.strictEqual(res.length, 1);
    assert.strictEqual(res[0].severity, 'HIGH');
    assert.strictEqual(res[0].badge, 'Clearing Needed');
    assert.strictEqual(res[0].action, 'Road Clearing Needed');
    assert(res[0].nearestStation && res[0].nearestStation.shortName === 'Sitabuldi PS');
  });

  await test('Roadworks within 150m with >= 25% congestion triggers Road Clearing Needed (HIGH); >150m is ignored', () => {
    const nearInc = [{ lat: 21.1466, lng: 79.0882, iconCategory: 9, description: 'Roadworks' }];
    const farInc = [{ lat: 21.1485, lng: 79.0882, iconCategory: 9, description: 'Far roadworks' }];

    const nearRes = predictDeployments(
      [{ ...baseJunction, currentSpeed: 30, freeFlowSpeed: 45 }],
      nearInc,
      { precipitation: 0 },
      stations,
      emptyHistory
    );
    assert.strictEqual(nearRes.length, 1);
    assert.strictEqual(nearRes[0].action, 'Road Clearing Needed');

    const farRes = predictDeployments(
      [{ ...baseJunction, currentSpeed: 30, freeFlowSpeed: 45 }],
      farInc,
      { precipitation: 0 },
      stations,
      emptyHistory
    );
    assert.strictEqual(farRes.length, 0);
  });

  await test('Rainfall >= 5 mm/hr with >= 50% congestion triggers Road Clearing Needed (HIGH)', () => {
    const highRainRes = predictDeployments(
      [{ ...baseJunction, currentSpeed: 20, freeFlowSpeed: 45 }],
      [],
      { precipitation: 6.2 },
      stations,
      emptyHistory
    );
    assert.strictEqual(highRainRes.length, 1);
    assert.strictEqual(highRainRes[0].severity, 'HIGH');
    assert.strictEqual(highRainRes[0].action, 'Road Clearing Needed');

    const lightCongestionRes = predictDeployments(
      [{ ...baseJunction, currentSpeed: 30, freeFlowSpeed: 45 }],
      [],
      { precipitation: 6.2 },
      stations,
      emptyHistory
    );
    assert.strictEqual(lightCongestionRes.length, 0);
  });

  await test('Congestion 40%-59% triggers Standby / Monitor (MEDIUM) without station dispatch', () => {
    const res = predictDeployments(
      [{ ...baseJunction, currentSpeed: 25, freeFlowSpeed: 45 }],
      [],
      { precipitation: 0 },
      stations,
      emptyHistory
    );
    assert.strictEqual(res.length, 1);
    assert.strictEqual(res[0].severity, 'MEDIUM');
    assert.strictEqual(res[0].badge, 'Monitor');
    assert.strictEqual(res[0].nearestStation, null);
  });

  await test('Composite severityScore (0-100) sorts alerts descending and tracks trend', () => {
    const hist = new Map([
      ['HIGH_DELAY', [30, 50, 70]],
      ['MED_IMPROVING', [65, 55, 45]],
      ['HIGH_STABLE', [62, 64, 65]]
    ]);
    assert.strictEqual(computeTrend([30, 50, 70]), 'worsening');
    assert.strictEqual(computeTrend([65, 55, 45]), 'improving');
    assert.strictEqual(computeTrend([62, 64, 65]), 'stable');

    const res = predictDeployments(
      [
        {
          ...baseJunction,
          id: 'MED_IMPROVING',
          name: 'Med',
          currentSpeed: 25,
          freeFlowSpeed: 45,
          currentTravelTime: 80,
          freeFlowTravelTime: 60
        },
        {
          ...baseJunction,
          id: 'HIGH_STABLE',
          name: 'HighStable',
          currentSpeed: 16,
          freeFlowSpeed: 45,
          currentTravelTime: 90,
          freeFlowTravelTime: 60
        },
        {
          ...baseJunction,
          id: 'HIGH_DELAY',
          name: 'HighDelay',
          currentSpeed: 14,
          freeFlowSpeed: 45,
          currentTravelTime: 360,
          freeFlowTravelTime: 60
        }
      ],
      [{ lat: 21.1459, lng: 79.0883, iconCategory: 1, description: 'Accident' }],
      { precipitation: 3.5 },
      stations,
      hist
    );
    assert.deepStrictEqual(
      res.map((r) => r.id),
      ['HIGH_DELAY', 'HIGH_STABLE', 'MED_IMPROVING']
    );
    assert(res[0].severityScore > res[1].severityScore);
    assert(res[1].severityScore > res[2].severityScore);
    assert.strictEqual(res[0].trend, 'worsening');
    assert.strictEqual(res[1].trend, 'stable');
    assert.strictEqual(res[2].trend, 'improving');
  });

  console.log('\nHTTP Endpoints:');
  const httpServer = app.listen(0);
  await new Promise((resolve) => httpServer.once('listening', resolve));
  const { port } = httpServer.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await test('GET /api/health returns 200 and expected telemetry schema', async () => {
      const res = await fetch(`${baseUrl}/api/health`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.status, 'ok');
      assert.strictEqual(typeof body.tomtomConfigured, 'boolean');
      assert.strictEqual(body.monitoredJunctions, 16);
      assert('updatedAt' in body);
      assert('activeClients' in body);
      assert('alertsCount' in body);
    });

    await test('GET /tiles/traffic/abc/0/0.png returns 400 and ?theme=dark is accepted', async () => {
      const badRes = await fetch(`${baseUrl}/tiles/traffic/abc/0/0.png`);
      assert.strictEqual(badRes.status, 400);

      const darkRes = await fetch(`${baseUrl}/tiles/traffic/13/5897/3585.png?theme=dark`);
      assert([200, 204, 502].includes(darkRes.status), `Unexpected status: ${darkRes.status}`);
    });

    await test('Static assets serve 200 and deleted simulation.html returns 404', async () => {
      const [indexRes, cssRes, jsRes, deletedRes] = await Promise.all([
        fetch(`${baseUrl}/`),
        fetch(`${baseUrl}/css/styles.css`),
        fetch(`${baseUrl}/js/app.js`),
        fetch(`${baseUrl}/simulation.html`)
      ]);
      assert.strictEqual(indexRes.status, 200);
      assert.strictEqual(cssRes.status, 200);
      assert.strictEqual(jsRes.status, 200);
      assert.strictEqual(deletedRes.status, 404);
    });
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
  }

  console.log('\n' + '='.repeat(40));
  console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

run();
