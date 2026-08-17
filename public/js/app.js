/* NGP-TRAFFIC Control Room — Main Application */
var state = {
  currentData: null,
  deploymentMode: 'optimized',
  liveHour: new Date().getHours(),
  viewingHour: null, // null = live
  officerCount: 25,
  searchFilter: '',
  previousDeployment: null
};

var map, heatLayer, junctionLayerGroup, officerLayerGroup, stationLayerGroup, incidentLayerGroup;
var riskChart = null;

document.addEventListener('DOMContentLoaded', function() {
  initClock();
  initMap();
  initRiskChart();
  loadInitialData().then(function() {
    refreshData();
    hideLoading();
    // Auto-refresh every 10 seconds to pick up incidents from Simulation Lab or Citizen App
    setInterval(function() { if (isLiveMode()) refreshData(); }, 10000);
  });
});

// ── CLOCK (real system time, auto-updating) ──
function initClock() {
  function tick() {
    var now = new Date();
    state.liveHour = now.getHours();
    document.getElementById('clock').textContent = now.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:true });
    updateSliderMax();
  }
  tick();
  setInterval(tick, 1000);
}

function getCurrentHour() {
  return state.viewingHour !== null ? state.viewingHour : state.liveHour;
}

function isLiveMode() {
  return state.viewingHour === null;
}

// ── HISTORICAL SLIDER (past-only) ──
function updateSliderMax() {
  var slider = document.getElementById('timeSlider');
  slider.max = state.liveHour;
  if (parseInt(slider.value) > state.liveHour) {
    slider.value = state.liveHour;
  }
}

function onTimeChange(val) {
  var hour = parseInt(val);
  if (hour >= state.liveHour) {
    backToLive();
    return;
  }
  state.viewingHour = hour;
  var h = hour % 12 || 12;
  var ampm = hour >= 12 ? 'PM' : 'AM';
  document.getElementById('timeLabel').textContent = h + ':00 ' + ampm;
  document.getElementById('histTimeLabel').textContent = h + ':00 ' + ampm;
  document.getElementById('historicalBar').style.display = 'flex';
  document.getElementById('badgeLive').style.display = 'none';
  document.getElementById('badgeHistorical').style.display = 'inline-flex';
  refreshData();
}

function backToLive() {
  state.viewingHour = null;
  document.getElementById('timeSlider').value = state.liveHour;
  document.getElementById('timeLabel').textContent = 'Live';
  document.getElementById('historicalBar').style.display = 'none';
  document.getElementById('badgeLive').style.display = 'inline-flex';
  document.getElementById('badgeHistorical').style.display = 'none';
  refreshData();
}

// ── MAP ──
function initMap() {
  map = L.map('map', { center:[21.1458,79.0882], zoom:13, zoomControl:true, attributionControl:false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:19 }).addTo(map);
  L.control.attribution({ position:'bottomright', prefix:false }).addAttribution('NGP-TRAFFIC').addTo(map);
  junctionLayerGroup = L.layerGroup().addTo(map);
  officerLayerGroup = L.layerGroup().addTo(map);
  stationLayerGroup = L.layerGroup().addTo(map);
  incidentLayerGroup = L.layerGroup().addTo(map);
  heatLayer = L.heatLayer([], { radius:30, blur:22, maxZoom:15, max:100, gradient:{0.2:'#3dbc72',0.4:'#84cc16',0.6:'#d4a72c',0.8:'#d47c2c',1.0:'#c94444'} }).addTo(map);
}

// ── DATA ──
function loadInitialData() {
  return Promise.all([
    fetch('/api/stations').then(function(r){return r.json();}),
    fetch('/api/officers').then(function(r){return r.json();}),
    fetch('/api/preset-incidents').then(function(r){return r.json();})
  ]).then(function(results) {
    state.stations = results[0];
    state.officers = results[1];
    state.presetIncidents = results[2];
    plotStations();
  });
}

function refreshData() {
  var hour = getCurrentHour();
  return fetch('/api/allocation?hour=' + hour + '&officers=' + state.officerCount)
    .then(function(r){return r.json();})
    .then(function(data) {
      var prevDeploy = state.currentData ? (state.deploymentMode === 'baseline' ? state.currentData.baselineDeployment : state.currentData.optimizedDeployment) : null;
      state.currentData = data;
      updateMap(data);
      updateTable(data);
      updateStats(data);
      updateNotifications(data);
      if (prevDeploy) detectRedeployments(prevDeploy, state.deploymentMode === 'baseline' ? data.baselineDeployment : data.optimizedDeployment, data);
    });
}

// ── MAP RENDERING ──
function updateMap(data) {
  junctionLayerGroup.clearLayers();
  officerLayerGroup.clearLayers();
  incidentLayerGroup.clearLayers();
  var deployment = state.deploymentMode === 'baseline' ? data.baselineDeployment : data.optimizedDeployment;

  // Heatmap
  heatLayer.setLatLngs(data.junctions.map(function(j){return [j.lat,j.lng,j.risk.total];}));

  // Junctions
  data.junctions.forEach(function(j) {
    var color = j.risk.level === 'high' ? '#c94444' : j.risk.level === 'medium' ? '#d4a72c' : '#3dbc72';
    var r = j.risk.level === 'high' ? 8 : j.risk.level === 'medium' ? 6 : 5;
    var hasOff = !!deployment[j.id];
    var marker = L.circleMarker([j.lat,j.lng], {
      radius:r, fillColor:color, color:hasOff ? color : '#fff',
      weight: hasOff ? 1.5 : 2.5, opacity:1, fillOpacity:0.8
    });
    marker.on('click', function(){ showJunctionDetail(j.id); });
    marker.bindTooltip(j.name + ' (' + j.risk.total + ')', { direction:'top', offset:[0,-6] });
    marker.addTo(junctionLayerGroup);
  });

  // Officers
  Object.keys(deployment).forEach(function(jid) {
    var junction = data.junctions.find(function(j){return j.id===jid;});
    var officer = deployment[jid];
    if (!junction || !officer) return;
    var icon = L.divIcon({
      className:'officer-icon',
      html:'<div style="background:#4a90d9;color:white;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.3);cursor:pointer;">&#128110;</div>',
      iconSize:[22,22], iconAnchor:[11,11]
    });
    var m = L.marker([junction.lat+0.0008,junction.lng+0.0008], {icon:icon});
    m.on('click', function(){ showOfficerDetail(officer.id, jid); });
    m.bindTooltip(officer.name, { direction:'top', offset:[0,-14] });
    m.addTo(officerLayerGroup);
  });

  // Incidents
  if (data.activeIncidents) {
    data.activeIncidents.forEach(function(inc) {
      var icon = L.divIcon({
        className:'inc-icon',
        html:'<div style="width:16px;height:16px;background:#c94444;border-radius:50%;border:2px solid white;box-shadow:0 0 8px rgba(201,68,68,0.4);display:flex;align-items:center;justify-content:center;font-size:9px;color:white;">!</div>',
        iconSize:[16,16], iconAnchor:[8,8]
      });
      L.marker([inc.lat,inc.lng], {icon:icon})
        .bindPopup('<strong>' + inc.name + '</strong><br>' + (inc.description||'') + '<br>Severity: ' + inc.severity.toUpperCase())
        .addTo(incidentLayerGroup);
      L.circle([inc.lat,inc.lng], { radius:inc.affectedRadius||800, color:'#c94444', fillColor:'#c94444', fillOpacity:0.06, weight:1, dashArray:'5 4' }).addTo(incidentLayerGroup);
    });
  }
}

function plotStations() {
  state.stations.forEach(function(s) {
    var icon = L.divIcon({
      className:'station-icon',
      html:'<div style="background:#1e3050;color:#4a90d9;width:20px;height:20px;border-radius:3px;display:flex;align-items:center;justify-content:center;font-size:11px;border:1px solid #4a90d9;box-shadow:0 1px 4px rgba(0,0,0,0.2);cursor:pointer;">&#127971;</div>',
      iconSize:[20,20], iconAnchor:[10,10]
    });
    var m = L.marker([s.lat,s.lng], {icon:icon});
    m.on('click', function(){ showStationDetail(s.id); });
    m.bindTooltip(s.name, { direction:'top', offset:[0,-12] });
    m.addTo(stationLayerGroup);
  });
}

// ── TABLE ──
function updateTable(data) {
  var tbody = document.getElementById('riskTableBody');
  var deployment = state.deploymentMode === 'baseline' ? data.baselineDeployment : data.optimizedDeployment;
  var filtered = data.junctions;
  if (state.searchFilter) {
    var q = state.searchFilter.toLowerCase();
    filtered = filtered.filter(function(j){return j.name.toLowerCase().indexOf(q)!==-1;});
  }
  var rows = '';
  filtered.forEach(function(j,idx) {
    var hasOff = !!deployment[j.id];
    var offName = hasOff ? deployment[j.id].name : '--';
    var color = j.risk.level==='high'?'#c94444':j.risk.level==='medium'?'#d4a72c':'#3dbc72';
    rows += '<tr onclick="showJunctionDetail(\''+j.id+'\')">' +
      '<td style="color:var(--text-muted);font-weight:600;font-family:var(--font-mono)">'+(idx+1)+'</td>' +
      '<td style="font-size:11px">'+j.name+'</td>' +
      '<td><div class="score-bar"><span class="score-num" style="color:'+color+'">'+j.risk.total+'</span><div class="score-fill" style="width:'+j.risk.total+'%;background:'+color+'"></div></div></td>' +
      '<td><span class="risk-badge '+j.risk.level+'">'+j.risk.level+'</span></td>' +
      '<td><div class="officer-cell"><span class="officer-dot '+(hasOff?'assigned':'unassigned')+'"></span><span style="font-size:10px;color:'+(hasOff?'var(--text-primary)':'var(--text-muted)')+'">'+offName+'</span></div></td></tr>';
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
  document.getElementById('statDeployed').textContent = s.officersDeployed+'/'+s.officersTotal;
  document.getElementById('statUnmanned').textContent = s.unmannedHighRisk;
  document.getElementById('baselineFill').style.width = s.baselineCoverage+'%';
  document.getElementById('baselinePct').textContent = s.baselineCoverage+'%';
  document.getElementById('optimizedFill').style.width = s.optimizedCoverage+'%';
  document.getElementById('optimizedPct').textContent = s.optimizedCoverage+'%';
  updateRiskChart(s);
}

// ── CHART ──
function initRiskChart() {
  var ctx = document.getElementById('riskChart');
  if (!ctx) return;
  riskChart = new Chart(ctx, {
    type:'doughnut',
    data:{ labels:['High','Medium','Low'], datasets:[{ data:[0,0,0], backgroundColor:['#c94444','#d4a72c','#3dbc72'], borderColor:['#8b2e2e','#8a7020','#287a4a'], borderWidth:1.5, hoverOffset:4 }] },
    options:{ responsive:true, maintainAspectRatio:false, cutout:'62%', plugins:{ legend:{ position:'bottom', labels:{ color:'#7a8ba5', font:{family:'Inter',size:10}, padding:8, usePointStyle:true, pointStyleWidth:6 }}, title:{ display:true, text:'Risk Distribution', color:'#4f5e74', font:{family:'Inter',size:10,weight:'700'}, padding:{bottom:6} } } }
  });
}

function updateRiskChart(s) {
  if (!riskChart) return;
  riskChart.data.datasets[0].data = [s.highRisk,s.mediumRisk,s.lowRisk];
  riskChart.update('none');
}

// ── NOTIFICATIONS ──
function updateNotifications(data) {
  var list = document.getElementById('notificationsList');
  var items = [];
  data.unmannedHighRisk.forEach(function(j) {
    items.push({ icon:'&#9888;', title:j.name+' — No officer assigned', desc:'High-risk junction (Score: '+j.risk.total+') requires attention', type:'warning', time:'Now' });
  });
  if (data.activeIncidents) {
    data.activeIncidents.forEach(function(inc) {
      items.push({ icon:'&#128680;', title:inc.name, desc:inc.description+' | Severity: '+inc.severity.toUpperCase(), type:'urgent', time:inc.timestamp ? new Date(inc.timestamp).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'}) : 'Now' });
    });
  }
  if (items.length === 0) { list.innerHTML = '<div class="notification-empty">No active notifications</div>'; return; }
  list.innerHTML = items.map(function(n) {
    return '<div class="notif-item '+n.type+'"><span class="notif-icon">'+n.icon+'</span><div class="notif-content"><div class="notif-title">'+n.title+'</div><div class="notif-desc">'+n.desc+'</div><div class="notif-time">'+n.time+'</div></div></div>';
  }).join('');
}

// ── REDEPLOYMENT TOAST ──
function detectRedeployments(prev, curr, data) {
  Object.keys(curr).forEach(function(jid) {
    if (!prev[jid] || prev[jid].id !== curr[jid].id) {
      var j = data.junctions.find(function(x){return x.id===jid;});
      if (j && j.risk.level !== 'low') {
        showToast({
          title:'Redeployment Required',
          body: curr[jid].name + ' → ' + j.name + '\nReason: ' + (j.risk.level==='high'?'High-risk junction':'Medium-risk coverage') + '\nPriority: ' + j.risk.level.toUpperCase(),
          urgent: j.risk.level === 'high'
        });
      }
    }
  });
}

function showToast(opts) {
  var container = document.getElementById('toastContainer');
  var el = document.createElement('div');
  el.className = 'toast' + (opts.urgent ? ' urgent' : '');
  el.innerHTML = '<div class="toast-title">' + opts.title + '</div><div class="toast-body">' + opts.body.replace(/\n/g,'<br>') + '</div><div class="toast-meta">' + new Date().toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',second:'2-digit'}) + '</div>';
  container.appendChild(el);
  setTimeout(function() { el.style.animation = 'toastOut 0.3s ease forwards'; setTimeout(function(){el.remove();},300); }, 6000);
}

// ── DETAIL PANELS ──
function showJunctionDetail(jid) {
  var data = state.currentData; if (!data) return;
  var j = data.junctions.find(function(x){return x.id===jid;});
  if (!j) return;
  var deployment = state.deploymentMode==='baseline' ? data.baselineDeployment : data.optimizedDeployment;
  var hasOff = !!deployment[j.id];
  var color = j.risk.level==='high'?'#c94444':j.risk.level==='medium'?'#d4a72c':'#3dbc72';
  var hour = getCurrentHour();
  var trafficLevel = j.trafficByHour[hour] > 1200 ? 'Heavy' : j.trafficByHour[hour] > 600 ? 'Moderate' : 'Light';

  var html = '<div class="detail-score-display"><div class="detail-score-number" style="color:'+color+'">'+j.risk.total+'</div><div class="detail-score-subtitle">Risk Score &bull; '+j.risk.level.toUpperCase()+'</div></div>';

  html += '<div class="detail-section"><div class="detail-section-title">Junction Info</div>';
  html += '<div class="detail-row"><span class="detail-row-label">Traffic Level</span><span class="detail-row-value">'+trafficLevel+'</span></div>';
  html += '<div class="detail-row"><span class="detail-row-label">Congestion</span><span class="detail-row-value">'+j.trafficByHour[hour]+' veh/hr</span></div>';
  html += '<div class="detail-row"><span class="detail-row-label">Road Type</span><span class="detail-row-value">'+j.roadType.replace(/_/g,' ')+'</span></div>';
  html += '<div class="detail-row"><span class="detail-row-label">Lanes</span><span class="detail-row-value">'+j.laneCount+'</span></div>';
  html += '<div class="detail-row"><span class="detail-row-label">Signal</span><span class="detail-row-value">'+(j.hasSignal?'Yes':'No')+'</span></div>';
  html += '<div class="detail-row"><span class="detail-row-label">Accidents/Year</span><span class="detail-row-value">'+j.accidentHistory+'</span></div>';
  html += '<div class="detail-row"><span class="detail-row-label">Pedestrian</span><span class="detail-row-value">'+j.pedestrianDensity+'</span></div>';
  html += '<div class="detail-row"><span class="detail-row-label">Near School</span><span class="detail-row-value">'+(j.nearSchool?'Yes':'No')+'</span></div>';
  html += '<div class="detail-row"><span class="detail-row-label">Near Hospital</span><span class="detail-row-value">'+(j.nearHospital?'Yes':'No')+'</span></div>';
  html += '<div class="detail-row"><span class="detail-row-label">Assigned Officer</span><span class="detail-row-value" style="color:'+(hasOff?'var(--green)':'var(--red)')+'">'+(hasOff?deployment[j.id].name:'None')+'</span></div>';
  html += '</div>';

  html += '<div class="detail-section"><div class="detail-section-title">Risk Breakdown</div>';
  var factors = [
    {key:'accidentHistory',label:'Accident History'},{key:'trafficVolume',label:'Traffic Volume'},
    {key:'roadType',label:'Road Type'},{key:'timeOfDay',label:'Time of Day'},
    {key:'pedestrian',label:'Pedestrian Density'},{key:'proximity',label:'Proximity Bonus'},
    {key:'incident',label:'Active Incidents'}
  ];
  factors.forEach(function(f) {
    var b = j.risk.breakdown[f.key];
    var pct = Math.round(b.score/b.max*100);
    var bc = pct>=70?'#c94444':pct>=40?'#d4a72c':'#3dbc72';
    html += '<div class="breakdown-row"><span class="breakdown-label">'+f.label+'</span><div class="breakdown-bar"><div class="breakdown-fill" style="width:'+pct+'%;background:'+bc+'"></div></div><span class="breakdown-value">'+b.score+'/'+b.max+'</span></div>';
  });
  html += '</div>';

  // Nearby incidents
  var nearby = (data.activeIncidents||[]).filter(function(inc) { return haversineJS(j.lat,j.lng,inc.lat,inc.lng) < 1000; });
  if (nearby.length > 0) {
    html += '<div class="detail-section"><div class="detail-section-title">Nearby Incidents</div>';
    nearby.forEach(function(inc) { html += '<div class="notif-item urgent" style="margin-bottom:4px"><span class="notif-icon">&#128680;</span><div class="notif-content"><div class="notif-title">'+inc.name+'</div><div class="notif-desc">'+inc.severity.toUpperCase()+'</div></div></div>'; });
    html += '</div>';
  }

  document.getElementById('detailTitle').textContent = j.name;
  document.getElementById('detailBody').innerHTML = html;
  document.getElementById('detailPanel').style.display = 'block';
  map.flyTo([j.lat,j.lng], 15, {duration:0.6});
}

function showStationDetail(sid) {
  var s = state.stations.find(function(x){return x.id===sid;});
  if (!s) return;
  var data = state.currentData;
  var allOfficers = state.officers.filter(function(o){return o.station===sid;});
  var deployment = data ? (state.deploymentMode==='baseline'?data.baselineDeployment:data.optimizedDeployment) : {};
  var deployedIds = Object.values(deployment).map(function(o){return o.id;});
  var deployed = allOfficers.filter(function(o){return deployedIds.indexOf(o.id)!==-1;});
  var available = allOfficers.filter(function(o){return deployedIds.indexOf(o.id)===-1;});

  var html = '<div class="detail-section"><div class="detail-section-title">Station Info</div>';
  html += '<div class="detail-row"><span class="detail-row-label">Zone</span><span class="detail-row-value">'+s.zone+'</span></div>';
  html += '<div class="detail-row"><span class="detail-row-label">Total Officers</span><span class="detail-row-value">'+allOfficers.length+'</span></div>';
  html += '<div class="detail-row"><span class="detail-row-label">Deployed</span><span class="detail-row-value" style="color:var(--accent)">'+deployed.length+'</span></div>';
  html += '<div class="detail-row"><span class="detail-row-label">Available</span><span class="detail-row-value" style="color:var(--green)">'+available.length+'</span></div>';
  html += '</div>';

  if (deployed.length > 0) {
    html += '<div class="detail-section"><div class="detail-section-title">Deployed Officers</div>';
    deployed.forEach(function(o) {
      var jid = Object.keys(deployment).find(function(k){return deployment[k].id===o.id;});
      var j = jid && data ? data.junctions.find(function(x){return x.id===jid;}) : null;
      html += '<div class="detail-row"><span class="detail-row-label">'+o.name+'</span><span class="detail-row-value" style="font-size:10px">'+(j?j.name:'--')+'</span></div>';
    });
    html += '</div>';
  }

  // Nearby high-risk junctions
  if (data) {
    var nearbyHigh = data.junctions.filter(function(j){return j.risk.level==='high' && haversineJS(s.lat,s.lng,j.lat,j.lng)<3000;});
    if (nearbyHigh.length > 0) {
      html += '<div class="detail-section"><div class="detail-section-title">Nearby High-Risk Junctions</div>';
      nearbyHigh.forEach(function(j) {
        html += '<div class="detail-row"><span class="detail-row-label">'+j.name+'</span><span class="detail-row-value" style="color:var(--risk-high)">'+j.risk.total+'</span></div>';
      });
      html += '</div>';
    }
  }

  document.getElementById('detailTitle').textContent = s.name;
  document.getElementById('detailBody').innerHTML = html;
  document.getElementById('detailPanel').style.display = 'block';
}

function showOfficerDetail(offId, jid) {
  var officer = state.officers.find(function(o){return o.id===offId;});
  if (!officer) return;
  var data = state.currentData;
  var deployment = data ? (state.deploymentMode==='baseline'?data.baselineDeployment:data.optimizedDeployment) : {};
  var assignedJunction = jid ? (data ? data.junctions.find(function(j){return j.id===jid;}) : null) : null;
  var isDeployed = Object.values(deployment).some(function(o){return o.id===offId;});

  var html = '<div class="detail-section"><div class="detail-section-title">Officer Info</div>';
  html += '<div class="detail-row"><span class="detail-row-label">ID</span><span class="detail-row-value">'+officer.id+'</span></div>';
  html += '<div class="detail-row"><span class="detail-row-label">Station</span><span class="detail-row-value">'+officer.stationName+'</span></div>';
  html += '<div class="detail-row"><span class="detail-row-label">Status</span><span class="detail-row-value" style="color:'+(isDeployed?'var(--accent)':'var(--green)')+'">'+(isDeployed?'Deployed':'Available')+'</span></div>';
  if (assignedJunction) {
    html += '<div class="detail-row"><span class="detail-row-label">Assignment</span><span class="detail-row-value">'+assignedJunction.name+'</span></div>';
    html += '<div class="detail-row"><span class="detail-row-label">Junction Risk</span><span class="detail-row-value" style="color:'+(assignedJunction.risk.level==='high'?'var(--risk-high)':assignedJunction.risk.level==='medium'?'var(--risk-medium)':'var(--risk-low)')+'">'+assignedJunction.risk.total+' ('+assignedJunction.risk.level.toUpperCase()+')</span></div>';
  }
  html += '</div>';

  document.getElementById('detailTitle').textContent = officer.name;
  document.getElementById('detailBody').innerHTML = html;
  document.getElementById('detailPanel').style.display = 'block';
}

function closeDetailPanel() {
  document.getElementById('detailPanel').style.display = 'none';
}

// ── CONTROLS ──
function changeOfficers(delta) {
  var input = document.getElementById('officerCount');
  var val = Math.max(1, Math.min(25, parseInt(input.value)+delta));
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
  document.getElementById('btnOptimized').classList.toggle('active', mode==='optimized');
  document.getElementById('btnBaseline').classList.toggle('active', mode==='baseline');
  document.getElementById('badgeMode').textContent = mode==='optimized'?'OPTIMIZED':'BASELINE';
  if (state.currentData) { updateMap(state.currentData); updateTable(state.currentData); }
}

function toggleLayer(layer) {
  if (layer==='heatmap') { document.getElementById('cbHeatmap').checked ? map.addLayer(heatLayer) : map.removeLayer(heatLayer); }
  else if (layer==='markers') { document.getElementById('cbMarkers').checked ? map.addLayer(junctionLayerGroup) : map.removeLayer(junctionLayerGroup); }
  else if (layer==='officers') { document.getElementById('cbOfficers').checked ? map.addLayer(officerLayerGroup) : map.removeLayer(officerLayerGroup); }
  else if (layer==='stations') { document.getElementById('cbStations').checked ? map.addLayer(stationLayerGroup) : map.removeLayer(stationLayerGroup); }
}

function filterTable(query) { state.searchFilter = query; if (state.currentData) updateTable(state.currentData); }

function reOptimize() {
  state.deploymentMode = 'optimized';
  document.getElementById('btnOptimized').classList.add('active');
  document.getElementById('btnBaseline').classList.remove('active');
  document.getElementById('badgeMode').textContent = 'OPTIMIZED';
  refreshData();
}

function hideLoading() {
  var o = document.getElementById('loadingOverlay');
  if (o) { o.classList.add('fade-out'); setTimeout(function(){o.style.display='none';},400); }
}

function haversineJS(lat1,lon1,lat2,lon2) {
  var R=6371000, dLat=(lat2-lat1)*Math.PI/180, dLon=(lon2-lon1)*Math.PI/180;
  var a=Math.sin(dLat/2)*Math.sin(dLat/2)+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)*Math.sin(dLon/2);
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}