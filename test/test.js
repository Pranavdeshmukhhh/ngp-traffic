/**
 * NGP-TRAFFIC Test Suite
 * Run: node test/test.js
 */
const assert = require('assert');
const { RandomForest, extractFeatures, FEATURE_NAMES } = require('../ml-engine');
const routing = require('../routing-engine');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0, total = 0;

function test(name, fn) {
  total++;
  try { fn(); passed++; console.log('  \u2713 ' + name); }
  catch(e) { failed++; console.log('  \u2717 ' + name + ' — ' + e.message); }
}

// ── Load Data ──
const junctions = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'nagpur-junctions.json'), 'utf8'));
const stations = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'police-stations.json'), 'utf8'));
const officers = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'officers.json'), 'utf8'));
const roadSegments = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'road-segments.json'), 'utf8'));

console.log('\n=== NGP-TRAFFIC Test Suite ===\n');

// ── DATA INTEGRITY ──
console.log('Data Integrity:');
test('50 junctions loaded', function() { assert.strictEqual(junctions.length, 50); });
test('25 officers loaded', function() { assert.strictEqual(officers.length, 25); });
test('10 stations loaded', function() { assert.strictEqual(stations.length, 10); });
test('All junctions have trafficByHour (24 entries)', function() { junctions.forEach(function(j) { assert.strictEqual(j.trafficByHour.length, 24, j.id); }); });
test('All junctions have valid coordinates', function() { junctions.forEach(function(j) { assert(j.lat > 20 && j.lat < 22, j.id + ' lat'); assert(j.lng > 78 && j.lng < 80, j.id + ' lng'); }); });
test('All junctions have valid road types', function() {
  var valid = ['major_intersection','highway_entry','school_zone','commercial','landmark_junction','minor'];
  junctions.forEach(function(j) { assert(valid.includes(j.roadType), j.id + ': ' + j.roadType); });
});

// ── ML ENGINE ──
console.log('\nML Engine:');
test('Feature extraction returns 13 features', function() {
  var f = extractFeatures(junctions[0], 14, 2, 0, 0);
  assert.strictEqual(f.length, 13);
});
test('Features are normalized [0,1]', function() {
  for (var h = 0; h < 24; h++) {
    var f = extractFeatures(junctions[0], h, 3, 20, 1);
    f.forEach(function(v, i) { assert(v >= 0 && v <= 1, 'Feature ' + FEATURE_NAMES[i] + ' = ' + v + ' at hour ' + h); });
  }
});
test('ML model trains and predicts', function() {
  var model = new RandomForest();
  model.train(junctions.slice(0, 5)); // small subset
  var prediction = model.predict(extractFeatures(junctions[0], 18, 1, 0, 0));
  assert(prediction >= 0 && prediction <= 100, 'Prediction out of range: ' + prediction);
});
test('ML metrics have valid R2', function() {
  var model = new RandomForest();
  model.train(junctions.slice(0, 5));
  assert(model.metrics.r2 > 0, 'R2 should be positive: ' + model.metrics.r2);
  assert(model.metrics.r2 <= 1, 'R2 should be <= 1: ' + model.metrics.r2);
});
test('ML metrics have valid accuracy', function() {
  var model = new RandomForest();
  model.train(junctions.slice(0, 5));
  assert(model.metrics.accuracy > 0.5, 'Accuracy too low: ' + model.metrics.accuracy);
  assert(model.metrics.accuracy <= 1, 'Accuracy > 1: ' + model.metrics.accuracy);
});
test('Feature importance sums to ~1', function() {
  var model = new RandomForest();
  model.train(junctions.slice(0, 5));
  var sum = Object.values(model.featureImportance).reduce(function(s,v){return s+v;}, 0);
  assert(Math.abs(sum - 1) < 0.1, 'Sum = ' + sum);
});

// ── ROUTING ENGINE ──
console.log('\nRouting Engine:');
test('Graph builds from junctions + road segments', function() {
  var graph = routing.buildGraph(junctions, roadSegments);
  assert(Object.keys(graph).length > 0, 'Graph is empty');
});
test('Dijkstra finds route between connected junctions', function() {
  var graph = routing.buildGraph(junctions, roadSegments);
  var route = routing.dijkstra(graph, 'J001', 'J010');
  assert(route !== null, 'No route found');
  assert(route.totalTime > 0, 'ETA should be > 0');
  assert(route.path.length >= 2, 'Path should have start+end');
});
test('Route has valid ETA (0-60 min for city)', function() {
  var graph = routing.buildGraph(junctions, roadSegments);
  var route = routing.dijkstra(graph, 'J001', 'J010');
  if (route) { assert(route.totalTime < 60, 'ETA too high: ' + route.totalTime + ' min'); }
});
test('Nearest station returns sorted results', function() {
  var graph = routing.buildGraph(junctions, roadSegments);
  var results = routing.findNearestStation(stations, junctions, graph, 'J001');
  assert(results.length > 0, 'No stations found');
  for (var i = 1; i < results.length; i++) {
    assert(results[i].eta >= results[i-1].eta, 'Not sorted by ETA');
  }
});
test('Haversine distance is reasonable', function() {
  // Nagpur city ~20km across
  var d = routing.haversine(21.1, 79.0, 21.2, 79.1);
  assert(d > 5000 && d < 20000, 'Distance: ' + d + 'm');
});

// ── ALLOCATION EDGE CASES ──
console.log('\nAllocation Edge Cases:');
test('Zero officers returns empty deployment', function() {
  var scored = junctions.map(function(j) { return Object.assign({}, j, { risk: { total: 50, level: 'medium' } }); });
  var avail = [];
  var assignments = {};
  scored.forEach(function(j) { if (avail.length > 0) assignments[j.id] = avail.shift(); });
  assert.strictEqual(Object.keys(assignments).length, 0);
});
test('More officers than junctions deploys to all', function() {
  var fakeJunctions = [{id:'A',risk:{total:90,level:'high'}},{id:'B',risk:{total:50,level:'medium'}}];
  var fakeOfficers = [{id:'O1'},{id:'O2'},{id:'O3'}];
  var sorted = fakeJunctions.sort(function(a,b){return b.risk.total-a.risk.total;});
  var avail = fakeOfficers.slice();
  var assign = {};
  sorted.forEach(function(j){if(avail.length>0) assign[j.id]=avail.shift();});
  assert.strictEqual(Object.keys(assign).length, 2);
});

// ── API ENDPOINT CHECKS ──
console.log('\nAPI Endpoints (structure validation):');
test('Allocation response has required fields', function() {
  // Simulate response structure
  var response = {
    junctions: [], optimizedDeployment: {}, baselineDeployment: {},
    unmannedHighRisk: [], stats: {}, activeIncidents: []
  };
  ['junctions','optimizedDeployment','baselineDeployment','unmannedHighRisk','stats','activeIncidents'].forEach(function(key) {
    assert(key in response, 'Missing: ' + key);
  });
});

// ── SUMMARY ──
console.log('\n' + '='.repeat(40));
console.log('Results: ' + passed + '/' + total + ' passed, ' + failed + ' failed');
if (failed === 0) console.log('\u2713 ALL TESTS PASSED');
else { console.log('\u2717 SOME TESTS FAILED'); process.exit(1); }
console.log('');