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

  console.log('\npredictDeployments():');
  const baseJunction = {
    id: 'J001',
    name: 'Variety Square',
    lat: 21.1458,
    lng: 79.0882,
    roadType: 'major_intersection',
    roadClosure: false
  };

  await test('Smooth traffic produces zero alerts', () => {
    const res = predictDeployments(
      [{ ...baseJunction, currentSpeed: 42, freeFlowSpeed: 45 }],
      [],
      { precipitation: 0 },
      stations
    );
    assert.strictEqual(res.length, 0);
  });

  await test('Handles edge cases: currentSpeed > freeFlowSpeed and freeFlowSpeed = 0', () => {
    const res = predictDeployments(
      [
        { ...baseJunction, id: 'J_FAST', currentSpeed: 55, freeFlowSpeed: 45 },
        { ...baseJunction, id: 'J_ZERO', currentSpeed: 0, freeFlowSpeed: 0 }
      ],
      [],
      { precipitation: 0 },
      stations
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
      stations
    );
    assert.strictEqual(res.length, 1);
    assert.strictEqual(res[0].severity, 'HIGH');
    assert.strictEqual(res[0].badge, 'Clearing Needed');
    assert.strictEqual(res[0].action, 'Road Clearing Needed');
    assert(res[0].nearestStation && res[0].nearestStation.shortName === 'Sitabuldi PS');
  });

  await test('Roadworks incident within 500m triggers Road Clearing Needed (HIGH); >500m is ignored', () => {
    const nearInc = [{ lat: 21.1462, lng: 79.0884, iconCategory: 9, description: 'Roadworks' }];
    const farInc = [{ lat: 21.16, lng: 79.11, iconCategory: 9, description: 'Far roadworks' }];

    const nearRes = predictDeployments(
      [{ ...baseJunction, currentSpeed: 38, freeFlowSpeed: 45 }],
      nearInc,
      { precipitation: 0 },
      stations
    );
    assert.strictEqual(nearRes.length, 1);
    assert.strictEqual(nearRes[0].action, 'Road Clearing Needed');

    const farRes = predictDeployments(
      [{ ...baseJunction, currentSpeed: 38, freeFlowSpeed: 45 }],
      farInc,
      { precipitation: 0 },
      stations
    );
    assert.strictEqual(farRes.length, 0);
  });

  await test('Rainfall >= 5 mm/hr with >= 50% congestion triggers Road Clearing Needed (HIGH)', () => {
    const highRainRes = predictDeployments(
      [{ ...baseJunction, currentSpeed: 20, freeFlowSpeed: 45 }],
      [],
      { precipitation: 6.2 },
      stations
    );
    assert.strictEqual(highRainRes.length, 1);
    assert.strictEqual(highRainRes[0].severity, 'HIGH');
    assert.strictEqual(highRainRes[0].action, 'Road Clearing Needed');

    const lightCongestionRes = predictDeployments(
      [{ ...baseJunction, currentSpeed: 30, freeFlowSpeed: 45 }],
      [],
      { precipitation: 6.2 },
      stations
    );
    assert.strictEqual(lightCongestionRes.length, 0);
  });

  await test('Accident/breakdown within 500m or congestion >= 60% triggers Traffic Officer Needed (HIGH)', () => {
    const accRes = predictDeployments(
      [{ ...baseJunction, currentSpeed: 38, freeFlowSpeed: 45 }],
      [{ lat: 21.1459, lng: 79.0885, iconCategory: 1, description: 'Accident' }],
      { precipitation: 0 },
      stations
    );
    assert.strictEqual(accRes.length, 1);
    assert.strictEqual(accRes[0].severity, 'HIGH');
    assert.strictEqual(accRes[0].badge, 'Officer Needed');

    const jamRes = predictDeployments(
      [{ ...baseJunction, currentSpeed: 15, freeFlowSpeed: 45 }],
      [],
      { precipitation: 0 },
      stations
    );
    assert.strictEqual(jamRes.length, 1);
    assert.strictEqual(jamRes[0].severity, 'HIGH');
    assert.strictEqual(jamRes[0].action, 'Traffic Officer Needed');
    assert(jamRes[0].nearestStation);
  });

  await test('Congestion 40%-59% triggers Standby / Monitor (MEDIUM) without station dispatch', () => {
    const res = predictDeployments(
      [{ ...baseJunction, currentSpeed: 25, freeFlowSpeed: 45 }],
      [],
      { precipitation: 0 },
      stations
    );
    assert.strictEqual(res.length, 1);
    assert.strictEqual(res[0].severity, 'MEDIUM');
    assert.strictEqual(res[0].badge, 'Monitor');
    assert.strictEqual(res[0].nearestStation, null);
  });

  await test('Alerts sort HIGH before MEDIUM and by congestionPct descending', () => {
    const res = predictDeployments(
      [
        { ...baseJunction, id: 'MED', name: 'Med', currentSpeed: 24, freeFlowSpeed: 45 },
        { ...baseJunction, id: 'HIGH_65', name: 'High65', currentSpeed: 16, freeFlowSpeed: 45 },
        { ...baseJunction, id: 'HIGH_80', name: 'High80', currentSpeed: 9, freeFlowSpeed: 45 }
      ],
      [],
      { precipitation: 0 },
      stations
    );
    assert.deepStrictEqual(
      res.map((r) => r.id),
      ['HIGH_80', 'HIGH_65', 'MED']
    );
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

    await test('GET /tiles/traffic/abc/0/0.png returns 400 for invalid tile coords', async () => {
      const res = await fetch(`${baseUrl}/tiles/traffic/abc/0/0.png`);
      assert.strictEqual(res.status, 400);
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
