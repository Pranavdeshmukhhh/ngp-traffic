/* NGP-TRAFFIC Simulation Lab */
var simState = { hour: 18, officers: 25, data: null, placingIncident: false };
var simMap, simHeatLayer, simJunctionGroup, simOfficerGroup, simIncidentGroup, simStations = [], simOfficers = [], presets = [];

document.addEventListener('DOMContentLoaded', function() {
  simMap = L.map('simMap', { center:[21.1458,79.0882], zoom:13, attributionControl:false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19}).addTo(simMap);
  simJunctionGroup = L.layerGroup().addTo(simMap);
  simOfficerGroup = L.layerGroup().addTo(simMap);
  simIncidentGroup = L.layerGroup().addTo(simMap);
  simHeatLayer = L.heatLayer([], { radius:30, blur:22, maxZoom:15, max:100, gradient:{0.2:'#3dbc72',0.4:'#84cc16',0.6:'#d4a72c',0.8:'#d47c2c',1.0:'#c94444'} }).addTo(simMap);

  simMap.on('click', function(e) {
    if (!simState.placingIncident) return;
    var type = document.getElementById('simIncType').value;
    var severity = document.getElementById('simIncSeverity').value;
    var desc = document.getElementById('simIncDesc').value || 'Simulated incident';
    var incidentData = {
      name: type.replace(/_/g,' ').replace(/^\w/,function(c){return c.toUpperCase();}) + ' near ' + e.latlng.lat.toFixed(4) + ', ' + e.latlng.lng.toFixed(4),
      type: type, severity: severity, description: desc,
      lat: e.latlng.lat, lng: e.latlng.lng
    };
    // POST to server so it persists and shows on main dashboard
    fetch('/api/incident?hour=' + simState.hour + '&officers=' + simState.officers, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(incidentData)
    }).then(function(r) { return r.json(); })
    .then(function() {
      simState.placingIncident = false;
      document.getElementById('simIncidentBanner').style.display = 'none';
      simMap.getContainer().style.cursor = '';
      refreshSim();
    });
  });

  Promise.all([
    fetch('/api/stations').then(function(r){return r.json();}),
    fetch('/api/officers').then(function(r){return r.json();}),
    fetch('/api/preset-incidents').then(function(r){return r.json();})
  ]).then(function(res) {
    simStations = res[0]; simOfficers = res[1]; presets = res[2];
    var sel = document.getElementById('presetSelect');
    presets.forEach(function(p,i) { var opt = document.createElement('option'); opt.value = i; opt.textContent = p.name; sel.appendChild(opt); });
    refreshSim();
  });
});

function refreshSim() {
  // Fetch allocation from server (uses server-side activeIncidents)
  var url = '/api/allocation?hour=' + simState.hour + '&officers=' + simState.officers;
  fetch(url).then(function(r){return r.json();}).then(function(data) {
    simState.data = data;
    renderSimMap(data);
    updateSimStats(data);
    logRedeployments(data);
  });
}

function renderSimMap(data) {
  simJunctionGroup.clearLayers();
  simOfficerGroup.clearLayers();
  simIncidentGroup.clearLayers();
  var dep = data.optimizedDeployment;
  simHeatLayer.setLatLngs(data.junctions.map(function(j){return [j.lat,j.lng,j.risk.total];}));
  data.junctions.forEach(function(j) {
    var c = j.risk.level==='high'?'#c94444':j.risk.level==='medium'?'#d4a72c':'#3dbc72';
    L.circleMarker([j.lat,j.lng], {radius:j.risk.level==='high'?8:6, fillColor:c, color:!!dep[j.id]?c:'#fff', weight:!!dep[j.id]?1.5:2.5, opacity:1, fillOpacity:0.8}).bindTooltip(j.name+' ('+j.risk.total+')').addTo(simJunctionGroup);
  });
  Object.keys(dep).forEach(function(jid) {
    var j = data.junctions.find(function(x){return x.id===jid;});
    if (!j) return;
    var icon = L.divIcon({ className:'', html:'<div style="background:#4a90d9;color:white;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.3);">&#128110;</div>', iconSize:[20,20], iconAnchor:[10,10] });
    L.marker([j.lat+0.0008,j.lng+0.0008], {icon:icon}).bindTooltip(dep[jid].name).addTo(simOfficerGroup);
  });
  if (data.activeIncidents && data.activeIncidents.length > 0) {
    data.activeIncidents.forEach(function(inc) {
      var icon = L.divIcon({ className:'', html:'<div style="width:16px;height:16px;background:#c94444;border-radius:50%;border:2px solid white;box-shadow:0 0 8px rgba(201,68,68,0.4);display:flex;align-items:center;justify-content:center;font-size:9px;color:white;">!</div>', iconSize:[16,16], iconAnchor:[8,8] });
      L.marker([inc.lat,inc.lng], {icon:icon}).bindPopup('<strong>'+inc.name+'</strong><br>'+inc.severity.toUpperCase()).addTo(simIncidentGroup);
      L.circle([inc.lat,inc.lng], {radius:inc.affectedRadius||800, color:'#c94444', fillColor:'#c94444', fillOpacity:0.06, weight:1, dashArray:'5 4'}).addTo(simIncidentGroup);
    });
  }
}

function updateSimStats(data) {
  var s = data.stats;
  document.getElementById('simHigh').textContent = s.highRisk;
  document.getElementById('simDeployed').textContent = s.officersDeployed + '/' + s.officersTotal;
  document.getElementById('simUnmanned').textContent = s.unmannedHighRisk;
  document.getElementById('simIncidents').textContent = (data.activeIncidents||[]).length;
  var avg = Math.round(data.junctions.reduce(function(s,j){return s+j.risk.total;},0) / data.junctions.length);
  document.getElementById('simAvgRisk').textContent = avg;
}

function logRedeployments(data) {
  var log = document.getElementById('simRedeployLog');
  var items = [];
  data.unmannedHighRisk.forEach(function(j) {
    items.push('<div class="notif-item warning"><span class="notif-icon">&#9888;</span><div class="notif-content"><div class="notif-title">'+j.name+' unmanned</div><div class="notif-desc">Score: '+j.risk.total+' — Needs assignment</div></div></div>');
  });
  if (data.activeIncidents) {
    data.activeIncidents.forEach(function(inc) {
      items.push('<div class="notif-item urgent"><span class="notif-icon">&#128680;</span><div class="notif-content"><div class="notif-title">'+inc.name+'</div><div class="notif-desc">'+inc.description+' | '+inc.severity.toUpperCase()+'</div></div></div>');
    });
  }
  log.innerHTML = items.length > 0 ? items.join('') : '<div class="notification-empty">No redeployments yet</div>';
}

function startSimIncidentMode() {
  simState.placingIncident = true;
  document.getElementById('simIncidentBanner').style.display = 'flex';
  document.getElementById('simIncidentForm').style.display = 'flex';
  simMap.getContainer().style.cursor = 'crosshair';
}

function cancelSimIncidentMode() {
  simState.placingIncident = false;
  document.getElementById('simIncidentBanner').style.display = 'none';
  simMap.getContainer().style.cursor = '';
}

function onSimTimeChange(val) {
  simState.hour = parseInt(val);
  var h = simState.hour % 12 || 12;
  document.getElementById('simTimeLabel').textContent = h + ':00 ' + (simState.hour >= 12 ? 'PM' : 'AM');
  refreshSim();
}

function simChangeOfficers(delta) {
  var input = document.getElementById('simOfficerCount');
  var val = Math.max(1, Math.min(25, parseInt(input.value) + delta));
  input.value = val;
  simState.officers = val;
  refreshSim();
}

function loadSimPreset(idx) {
  if (idx === '') return;
  var preset = presets[parseInt(idx)];
  if (!preset) return;
  // POST each preset incident to the server so they appear everywhere
  var promises = preset.incidents.map(function(inc) {
    return fetch('/api/incident?hour=' + simState.hour + '&officers=' + simState.officers, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(inc)
    }).then(function(r) { return r.json(); });
  });
  Promise.all(promises).then(function() { refreshSim(); });
}

function clearSimIncidents() {
  // Clear server-side incidents so main dashboard clears too
  fetch('/api/incident/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    .then(function() { refreshSim(); });
}

function resetSim() {
  simState = { hour: 18, officers: 25, data: null, placingIncident: false };
  document.getElementById('simTimeSlider').value = 18;
  document.getElementById('simTimeLabel').textContent = '6:00 PM';
  document.getElementById('simOfficerCount').value = 25;
  document.getElementById('presetSelect').value = '';
  document.getElementById('simIncidentForm').style.display = 'none';
  // Clear server-side incidents
  fetch('/api/incident/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    .then(function() { refreshSim(); });
}