'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DEFAULT_THRESHOLDS, validateCityConfig } = require('../src/citySchema');
const { DEFAULT_CITY_ID, getCity, hasCity, listCities, loadCityRegistry } = require('../src/cityRegistry');

const rootDir = path.join(__dirname, '..');

function makeValidCityFixture(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'testcity',
    name: 'Test City',
    country: 'IN',
    timezone: 'Asia/Kolkata',
    locale: 'en-IN',
    status: 'experimental',
    map: {
      center: { lat: 18.52, lng: 73.85 },
      zoom: 12,
      minZoom: 10,
      maxZoom: 18,
      bbox: { south: 18.4, west: 73.7, north: 18.65, east: 74.0 }
    },
    search: { biasRadiusM: 25000 },
    landmarks: [
      { id: 'center', label: 'Center', lat: 18.52, lng: 73.85 }
    ],
    junctions: [
      { id: 'J001', name: 'Main Square', lat: 18.52, lng: 73.85, key: true }
    ],
    policeStations: [],
    sources: {
      junctions: 'Synthetic test fixture',
      policeStations: 'None',
      retrievedOn: '2026-11-25',
      licence: 'CC0-1.0'
    },
    ...overrides
  };
}

test('config/cities/nagpur.json passes citySchema and preserves exact parity with migrated Nagpur baseline', () => {
  const raw = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'config', 'cities', 'nagpur.json'), 'utf8')
  );
  const res = validateCityConfig(raw, { expectedId: 'nagpur' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.warnings, []);
  const city = res.data;

  // Center, map bbox, routeBbox, search, incidents, view literals
  assert.deepEqual(city.map.center, { lat: 21.1458, lng: 79.0882 });
  assert.equal(city.map.zoom, 13);
  assert.deepEqual(city.map.bbox, { south: 21.05, west: 78.95, north: 21.25, east: 79.2 });
  assert.deepEqual(city.routeBbox, { south: 20.5, west: 78.4, north: 21.8, east: 79.8 });
  assert.deepEqual(city.search, { biasRadiusM: 25000, countrySet: 'IN' });
  assert.deepEqual(city.incidents, { language: 'en-GB' });
  assert.equal(city.tomtomView, 'IN');
  assert.deepEqual(city.thresholds, DEFAULT_THRESHOLDS);

  // Landmarks, junctions, stations counts, ID ranges & (id, lat, lng) checksums
  assert.equal(city.landmarks.length, 5);
  assert.equal(city.junctions.length, 50);
  assert.equal(city.junctions.filter((j) => j.key === true).length, 16);
  assert.equal(city.junctions[0].id, 'J001');
  assert.equal(city.junctions[city.junctions.length - 1].id, 'J050');

  assert.equal(city.policeStations.length, 10);
  assert.equal(city.policeStations[0].id, 'PS01');
  assert.equal(city.policeStations[city.policeStations.length - 1].id, 'PS10');

  const junctionChecksum = crypto
    .createHash('sha256')
    .update(JSON.stringify(city.junctions.map((j) => [j.id, j.lat, j.lng])))
    .digest('hex');
  const stationChecksum = crypto
    .createHash('sha256')
    .update(JSON.stringify(city.policeStations.map((s) => [s.id, s.lat, s.lng])))
    .digest('hex');

  assert.equal(
    junctionChecksum,
    'e3828e516902a050ac9f8cb6197f858f6f5cd0e15b7468739982a0bd584151ff'
  );
  assert.equal(
    stationChecksum,
    '9d338694ff71c7510060aef6ce1d6515ad8283631a09c9a4e6f6448cc77a954c'
  );
});

test('citySchema rejects invalid structures, geo bounds, IDs, counts, and unknown keys', () => {
  const base = makeValidCityFixture();

  // Defaults work cleanly when optional fields omitted
  const validMinimal = validateCityConfig(base, { expectedId: 'testcity' });
  assert.equal(validMinimal.ok, true);
  assert.equal(validMinimal.data.tomtomView, 'IN');
  assert.deepEqual(validMinimal.data.routeBbox, base.map.bbox);
  assert.equal(validMinimal.data.search.countrySet, 'IN');
  assert.equal(validMinimal.data.incidents.language, 'en-GB');
  assert.equal(validMinimal.warnings.length, 1);

  // Unknown key rejected (.strict)
  const unknownKey = validateCityConfig({ ...base, extraField: 123 }, { expectedId: 'testcity' });
  assert.equal(unknownKey.ok, false);

  // Bad id slug & id/filename mismatch
  assert.equal(validateCityConfig({ ...base, id: 'Bad_ID' }).ok, false);
  const mismatch = validateCityConfig(base, { expectedId: 'othercity' });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.issues[0].path, 'id');

  // Inverted bbox
  const badBbox = validateCityConfig({
    ...base,
    map: { ...base.map, bbox: { south: 18.7, west: 73.7, north: 18.6, east: 74.0 } }
  });
  assert.equal(badBbox.ok, false);

  // Point outside bbox
  const outPoint = validateCityConfig({
    ...base,
    junctions: [{ id: 'J001', name: 'Far Away', lat: 19.5, lng: 73.85, key: true }]
  });
  assert.equal(outPoint.ok, false);
  assert.equal(outPoint.issues.some((i) => i.path === 'junctions.0'), true);

  // routeBbox not enclosing map.bbox
  const smallRoute = validateCityConfig({
    ...base,
    routeBbox: { south: 18.45, west: 73.75, north: 18.6, east: 73.95 }
  });
  assert.equal(smallRoute.ok, false);
  assert.equal(smallRoute.issues.some((i) => i.path === 'routeBbox'), true);

  // Duplicate IDs
  const dupIds = validateCityConfig({
    ...base,
    junctions: [
      { id: 'J001', name: 'A', lat: 18.52, lng: 73.85, key: true },
      { id: 'J001', name: 'B', lat: 18.53, lng: 73.86 }
    ]
  });
  assert.equal(dupIds.ok, false);
  assert.equal(dupIds.issues.some((i) => i.path === 'junctions.1.id'), true);

  // Zero key junctions rejected
  const noKey = validateCityConfig({
    ...base,
    junctions: [{ id: 'J001', name: 'Main Square', lat: 18.52, lng: 73.85, key: false }]
  });
  assert.equal(noKey.ok, false);

  // Oversized junctions array (>200) rejected
  const oversized = Array.from({ length: 201 }, (_, i) => ({
    id: `J${String(i + 1).padStart(3, '0')}`,
    name: `Junction ${i + 1}`,
    lat: 18.52,
    lng: 73.85,
    key: i === 0 ? true : undefined
  }));
  assert.equal(validateCityConfig({ ...base, junctions: oversized }).ok, false);

  // Bad thresholds (NaN / monitor > officer)
  const badThresholds = validateCityConfig({
    ...base,
    thresholds: { monitorCongestionPct: 70, officerCongestionPct: 50 }
  });
  assert.equal(badThresholds.ok, false);
});

test('cityRegistry freezes configs, blocks path traversal / prototype lookups, and fails closed on invalid CITY or JSON', () => {
  const defaultCity = getCity(DEFAULT_CITY_ID);
  assert.ok(defaultCity);
  assert.equal(defaultCity.id, 'nagpur');
  assert.equal(listCities().length >= 1, true);

  // Deep freeze prevents accidental runtime mutations
  assert.equal(Object.isFrozen(defaultCity), true);
  assert.equal(Object.isFrozen(defaultCity.junctions), true);
  assert.equal(Object.isFrozen(defaultCity.junctions[0]), true);
  assert.equal(Object.isFrozen(defaultCity.thresholds), true);
  assert.throws(() => {
    defaultCity.junctions.sort(() => 0);
  }, TypeError);

  // Path-like & prototype pollution lookups must return undefined / false cleanly
  for (const evil of ['../../etc/passwd', 'nagpur%2f..', '__proto__', 'constructor', 'toString']) {
    assert.equal(hasCity(evil), false);
    assert.equal(getCity(evil), undefined);
  }

  // Exact CITY match enforcement + temp dir fail-closed behavior
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ngp-city-reg-'));
  try {
    // Empty dir -> fail closed
    assert.throws(() => loadCityRegistry({ citiesDir: tmpDir }), /no city config files/i);

    const nagpurRaw = JSON.parse(
      fs.readFileSync(path.join(rootDir, 'config', 'cities', 'nagpur.json'), 'utf8')
    );
    fs.writeFileSync(path.join(tmpDir, 'nagpur.json'), JSON.stringify(nagpurRaw), 'utf8');
    // Ignored template file must not crash loader
    fs.writeFileSync(path.join(tmpDir, '_template.json'), '{not json', 'utf8');

    // Default / exact match succeeds; case/whitespace mismatch or unknown id fails closed
    assert.equal(loadCityRegistry({ citiesDir: tmpDir, envCity: undefined }).defaultCityId, 'nagpur');
    assert.equal(loadCityRegistry({ citiesDir: tmpDir, envCity: '' }).defaultCityId, 'nagpur');
    assert.equal(loadCityRegistry({ citiesDir: tmpDir, envCity: 'nagpur' }).defaultCityId, 'nagpur');
    assert.throws(() => loadCityRegistry({ citiesDir: tmpDir, envCity: 'NAGPUR' }), /CITY=/);
    assert.throws(() => loadCityRegistry({ citiesDir: tmpDir, envCity: ' nagpur ' }), /CITY=/);
    assert.throws(() => loadCityRegistry({ citiesDir: tmpDir, envCity: 'unknown' }), /CITY=/);
    assert.throws(() => loadCityRegistry({ citiesDir: tmpDir, envCity: '__proto__' }), /CITY=/);

    // Invalid JSON file fails closed
    fs.writeFileSync(path.join(tmpDir, 'broken.json'), '{bad json', 'utf8');
    assert.throws(() => loadCityRegistry({ citiesDir: tmpDir }), /invalid JSON/i);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('removed mock files remain absent and README/app.js stay aligned', () => {
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
    assert.equal(fs.existsSync(path.join(rootDir, rel)), false, `${rel} should not exist`);
  }

  const readme = fs.readFileSync(path.join(rootDir, 'README.md'), 'utf8');
  assert.equal(readme.includes('150 m'), true);
  assert.equal(readme.includes('within 500 m'), false);

  const appJs = fs.readFileSync(path.join(rootDir, 'public', 'js', 'app.js'), 'utf8');
  const lightMatch = appJs.match(/light:\s*'([^']+)'/);
  const darkMatch = appJs.match(/dark:\s*'([^']+)'/);
  assert.ok(lightMatch && darkMatch);
  assert.notEqual(lightMatch[1], darkMatch[1]);
});
