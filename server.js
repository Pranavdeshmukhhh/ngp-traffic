const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const junctions = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'nagpur-junctions.json'), 'utf8'));
const stations = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'police-stations.json'), 'utf8'));
const officers = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'officers.json'), 'utf8'));
const presetIncidents = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'preset-incidents.json'), 'utf8'));

let activeIncidents = [];
let manualOverrides = {};

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function calcRiskScore(junction, hour, incidents) {
  hour = hour || 14;
  incidents = incidents || [];
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
  var incidentBoost = 0;
  incidents.forEach(function(inc) {
    var dist = haversine(junction.lat, junction.lng, inc.lat, inc.lng);
    if (dist < (inc.affectedRadius || 800)) {
      incidentBoost = Math.max(incidentBoost, inc.severity === 'high' ? 100 : 70);
    }
  });
  var score = Math.round(0.30*accidentNorm + 0.25*trafficNorm + 0.15*roadFactor + 0.10*timeFactor + 0.10*pedFactor + 0.05*proxFactor + 0.05*incidentBoost);
  return {
    total: Math.min(score, 100),
    breakdown: {
      accidentHistory: { score: Math.round(0.30*accidentNorm), max: 30, raw: junction.accidentHistory },
      trafficVolume: { score: Math.round(0.25*trafficNorm), max: 25, raw: hourVol },
      roadType: { score: Math.round(0.15*roadFactor), max: 15, raw: junction.roadType },
      timeOfDay: { score: Math.round(0.10*timeFactor), max: 10, raw: hour },
      pedestrian: { score: Math.round(0.10*pedFactor), max: 10, raw: junction.pedestrianDensity },
      proximity: { score: Math.round(0.05*proxFactor), max: 5, raw: (junction.nearSchool ? 'School ' : '') + (junction.nearHospital ? 'Hospital' : '') || 'None' },
      incident: { score: Math.round(0.05*incidentBoost), max: 5, raw: incidentBoost > 0 ? 'Active nearby' : 'None' }
    },
    level: score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low'
  };
}

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

app.get('/api/junctions', function(req, res) { res.json(junctions); });
app.get('/api/stations', function(req, res) { res.json(stations); });
app.get('/api/officers', function(req, res) { res.json(officers); });
app.get('/api/preset-incidents', function(req, res) { res.json(presetIncidents); });

app.get('/api/risk-scores', function(req, res) {
  var hour = parseInt(req.query.hour) || 14;
  var scored = junctions.map(function(j){ return Object.assign({}, j, { risk: calcRiskScore(j, hour, activeIncidents) }); });
  scored.sort(function(a,b){ return b.risk.total - a.risk.total; });
  res.json(scored);
});

app.get('/api/allocation', function(req, res) {
  var hour = parseInt(req.query.hour) || 14;
  var numOfficers = parseInt(req.query.officers) || 25;
  var scored = junctions.map(function(j){ return Object.assign({}, j, { risk: calcRiskScore(j, hour, activeIncidents) }); });
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
  res.json({ junctions: scored, optimizedDeployment: optimized, baselineDeployment: baseline, unmannedHighRisk: unmanned, stats: stats, activeIncidents: activeIncidents });
});

app.get('/api/baseline', function(req, res) { res.json(getBaselineDeployment()); });

app.post('/api/incident', function(req, res) {
  var b = req.body;
  var incident = { id: 'INC_' + Date.now(), name: b.name || 'Incident', type: b.type || 'accident', lat: b.lat, lng: b.lng, severity: b.severity || 'high', affectedRadius: b.severity === 'high' ? 800 : 500, description: b.description || 'Reported incident', timestamp: new Date().toISOString(), resolved: false };
  activeIncidents.push(incident);
  var hour = parseInt(req.query.hour) || new Date().getHours();
  var numOfficers = parseInt(req.query.officers) || 25;
  var scored = junctions.map(function(j){ return Object.assign({}, j, { risk: calcRiskScore(j, hour, activeIncidents) }); });
  scored.sort(function(a,b){ return b.risk.total - a.risk.total; });
  var redeployment = allocateOfficers(scored, numOfficers, manualOverrides);
  res.json({ incident: incident, redeployment: redeployment, junctions: scored });
});

app.post('/api/incident/resolve', function(req, res) { activeIncidents = activeIncidents.filter(function(i){ return i.id !== req.body.id; }); res.json({ success: true, activeIncidents: activeIncidents }); });
app.post('/api/incident/clear', function(req, res) { activeIncidents = []; res.json({ success: true }); });
app.post('/api/override', function(req, res) { if (req.body.officerId) { manualOverrides[req.body.junctionId] = req.body.officerId; } else { delete manualOverrides[req.body.junctionId]; } res.json({ success: true, overrides: manualOverrides }); });
app.post('/api/override/clear', function(req, res) { manualOverrides = {}; res.json({ success: true }); });

app.listen(PORT, function() {
  console.log('');
  console.log('  NGP-TRAFFIC Server running at http://localhost:' + PORT);
  console.log('  Data: ' + junctions.length + ' junctions, ' + officers.length + ' officers, ' + stations.length + ' stations');
  console.log('');
});