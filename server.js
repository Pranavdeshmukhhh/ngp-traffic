const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const { RandomForest, extractFeatures, FEATURE_NAMES } = require('./ml-engine');
const routing = require('./routing-engine');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Load data
const junctions = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'nagpur-junctions.json'), 'utf8'));
const stations = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'police-stations.json'), 'utf8'));
const officers = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'officers.json'), 'utf8'));
const presetIncidents = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'preset-incidents.json'), 'utf8'));
const roadSegments = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'road-segments.json'), 'utf8'));

let activeIncidents = [];
let manualOverrides = {};
let officerStatuses = {}; // track officer accept/en-route/resolved

// ── Train ML Model ──
console.log('\n  [NGP-TRAFFIC] Initializing...');
const mlModel = new RandomForest();
mlModel.train(junctions);

// ── Build Road Graph ──
console.log('  [ROUTING] Building road network graph...');
const roadGraph = routing.buildGraph(junctions, roadSegments);
console.log('  [ROUTING] Graph built: ' + Object.keys(roadGraph).length + ' nodes');

// ── Utility ──
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── Risk Scoring (hybrid: heuristic + ML) ──
function calcRiskScore(junction, hour, incidents) {
  hour = hour || 14;
  incidents = incidents || [];
  var dayOfWeek = new Date().getDay();
  var rainMM = 0; // could be real-time weather API
  var incidentWeight = 0;
  incidents.forEach(function(inc) {
    var dist = haversine(junction.lat, junction.lng, inc.lat, inc.lng);
    if (dist < (inc.affectedRadius || 800)) {
      incidentWeight = Math.max(incidentWeight, inc.severity === 'high' ? 1 : 0.7);
    }
  });
  // ML prediction
  var features = extractFeatures(junction, hour, dayOfWeek, rainMM, incidentWeight);
  var mlScore = mlModel.predict(features);

  // Heuristic fallback
  const maxAccidents = 30;
  const accidentNorm = Math.min(junction.accidentHistory / maxAccidents, 1) * 100;
  const hourVol = junction.trafficByHour[hour] || 0;
  const maxHourVol = Math.max.apply(null, junction.trafficByHour);
  const trafficNorm = (hourVol / (maxHourVol || 1)) * 100;
  const roadTypeScores = { major_intersection: 100, highway_entry: 85, school_zone: 90, commercial: 70, landmark_junction: 65, minor: 40 };
  const roadFactor = roadTypeScores[junction.roadType] || 50;
  var timeFactor;
  if ((hour >= 8 && hour <= 10) || (hour >= 17 && hour <= 19)) timeFactor = 100;
  else if (hour >= 22 || hour <= 5) timeFactor = 70;
  else if (hour >= 11 && hour <= 16) timeFactor = 55;
  else timeFactor = 40;
  const pedScores = { high: 100, medium: 60, low: 20 };
  const pedFactor = pedScores[junction.pedestrianDensity] || 40;
  var proxFactor = 0;
  if (junction.nearSchool) proxFactor += 60;
  if (junction.nearHospital) proxFactor += 40;
  proxFactor = Math.min(proxFactor, 100);
  var incidentBoost = incidentWeight * 100;
  var heuristicScore = Math.round(0.30*accidentNorm + 0.25*trafficNorm + 0.15*roadFactor + 0.10*timeFactor + 0.10*pedFactor + 0.05*proxFactor + 0.05*incidentBoost);

  // Ensemble: 60% ML, 40% heuristic
  var ensembleScore = Math.round(0.6 * mlScore + 0.4 * heuristicScore);
  ensembleScore = Math.min(ensembleScore, 100);

  return {
    total: ensembleScore,
    mlScore: mlScore,
    heuristicScore: Math.min(heuristicScore, 100),
    breakdown: {
      accidentHistory: { score: Math.round(0.30*accidentNorm), max: 30, raw: junction.accidentHistory },
      trafficVolume: { score: Math.round(0.25*trafficNorm), max: 25, raw: hourVol },
      roadType: { score: Math.round(0.15*roadFactor), max: 15, raw: junction.roadType },
      timeOfDay: { score: Math.round(0.10*timeFactor), max: 10, raw: hour },
      pedestrian: { score: Math.round(0.10*pedFactor), max: 10, raw: junction.pedestrianDensity },
      proximity: { score: Math.round(0.05*proxFactor), max: 5, raw: (junction.nearSchool ? 'School ' : '') + (junction.nearHospital ? 'Hospital' : '') || 'None' },
      incident: { score: Math.round(0.05*incidentBoost), max: 5, raw: incidentWeight > 0 ? 'Active nearby' : 'None' }
    },
    level: ensembleScore >= 70 ? 'high' : ensembleScore >= 40 ? 'medium' : 'low'
  };
}

// ── Allocation ──
function allocateOfficers(scoredJunctions, numOfficers, overrides) {
  overrides = overrides || {};
  var sorted = scoredJunctions.slice().sort(function(a,b){ return b.risk.total - a.risk.total; });
  var assignments = {};
  var available = officers.slice(0, numOfficers);
  Object.keys(overrides).forEach(function(junctionId) {
    var offIdx = available.findIndex(function(o){ return o.id === overrides[junctionId]; });
    if (offIdx !== -1) { assignments[junctionId] = available.splice(offIdx, 1)[0]; }
  });
  sorted.forEach(function(j) {
    if (!assignments[j.id] && available.length > 0) { assignments[j.id] = available.shift(); }
  });
  return assignments;
}

function getBaselineDeployment() {
  var baseline = {};
  junctions.forEach(function(j) {
    if (j.baselineOfficer) {
      var off = officers.find(function(o){ return o.id === j.baselineOfficer; });
      if (off) baseline[j.id] = off;
    }
  });
  return baseline;
}

// ── API Routes ──
app.get('/api/junctions', function(req, res) { res.json(junctions); });
app.get('/api/stations', function(req, res) { res.json(stations); });
app.get('/api/officers', function(req, res) { res.json(officers); });
app.get('/api/preset-incidents', function(req, res) { res.json(presetIncidents); });
app.get('/api/road-segments', function(req, res) { res.json(roadSegments); });

app.get('/api/ml/metrics', function(req, res) {
  res.json({
    metrics: mlModel.metrics,
    featureImportance: mlModel.featureImportance,
    featureNames: FEATURE_NAMES,
    modelType: 'Gradient Boosted Ensemble (50 stumps, lr=0.15)',
    trainingInfo: { samples: mlModel.metrics ? mlModel.metrics.trainSize : 0, features: FEATURE_NAMES.length, trees: 15 }
  });
});

app.get('/api/risk-scores', function(req, res) {
  var hour = parseInt(req.query.hour) || 14;
  var scored = junctions.map(function(j){ return Object.assign({}, j, { risk: calcRiskScore(j, hour, activeIncidents) }); });
  scored.sort(function(a,b){ return b.risk.total - a.risk.total; });
  res.json(scored);
});

app.get('/api/allocation', function(req, res) {
  var hour = parseInt(req.query.hour) || 14;
  var numOfficers = parseInt(req.query.officers) || 25;
  var queryIncidents = req.query.incidents ? JSON.parse(decodeURIComponent(req.query.incidents)) : null;
  var effectiveIncidents = queryIncidents ? queryIncidents : activeIncidents;
  var scored = junctions.map(function(j){ return Object.assign({}, j, { risk: calcRiskScore(j, hour, effectiveIncidents) }); });
  scored.sort(function(a,b){ return b.risk.total - a.risk.total; });
  var optimized = allocateOfficers(scored, numOfficers, manualOverrides);
  var baseline = getBaselineDeployment();
  var unmanned = scored.filter(function(j){ return !optimized[j.id] && j.risk.level === 'high'; });
  var highMed = scored.filter(function(j){ return j.risk.level !== 'low'; });
  var optHighMed = Object.keys(optimized).filter(function(jid){ var j = scored.find(function(s){ return s.id === jid; }); return j && j.risk.level !== 'low'; });
  var stats = {
    totalJunctions: scored.length,
    highRisk: scored.filter(function(j){ return j.risk.level === 'high'; }).length,
    mediumRisk: scored.filter(function(j){ return j.risk.level === 'medium'; }).length,
    lowRisk: scored.filter(function(j){ return j.risk.level === 'low'; }).length,
    officersDeployed: Object.keys(optimized).length,
    officersTotal: numOfficers,
    unmannedHighRisk: unmanned.length,
    baselineCoverage: Math.round(Object.keys(baseline).length / Math.max(highMed.length,1) * 100),
    optimizedCoverage: Math.round(optHighMed.length / Math.max(highMed.length,1) * 100),
    avgRiskScore: Math.round(scored.reduce(function(s,j){ return s + j.risk.total; }, 0) / scored.length)
  };
  res.json({ junctions: scored, optimizedDeployment: optimized, baselineDeployment: baseline, unmannedHighRisk: unmanned, stats: stats, activeIncidents: effectiveIncidents });
});

app.get('/api/baseline', function(req, res) { res.json(getBaselineDeployment()); });

app.get('/api/route', function(req, res) {
  var from = req.query.from;
  var to = req.query.to;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  var route = routing.dijkstra(roadGraph, from, to);
  if (!route) return res.json({ error: 'No route found', from: from, to: to });
  // Add lat/lng for each path junction
  route.path = route.path.map(function(p) {
    var j = junctions.find(function(jj) { return jj.id === p.junction; });
    return Object.assign({}, p, { lat: j ? j.lat : 0, lng: j ? j.lng : 0, name: j ? j.name : p.junction });
  });
  res.json(route);
});

app.get('/api/nearest-station', function(req, res) {
  var junctionId = req.query.junction;
  if (!junctionId) return res.status(400).json({ error: 'junction required' });
  var results = routing.findNearestStation(stations, junctions, roadGraph, junctionId);
  res.json(results.slice(0, 3));
});

app.get('/api/officer-statuses', function(req, res) {
  res.json(officerStatuses);
});

// ── Incident (POST from Citizen App or Simulation) ──
app.post('/api/incident', function(req, res) {
  var b = req.body;
  var incident = {
    id: 'INC_' + Date.now(),
    name: b.name || 'Incident',
    type: b.type || 'accident',
    lat: b.lat, lng: b.lng,
    severity: b.severity || 'high',
    affectedRadius: b.severity === 'high' ? 800 : 500,
    description: b.description || 'Reported incident',
    reportedBy: b.reportedBy || 'Control Room',
    timestamp: new Date().toISOString(),
    resolved: false
  };
  activeIncidents.push(incident);

  // Recalculate deployment
  var hour = parseInt(req.query.hour) || new Date().getHours();
  var numOfficers = parseInt(req.query.officers) || 25;
  var scored = junctions.map(function(j){ return Object.assign({}, j, { risk: calcRiskScore(j, hour, activeIncidents) }); });
  scored.sort(function(a,b){ return b.risk.total - a.risk.total; });
  var redeployment = allocateOfficers(scored, numOfficers, manualOverrides);

  // Find nearest junction and dispatch info
  var nearestJ = routing.findNearestJunction(junctions, incident.lat, incident.lng);
  var dispatchInfo = null;
  if (nearestJ && redeployment[nearestJ.id]) {
    var officer = redeployment[nearestJ.id];
    var eta = routing.calcOfficerETA(officer.station, nearestJ.id, stations, junctions, roadGraph);
    dispatchInfo = {
      officer: officer,
      junction: nearestJ,
      eta: eta ? eta.totalTime : null,
      route: eta
    };
    officerStatuses[officer.id] = { status: 'dispatched', junction: nearestJ.id, junctionName: nearestJ.name, incident: incident.id, eta: eta ? eta.totalTime : null, timestamp: new Date().toISOString() };
  }

  var payload = { incident: incident, redeployment: redeployment, junctions: scored, dispatch: dispatchInfo };

  // Broadcast to all connected clients
  io.emit('incident:new', payload);
  io.emit('deployment:update', { redeployment: redeployment, junctions: scored, activeIncidents: activeIncidents });

  res.json(payload);
});

app.post('/api/incident/resolve', function(req, res) {
  var incId = req.body.id;
  activeIncidents = activeIncidents.filter(function(i){ return i.id !== incId; });
  // Clear officer statuses related to this incident
  Object.keys(officerStatuses).forEach(function(offId) {
    if (officerStatuses[offId].incident === incId) { officerStatuses[offId] = { status: 'available', timestamp: new Date().toISOString() }; }
  });
  io.emit('incident:resolved', { id: incId, activeIncidents: activeIncidents });
  res.json({ success: true, activeIncidents: activeIncidents });
});

app.post('/api/incident/clear', function(req, res) {
  activeIncidents = [];
  officerStatuses = {};
  io.emit('incidents:cleared', {});
  res.json({ success: true });
});

app.post('/api/officer/accept', function(req, res) {
  var offId = req.body.officerId;
  if (officerStatuses[offId]) {
    officerStatuses[offId].status = 'en-route';
    officerStatuses[offId].acceptedAt = new Date().toISOString();
    io.emit('officer:status', { officerId: offId, status: officerStatuses[offId] });
  }
  res.json({ success: true, status: officerStatuses[offId] });
});

app.post('/api/officer/arrived', function(req, res) {
  var offId = req.body.officerId;
  if (officerStatuses[offId]) {
    officerStatuses[offId].status = 'on-scene';
    officerStatuses[offId].arrivedAt = new Date().toISOString();
    io.emit('officer:status', { officerId: offId, status: officerStatuses[offId] });
  }
  res.json({ success: true, status: officerStatuses[offId] });
});

app.post('/api/override', function(req, res) { if (req.body.officerId) { manualOverrides[req.body.junctionId] = req.body.officerId; } else { delete manualOverrides[req.body.junctionId]; } res.json({ success: true, overrides: manualOverrides }); });
app.post('/api/override/clear', function(req, res) { manualOverrides = {}; res.json({ success: true }); });

// ── Socket.IO ──
io.on('connection', function(socket) {
  console.log('  [WS] Client connected: ' + socket.id);
  socket.emit('init', { activeIncidents: activeIncidents, officerStatuses: officerStatuses });
  socket.on('disconnect', function() { console.log('  [WS] Client disconnected: ' + socket.id); });
});

// ── Start ──
server.listen(PORT, function() {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║  NGP-TRAFFIC Server v2.0                    ║');
  console.log('  ║  http://localhost:' + PORT + '                      ║');
  console.log('  ╠══════════════════════════════════════════════╣');
  console.log('  ║  Command Center:  /                         ║');
  console.log('  ║  Citizen App:     /citizen.html              ║');
  console.log('  ║  Officer App:     /officer.html              ║');
  console.log('  ║  Simulation Lab:  /simulation.html           ║');
  console.log('  ╠══════════════════════════════════════════════╣');
  console.log('  ║  Data: ' + junctions.length + ' junctions, ' + officers.length + ' officers, ' + stations.length + ' stations  ║');
  console.log('  ║  ML Model: Gradient Boosted (50 rounds)         ║');
  console.log('  ║  WebSocket: Active                          ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');
});