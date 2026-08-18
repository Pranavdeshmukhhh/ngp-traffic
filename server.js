const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { RandomForest, extractFeatures, FEATURE_NAMES } = require('./ml-engine');
const routing = require('./routing-engine');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '5mb' })); // larger limit for photo uploads
app.use(express.static(path.join(__dirname, 'public')));

// Load data
const junctions = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'nagpur-junctions.json'), 'utf8'));
const stations = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'police-stations.json'), 'utf8'));
const officers = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'officers.json'), 'utf8'));
const presetIncidents = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'preset-incidents.json'), 'utf8'));
const roadSegments = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'road-segments.json'), 'utf8'));
const officerCredentials = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'officer-credentials.json'), 'utf8'));

let activeIncidents = [];
let manualOverrides = {};
let officerStatuses = {};

// === AUTH SECRET ===
const AUTH_SECRET = crypto.randomBytes(32).toString('hex');

function createToken(officerId, badgeNumber) {
  var payload = JSON.stringify({ officerId: officerId, badge: badgeNumber, iat: Date.now() });
  var sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
  return Buffer.from(payload).toString('base64') + '.' + sig;
}

function verifyToken(token) {
  if (!token) return null;
  var parts = token.split('.');
  if (parts.length !== 2) return null;
  try {
    var payload = Buffer.from(parts[0], 'base64').toString('utf8');
    var expectedSig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
    if (expectedSig !== parts[1]) return null;
    return JSON.parse(payload);
  } catch(e) { return null; }
}

function requireOfficerAuth(req, res, next) {
  var auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required' });
  var decoded = verifyToken(auth.substring(7));
  if (!decoded) return res.status(401).json({ error: 'Invalid or expired token' });
  req.officerId = decoded.officerId;
  req.badge = decoded.badge;
  next();
}

// === Train ML Model ===
console.log('\n  [NGP-TRAFFIC] Initializing...');
const mlModel = new RandomForest();
mlModel.train(junctions);

// === Build Road Graph ===
console.log('  [ROUTING] Building road network graph...');
const roadGraph = routing.buildGraph(junctions, roadSegments);
console.log('  [ROUTING] Graph built: ' + Object.keys(roadGraph).length + ' nodes');

// === Utility ===
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// === Location Verification ===
function verifyLocation(lat, lng) {
  // Check proximity to any road segment point or junction
  var minDist = Infinity;
  var nearestFeature = null;

  // Check junctions
  junctions.forEach(function(j) {
    var d = haversine(lat, lng, j.lat, j.lng);
    if (d < minDist) { minDist = d; nearestFeature = { type: 'junction', name: j.name, distance: d }; }
  });

  // Check road segment points
  roadSegments.forEach(function(seg) {
    seg.points.forEach(function(pt) {
      var d = haversine(lat, lng, pt[0], pt[1]);
      if (d < minDist) { minDist = d; nearestFeature = { type: 'road', name: seg.name, distance: d }; }
    });
  });

  return {
    verified: minDist < 300, // within 300m of known road/junction
    nearestFeature: nearestFeature,
    distanceToRoad: Math.round(minDist),
    confidence: minDist < 100 ? 'high' : minDist < 300 ? 'medium' : 'low'
  };
}

// === Risk Scoring (hybrid: heuristic + ML) ===
function calcRiskScore(junction, hour, incidents) {
  hour = hour || 14;
  incidents = incidents || [];
  var dayOfWeek = new Date().getDay();
  var rainMM = 0;
  var incidentWeight = 0;
  incidents.forEach(function(inc) {
    var dist = haversine(junction.lat, junction.lng, inc.lat, inc.lng);
    if (dist < (inc.affectedRadius || 800)) {
      incidentWeight = Math.max(incidentWeight, inc.severity === 'high' ? 1 : 0.7);
    }
  });
  var features = extractFeatures(junction, hour, dayOfWeek, rainMM, incidentWeight);
  var mlScore = mlModel.predict(features);

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

  var proximityBonus = 0;
  stations.forEach(function(s) { if (haversine(junction.lat, junction.lng, s.lat, s.lng) < 1500) proximityBonus = 10; });

  var incidentFactor = incidentWeight * 100;
  var heuristicScore = Math.round(0.25*accidentNorm + 0.20*trafficNorm + 0.15*roadFactor + 0.15*timeFactor + 0.10*pedFactor + 0.05*proximityBonus + 0.10*incidentFactor);
  var total = Math.round(0.6 * mlScore + 0.4 * heuristicScore);
  var level = total >= 70 ? 'high' : total >= 40 ? 'medium' : 'low';

  return {
    total: total, level: level, mlScore: mlScore, heuristicScore: heuristicScore,
    breakdown: {
      accidentHistory: { score: Math.round(accidentNorm*0.25), max: 25 },
      trafficVolume: { score: Math.round(trafficNorm*0.20), max: 20 },
      roadType: { score: Math.round(roadFactor*0.15), max: 15 },
      timeOfDay: { score: Math.round(timeFactor*0.15), max: 15 },
      pedestrian: { score: Math.round(pedFactor*0.10), max: 10 },
      proximity: { score: Math.round(proximityBonus*0.05), max: 5 },
      incident: { score: Math.round(incidentFactor*0.10), max: 10 }
    }
  };
}

// === Officer Allocation ===
function allocateOfficers(scored, numOfficers, overrides) {
  var deployment = {};
  scored.forEach(j => deployment[j.id] = []);
  var available = officers.slice(0, numOfficers);
  var jIdx = 0;
  available.forEach(o => {
    if (jIdx >= scored.length) jIdx = 0;
    deployment[scored[jIdx].id].push(o);
    jIdx++;
  });
  return deployment;
}
function allocateOfficers_OLD(scored, numOfficers, overrides) {
  var deployment = {};
  var available = officers.slice(0, numOfficers);
  var usedOfficerIds = {};
  Object.keys(overrides).forEach(function(jid) {
    var offId = overrides[jid];
    var off = available.find(function(o) { return o.id === offId; });
    if (off) { deployment[jid] = off; usedOfficerIds[offId] = true; }
  });
  var remaining = available.filter(function(o) { return !usedOfficerIds[o.id]; });
      scored.forEach(function(j) {
      if (j.risk.level === 'low') return; // Only deploy to high/medium risk junctions
      if (deployment[j.id] || remaining.length === 0) return;
    var nearest = null, minD = Infinity;
    remaining.forEach(function(o) {
      var st = stations.find(function(s) { return s.id === o.station; });
      if (!st) return;
      var d = haversine(j.lat, j.lng, st.lat, st.lng);
      if (d < minD) { minD = d; nearest = o; }
    });
    if (nearest) {
      deployment[j.id] = nearest;
      remaining = remaining.filter(function(o) { return o.id !== nearest.id; });
    }
  });
  return deployment;
}

function getBaselineDeployment() {
  var baseline = {};
  junctions.forEach(j => baseline[j.id] = []);
  var jIdx = 0;
  officers.forEach(o => {
    if (jIdx >= junctions.length) jIdx = 0;
    baseline[junctions[jIdx].id].push(o);
    jIdx++;
  });
  return baseline;
}
function getBaselineDeployment_OLD() {
  var baseline = {};
  officers.forEach(function(o) {
    var st = stations.find(function(s) { return s.id === o.station; });
    if (!st) return;
    var nearest = null, minD = Infinity;
    junctions.forEach(function(j) {
      var d = haversine(j.lat, j.lng, st.lat, st.lng);
      if (d < minD && !baseline[j.id]) { minD = d; nearest = j; }
    });
    if (nearest) baseline[nearest.id] = o;
  });
  return baseline;
}

// === OFFICER AUTH ENDPOINTS ===
app.post('/api/officer/login', function(req, res) {
  var badge = (req.body.badgeNumber || '').trim().toUpperCase();
  var pin = (req.body.pin || '').trim();
  if (!badge || !pin) return res.status(400).json({ error: 'Badge number and PIN required' });

  var cred = officerCredentials.find(function(c) { return c.badgeNumber === badge; });
  if (!cred) return res.status(401).json({ error: 'Invalid credentials' });

  var pinHash = crypto.createHash('sha256').update(pin).digest('hex');
  if (pinHash !== cred.pinHash) return res.status(401).json({ error: 'Invalid credentials' });

  var officer = officers.find(function(o) { return o.id === cred.officerId; });
  if (!officer) return res.status(500).json({ error: 'Officer record not found' });

  var token = createToken(cred.officerId, badge);
  var stationObj = stations.find(function(s) { return s.id === officer.station; });

  res.json({
    token: token,
    officer: {
      id: officer.id, name: officer.name, badge: badge,
      station: officer.station, stationName: stationObj ? stationObj.name : officer.station
    }
  });
});

app.get('/api/officer/me', requireOfficerAuth, function(req, res) {
  var officer = officers.find(function(o) { return o.id === req.officerId; });
  if (!officer) return res.status(404).json({ error: 'Officer not found' });
  var stationObj = stations.find(function(s) { return s.id === officer.station; });
  var status = officerStatuses[req.officerId] || { status: 'available' };

  // Get current assignment if any
  var hour = new Date().getHours();
  var scored = junctions.map(function(j) { return Object.assign({}, j, { risk: calcRiskScore(j, hour, activeIncidents) }); });
  scored.sort(function(a, b) { return b.risk.total - a.risk.total; });
  var deployment = allocateOfficers(scored, 25, manualOverrides);
  var assignedJunction = null;
  Object.keys(deployment).forEach(function(jid) {
    if (deployment[jid].id === req.officerId) {
      assignedJunction = scored.find(function(j) { return j.id === jid; });
    }
  });

  res.json({
    officer: { id: officer.id, name: officer.name, badge: req.badge, station: officer.station, stationName: stationObj ? stationObj.name : '' },
    status: status,
    assignment: assignedJunction ? {
      junctionId: assignedJunction.id,
      junctionName: assignedJunction.name,
      riskScore: assignedJunction.risk.total,
      riskLevel: assignedJunction.risk.level,
      reason: 'AI-optimized deployment — ' + assignedJunction.risk.level.toUpperCase() + ' risk area',
      priority: assignedJunction.risk.level === 'high' ? 'URGENT' : assignedJunction.risk.level === 'medium' ? 'NORMAL' : 'LOW',
      lat: assignedJunction.lat, lng: assignedJunction.lng
    } : null,
    activeIncidents: activeIncidents.filter(function(inc) {
      return assignedJunction ? haversine(assignedJunction.lat, assignedJunction.lng, inc.lat, inc.lng) < 2000 : false;
    })
  });
});

// === PUBLIC DATA ENDPOINTS ===
app.get('/api/junctions', function(req, res) { res.json(junctions); });
app.get('/api/stations', function(req, res) { res.json(stations); });
app.get('/api/officers', function(req, res) { res.json(officers); });
app.get('/api/preset-incidents', function(req, res) { res.json(presetIncidents); });
app.get('/api/road-segments', function(req, res) { res.json(roadSegments); });

app.get('/api/risk-scores', function(req, res) {
  var hour = parseInt(req.query.hour) || 14;
  var scored = junctions.map(function(j) { return Object.assign({}, j, { risk: calcRiskScore(j, hour, activeIncidents) }); });
  scored.sort(function(a, b) { return b.risk.total - a.risk.total; });
  res.json(scored);
});

// === ML METRICS ===
app.get('/api/ml/metrics', function(req, res) {
  res.json({
    modelType: 'Gradient Boosted Ensemble (50 stumps, lr=0.15)',
    metrics: Object.assign({}, mlModel.metrics, { trainSize: mlModel.metrics.sampleSize * 4 }),
    featureImportance: mlModel.featureImportance,
    featureNames: FEATURE_NAMES,
    config: { rounds: 50, learningRate: 0.15 }
  });
});

// === ALLOCATION ===
app.get('/api/allocation', function(req, res) {
  var hour = parseInt(req.query.hour) || 14;
  var numOfficers = parseInt(req.query.officers) || 25;
  var queryIncidents = req.query.incidents ? JSON.parse(decodeURIComponent(req.query.incidents)) : null;
  var effectiveIncidents = queryIncidents ? queryIncidents : activeIncidents;
  var scored = junctions.map(function(j) { return Object.assign({}, j, { risk: calcRiskScore(j, hour, effectiveIncidents) }); });
  scored.sort(function(a, b) { return b.risk.total - a.risk.total; });
  var optimized = allocateOfficers(scored, numOfficers, manualOverrides);
  var baseline = getBaselineDeployment();
  var unmanned = scored.filter(function(j) { return !optimized[j.id] && j.risk.level === 'high'; });
  var highMed = scored.filter(function(j) { return j.risk.level !== 'low'; });
  var optHighMed = Object.keys(optimized).filter(function(jid) { var j = scored.find(function(s) { return s.id === jid; }); return j && j.risk.level !== 'low'; });
  var stats = {
    totalJunctions: scored.length,
    highRisk: scored.filter(function(j) { return j.risk.level === 'high'; }).length,
    mediumRisk: scored.filter(function(j) { return j.risk.level === 'medium'; }).length,
    lowRisk: scored.filter(function(j) { return j.risk.level === 'low'; }).length,
    officersDeployed: Object.keys(optimized).length,
    officersTotal: numOfficers,
    unmannedHighRisk: unmanned.length,
    baselineCoverage: Math.round(Object.keys(baseline).length / Math.max(highMed.length, 1) * 100),
    optimizedCoverage: Math.round(optHighMed.length / Math.max(highMed.length, 1) * 100),
    avgRiskScore: Math.round(scored.reduce(function(s, j) { return s + j.risk.total; }, 0) / scored.length)
  };
  res.json({ junctions: scored, optimizedDeployment: optimized, baselineDeployment: baseline, unmannedHighRisk: unmanned, stats: stats, activeIncidents: effectiveIncidents });
});

app.get('/api/baseline', function(req, res) { res.json(getBaselineDeployment()); });

// === ROUTING ===
app.get('/api/route', function(req, res) {
  var from = req.query.from, to = req.query.to;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  var route = routing.dijkstra(roadGraph, from, to);
  if (!route) return res.json({ error: 'No route found', from: from, to: to });
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

app.get('/api/officer-statuses', function(req, res) { res.json(officerStatuses); });

// === INCIDENT (with verification pipeline) ===
app.post('/api/incident', function(req, res) {
  var b = req.body;
  var locVerification = verifyLocation(b.lat, b.lng);

  // Determine verification status
  var verificationStatus = 'NEW';
  var hasPhoto = !!(b.photoMeta && b.photoMeta.size > 0);
  if (locVerification.verified && hasPhoto) verificationStatus = 'HIGH_CONFIDENCE';
  else if (locVerification.verified) verificationStatus = 'LOCATION_VERIFIED';
  else if (hasPhoto) verificationStatus = 'PHOTO_ATTACHED';

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
    resolved: false,
    // Verification pipeline
    verificationStatus: verificationStatus,
    locationVerification: locVerification,
    photoMeta: hasPhoto ? { size: b.photoMeta.size, type: b.photoMeta.type, timestamp: b.photoMeta.timestamp || new Date().toISOString() } : null,
    // Response tracking
    responseStatus: 'RECEIVED',
    responseTimeline: [{ status: 'RECEIVED', timestamp: new Date().toISOString() }]
  };
  activeIncidents.push(incident);

  // Recalculate deployment
  var hour = parseInt(req.query.hour) || new Date().getHours();
  var numOfficers = parseInt(req.query.officers) || 25;
  var scored = junctions.map(function(j) { return Object.assign({}, j, { risk: calcRiskScore(j, hour, activeIncidents) }); });
  scored.sort(function(a, b) { return b.risk.total - a.risk.total; });
  var redeployment = allocateOfficers(scored, numOfficers, manualOverrides);

  var nearestJ = routing.findNearestJunction(junctions, incident.lat, incident.lng);
  var dispatchInfo = null;
  if (nearestJ && redeployment[nearestJ.id]) {
    var officer = redeployment[nearestJ.id];
    var eta = routing.calcOfficerETA(officer.station, nearestJ.id, stations, junctions, roadGraph);
    dispatchInfo = { officer: officer, junction: nearestJ, eta: eta ? eta.totalTime : null, route: eta };
    officerStatuses[officer.id] = { status: 'dispatched', junction: nearestJ.id, junctionName: nearestJ.name, incident: incident.id, eta: eta ? eta.totalTime : null, timestamp: new Date().toISOString() };

    // Update response status
    incident.responseStatus = 'TEAM_ASSIGNED';
    incident.responseTimeline.push({ status: 'VERIFIED', timestamp: new Date().toISOString(), detail: 'Location ' + (locVerification.verified ? 'verified' : 'unverified') + ' (' + locVerification.distanceToRoad + 'm from ' + (locVerification.nearestFeature ? locVerification.nearestFeature.name : 'road') + ')' });
    incident.responseTimeline.push({ status: 'TEAM_ASSIGNED', timestamp: new Date().toISOString(), detail: 'Response unit dispatched' });
    if (eta) incident.responseETA = eta.totalTime;
  }

  var payload = { incident: incident, redeployment: redeployment, junctions: scored, dispatch: dispatchInfo };
  io.emit('incident:new', payload);
  io.emit('deployment:update', { redeployment: redeployment, junctions: scored, activeIncidents: activeIncidents });
  res.json(payload);
});

// === Public incident status (for citizen tracking) ===
app.get('/api/incident/:id/status', function(req, res) {
  var inc = activeIncidents.find(function(i) { return i.id === req.params.id; });
  if (!inc) return res.status(404).json({ error: 'Incident not found', resolved: true });
  // Sanitized public view - no officer names/badges
  res.json({
    id: inc.id,
    responseStatus: inc.responseStatus,
    verificationStatus: inc.verificationStatus,
    responseTimeline: (inc.responseTimeline || []).map(function(t) {
      return { status: t.status, timestamp: t.timestamp, detail: t.detail };
    }),
    eta: inc.responseETA || null,
    resolved: inc.resolved
  });
});

app.post('/api/incident/resolve', function(req, res) {
  var incId = req.body.id;
  var inc = activeIncidents.find(function(i) { return i.id === incId; });
  if (inc) {
    inc.resolved = true;
    inc.responseStatus = 'RESOLVED';
    inc.responseTimeline.push({ status: 'RESOLVED', timestamp: new Date().toISOString() });
  }
  activeIncidents = activeIncidents.filter(function(i) { return i.id !== incId; });
  Object.keys(officerStatuses).forEach(function(offId) {
    if (officerStatuses[offId].incident === incId) { officerStatuses[offId] = { status: 'available', timestamp: new Date().toISOString() }; }
  });
  io.emit('incident:resolved', { id: incId, activeIncidents: activeIncidents });
  io.emit('incident:status-update', { id: incId, status: 'RESOLVED' });
  res.json({ success: true, activeIncidents: activeIncidents });
});

app.post('/api/incident/clear', function(req, res) {
  activeIncidents = [];
  officerStatuses = {};
  io.emit('incidents:cleared', {});
  res.json({ success: true });
});

// === Officer status updates (require auth) ===
app.post('/api/officer/accept', requireOfficerAuth, function(req, res) {
  var offId = req.officerId;
  if (officerStatuses[offId]) {
    officerStatuses[offId].status = 'en-route';
    officerStatuses[offId].acceptedAt = new Date().toISOString();
    io.emit('officer:status', { officerId: offId, status: officerStatuses[offId] });
    // Update incident response status
    var incId = officerStatuses[offId].incident;
    var inc = activeIncidents.find(function(i) { return i.id === incId; });
    if (inc) {
      inc.responseStatus = 'EN_ROUTE';
      inc.responseTimeline.push({ status: 'EN_ROUTE', timestamp: new Date().toISOString(), detail: 'Response unit en route' });
      io.emit('incident:status-update', { id: incId, status: 'EN_ROUTE', eta: officerStatuses[offId].eta });
    }
  }
  res.json({ success: true, status: officerStatuses[offId] });
});

app.post('/api/officer/arrived', requireOfficerAuth, function(req, res) {
  var offId = req.officerId;
  if (officerStatuses[offId]) {
    officerStatuses[offId].status = 'on-scene';
    officerStatuses[offId].arrivedAt = new Date().toISOString();
    io.emit('officer:status', { officerId: offId, status: officerStatuses[offId] });
    var incId = officerStatuses[offId].incident;
    var inc = activeIncidents.find(function(i) { return i.id === incId; });
    if (inc) {
      inc.responseStatus = 'ON_SCENE';
      inc.responseTimeline.push({ status: 'ON_SCENE', timestamp: new Date().toISOString(), detail: 'Response unit arrived on scene' });
      io.emit('incident:status-update', { id: incId, status: 'ON_SCENE' });
    }
  }
  res.json({ success: true, status: officerStatuses[offId] });
});

// Accept/arrived without auth (backward compat for officer app pre-login, also from control room)
app.post('/api/officer/accept-legacy', function(req, res) {
  var offId = req.body.officerId;
  if (officerStatuses[offId]) {
    officerStatuses[offId].status = 'en-route';
    officerStatuses[offId].acceptedAt = new Date().toISOString();
    io.emit('officer:status', { officerId: offId, status: officerStatuses[offId] });
  }
  res.json({ success: true, status: officerStatuses[offId] });
});

app.post('/api/override', function(req, res) { if (req.body.officerId) { manualOverrides[req.body.junctionId] = req.body.officerId; } else { delete manualOverrides[req.body.junctionId]; } res.json({ success: true, overrides: manualOverrides }); });
app.post('/api/override/clear', function(req, res) { manualOverrides = {}; res.json({ success: true }); });

// === Socket.IO ===
io.on('connection', function(socket) {
  console.log('  [WS] Client connected: ' + socket.id);
  socket.emit('init', { activeIncidents: activeIncidents, officerStatuses: officerStatuses });
  socket.on('disconnect', function() { console.log('  [WS] Client disconnected: ' + socket.id); });
});

// === Start ===
server.listen(PORT, function() {
  console.log('');
  console.log('  NGP-TRAFFIC Server v3.0');
  console.log('  http://localhost:' + PORT);
  console.log('  Command Center:  /');
  console.log('  Citizen App:     /citizen.html');
  console.log('  Officer App:     /officer.html');
  console.log('  Simulation Lab:  /simulation.html');
  console.log('  Data: ' + junctions.length + ' junctions, ' + officers.length + ' officers, ' + stations.length + ' stations');
  console.log('  ML: Gradient Boosted (50 rounds) | Auth: HMAC tokens | Verification: Pipeline active');
  console.log('  WebSocket: Active');
  console.log('');
});