/* NGP-TRAFFIC Control Room – Main Application */
var state = {
  currentData: null,
  deploymentMode: 'optimized',
  liveHour: new Date().getHours(),
  viewingHour: null, // null = live
  officerCount: 654,
  searchFilter: '',
  previousDeployment: null
};

var map, heatLayer, junctionLayerGroup, officerLayerGroup, stationLayerGroup, incidentLayerGroup;
var trafficRoadLayerGroup;
var roadSegmentsData = null;
var riskChart = null;

document.addEventListener('DOMContentLoaded', function() {
  initClock();
  initMap();
  initRiskChart();
  loadInitialData().then(function() {
    initRoutePlanner(); // must be after map AND data are loaded
    refreshData();
    hideLoading();
    // Auto-refresh every 10 seconds to pick up incidents from Simulation Lab or Citizen App
    setInterval(function() { if (isLiveMode()) refreshData(); }, 10000);
  });
});

// -- CLOCK (real system time, auto-updating) --
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

// -- HISTORICAL SLIDER (past-only) --
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

// -- MAP --
function initMap() {
  map = L.map('map', { center:[21.1458,79.0882], zoom:13, zoomControl:true, attributionControl:false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:19 }).addTo(map);
  L.control.attribution({ position:'bottomright', prefix:false }).addAttribution('NGP-TRAFFIC').addTo(map);
  junctionLayerGroup = L.layerGroup().addTo(map);
  officerLayerGroup = L.layerGroup().addTo(map);
  stationLayerGroup = L.layerGroup().addTo(map);
  incidentLayerGroup = L.layerGroup().addTo(map);
  trafficRoadLayerGroup = L.layerGroup().addTo(map);
  heatLayer = L.heatLayer([], { radius:15, blur:15, maxZoom:15, max:100, gradient:{0.2:'#3dbc72',0.4:'#84cc16',0.6:'#d4a72c',0.8:'#d47c2c',1.0:'#c94444'} }).addTo(map);
}

// -- DATA --
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
    roadSegmentsData = results[3];
    // Populate datalist for route planner landmark autocomplete
    var datalist = document.getElementById('squareNames');
    if (datalist && roadSegmentsData) {
      roadSegmentsData.forEach(function(seg) {
        var opt = document.createElement('option');
        opt.value = seg.name;
        datalist.appendChild(opt);
      });
    }
    // Populate _allJunctions for route risk scoring
    window._allJunctions = null; // will be set after first refreshData
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
      // Set _allJunctions for route planner risk scoring
      window._allJunctions = data.junctions;
      updateMap(data);
      updateTable(data);
      updateStats(data);
      updateNotifications(data);
      if (prevDeploy) detectRedeployments(prevDeploy, state.deploymentMode === 'baseline' ? data.baselineDeployment : data.optimizedDeployment, data);
    });
}

// -- MAP RENDERING --
function updateMap(data) {
  junctionLayerGroup.clearLayers();
  officerLayerGroup.clearLayers();
  incidentLayerGroup.clearLayers();
  var deployment = state.deploymentMode === 'baseline' ? data.baselineDeployment : data.optimizedDeployment;

  // Heatmap from junction risk data
  var heatPoints = [];
  data.junctions.forEach(function(j) {
    heatPoints.push([j.lat, j.lng, j.risk.total]);
  });
  // Also add road traffic heat if available
  if (roadSegmentsData) {
    roadSegmentsData.forEach(function(seg) {
      var riskIntensity = seg.trafficVolume ? (seg.trafficVolume * 100) : 50;
      seg.points.forEach(function(pt, idx) {
        if (idx % 3 === 0) {
          heatPoints.push([pt[0], pt[1], riskIntensity]);
        }
      });
    });
  }
  heatLayer.setLatLngs(heatPoints);

  // Junctions
  data.junctions.forEach(function(j) {
    var color = j.risk.level === 'high' ? '#c94444' : j.risk.level === 'medium' ? '#d4a72c' : '#3dbc72';
    var r = j.risk.level === 'high' ? 8 : j.risk.level === 'medium' ? 6 : 5;
    var offArr = deployment[j.id];
    var hasOff = offArr && offArr.length > 0;
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
    var officerArray = deployment[jid];
    if (!junction || !officerArray || !Array.isArray(officerArray) || officerArray.length === 0) return;
    var count = officerArray.length;
    var icon = L.divIcon({
      className:'officer-icon',
      html:'<div style="background:#4a90d9;color:white;width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:bold;border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.3);cursor:pointer;">' + count + '</div>',
      iconSize:[26,26],
      iconAnchor:[13,13]
    });
    var offMarker = L.marker([junction.lat, junction.lng], {icon:icon, zIndexOffset:1000});
    // Show officer names in tooltip
    var names = officerArray.slice(0, 5).map(function(o) { return o.name; }).join(', ');
    if (officerArray.length > 5) names += ' +' + (officerArray.length - 5) + ' more';
    offMarker.bindTooltip(count + ' Officers: ' + names, { direction:'bottom', offset:[0,5] });
    offMarker.addTo(officerLayerGroup);
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

// -- TABLE --
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
    var offArr = deployment[j.id];
    var hasOff = offArr && offArr.length > 0;
    var offName = hasOff ? offArr.length + ' Officers' : '--';
    if (hasOff && offArr[0]) offName += ' (' + offArr[0].name.split(' ')[0] + '...)';
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

// -- STATS --
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

// -- CHART --
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

// -- NOTIFICATIONS --
function updateNotifications(data) {
  var list = document.getElementById('notificationsList');
  var items = [];
  if (data.unmannedHighRisk && Array.isArray(data.unmannedHighRisk)) {
    data.unmannedHighRisk.forEach(function(j) {
      items.push({ icon:'&#9888;', title:j.name+' - No officer assigned', desc:'High-risk junction (Score: '+j.risk.total+') requires attention', type:'warning', time:'Now' });
    });
  }
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

// -- REDEPLOYMENT TOAST --
function detectRedeployments(prev, curr, data) {
  Object.keys(curr).forEach(function(jid) {
    var currArr = curr[jid];
    var prevArr = prev[jid];
    if (!currArr || !Array.isArray(currArr) || currArr.length === 0) return;
    var prevIds = (prevArr && Array.isArray(prevArr)) ? prevArr.map(function(o){return o.id;}) : [];
    var newOfficers = currArr.filter(function(o) { return prevIds.indexOf(o.id) === -1; });
    if (newOfficers.length > 0) {
      var j = data.junctions.find(function(x){return x.id===jid;});
      if (j && j.risk.level !== 'low') {
        showToast({
          title:'Redeployment Required',
          body: newOfficers[0].name + ' -> ' + j.name + '\nReason: ' + (j.risk.level==='high'?'High-risk junction':'Medium-risk coverage') + '\nPriority: ' + j.risk.level.toUpperCase(),
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

// -- DETAIL PANELS --
function showJunctionDetail(jid) {
  var data = state.currentData; if (!data) return;
  var j = data.junctions.find(function(x){return x.id===jid;});
  if (!j) return;
  var deployment = state.deploymentMode==='baseline' ? data.baselineDeployment : data.optimizedDeployment;
  var offArr = deployment[j.id];
  var hasOff = offArr && offArr.length > 0;
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
  var offNameStr = hasOff ? offArr.map(function(o){return o.name;}).join(', ') : 'None';
  html += '<div class="detail-row"><span class="detail-row-label">Assigned Officers</span><span class="detail-row-value" style="color:'+(hasOff?'var(--green)':'var(--red)')+'">'+offNameStr+'</span></div>';
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
  // Collect all deployed officer IDs
  var deployedIds = [];
  Object.values(deployment).forEach(function(arr) {
    if (Array.isArray(arr)) {
      arr.forEach(function(o) { deployedIds.push(o.id); });
    }
  });
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
    deployed.slice(0, 20).forEach(function(o) {
      var atJunction = null;
      Object.keys(deployment).forEach(function(jid) {
        if (Array.isArray(deployment[jid])) {
          deployment[jid].forEach(function(dOff) {
            if (dOff.id === o.id) {
              atJunction = data ? data.junctions.find(function(x){return x.id===jid;}) : null;
            }
          });
        }
      });
      html += '<div class="detail-row"><span class="detail-row-label">'+o.name+'</span><span class="detail-row-value" style="font-size:10px">'+(atJunction?atJunction.name:'--')+'</span></div>';
    });
    if (deployed.length > 20) html += '<div class="detail-row"><span class="detail-row-label" style="color:var(--text-muted)">...and ' + (deployed.length - 20) + ' more</span></div>';
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
  var isDeployed = false;
  Object.values(deployment).forEach(function(arr) {
    if (Array.isArray(arr)) {
      arr.forEach(function(o) { if (o.id === offId) isDeployed = true; });
    }
  });

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

// -- CONTROLS --
function changeOfficers(delta) {
  var input = document.getElementById('officerCount');
  var val = Math.max(1, Math.min(654, parseInt(input.value)+delta));
  input.value = val;
  state.officerCount = val;
  refreshData();
}

function onOfficerChange(val) {
  state.officerCount = Math.max(1, Math.min(654, parseInt(val)));
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
  else if (layer==='traffic') {
    var cb = document.getElementById('cbTraffic');
    if (cb && cb.checked) {
      map.addLayer(trafficRoadLayerGroup);
      renderTrafficRoads();
    } else {
      map.removeLayer(trafficRoadLayerGroup);
    }
  }
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

// -- Socket.IO Real-time --
var socket = typeof io !== 'undefined' ? io() : null;
if (socket) {
  socket.on('incident:new', function(data) {
    showToast({ title: 'NEW INCIDENT: ' + data.incident.name, body: 'Severity: ' + data.incident.severity.toUpperCase(), urgent: data.incident.severity === 'high' });
    refreshData();
  });
  socket.on('deployment:update', function() { refreshData(); });
  socket.on('incident:resolved', function(data) {
    showToast({ title: 'Incident resolved', body: 'ID: ' + data.id, urgent: false });
    refreshData();
  });
  socket.on('incidents:cleared', function() { refreshData(); });
  socket.on('officer:status', function(data) {
    showToast({ title: 'Officer Update', body: 'Officer ' + data.officerId + ': ' + data.status.status, urgent: false });
  });
}

// -- ML Metrics Modal --
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

    // Feature importance chart
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

    // PvA chart
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


// =============================================
// === OSRM ROUTE PLANNER ===
// =============================================

var routePlannerActive = false;
var routeStartCoords = null;
var routeEndCoords = null;
var currentRouteLayer = null;

var NAGPUR_LANDMARKS = {
  'sitabuldi': { lat: 21.1466, lng: 79.0779 },
  'variety square': { lat: 21.1458, lng: 79.0882 },
  'vnit nagpur': { lat: 21.1249, lng: 79.0508 },
  'vnit': { lat: 21.1249, lng: 79.0508 },
  'airport': { lat: 21.0558, lng: 79.0520 },
  'it park': { lat: 21.1166, lng: 79.0270 },
  'medical square': { lat: 21.1309, lng: 79.0968 },
  'dharampeth': { lat: 21.1396, lng: 79.0645 },
  'sadar': { lat: 21.1558, lng: 79.0867 },
  'manewada': { lat: 21.1683, lng: 79.0700 },
  'hingna': { lat: 21.1015, lng: 78.9951 },
  'cotton market': { lat: 21.1533, lng: 79.0820 },
  'pardi': { lat: 21.1390, lng: 79.1026 },
  'wardha road': { lat: 21.1170, lng: 79.0930 }
};

function toggleRoutePlanner() {
  var overlay = document.getElementById('routePlannerOverlay');
  routePlannerActive = !routePlannerActive;
  if (routePlannerActive) {
    overlay.classList.add('active');
    document.getElementById('map').style.cursor = 'crosshair';
  } else {
    overlay.classList.remove('active');
    document.getElementById('map').style.cursor = '';
    if (currentRouteLayer) { map.removeLayer(currentRouteLayer); currentRouteLayer = null; }
    routeStartCoords = null;
    routeEndCoords = null;
    document.getElementById('routeStart').value = '';
    document.getElementById('routeEnd').value = '';
    document.getElementById('routeResult').innerHTML = '';
  }
}

function initRoutePlanner() {
  if (!map) return;
  // Also populate landmarks into datalist
  var datalist = document.getElementById('squareNames');
  if (datalist) {
    Object.keys(NAGPUR_LANDMARKS).forEach(function(name) {
      var opt = document.createElement('option');
      opt.value = name;
      datalist.appendChild(opt);
    });
    // Add junction names from data
    if (window._allJunctions) {
      window._allJunctions.forEach(function(j) {
        var opt = document.createElement('option');
        opt.value = j.name;
        datalist.appendChild(opt);
      });
    }
  }
  map.on('click', function(e) {
    if (!routePlannerActive) return;
    var lat = e.latlng.lat;
    var lng = e.latlng.lng;

    if (!routeStartCoords) {
      routeStartCoords = { lat: lat, lng: lng };
      document.getElementById('routeStart').value = lat.toFixed(4) + ', ' + lng.toFixed(4);
    } else if (!routeEndCoords) {
      routeEndCoords = { lat: lat, lng: lng };
      document.getElementById('routeEnd').value = lat.toFixed(4) + ', ' + lng.toFixed(4);
      calculateRoute(); // auto calc
    } else {
      // Reset
      routeStartCoords = { lat: lat, lng: lng };
      routeEndCoords = null;
      document.getElementById('routeStart').value = lat.toFixed(4) + ', ' + lng.toFixed(4);
      document.getElementById('routeEnd').value = '';
      if (currentRouteLayer) { map.removeLayer(currentRouteLayer); currentRouteLayer = null; }
      document.getElementById('routeResult').innerHTML = '';
    }
  });
}

function resolveLocation(input) {
  if (!input) return null;
  var str = input.toLowerCase().trim();
  // Check landmarks
  if (NAGPUR_LANDMARKS[str]) return NAGPUR_LANDMARKS[str];
  // Check junction names
  if (window._allJunctions) {
    var match = window._allJunctions.find(function(j) { return j.name.toLowerCase() === str; });
    if (match) return { lat: match.lat, lng: match.lng };
  }
  // Check lat,lng format
  var parts = str.split(',');
  if (parts.length === 2) {
    var lat = parseFloat(parts[0]);
    var lng = parseFloat(parts[1]);
    if (!isNaN(lat) && !isNaN(lng)) return { lat: lat, lng: lng };
  }
  return null;
}

function haversineDist(lat1, lon1, lat2, lon2) {
  var R = 6371e3;
  var dLat = (lat2 - lat1) * Math.PI / 180;
  var dLon = (lon2 - lon1) * Math.PI / 180;
  var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
          Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) *
          Math.sin(dLon/2) * Math.sin(dLon/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function calculateRoute() {
  var startInput = document.getElementById('routeStart').value;
  var endInput = document.getElementById('routeEnd').value;

  var start = resolveLocation(startInput) || routeStartCoords;
  var end = resolveLocation(endInput) || routeEndCoords;

  if (!start || !end) {
    document.getElementById('routeResult').innerHTML = '<p style="color:#d4a72c">Please provide valid start and destination locations.</p>';
    return;
  }

  var container = document.getElementById('routeResult');
  container.innerHTML = '<p style="color:#7a8ba5">Calculating real road route (OSRM)...</p>';

  // OSRM Public API (requires lon,lat order)
  var url = 'https://router.project-osrm.org/route/v1/driving/' + start.lng + ',' + start.lat + ';' + end.lng + ',' + end.lat + '?overview=full&geometries=geojson&alternatives=true';

  fetch(url)
    .then(function(res) {
      if (!res.ok) throw new Error('OSRM returned status ' + res.status);
      return res.json();
    })
    .then(function(data) {
      if (!data.routes || data.routes.length === 0) {
        container.innerHTML = '<p style="color:#c94444">No route found between these points.</p>';
        return;
      }

      // Evaluate OSRM routes against our junction risk
      var routesWithRisk = data.routes.map(function(r) {
        var riskScore = 0;
        var highRiskJunctions = 0;

        var coords = r.geometry.coordinates; // [lng, lat][]

        // Sample every Nth point on the geometry
        var points = [];
        for (var i = 0; i < coords.length; i += 10) { points.push(coords[i]); }
        if (points.length === 0 && coords.length > 0) points.push(coords[0]);

        if (window._allJunctions) {
          points.forEach(function(pt) {
            var ptLat = pt[1];
            var ptLng = pt[0];
            var nearestJ = null;
            var minDist = 500;
            window._allJunctions.forEach(function(j) {
              var d = haversineDist(ptLat, ptLng, j.lat, j.lng);
              if (d < minDist) { minDist = d; nearestJ = j; }
            });
            if (nearestJ) {
              riskScore += nearestJ.risk.total;
              if (nearestJ.risk.total > 70) highRiskJunctions++;
            }
          });
          riskScore = points.length > 0 ? Math.round(riskScore / points.length) : 0;
        }

        var durationMins = Math.round(r.duration / 60);
        var distKm = (r.distance / 1000).toFixed(1);
        var compositeScore = durationMins + (riskScore * 0.1);

        return {
          osrm: r,
          durationMins: durationMins,
          distKm: distKm,
          riskScore: riskScore,
          highRiskJunctions: highRiskJunctions,
          compositeScore: compositeScore
        };
      });

      // Sort by composite score (lowest first)
      routesWithRisk.sort(function(a, b) { return a.compositeScore - b.compositeScore; });

      displayRouteOnMap(routesWithRisk[0].osrm.geometry.coordinates, routesWithRisk[0].riskScore);
      renderRouteCards(routesWithRisk);
    })
    .catch(function(err) {
      container.innerHTML = '<p style="color:#c94444">Failed to compute route: ' + err.message + '</p>';
    });
}

function displayRouteOnMap(coordinates, riskScore) {
  if (currentRouteLayer) { map.removeLayer(currentRouteLayer); currentRouteLayer = null; }

  // OSRM geojson coordinates are [lng, lat], Leaflet wants [lat, lng]
  var latLngs = coordinates.map(function(c) { return [c[1], c[0]]; });

  // Use actual hex colors (Leaflet doesn't support CSS variables)
  var color = riskScore > 70 ? '#c94444' : riskScore > 40 ? '#d4a72c' : '#3dbc72';

  currentRouteLayer = L.layerGroup();

  var routeLine = L.polyline(latLngs, {
    color: color,
    weight: 6,
    opacity: 0.8,
    dashArray: '10, 5'
  }).addTo(currentRouteLayer);

  // Add direction arrows
  try {
    L.polylineDecorator(routeLine, {
      patterns: [
        { offset: '5%', repeat: 80, symbol: L.Symbol.arrowHead({ pixelSize: 10, polygon: false, pathOptions: { stroke: true, color: '#fff', weight: 2 } }) }
      ]
    }).addTo(currentRouteLayer);
  } catch(e) { /* polylineDecorator might not be loaded */ }

  // Add start/end markers
  if (latLngs.length > 0) {
    L.circleMarker(latLngs[0], { radius: 8, fillColor: '#3dbc72', color: '#fff', weight: 2, fillOpacity: 1 })
      .bindTooltip('Start', { permanent: true, direction: 'top', offset: [0, -10] })
      .addTo(currentRouteLayer);
    L.circleMarker(latLngs[latLngs.length - 1], { radius: 8, fillColor: '#c94444', color: '#fff', weight: 2, fillOpacity: 1 })
      .bindTooltip('End', { permanent: true, direction: 'top', offset: [0, -10] })
      .addTo(currentRouteLayer);
  }

  currentRouteLayer.addTo(map);
  map.fitBounds(routeLine.getBounds(), { padding: [50, 50] });
}

function renderRouteCards(routes) {
  var container = document.getElementById('routeResult');
  var html = '';

  routes.forEach(function(r, idx) {
    var isRec = idx === 0;
    var barColor = r.riskScore > 70 ? '#c94444' : r.riskScore > 40 ? '#d4a72c' : '#3dbc72';
    var barWidth = Math.min(100, r.riskScore) + '%';

    html += '<div class="route-card ' + (isRec ? 'recommended' : '') + '" style="cursor:pointer;" onclick="selectRoute(' + idx + ')" data-route-idx="' + idx + '">' +
      '<div class="route-header">' +
        '<div class="route-title">' +
          (isRec ? '<span class="badge-rec">BEST</span>' : '') + ' Route ' + (idx + 1) +
        '</div>' +
        '<div class="route-eta">' + r.durationMins + ' min</div>' +
      '</div>' +
      '<div class="route-stats">' +
        '<div class="route-stat-item">Dist: <span>' + r.distKm + ' km</span></div>' +
        '<div class="route-stat-item">Risk: <span style="color:' + barColor + '">' + r.riskScore + '</span></div>' +
        '<div class="route-stat-item">High-Risk Zones: <span style="color:#c94444">' + r.highRiskJunctions + '</span></div>' +
      '</div>' +
      '<div class="risk-bar-container">' +
        '<div class="risk-bar" style="width:' + barWidth + '; background:' + barColor + '"></div>' +
      '</div>' +
    '</div>';
  });

  container.innerHTML = html;
  // Store routes globally for selection
  window._routeResults = routes;
}

function selectRoute(idx) {
  if (!window._routeResults || !window._routeResults[idx]) return;
  var r = window._routeResults[idx];
  displayRouteOnMap(r.osrm.geometry.coordinates, r.riskScore);
}


// =============================================
// === TRAFFIC VISUALIZATION ===
// =============================================

function randomizeTraffic(noRender) {
  if (!roadSegmentsData) return;
  var hour = getCurrentHour();
  var timeMod = 1.0;
  if (hour >= 8 && hour <= 11) timeMod = 1.5;
  else if (hour >= 17 && hour <= 20) timeMod = 1.6;
  else if (hour >= 1 && hour <= 5) timeMod = 0.2;

  roadSegmentsData.forEach(function(seg) {
    var baseVal = ((seg.name.length * 13) % 100) / 100.0;
    var randomJitter = Math.random() * 0.4 - 0.2;
    var traffic = (baseVal + randomJitter) * timeMod;
    seg.trafficVolume = Math.min(Math.max(traffic, 0.1), 1.0);
  });
  if (!noRender) renderTrafficRoads();

  // Also tell the backend to randomize junction traffic
  if (!noRender) {
    fetch('/api/randomize-traffic', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hour: hour })
    }).then(function() { refreshData(); });
  }
}

var trafficAnimInterval = null;
var trafficDecorators = [];

function renderTrafficRoads() {
  if (!trafficRoadLayerGroup) return;
  trafficRoadLayerGroup.clearLayers();

  if (trafficAnimInterval) { clearInterval(trafficAnimInterval); trafficAnimInterval = null; }
  trafficDecorators = [];

  if (!roadSegmentsData) return;

  var cb = document.getElementById('cbTraffic');
  if (!cb || !cb.checked) return;

  roadSegmentsData.forEach(function(seg) {
    if (seg.trafficVolume === undefined) seg.trafficVolume = Math.random();
    var color = seg.trafficVolume > 0.7 ? '#c94444' : (seg.trafficVolume > 0.4 ? '#d4a72c' : '#3dbc72');
    var weight = seg.trafficVolume > 0.7 ? 5 : (seg.trafficVolume > 0.4 ? 4 : 3);
    var poly = L.polyline(seg.points, {color: color, weight: weight, opacity: 0.7});
    poly.bindTooltip(seg.name + '<br>Traffic: ' + Math.round(seg.trafficVolume * 100) + '%', {direction: 'center'});
    poly.addTo(trafficRoadLayerGroup);

    try {
      var dec = L.polylineDecorator(poly, {
        patterns: [
          { offset: 0, repeat: 40, symbol: L.Symbol.arrowHead({pixelSize: 8, polygon: false, pathOptions: {stroke: true, color: '#fff', weight: 2}}) }
        ]
      }).addTo(trafficRoadLayerGroup);
      trafficDecorators.push({ dec: dec, offset: 0, speed: (1.2 - seg.trafficVolume) * 5 });
    } catch(e) { /* polylineDecorator might not be loaded */ }
  });

  if (trafficDecorators.length > 0) {
    trafficAnimInterval = setInterval(function() {
      trafficDecorators.forEach(function(item) {
        item.offset = (item.offset + item.speed) % 40;
        try {
          item.dec.setPatterns([
            { offset: item.offset + 'px', repeat: 40, symbol: L.Symbol.arrowHead({pixelSize: 8, polygon: false, pathOptions: {stroke: true, color: '#fff', weight: 2}}) }
          ]);
        } catch(e) {}
      });
    }, 100);
  }
}
