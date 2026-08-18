// NGP-TRAFFIC Control Room v3.0
var state = {
  currentData: null,
  deploymentMode: 'optimized',
  liveHour: new Date().getHours(),
  viewingHour: null,
  officerCount: 25,
  searchFilter: '',
  previousDeployment: null,
  notificationStore: [],
  roadSegments: []
};

var map, heatLayer, junctionLayerGroup, officerLayerGroup, stationLayerGroup, incidentLayerGroup, roadRiskLayer;
var riskChart = null;

document.addEventListener('DOMContentLoaded', function() {
  initClock();
  initMap();
  initRiskChart();
  loadInitialData().then(function() {
    refreshData();
    hideLoading();
    setInterval(function() { if (isLiveMode()) refreshData(); }, 10000);
  });
});

// == CLOCK ==
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

function getCurrentHour() { return state.viewingHour !== null ? state.viewingHour : state.liveHour; }
function isLiveMode() { return state.viewingHour === null; }

// == HISTORICAL SLIDER ==
function updateSliderMax() {
  var slider = document.getElementById('timeSlider');
  slider.max = state.liveHour;
  if (parseInt(slider.value) > state.liveHour) slider.value = state.liveHour;
}

function onTimeChange(val) {
  var hour = parseInt(val);
  if (hour >= state.liveHour) { backToLive(); return; }
  state.viewingHour = hour;
  var h = hour % 12 || 12;
  var ampm = hour >= 12 ? 'PM' : 'AM';
  document.getElementById('timeLabel').textContent = h + ':00 ' + ampm;
  document.getElementById('histTimeLabel').textContent = h + ':00 ' + ampm;
  document.getElementById('historicalBar').style.display = 'flex';
  document.getElementById('badgeLive').style.display = 'none';
  document.getElementById('badgeHistorical').style.display = 'inline-flex';
  // Suppress toasts visually in historical mode
  document.getElementById('toastContainer').style.display = 'none';
  refreshData();
}

function backToLive() {
  state.viewingHour = null;
  document.getElementById('timeSlider').value = state.liveHour;
  document.getElementById('timeLabel').textContent = 'Live';
  document.getElementById('historicalBar').style.display = 'none';
  document.getElementById('badgeLive').style.display = 'inline-flex';
  document.getElementById('badgeHistorical').style.display = 'none';
  document.getElementById('toastContainer').style.display = 'block';
  refreshData();
}

// == MAP ==
function initMap() {
  map = L.map('map', { center:[21.1458,79.0882], zoom:13, zoomControl:true, attributionControl:false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:19 }).addTo(map);
  L.control.attribution({ position:'bottomright', prefix:false }).addAttribution('NGP-TRAFFIC').addTo(map);
  junctionLayerGroup = L.layerGroup().addTo(map);
  officerLayerGroup = L.layerGroup().addTo(map);
  stationLayerGroup = L.layerGroup().addTo(map);
  incidentLayerGroup = L.layerGroup().addTo(map);
  roadRiskLayer = L.layerGroup().addTo(map);
  // Keep heatLayer as a hidden dummy for the checkbox toggle
  heatLayer = L.layerGroup();
}

// == DATA ==
function loadInitialData() {
  return Promise.all([
    fetch('/api/stations').then(function(r){return r.json();}),
    fetch('/api/officers').then(function(r){return r.json();}),
    fetch('/api/preset-incidents').then(function(r){return r.json();}),
    fetch('/api/road-segments').then(function(r){return r.json();})
  ]).then(function(results) {
    state.stations = results[0];
    state.officers = results[1];
    state.presetIncidents = results[2];
    state.roadSegments = results[3];
    plotStations();
  });
}

function refreshData() {
  var hour = getCurrentHour();
  var url = '/api/allocation?hour=' + hour + '&officers=' + state.officerCount;
  // In historical mode, don't include live incidents
  if (!isLiveMode()) url += '&incidents=' + encodeURIComponent('[]');
  return fetch(url)
    .then(function(r){return r.json();})
    .then(function(data) {
      var prevDeploy = state.currentData ? (state.deploymentMode === 'baseline' ? state.currentData.baselineDeployment : state.currentData.optimizedDeployment) : null;
      state.currentData = data;
      updateMap(data);
      updateTable(data);
      updateStats(data);
      updateNotifications(data);
      if (prevDeploy && isLiveMode()) detectRedeployments(prevDeploy, state.deploymentMode === 'baseline' ? data.baselineDeployment : data.optimizedDeployment, data);
    });
}

// == MAP RENDERING ==
function getRiskColorForScore(score) {
  if (score >= 70) return '#c94444';
  if (score >= 55) return '#d47c2c';
  if (score >= 40) return '#d4a72c';
  if (score >= 25) return '#84cc16';
  return '#3dbc72';
}

function getSegmentRisk(segment, junctions) {
  // Find nearest junctions to this road segment and average their risk
  var totalRisk = 0, count = 0;
  segment.points.forEach(function(pt) {
    var minDist = Infinity, nearestRisk = 40;
    junctions.forEach(function(j) {
      var d = haversineJS(pt[0], pt[1], j.lat, j.lng);
      if (d < minDist) { minDist = d; nearestRisk = j.risk.total; }
    });
    if (minDist < 3000) { totalRisk += nearestRisk; count++; }
  });
  return count > 0 ? Math.round(totalRisk / count) : 30;
}

function updateMap(data) {
  junctionLayerGroup.clearLayers();
  officerLayerGroup.clearLayers();
  incidentLayerGroup.clearLayers();
  roadRiskLayer.clearLayers();
  var deployment = state.deploymentMode === 'baseline' ? data.baselineDeployment : data.optimizedDeployment;

  // Junctions
  data.junctions.forEach(function(j) {
    var color = j.risk.level === 'high' ? '#c94444' : j.risk.level === 'medium' ? '#d4a72c' : '#3dbc72';
    var r = j.risk.level === 'high' ? 7 : j.risk.level === 'medium' ? 5 : 4;
    var hasOff = !!deployment[j.id];
    var marker = L.circleMarker([j.lat,j.lng], {
      radius:r, fillColor:color, color: hasOff ? '#fff' : color,
      weight: hasOff ? 2 : 1.5, opacity:1, fillOpacity:0.85
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
    var m = L.marker([junction.lat, junction.lng], {icon:icon});
    m.on('click', function(){ showOfficerDetail(officer.id, jid); });
    m.bindTooltip(officer.name, { direction:'top', offset:[0,-14] });
    m.addTo(officerLayerGroup);
  });

  // Incidents (only in live mode)
  if (isLiveMode() && data.activeIncidents) {
    data.activeIncidents.forEach(function(inc) {
      var icon = L.divIcon({
        className:'inc-icon',
        html:'<div style="width:16px;height:16px;background:#c94444;border-radius:50%;border:2px solid white;box-shadow:0 0 8px rgba(201,68,68,0.4);display:flex;align-items:center;justify-content:center;font-size:9px;color:white;">!</div>',
        iconSize:[16,16], iconAnchor:[8,8]
      });
      var verif = inc.verificationStatus ? ' | ' + inc.verificationStatus.replace(/_/g,' ') : '';
      L.marker([inc.lat,inc.lng], {icon:icon})
        .bindPopup('<strong>' + inc.name + '</strong><br>' + (inc.description||'') + '<br>Severity: ' + inc.severity.toUpperCase() + verif)
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

// == TABLE ==
function updateTable(data) {
  var tbody = document.getElementById('riskTableBody');
  var deployment = state.deploymentMode === 'baseline' ? data.baselineDeployment : data.optimizedDeployment;
  var filtered = data.junctions;
  if (state.searchFilter) {
    var q = state.searchFilter.toLowerCase();
    filtered = data.junctions.filter(function(j) { return j.name.toLowerCase().indexOf(q) !== -1 || j.id.toLowerCase().indexOf(q) !== -1; });
  }
  tbody.innerHTML = filtered.map(function(j, i) {
    var color = j.risk.level === 'high' ? 'var(--risk-high)' : j.risk.level === 'medium' ? 'var(--risk-medium)' : 'var(--risk-low)';
    var off = deployment[j.id];
    return '<tr onclick="showJunctionDetail(\''+j.id+'\')" style="cursor:pointer"><td>'+(i+1)+'</td><td>'+j.name+'</td><td style="color:'+color+';font-weight:700">'+j.risk.total+'</td><td><span class="risk-badge risk-'+j.risk.level+'">'+j.risk.level.toUpperCase()+'</span></td><td>'+(off?off.name:'ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â')+'</td></tr>';
  }).join('');
}

// == STATS ==
function updateStats(data) {
  document.getElementById('statTotal').textContent = data.stats.totalJunctions;
  document.getElementById('statHigh').textContent = data.stats.highRisk;
  document.getElementById('statMedium').textContent = data.stats.mediumRisk;
  document.getElementById('statLow').textContent = data.stats.lowRisk;
  document.getElementById('statDeployed').textContent = data.stats.officersDeployed;
  document.getElementById('statUnmanned').textContent = data.stats.unmannedHighRisk;
  document.getElementById('baselineFill').style.width = data.stats.baselineCoverage + '%';
  document.getElementById('baselinePct').textContent = data.stats.baselineCoverage + '%';
  document.getElementById('optimizedFill').style.width = data.stats.optimizedCoverage + '%';
  document.getElementById('optimizedPct').textContent = data.stats.optimizedCoverage + '%';
  updateRiskChart(data);
}

function initRiskChart() {
  var ctx = document.getElementById('riskChart').getContext('2d');
  riskChart = new Chart(ctx, {
    type: 'doughnut',
    data: { labels: ['High','Medium','Low'], datasets: [{ data: [0,0,0], backgroundColor: ['#c94444','#d4a72c','#3dbc72'], borderColor: '#1a2332', borderWidth: 2 }] },
    options: { responsive:true, plugins:{ legend:{ position:'bottom', labels:{ color:'#7a8ba5', font:{size:10} } } }, cutout:'65%' }
  });
}

function updateRiskChart(data) {
  if (!riskChart) return;
  riskChart.data.datasets[0].data = [data.stats.highRisk, data.stats.mediumRisk, data.stats.lowRisk];
  riskChart.update('none');
}

// == NOTIFICATIONS ==
function updateNotifications(data) {
  var list = document.getElementById('notificationsList');
  // Build notifications from data state
  var items = [];
  if (data.stats.unmannedHighRisk > 0) {
    items.push({ icon: '&#9888;', title: data.stats.unmannedHighRisk + ' HIGH-RISK junctions unmanned', desc: 'Consider deploying more officers', urgent: true });
  }
  if (data.stats.highRisk > 3) {
    items.push({ icon: '&#128308;', title: data.stats.highRisk + ' junctions at HIGH risk', desc: 'Hour: ' + getCurrentHour() + ':00', urgent: false });
  }
  if (isLiveMode() && data.activeIncidents && data.activeIncidents.length > 0) {
    data.activeIncidents.forEach(function(inc) {
      items.push({ icon: '&#128680;', title: inc.name, desc: inc.severity.toUpperCase() + ' | ' + (inc.verificationStatus || 'NEW').replace(/_/g,' '), urgent: inc.severity === 'high' });
    });
  }
  // Add stored notifications
  state.notificationStore.forEach(function(n) {
    items.push(n);
  });

  if (items.length === 0) {
    list.innerHTML = '<div class="notification-empty">No active notifications</div>';
    return;
  }
  // Show historical label if not live
  var prefix = '';
  if (!isLiveMode()) {
    prefix = '<div style="padding:6px 10px;background:rgba(212,167,44,0.1);border:1px solid rgba(212,167,44,0.2);border-radius:6px;font-size:11px;color:#d4a72c;margin-bottom:6px;text-align:center;">&#128337; Historical View ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â Live notifications paused</div>';
  }
  list.innerHTML = prefix + items.slice(0, 12).map(function(n) {
    return '<div class="notif-item' + (n.urgent ? ' urgent' : '') + '"><span class="notif-icon">' + n.icon + '</span><div class="notif-content"><div class="notif-title">' + n.title + '</div><div class="notif-desc">' + n.desc + '</div></div></div>';
  }).join('');
}

function detectRedeployments(oldDeploy, newDeploy, data) {
  var changes = [];
  Object.keys(newDeploy).forEach(function(jid) {
    if (!oldDeploy[jid] || oldDeploy[jid].id !== newDeploy[jid].id) {
      var j = data.junctions.find(function(x){return x.id===jid;});
      if (j) changes.push(newDeploy[jid].name + ' \u2192 ' + j.name);
    }
  });
  if (changes.length > 0) {
    showToast({ title: '&#128260; Redeployment', body: changes.join('\n'), urgent: false });
  }
}

function showToast(opts) {
  // Always store in notification center
  state.notificationStore.unshift({ icon: '&#128276;', title: opts.title.replace(/<[^>]*>/g,''), desc: opts.body.replace(/<[^>]*>/g,'').replace(/\n/g,', '), urgent: opts.urgent || false, time: new Date().toISOString() });
  if (state.notificationStore.length > 30) state.notificationStore.pop();

  // Only show popup toast in live mode
  if (!isLiveMode()) return;

  var container = document.getElementById('toastContainer');
  var el = document.createElement('div');
  el.className = 'toast' + (opts.urgent ? ' urgent' : '');
  el.innerHTML = '<div class="toast-title">' + opts.title + '</div><div class="toast-body">' + opts.body.replace(/\n/g,'<br>') + '</div><div class="toast-meta">' + new Date().toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',second:'2-digit'}) + '</div>';
  container.appendChild(el);
  setTimeout(function() { el.style.animation = 'toastOut 0.3s ease forwards'; setTimeout(function(){el.remove();},300); }, 6000);
}

// == DETAIL PANELS ==
function showJunctionDetail(jid) {
  var data = state.currentData; if (!data) return;
  var j = data.junctions.find(function(x){return x.id===jid;});
  if (!j) return;
  var deployment = state.deploymentMode==='baseline' ? data.baselineDeployment : data.optimizedDeployment;
  var hasOff = !!deployment[j.id];
  var color = j.risk.level==='high'?'#c94444':j.risk.level==='medium'?'#d4a72c':'#3dbc72';
  var hour = getCurrentHour();
  var trafficLevel = j.trafficByHour[hour] > 1200 ? 'Heavy' : j.trafficByHour[hour] > 600 ? 'Moderate' : 'Light';

  var html = '<div class="detail-score-display"><div class="detail-score-number" style="color:'+color+'">'+j.risk.total+'</div><div class="detail-score-subtitle">Risk Score \u2022 '+j.risk.level.toUpperCase()+'</div></div>';
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
  var factors = [{key:'accidentHistory',label:'Accident History'},{key:'trafficVolume',label:'Traffic Volume'},{key:'roadType',label:'Road Type'},{key:'timeOfDay',label:'Time of Day'},{key:'pedestrian',label:'Pedestrian Density'},{key:'proximity',label:'Proximity Bonus'},{key:'incident',label:'Active Incidents'}];
  factors.forEach(function(f) {
    var b = j.risk.breakdown[f.key];
    var pct = Math.round(b.score/b.max*100);
    var bc = pct>=70?'#c94444':pct>=40?'#d4a72c':'#3dbc72';
    html += '<div class="breakdown-row"><span class="breakdown-label">'+f.label+'</span><div class="breakdown-bar"><div class="breakdown-fill" style="width:'+pct+'%;background:'+bc+'"></div></div><span class="breakdown-value">'+b.score+'/'+b.max+'</span></div>';
  });
  html += '</div>';

  var nearby = (data.activeIncidents||[]).filter(function(inc) { return haversineJS(j.lat,j.lng,inc.lat,inc.lng) < 1000; });
  if (nearby.length > 0) {
    html += '<div class="detail-section"><div class="detail-section-title">Nearby Incidents</div>';
    nearby.forEach(function(inc) { html += '<div class="notif-item urgent" style="margin-bottom:4px"><span class="notif-icon">&#128680;</span><div class="notif-content"><div class="notif-title">'+inc.name+'</div><div class="notif-desc">'+inc.severity.toUpperCase()+' | '+(inc.verificationStatus||'NEW').replace(/_/g,' ')+'</div></div></div>'; });
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

  if (data) {
    var nearbyHigh = data.junctions.filter(function(j){return j.risk.level==='high' && haversineJS(s.lat,s.lng,j.lat,j.lng)<3000;});
    if (nearbyHigh.length > 0) {
      html += '<div class="detail-section"><div class="detail-section-title">Nearby High-Risk Junctions</div>';
      nearbyHigh.forEach(function(j) { html += '<div class="detail-row"><span class="detail-row-label">'+j.name+'</span><span class="detail-row-value" style="color:var(--risk-high)">'+j.risk.total+'</span></div>'; });
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

function closeDetailPanel() { document.getElementById('detailPanel').style.display = 'none'; }

// == CONTROLS ==
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
  if (layer==='heatmap') {
    if (state.currentData) updateMap(state.currentData); // re-render with/without road risk
  }
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

// == Socket.IO Real-time ==
var socket = typeof io !== 'undefined' ? io() : null;
if (socket) {
  socket.on('incident:new', function(data) {
    showToast({ title: '&#128680; NEW INCIDENT', body: data.incident.name + '\nVerification: ' + (data.incident.verificationStatus || 'NEW').replace(/_/g,' '), urgent: data.incident.severity === 'high' });
    if (isLiveMode()) refreshData();
  });
  socket.on('deployment:update', function() { if (isLiveMode()) refreshData(); });
  socket.on('incident:resolved', function(data) {
    showToast({ title: '&#9989; Incident Resolved', body: 'Incident ' + data.id + ' cleared', urgent: false });
    if (isLiveMode()) refreshData();
  });
  socket.on('incidents:cleared', function() { if (isLiveMode()) refreshData(); });
  socket.on('officer:status', function(data) {
    showToast({ title: '&#128110; Officer Update', body: data.officerId + ': ' + data.status.status, urgent: false });
  });
}

// == ML Metrics Modal ==
function showMLMetrics() {
  var modal = document.getElementById('mlModal');
  modal.style.display = 'flex';
  fetch('/api/ml/metrics').then(function(r){return r.json();}).then(function(data) {
    var m = data.metrics;
    var content = document.getElementById('mlMetricsContent');
    content.innerHTML =
      '<div style="background:#212d3f;border-radius:8px;padding:14px;text-align:center;"><div style="font-size:10px;color:#7a8ba5;text-transform:uppercase;">R\u00b2 Score</div><div style="font-size:26px;font-weight:800;color:#3dbc72;">' + m.r2.toFixed(4) + '</div></div>' +
      '<div style="background:#212d3f;border-radius:8px;padding:14px;text-align:center;"><div style="font-size:10px;color:#7a8ba5;text-transform:uppercase;">RMSE</div><div style="font-size:26px;font-weight:800;color:#d4a72c;">' + m.rmse.toFixed(2) + '</div></div>' +
      '<div style="background:#212d3f;border-radius:8px;padding:14px;text-align:center;"><div style="font-size:10px;color:#7a8ba5;text-transform:uppercase;">Accuracy</div><div style="font-size:26px;font-weight:800;color:#4a90d9;">' + (m.accuracy*100).toFixed(1) + '%</div></div>' +
      '<div style="background:#212d3f;border-radius:8px;padding:14px;text-align:center;"><div style="font-size:10px;color:#7a8ba5;text-transform:uppercase;">F1 (Macro)</div><div style="font-size:26px;font-weight:800;color:#84cc16;">' + m.macroF1.toFixed(3) + '</div></div>' +
      '<div style="background:#212d3f;border-radius:8px;padding:14px;grid-column:span 2;"><div style="font-size:10px;color:#7a8ba5;text-transform:uppercase;margin-bottom:6px;">Model Info</div><div style="font-size:12px;color:#dce3ed;">' + data.modelType + '<br>Training: ' + m.trainSize + ' samples | ' + data.featureNames.length + ' features<br>F1 High: ' + m.f1PerClass.high.toFixed(3) + ' | Med: ' + m.f1PerClass.medium.toFixed(3) + ' | Low: ' + m.f1PerClass.low.toFixed(3) + '</div></div>';

    var fi = data.featureImportance;
    var labels = Object.keys(fi).sort(function(a,b){return fi[b]-fi[a];});
    var values = labels.map(function(k){return fi[k];});
    var ctx = document.getElementById('featureChart').getContext('2d');
    if (window._fiChart) window._fiChart.destroy();
    window._fiChart = new Chart(ctx, {
      type: 'bar',
      data: { labels: labels.map(function(l){return l.replace(/_/g,' ');}), datasets: [{ label: 'Importance', data: values, backgroundColor: labels.map(function(_,i){return 'hsl(' + (200 + i*25) + ',60%,55%)';}) }] },
      options: { indexAxis:'y', responsive:true, plugins:{legend:{display:false}}, scales:{x:{grid:{color:'#2a3a50'},ticks:{color:'#7a8ba5'}},y:{grid:{display:false},ticks:{color:'#dce3ed',font:{size:10}}}} }
    });

    if (m.pvaCurve && m.pvaCurve.length > 0) {
      var pvaCtx = document.getElementById('pvaChart').getContext('2d');
      if (window._pvaChart) window._pvaChart.destroy();
      window._pvaChart = new Chart(pvaCtx, {
        type: 'scatter',
        data: {
          datasets: [
            { label:'Predicted vs Actual', data:m.pvaCurve.map(function(p){return {x:p.actual,y:p.predicted};}), backgroundColor:'rgba(74,144,217,0.6)', pointRadius:3 },
            { label:'Perfect', data:[{x:0,y:0},{x:100,y:100}], type:'line', borderColor:'rgba(61,188,114,0.4)', borderDash:[5,5], pointRadius:0 }
          ]
        },
        options: { responsive:true, plugins:{legend:{labels:{color:'#7a8ba5'}}}, scales:{x:{title:{display:true,text:'Actual',color:'#7a8ba5'},grid:{color:'#2a3a50'},ticks:{color:'#7a8ba5'}},y:{title:{display:true,text:'Predicted',color:'#7a8ba5'},grid:{color:'#2a3a50'},ticks:{color:'#7a8ba5'}}} }
      });
    }
  });
}

// --- OSRM ROUTE PLANNER ---

let routePlannerActive = false;
let routeStartCoords = null;
let routeEndCoords = null;
let currentRouteLayer = null;

const NAGPUR_LANDMARKS = {
  'sitabuldi': { lat: 21.1466, lng: 79.0779 },
  'vnit nagpur': { lat: 21.1249, lng: 79.0508 },
  'airport': { lat: 21.0558, lng: 79.0520 },
  'it park': { lat: 21.1166, lng: 79.0270 },
  'medical square': { lat: 21.1309, lng: 79.0968 },
  'dharampeth': { lat: 21.1396, lng: 79.0645 }
};

function toggleRoutePlanner() {
  const overlay = document.getElementById('routePlannerOverlay');
  routePlannerActive = !routePlannerActive;
  if (routePlannerActive) {
    overlay.classList.add('active');
    document.getElementById('map').style.cursor = 'crosshair';
  } else {
    overlay.classList.remove('active');
    document.getElementById('map').style.cursor = '';
    if (currentRouteLayer) map.removeLayer(currentRouteLayer);
    routeStartCoords = null;
    routeEndCoords = null;
    document.getElementById('routeStart').value = '';
    document.getElementById('routeEnd').value = '';
    document.getElementById('routeResult').innerHTML = '';
  }
}

map.on('click', function(e) {
  if (!routePlannerActive) return;
  const lat = e.latlng.lat;
  const lng = e.latlng.lng;
  
  if (!routeStartCoords) {
    routeStartCoords = { lat, lng };
    document.getElementById('routeStart').value = lat.toFixed(4) + ', ' + lng.toFixed(4);
  } else if (!routeEndCoords) {
    routeEndCoords = { lat, lng };
    document.getElementById('routeEnd').value = lat.toFixed(4) + ', ' + lng.toFixed(4);
    calculateRoute(); // auto calc
  } else {
    // Reset
    routeStartCoords = { lat, lng };
    routeEndCoords = null;
    document.getElementById('routeStart').value = lat.toFixed(4) + ', ' + lng.toFixed(4);
    document.getElementById('routeEnd').value = '';
    if (currentRouteLayer) map.removeLayer(currentRouteLayer);
    document.getElementById('routeResult').innerHTML = '';
  }
});

function resolveLocation(input) {
  if (!input) return null;
  const str = input.toLowerCase().trim();
  if (NAGPUR_LANDMARKS[str]) return NAGPUR_LANDMARKS[str];
  const parts = str.split(',').map(s => parseFloat(s));
  if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
    return { lat: parts[0], lng: parts[1] };
  }
  return null;
}

function haversineDist(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // metres
  const p1 = lat1 * Math.PI/180;
  const p2 = lat2 * Math.PI/180;
  const dp = (lat2-lat1) * Math.PI/180;
  const dl = (lon2-lon1) * Math.PI/180;
  const a = Math.sin(dp/2) * Math.sin(dp/2) +
            Math.cos(p1) * Math.cos(p2) *
            Math.sin(dl/2) * Math.sin(dl/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

async function calculateRoute() {
  const startInput = document.getElementById('routeStart').value;
  const endInput = document.getElementById('routeEnd').value;
  
  const start = resolveLocation(startInput) || routeStartCoords;
  const end = resolveLocation(endInput) || routeEndCoords;
  
  if (!start || !end) {
    alert('Please provide valid start and destination locations.');
    return;
  }
  
  const container = document.getElementById('routeResult');
  container.innerHTML = '<p>Calculating real road route (OSRM)...</p>';
  
  try {
    // OSRM Public API (requires lon,lat order)
    const url = `https://router.project-osrm.org/route/v1/driving/${start.lng},${start.lat};${end.lng},${end.lat}?overview=full&geometries=geojson&alternatives=true`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('OSRM network response was not ok');
    
    const data = await res.json();
    if (!data.routes || data.routes.length === 0) {
      container.innerHTML = '<p style="color:var(--risk-high)">No route found.</p>';
      return;
    }
    
    // Evaluate OSRM routes against our junction risk
    const routesWithRisk = data.routes.map(r => {
      // Analyze route risk using window._allJunctions
      let riskScore = 0;
      let incidentCount = 0;
      let highRiskJunctions = 0;
      
      const coords = r.geometry.coordinates; // [lng, lat][]
      
      // We sample every Nth point on the geometry to keep it fast
      const points = [];
      for(let i=0; i<coords.length; i+=10) { points.push(coords[i]); }
      if (points.length === 0 && coords.length > 0) points.push(coords[0]);
      
      if (window._allJunctions) {
        points.forEach(pt => {
          const ptLat = pt[1];
          const ptLng = pt[0];
          // Find nearest junction within 500m
          let nearestJ = null;
          let minDist = 500; 
          window._allJunctions.forEach(j => {
            const d = haversineDist(ptLat, ptLng, j.lat, j.lng);
            if (d < minDist) { minDist = d; nearestJ = j; }
          });
          
          if (nearestJ) {
            riskScore += nearestJ.risk.total;
            if (nearestJ.risk.total > 70) highRiskJunctions++;
          }
        });
        riskScore = points.length > 0 ? (riskScore / points.length) : 0;
      }
      
      // OSRM duration is in seconds, distance in meters
      const durationMins = Math.round(r.duration / 60);
      const distKm = (r.distance / 1000).toFixed(1);
      
      // Composite Score: Lower is better (Time + Risk Penalty)
      const compositeScore = durationMins + (riskScore * 0.1);
      
      return {
        osrm: r,
        durationMins,
        distKm,
        riskScore: Math.round(riskScore),
        compositeScore
      };
    });
    
    // Sort by composite score (lowest first)
    routesWithRisk.sort((a, b) => a.compositeScore - b.compositeScore);
    
    displayRouteOnMap(routesWithRisk[0].osrm.geometry.coordinates, routesWithRisk[0].riskScore);
    renderRouteCards(routesWithRisk);
    deployOfficersOnRoute(routesWithRisk[0].routeJunctions);
    
  } catch (err) {
    container.innerHTML = '<p style="color:var(--risk-high)">Failed to compute route: ' + err.message + '</p>';
  }
}

function displayRouteOnMap(coordinates, riskScore) {
  if (currentRouteLayer) map.removeLayer(currentRouteLayer);
  
  // OSRM geojson coordinates are [lng, lat], Leaflet wants [lat, lng]
  const latLngs = coordinates.map(c => [c[1], c[0]]);
  
  const color = riskScore > 70 ? 'var(--risk-high)' : riskScore > 40 ? 'var(--risk-medium)' : 'var(--risk-low)';
  
  const polyline = L.polyline(latLngs, {
    color: color,
    weight: 6,
    opacity: 0.9
  });
  
  // Continuous arrow pattern using Leaflet PolylineDecorator
  const arrows = L.polylineDecorator(polyline, {
    patterns: [
      {
        offset: '5%', 
        repeat: '10%', 
        symbol: L.Symbol.arrowHead({
          pixelSize: 14, 
          polygon: false, 
          pathOptions: { stroke: true, color: '#ffffff', weight: 2, opacity: 0.9 }
        })
      }
    ]
  });

  currentRouteLayer = L.layerGroup([polyline, arrows]).addTo(map);
  map.fitBounds(polyline.getBounds(), { padding: [50, 50] });
}

function renderRouteCards(routes) {
  const container = document.getElementById('routeResult');
  let html = '';
  
  routes.forEach((r, idx) => {
    const isRec = idx === 0;
    const barColor = r.riskScore > 70 ? 'var(--risk-high)' : r.riskScore > 40 ? 'var(--risk-medium)' : 'var(--risk-low)';
    const barWidth = Math.min(100, r.riskScore) + '%';
    
    // We escape quotes for the onclick handler
    const coordsJson = JSON.stringify(r.osrm.geometry.coordinates).replace(/"/g, '&quot;');
    
    html += `<div class="route-card ${isRec ? 'recommended' : ''}" ${!isRec ? `style="cursor:pointer;" onclick="displayRouteOnMap(${coordsJson}, ${r.riskScore})"` : ''}>
      <div class="route-header">
        <div class="route-title">
          ${isRec ? '<span class="badge-rec">BEST</span>' : ''} Route ${idx + 1}
        </div>
        <div class="route-eta">${r.durationMins} min</div>
      </div>
      <div class="route-stats">
        <div class="route-stat-item">Dist: <span>${r.distKm} km</span></div>
        <div class="route-stat-item">Risk: <span style="color:${barColor}">${r.riskScore}</span></div>
      </div>
      <div class="risk-bar-container">
        <div class="risk-bar" style="width:${barWidth}; background:${barColor}"></div>
      </div>
    </div>`;
  });
  
  container.innerHTML = html;
}

function deployOfficersOnRoute(routeJunctions) {
  if (!routeJunctions || routeJunctions.length === 0) return;
  
  // Clear normal officer deployment layer and visually deploy officers only on this route
  officerLayerGroup.clearLayers();
  
  // Get max officers user requested
  const maxOfficers = parseInt(document.getElementById('officerCount').value, 10) || 25;
  const numToDeploy = Math.min(maxOfficers, routeJunctions.length);
  
  // Sort route junctions by risk descending to prioritize deployment on the route
  const sortedJunctions = [...routeJunctions].sort((a, b) => b.risk.total - a.risk.total);
  const targetJunctions = sortedJunctions.slice(0, numToDeploy);
  
  targetJunctions.forEach((junction, i) => {
    var icon = L.divIcon({
      className:'officer-icon',
      html:'<div style="background:#22c55e;color:white;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.3);cursor:pointer;">&#128110;</div>',
      iconSize:[22,22], iconAnchor:[11,11]
    });
    // Snap directly to the junction coordinates (on the road)
    var m = L.marker([junction.lat, junction.lng], {icon:icon, zIndexOffset: 1000});
    m.bindTooltip("Route Escort " + (i+1) + " at " + junction.name, { direction:'top', offset:[0,-14] });
    m.addTo(officerLayerGroup);
  });
}