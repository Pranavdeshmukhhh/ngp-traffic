/* ═══════════════════════════════════════════════════════════════
   NGP-TRAFFIC — Main Application Controller
   ═══════════════════════════════════════════════════════════════ */

// ── STATE ──
let state = {
  junctions: [],
  officers: [],
  stations: [],
  presetIncidents: [],
  currentData: null,
  deploymentMode: 'optimized', // 'optimized' | 'baseline'
  hour: 18,
  officerCount: 25,
  incidentMode: false,
  searchFilter: '',
  roadSegments: []
};

// ── MAP VARIABLES ──
let map, heatLayer, junctionLayerGroup, officerLayerGroup, stationLayerGroup, incidentLayerGroup, roadLayerGroup, vehicleLayerGroup;
let junctionMarkers = {};
let officerMarkers = {};
let vehicleAnimFrameId = null;
let vehicles = [];


// ── CHART ──
let riskChart = null;

function initRiskChart() {
  var ctx = document.getElementById('riskChart');
  if (!ctx) return;
  riskChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['High Risk', 'Medium Risk', 'Low Risk'],
      datasets: [{
        data: [0, 0, 0],
        backgroundColor: ['#ef4444', '#eab308', '#22c55e'],
        borderColor: ['#991b1b', '#a16207', '#166534'],
        borderWidth: 2,
        hoverOffset: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '60%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: '#8896b3',
            font: { family: 'Inter', size: 11 },
            padding: 12,
            usePointStyle: true,
            pointStyleWidth: 8
          }
        },
        title: {
          display: true,
          text: 'Risk Distribution',
          color: '#8896b3',
          font: { family: 'Inter', size: 11, weight: '700' },
          padding: { bottom: 8 }
        }
      }
    }
  });
}

function updateRiskChart(stats) {
  if (!riskChart) initRiskChart();
  if (riskChart) {
    riskChart.data.datasets[0].data = [stats.highRisk, stats.mediumRisk, stats.lowRisk];
    riskChart.update('none');
  }
}

function hideLoading() {
  var overlay = document.getElementById('loadingOverlay');
  if (overlay) {
    overlay.classList.add('fade-out');
    setTimeout(function() { overlay.style.display = 'none'; }, 500);
  }
}

// ── INIT ──
document.addEventListener('DOMContentLoaded', async function() {
  initClock();
  initMap();
  await loadInitialData();
  initRiskChart();
  await refreshData();
  hideLoading();
});

// ── CLOCK ──
function initClock() {
  function update() {
    var now = new Date();
    document.getElementById('clock').textContent = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  }
  update();
  setInterval(update, 1000);
}

// ── MAP INIT ──
function initMap() {
  map = L.map('map', {
    center: [21.1458, 79.0882],
    zoom: 13,
    zoomControl: true,
    attributionControl: false
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19
  }).addTo(map);

  L.control.attribution({ position: 'bottomright', prefix: false })
    .addAttribution('NGP-TRAFFIC | OpenStreetMap')
    .addTo(map);

  // Layer groups
  junctionLayerGroup = L.layerGroup().addTo(map);
  officerLayerGroup = L.layerGroup().addTo(map);
  stationLayerGroup = L.layerGroup().addTo(map);
  incidentLayerGroup = L.layerGroup().addTo(map);
  roadLayerGroup = L.layerGroup().addTo(map);
  vehicleLayerGroup = L.layerGroup().addTo(map);

  // Heatmap layer (empty initially)
  heatLayer = L.heatLayer([], {
    radius: 35,
    blur: 25,
    maxZoom: 15,
    max: 100,
    gradient: { 0.2: '#22c55e', 0.4: '#84cc16', 0.6: '#eab308', 0.8: '#f97316', 1.0: '#ef4444' }
  }).addTo(map);

  // Click handler for incident mode
  map.on('click', function(e) {
    if (state.incidentMode) {
      placeIncident(e.latlng.lat, e.latlng.lng);
    }
  });
}

// ── DATA LOADING ──
async function loadInitialData() {
  try {
    var results = await Promise.all([
      fetch('/api/stations').then(function(r){ return r.json(); }),
      fetch('/api/road-segments').then(function(r){ return r.json(); }),
      fetch('/api/officers').then(function(r){ return r.json(); }),
      fetch('/api/preset-incidents').then(function(r){ return r.json(); })
    ]);
    state.stations = results[0];
    state.roadSegments = results[1];
    state.officers = results[2];
    state.presetIncidents = results[3];
    plotStations();
    plotRoads();
    initVehicleAnimation();
    populatePresets();
  } catch(err) {
    console.error('Failed to load data:', err);
  }
}

async function refreshData() {
  try {
    var url = '/api/allocation?hour=' + state.hour + '&officers=' + state.officerCount;
    var res = await fetch(url);
    var data = await res.json();
    state.currentData = data;
    updateMap(data);
    updateTable(data);
    updateStats(data);
    updateAlerts(data);
  } catch(err) {
    console.error('Failed to refresh data:', err);
  }
}

// ── MAP RENDERING ──
function updateMap(data) {
  // Clear layers
  junctionLayerGroup.clearLayers();
  officerLayerGroup.clearLayers();
  incidentLayerGroup.clearLayers();
  junctionMarkers = {};
  officerMarkers = {};

  // Determine deployment
  var deployment = state.deploymentMode === 'baseline' ? data.baselineDeployment : data.optimizedDeployment;

  // Heatmap data
  var heatData = data.junctions.map(function(j) {
    return [j.lat, j.lng, j.risk.total];
  });
  heatLayer.setLatLngs(heatData);

  // Junction markers
  data.junctions.forEach(function(j) {
    var color = j.risk.level === 'high' ? '#ef4444' : j.risk.level === 'medium' ? '#eab308' : '#22c55e';
    var radius = j.risk.level === 'high' ? 10 : j.risk.level === 'medium' ? 8 : 6;
    var hasOfficer = !!deployment[j.id];
    var isUnmanned = !hasOfficer && j.risk.level === 'high';

    var marker = L.circleMarker([j.lat, j.lng], {
      radius: radius,
      fillColor: color,
      color: isUnmanned ? '#fff' : color,
      weight: isUnmanned ? 3 : 2,
      opacity: 1,
      fillOpacity: 0.8,
      className: isUnmanned ? 'unmanned-pulse' : ''
    });

    var popupContent = '<div class="popup-title">' + j.name + '</div>' +
      '<div>Risk: <span class="popup-score" style="color:' + color + '">' + j.risk.total + '/100</span> (' + j.risk.level.toUpperCase() + ')</div>' +
      '<div>Officer: ' + (hasOfficer ? deployment[j.id].name : '<span style="color:#ef4444">None</span>') + '</div>' +
      '<button class="popup-btn" onclick="showJunctionDetail(\'' + j.id + '\')">View Details</button>';

    marker.bindPopup(popupContent);
    marker.bindTooltip(j.name + ' (' + j.risk.total + ')', { direction: 'top', offset: [0, -8] });
    marker.addTo(junctionLayerGroup);
    junctionMarkers[j.id] = marker;
  });

  // Officer markers
  Object.keys(deployment).forEach(function(jid) {
    var junction = data.junctions.find(function(j){ return j.id === jid; });
    var officer = deployment[jid];
    if (!junction || !officer) return;

    var icon = L.divIcon({
      className: 'officer-marker',
      html: '<div style="background:#3b82f6;color:white;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;border:2px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.3);">&#128110;</div>',
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    });

    var marker = L.marker([junction.lat + 0.001, junction.lng + 0.001], { icon: icon });
    marker.bindTooltip(officer.name, { direction: 'top', offset: [0, -16], className: 'officer-tooltip' });
    marker.addTo(officerLayerGroup);
    officerMarkers[officer.id] = marker;
  });

  // Incident markers
  if (data.activeIncidents && data.activeIncidents.length > 0) {
    data.activeIncidents.forEach(function(inc) {
      var pulseIcon = L.divIcon({
        className: 'incident-marker',
        html: '<div style="position:relative;"><div style="width:20px;height:20px;background:#ef4444;border-radius:50%;border:3px solid white;box-shadow:0 0 12px rgba(239,68,68,0.6);display:flex;align-items:center;justify-content:center;font-size:12px;">&#9888;</div><div style="position:absolute;top:-8px;left:-8px;width:36px;height:36px;border-radius:50%;border:2px solid #ef4444;animation:incidentPulse 1.5s infinite;"></div></div>',
        iconSize: [20, 20],
        iconAnchor: [10, 10]
      });
      L.marker([inc.lat, inc.lng], { icon: pulseIcon })
        .bindPopup('<div class="popup-title">' + inc.name + '</div><div>' + (inc.description || '') + '</div><div>Severity: <strong>' + inc.severity.toUpperCase() + '</strong></div>')
        .addTo(incidentLayerGroup);

      // Affected radius circle
      L.circle([inc.lat, inc.lng], {
        radius: inc.affectedRadius || 800,
        color: '#ef4444',
        fillColor: '#ef4444',
        fillOpacity: 0.08,
        weight: 1,
        dashArray: '6 4'
      }).addTo(incidentLayerGroup);
    });
  }
}

function plotStations() {
  state.stations.forEach(function(s) {
    var icon = L.divIcon({
      className: 'station-marker',
      html: '<div style="background:#1e3a5f;color:#60a5fa;width:24px;height:24px;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:13px;border:1px solid #3b82f6;box-shadow:0 2px 6px rgba(0,0,0,0.3);">&#127971;</div>',
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    });
    L.marker([s.lat, s.lng], { icon: icon })
      .bindTooltip(s.name, { direction: 'top', offset: [0, -14] })
      .addTo(stationLayerGroup);
  });
}


// ── ROAD NETWORK RENDERING ──
function plotRoads() {
  if (!state.roadSegments) return;
  roadLayerGroup.clearLayers();
  state.roadSegments.forEach(function(road) {
    var latlngs = road.points.map(function(p){ return [p[0], p[1]]; });
    var opacity = road.type === 'highway' ? 0.35 : 0.25;
    var weight = road.type === 'highway' ? 5 : 3;
    var color = road.traffic === 'heavy' ? '#f97316' : '#3b82f6';
    L.polyline(latlngs, {
      color: color,
      weight: weight,
      opacity: opacity,
      dashArray: road.type === 'highway' ? null : '8 6',
      lineCap: 'round',
      lineJoin: 'round',
      className: 'road-segment'
    }).bindTooltip(road.name, { sticky: true, direction: 'top', className: 'road-tooltip' })
    .addTo(roadLayerGroup);
  });
}

// ── VEHICLE ANIMATION ──
function initVehicleAnimation() {
  if (!state.roadSegments) return;
  vehicles = [];
  state.roadSegments.forEach(function(road) {
    var count = road.traffic === 'heavy' ? 4 : 2;
    for (var i = 0; i < count; i++) {
      vehicles.push(createVehicle(road, i / count));
    }
  });
  animateVehicles();
}

function createVehicle(road, startProgress) {
  var colors = ['#60a5fa','#34d399','#fbbf24','#f87171','#a78bfa','#fb923c'];
  var color = colors[Math.floor(Math.random() * colors.length)];
  var size = 4 + Math.floor(Math.random() * 3);
  var speed = 0.0003 + Math.random() * 0.0004;
  var wobble = (Math.random() - 0.5) * 0.0008;
  var marker = L.circleMarker([0,0], {
    radius: size,
    fillColor: color,
    color: 'rgba(255,255,255,0.5)',
    weight: 1,
    fillOpacity: 0.85,
    opacity: 0.6
  });
  marker.addTo(vehicleLayerGroup);
  return {
    road: road,
    progress: startProgress,
    speed: speed,
    wobbleX: wobble,
    wobbleY: (Math.random() - 0.5) * 0.0008,
    marker: marker,
    direction: Math.random() > 0.5 ? 1 : -1
  };
}

function interpolateRoadPos(points, progress) {
  if (points.length < 2) return points[0];
  var totalDist = 0;
  var segDists = [];
  for (var i = 1; i < points.length; i++) {
    var d = Math.sqrt(Math.pow(points[i][0]-points[i-1][0],2) + Math.pow(points[i][1]-points[i-1][1],2));
    segDists.push(d);
    totalDist += d;
  }
  var targetDist = progress * totalDist;
  var accum = 0;
  for (var s = 0; s < segDists.length; s++) {
    if (accum + segDists[s] >= targetDist) {
      var segProgress = (targetDist - accum) / segDists[s];
      return [
        points[s][0] + (points[s+1][0] - points[s][0]) * segProgress,
        points[s][1] + (points[s+1][1] - points[s][1]) * segProgress
      ];
    }
    accum += segDists[s];
  }
  return points[points.length - 1];
}

function animateVehicles() {
  vehicles.forEach(function(v) {
    v.progress += v.speed * v.direction;
    if (v.progress > 1) { v.progress = 1; v.direction = -1; }
    if (v.progress < 0) { v.progress = 0; v.direction = 1; }
    var pos = interpolateRoadPos(v.road.points, v.progress);
    var wobblePhase = Date.now() * 0.001;
    var lat = pos[0] + v.wobbleX * Math.sin(wobblePhase + v.progress * 10);
    var lng = pos[1] + v.wobbleY * Math.cos(wobblePhase + v.progress * 7);
    v.marker.setLatLng([lat, lng]);
  });
  vehicleAnimFrameId = requestAnimationFrame(animateVehicles);
}

// ── TABLE ──
function updateTable(data) {
  var tbody = document.getElementById('riskTableBody');
  var deployment = state.deploymentMode === 'baseline' ? data.baselineDeployment : data.optimizedDeployment;
  var filtered = data.junctions;
  if (state.searchFilter) {
    var q = state.searchFilter.toLowerCase();
    filtered = filtered.filter(function(j) { return j.name.toLowerCase().indexOf(q) !== -1; });
  }

  var rows = '';
  filtered.forEach(function(j, idx) {
    var hasOfficer = !!deployment[j.id];
    var officerName = hasOfficer ? deployment[j.id].name : '--';
    var color = j.risk.level === 'high' ? '#ef4444' : j.risk.level === 'medium' ? '#eab308' : '#22c55e';
    rows += '<tr onclick="showJunctionDetail(\'' + j.id + '\')" data-id="' + j.id + '">' +
      '<td style="color:' + (j.risk.level === 'high' ? 'var(--risk-high)' : 'var(--text-muted)') + ';font-weight:700;font-family:var(--font-mono)">' + (idx + 1) + '</td>' +
      '<td>' + j.name + '</td>' +
      '<td><div class="score-bar"><span class="score-num" style="color:' + color + '">' + j.risk.total + '</span><div class="score-fill" style="width:' + j.risk.total + '%;background:' + color + ';height:6px;border-radius:3px;"></div></div></td>' +
      '<td><span class="risk-badge ' + j.risk.level + '">' + j.risk.level + '</span></td>' +
      '<td><div class="officer-cell"><span class="officer-dot ' + (hasOfficer ? 'assigned' : 'unassigned') + '"></span><span style="font-size:11px;color:' + (hasOfficer ? 'var(--text-primary)' : 'var(--text-muted)') + '">' + officerName + '</span></div></td>' +
      '</tr>';
  });
  tbody.innerHTML = rows;
}

// ── STATS ──
function updateStats(data) {
  var s = data.stats;
  document.getElementById('statTotal').textContent = s.totalJunctions;
  document.getElementById('statHigh').textContent = s.highRisk;
  document.getElementById('statMedium').textContent = s.mediumRisk;
  document.getElementById('statLow').textContent = s.lowRisk;
  document.getElementById('statDeployed').textContent = s.officersDeployed + '/' + s.officersTotal;
  document.getElementById('statUnmanned').textContent = s.unmannedHighRisk;

  document.getElementById('baselineFill').style.width = s.baselineCoverage + '%';
  document.getElementById('baselinePct').textContent = s.baselineCoverage + '%';
  document.getElementById('optimizedFill').style.width = s.optimizedCoverage + '%';
  document.getElementById('optimizedPct').textContent = s.optimizedCoverage + '%';
  updateRiskChart(s);
}

// ── ALERTS ──
function updateAlerts(data) {
  var list = document.getElementById('alertsList');
  var alerts = [];

  // Unmanned high-risk alerts
  data.unmannedHighRisk.forEach(function(j) {
    alerts.push({
      icon: '&#9888;',
      title: j.name + ' unmanned!',
      desc: 'High-risk junction (Score: ' + j.risk.total + ') has no officer assigned',
      type: 'warning'
    });
  });

  // Active incident alerts
  if (data.activeIncidents) {
    data.activeIncidents.forEach(function(inc) {
      alerts.push({
        icon: '&#128680;',
        title: inc.name,
        desc: inc.description + ' (Severity: ' + inc.severity + ')',
        type: ''
      });
    });
  }

  if (alerts.length === 0) {
    list.innerHTML = '<div class="alert-empty">No active alerts</div>';
    return;
  }

  var html = '';
  alerts.forEach(function(a) {
    html += '<div class="alert-item ' + a.type + '">' +
      '<span class="alert-icon">' + a.icon + '</span>' +
      '<div class="alert-content">' +
      '<div class="alert-title">' + a.title + '</div>' +
      '<div class="alert-desc">' + a.desc + '</div>' +
      '</div></div>';
  });
  list.innerHTML = html;
}

// ── JUNCTION DETAIL MODAL ──
function showJunctionDetail(jid) {
  var data = state.currentData;
  if (!data) return;
  var j = data.junctions.find(function(x){ return x.id === jid; });
  if (!j) return;

  var deployment = state.deploymentMode === 'baseline' ? data.baselineDeployment : data.optimizedDeployment;
  var hasOfficer = !!deployment[j.id];
  var color = j.risk.level === 'high' ? '#ef4444' : j.risk.level === 'medium' ? '#eab308' : '#22c55e';

  document.getElementById('modalTitle').textContent = j.name;

  var body = '<div class="modal-score">' +
    '<div class="modal-score-value" style="color:' + color + '">' + j.risk.total + '</div>' +
    '<div class="modal-score-label">Risk Score / 100 &bull; ' + j.risk.level.toUpperCase() + ' RISK</div>' +
    '</div>';

  // Breakdown
  body += '<h3 style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;text-transform:uppercase;letter-spacing:1px">Risk Breakdown</h3>';

  var factors = [
    { key: 'accidentHistory', label: 'Accident History', icon: '&#128165;' },
    { key: 'trafficVolume', label: 'Traffic Volume', icon: '&#128663;' },
    { key: 'roadType', label: 'Road Type', icon: '&#128739;' },
    { key: 'timeOfDay', label: 'Time of Day', icon: '&#128336;' },
    { key: 'pedestrian', label: 'Pedestrian Density', icon: '&#128694;' },
    { key: 'proximity', label: 'Proximity Bonus', icon: '&#127979;' },
    { key: 'incident', label: 'Active Incidents', icon: '&#9888;' }
  ];

  factors.forEach(function(f) {
    var b = j.risk.breakdown[f.key];
    var pct = Math.round(b.score / b.max * 100);
    var barColor = pct >= 70 ? '#ef4444' : pct >= 40 ? '#eab308' : '#22c55e';
    body += '<div class="breakdown-row">' +
      '<span class="breakdown-label">' + f.icon + ' ' + f.label + '</span>' +
      '<div class="breakdown-bar"><div class="breakdown-fill" style="width:' + pct + '%;background:' + barColor + '"></div></div>' +
      '<span class="breakdown-value">' + b.score + '/' + b.max + '</span>' +
      '</div>';
  });

  // Info
  body += '<div style="margin-top:16px;padding:12px;background:var(--bg-card);border-radius:8px;font-size:12px;color:var(--text-secondary)">' +
    '<div><strong>Road:</strong> ' + j.roadType.replace('_',' ') + ' | <strong>Lanes:</strong> ' + j.laneCount + ' | <strong>Signal:</strong> ' + (j.hasSignal ? 'Yes' : 'No') + '</div>' +
    '<div><strong>Accidents/Year:</strong> ' + j.accidentHistory + ' | <strong>Avg Daily Traffic:</strong> ' + j.avgDailyTraffic.toLocaleString() + '</div>' +
    '</div>';

  // Assign officer
  body += '<div class="modal-assign">' +
    '<label style="font-size:12px;font-weight:600;color:var(--text-secondary)">Assign Officer (Manual Override)</label>' +
    '<select onchange="manualAssign(\'' + j.id + '\', this.value)">' +
    '<option value="">-- Auto (remove override) --</option>';
  state.officers.forEach(function(o) {
    body += '<option value="' + o.id + '"' + (hasOfficer && deployment[j.id].id === o.id ? ' selected' : '') + '>' + o.name + ' (' + o.stationName + ')</option>';
  });
  body += '</select></div>';

  document.getElementById('modalBody').innerHTML = body;
  document.getElementById('riskModal').style.display = 'flex';

  // Pan map to junction
  map.flyTo([j.lat, j.lng], 15, { duration: 0.8 });
}

function closeModal(e) {
  if (!e || e.target === document.getElementById('riskModal')) {
    document.getElementById('riskModal').style.display = 'none';
  }
}

// ── CONTROLS ──
function onTimeChange(val) {
  state.hour = parseInt(val);
  var h = state.hour % 12 || 12;
  var ampm = state.hour >= 12 ? 'PM' : 'AM';
  document.getElementById('timeLabel').textContent = h + ':00 ' + ampm;
  refreshData();
}

function changeOfficers(delta) {
  var input = document.getElementById('officerCount');
  var val = Math.max(1, Math.min(25, parseInt(input.value) + delta));
  input.value = val;
  state.officerCount = val;
  refreshData();
}

function onOfficerChange(val) {
  state.officerCount = Math.max(1, Math.min(25, parseInt(val)));
  document.getElementById('officerCount').value = state.officerCount;
  refreshData();
}

function setDeploymentMode(mode) {
  state.deploymentMode = mode;
  document.getElementById('btnOptimized').classList.toggle('active', mode === 'optimized');
  document.getElementById('btnBaseline').classList.toggle('active', mode === 'baseline');
  document.getElementById('badgeMode').textContent = mode.toUpperCase();
  document.getElementById('badgeMode').style.color = mode === 'optimized' ? 'var(--accent-blue)' : 'var(--accent-orange)';
  if (state.currentData) {
    updateMap(state.currentData);
    updateTable(state.currentData);
  }
}

function toggleLayer(layer) {
  if (layer === 'heatmap') {
    document.getElementById('cbHeatmap').checked ? map.addLayer(heatLayer) : map.removeLayer(heatLayer);
  } else if (layer === 'markers') {
    document.getElementById('cbMarkers').checked ? map.addLayer(junctionLayerGroup) : map.removeLayer(junctionLayerGroup);
  } else if (layer === 'officers') {
    document.getElementById('cbOfficers').checked ? map.addLayer(officerLayerGroup) : map.removeLayer(officerLayerGroup);
  } else if (layer === 'stations') {
    document.getElementById('cbStations').checked ? map.addLayer(stationLayerGroup) : map.removeLayer(stationLayerGroup);
  } else if (layer === 'roads') {
    document.getElementById('cbRoads').checked ? map.addLayer(roadLayerGroup) : map.removeLayer(roadLayerGroup);
  } else if (layer === 'vehicles') {
    if (document.getElementById('cbVehicles').checked) {
      map.addLayer(vehicleLayerGroup);
    } else {
      map.removeLayer(vehicleLayerGroup);
    }
  }
}

function filterTable(query) {
  state.searchFilter = query;
  if (state.currentData) updateTable(state.currentData);
}

function reOptimize() {
  state.deploymentMode = 'optimized';
  document.getElementById('btnOptimized').classList.add('active');
  document.getElementById('btnBaseline').classList.remove('active');
  document.getElementById('badgeMode').textContent = 'OPTIMIZED';
  refreshData();
}

async function resetAll() {
  await fetch('/api/incident/clear', { method: 'POST' });
  await fetch('/api/override/clear', { method: 'POST' });
  state.deploymentMode = 'optimized';
  state.hour = 18;
  state.officerCount = 25;
  state.incidentMode = false;
  document.getElementById('timeSlider').value = 18;
  document.getElementById('timeLabel').textContent = '6:00 PM';
  document.getElementById('officerCount').value = 25;
  document.getElementById('btnOptimized').classList.add('active');
  document.getElementById('btnBaseline').classList.remove('active');
  document.getElementById('badgeMode').textContent = 'OPTIMIZED';
  document.getElementById('incidentBanner').style.display = 'none';
  refreshData();
}

// ── INCIDENT SIMULATION ──
function startIncidentMode() {
  state.incidentMode = true;
  document.getElementById('incidentBanner').style.display = 'flex';
  map.getContainer().style.cursor = 'crosshair';
}

function cancelIncidentMode() {
  state.incidentMode = false;
  document.getElementById('incidentBanner').style.display = 'none';
  map.getContainer().style.cursor = '';
}

async function placeIncident(lat, lng) {
  cancelIncidentMode();
  var body = { lat: lat, lng: lng, type: 'accident', severity: 'high', name: 'Incident at ' + lat.toFixed(4) + ', ' + lng.toFixed(4), description: 'Simulated incident' };
  var url = '/api/incident?hour=' + state.hour + '&officers=' + state.officerCount;
  await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  refreshData();
}

function populatePresets() {
  var sel = document.getElementById('presetSelect');
  state.presetIncidents.forEach(function(p) {
    var opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  });
}

async function loadPresetIncident(presetId) {
  if (!presetId) return;
  var preset = state.presetIncidents.find(function(p){ return p.id === presetId; });
  if (!preset) return;
  var url = '/api/incident?hour=' + state.hour + '&officers=' + state.officerCount;
  await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(preset) });
  document.getElementById('presetSelect').value = '';
  refreshData();
  map.flyTo([preset.lat, preset.lng], 14, { duration: 1 });
}

// ── MANUAL OVERRIDE ──
async function manualAssign(junctionId, officerId) {
  await fetch('/api/override', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ junctionId: junctionId, officerId: officerId || null })
  });
  closeModal();
  refreshData();
}