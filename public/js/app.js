(function () {
  'use strict';

  const NAGPUR_CENTER = [21.1458, 79.0882];
  const BASEMAPS = {
    light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatRelativeTime(isoString) {
    if (!isoString) return 'Waiting for update';
    const diffSec = Math.max(0, Math.floor((Date.now() - new Date(isoString).getTime()) / 1000));
    if (diffSec < 60) return 'Just now';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    return `${diffHr}h ago`;
  }

  // ── Map Initialization ──
  const map = L.map('map', {
    center: NAGPUR_CENTER,
    zoom: 13,
    zoomControl: false
  });

  L.control.zoom({ position: 'bottomright' }).addTo(map);

  const savedTheme = localStorage.getItem('ngp_theme') === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', savedTheme);

  let baseLayer = L.tileLayer(BASEMAPS[savedTheme], {
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    subdomains: 'abcd',
    maxZoom: 19
  }).addTo(map);

  const trafficFlowLayer = L.tileLayer('/tiles/traffic/{z}/{x}/{y}.png', {
    maxZoom: 19,
    opacity: 0.78
  }).addTo(map);

  const incidentsLayerGroup = L.layerGroup().addTo(map);
  const alertsLayerGroup = L.layerGroup().addTo(map);
  const routeLayerGroup = L.layerGroup().addTo(map);

  // ── State ──
  let latestState = {
    updatedAt: null,
    tomtomConfigured: true,
    weather: null,
    junctions: [],
    incidents: [],
    predictions: []
  };

  const routeState = {
    origin: null,
    destination: null,
    activeRouteType: 'fastest',
    routes: null,
    fastestLine: null,
    shortestLine: null
  };

  const alertMarkersById = new Map();

  // ── DOM Elements ──
  const setupBanner = document.getElementById('setup-banner');
  const updatedText = document.getElementById('updated-text');
  const weatherSep = document.getElementById('weather-sep');
  const weatherText = document.getElementById('weather-text');

  const themeToggle = document.getElementById('theme-toggle');
  const iconMoon = document.getElementById('icon-moon');
  const iconSun = document.getElementById('icon-sun');

  const layersBtn = document.getElementById('layers-btn');
  const layersPopover = document.getElementById('layers-popover');
  const layerFlowCheckbox = document.getElementById('layer-flow');
  const layerIncidentsCheckbox = document.getElementById('layer-incidents');
  const layerAlertsCheckbox = document.getElementById('layer-alerts');

  const alertsDrawer = document.getElementById('alerts-drawer');
  const drawerOpenBtn = document.getElementById('drawer-open-btn');
  const drawerCloseBtn = document.getElementById('drawer-close-btn');
  const drawerOpenCount = document.getElementById('drawer-open-count');
  const alertsCount = document.getElementById('alerts-count');
  const alertsList = document.getElementById('alerts-list');

  const originInput = document.getElementById('origin-input');
  const destInput = document.getElementById('dest-input');
  const originDropdown = document.getElementById('origin-dropdown');
  const destDropdown = document.getElementById('dest-dropdown');
  const swapBtn = document.getElementById('swap-btn');
  const clearRouteBtn = document.getElementById('clear-route-btn');
  const routeStatus = document.getElementById('route-status');
  const routeCards = document.getElementById('route-cards');
  const cardFastest = document.getElementById('card-fastest');
  const cardShortest = document.getElementById('card-shortest');
  const fastestTimeEl = document.getElementById('fastest-time');
  const fastestMetaEl = document.getElementById('fastest-meta');
  const shortestTimeEl = document.getElementById('shortest-time');
  const shortestMetaEl = document.getElementById('shortest-meta');

  // ── Theme Controls ──
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('ngp_theme', theme);
    iconMoon.classList.toggle('hidden', theme === 'dark');
    iconSun.classList.toggle('hidden', theme !== 'dark');

    if (baseLayer) {
      map.removeLayer(baseLayer);
    }
    baseLayer = L.tileLayer(BASEMAPS[theme], {
      attribution: '&copy; OpenStreetMap &copy; CARTO',
      subdomains: 'abcd',
      maxZoom: 19
    }).addTo(map);
    baseLayer.bringToBack();
  }

  applyTheme(savedTheme);

  themeToggle.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    applyTheme(current === 'dark' ? 'light' : 'dark');
  });

  // ── Layers Popover ──
  layersBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const expanded = layersPopover.classList.toggle('hidden') === false;
    layersBtn.setAttribute('aria-expanded', String(expanded));
  });

  document.addEventListener('click', (e) => {
    if (!layersPopover.contains(e.target) && !layersBtn.contains(e.target)) {
      layersPopover.classList.add('hidden');
      layersBtn.setAttribute('aria-expanded', 'false');
    }
    if (!originInput.contains(e.target) && !originDropdown.contains(e.target)) {
      originDropdown.classList.add('hidden');
    }
    if (!destInput.contains(e.target) && !destDropdown.contains(e.target)) {
      destDropdown.classList.add('hidden');
    }
  });

  layerFlowCheckbox.addEventListener('change', () => {
    if (layerFlowCheckbox.checked) {
      trafficFlowLayer.addTo(map);
    } else {
      map.removeLayer(trafficFlowLayer);
    }
  });

  layerIncidentsCheckbox.addEventListener('change', () => {
    if (layerIncidentsCheckbox.checked) {
      incidentsLayerGroup.addTo(map);
    } else {
      map.removeLayer(incidentsLayerGroup);
    }
  });

  layerAlertsCheckbox.addEventListener('change', () => {
    if (layerAlertsCheckbox.checked) {
      alertsLayerGroup.addTo(map);
    } else {
      map.removeLayer(alertsLayerGroup);
    }
  });

  // ── Alerts Drawer Collapse (closed by default on mobile) ──
  function setDrawerOpen(open) {
    alertsDrawer.classList.toggle('collapsed', !open);
    drawerOpenBtn.classList.toggle('hidden', open);
  }

  if (window.matchMedia('(max-width: 768px)').matches) {
    setDrawerOpen(false);
  } else {
    setDrawerOpen(true);
  }

  drawerCloseBtn.addEventListener('click', () => setDrawerOpen(false));
  drawerOpenBtn.addEventListener('click', () => setDrawerOpen(true));

  // ── Render Live State ──
  function renderStatusBar() {
    setupBanner.classList.toggle('hidden', Boolean(latestState.tomtomConfigured));
    updatedText.textContent = formatRelativeTime(latestState.updatedAt);

    if (latestState.weather) {
      weatherSep.classList.remove('hidden');
      weatherText.classList.remove('hidden');
      weatherText.textContent = `${latestState.weather.temperatureC}°C · ${latestState.weather.condition}`;
    } else {
      weatherSep.classList.add('hidden');
      weatherText.classList.add('hidden');
    }
  }

  function renderIncidents() {
    incidentsLayerGroup.clearLayers();
    const incidents = Array.isArray(latestState.incidents) ? latestState.incidents : [];

    for (const inc of incidents) {
      if (!Number.isFinite(inc.lat) || !Number.isFinite(inc.lng)) continue;
      const marker = L.circleMarker([inc.lat, inc.lng], {
        radius: 5,
        color: '#FFFFFF',
        weight: 1.5,
        fillColor: '#F59E0B',
        fillOpacity: 0.95
      });

      const delayMin = inc.delaySec > 0 ? `${Math.round(inc.delaySec / 60)}m delay` : 'Active incident';
      const corridor = inc.from ? `${escapeHtml(inc.from)}${inc.to ? ' to ' + escapeHtml(inc.to) : ''}` : 'Nagpur corridor';

      marker.bindPopup(
        `<div class="map-popup-title">${escapeHtml(inc.description || 'Traffic Incident')}</div>` +
        `<div class="map-popup-meta">${corridor} · ${escapeHtml(delayMin)}</div>`
      );
      marker.addTo(incidentsLayerGroup);
    }
  }

  function renderAlerts() {
    alertsLayerGroup.clearLayers();
    alertMarkersById.clear();

    const predictions = Array.isArray(latestState.predictions) ? latestState.predictions : [];
    alertsCount.textContent = String(predictions.length);
    drawerOpenCount.textContent = String(predictions.length);

    if (predictions.length === 0) {
      alertsList.innerHTML =
        '<div class="alerts-empty"><p>Traffic flowing smoothly across monitored Nagpur junctions.</p></div>';
      return;
    }

    const fragment = document.createDocumentFragment();

    for (const alert of predictions) {
      const color = alert.severity === 'HIGH' ? '#EF4444' : '#F59E0B';
      const marker = L.circleMarker([alert.lat, alert.lng], {
        radius: alert.severity === 'HIGH' ? 8 : 6,
        color: '#FFFFFF',
        weight: 2,
        fillColor: color,
        fillOpacity: 0.95
      });

      const stationLine = alert.nearestStation
        ? `<div class="map-popup-meta" style="margin-top:4px;">Nearest: ${escapeHtml(alert.nearestStation.shortName)} (${alert.nearestStation.distanceKm} km)</div>`
        : '';

      marker.bindPopup(
        `<div class="map-popup-title">${escapeHtml(alert.name)}</div>` +
        `<div class="map-popup-meta">${escapeHtml(alert.badge)} · ${alert.currentSpeed} km/h vs ${alert.freeFlowSpeed} km/h</div>` +
        `<div class="map-popup-meta" style="margin-top:3px;">${escapeHtml(alert.reason)}</div>` +
        stationLine
      );

      marker.addTo(alertsLayerGroup);
      alertMarkersById.set(alert.id, marker);

      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'alert-card';

      const stationHtml = alert.nearestStation
        ? `<div class="alert-station">
             <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
               <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
             </svg>
             <span>${escapeHtml(alert.nearestStation.shortName)} &middot; ${alert.nearestStation.distanceKm} km</span>
           </div>`
        : '';

      card.innerHTML =
        `<div class="alert-card-top">
           <span class="alert-junction">${escapeHtml(alert.name)}</span>
           <span class="alert-badge ${escapeHtml(alert.category)}">${escapeHtml(alert.badge)}</span>
         </div>
         <div class="alert-speed">${alert.currentSpeed} km/h vs ${alert.freeFlowSpeed} km/h</div>
         <div class="alert-reason">${escapeHtml(alert.reason)}</div>
         ${stationHtml}`;

      card.addEventListener('click', () => {
        if (!layerAlertsCheckbox.checked) {
          layerAlertsCheckbox.checked = true;
          alertsLayerGroup.addTo(map);
        }
        map.flyTo([alert.lat, alert.lng], 15, { duration: 0.6 });
        marker.openPopup();
      });

      fragment.appendChild(card);
    }

    alertsList.innerHTML = '';
    alertsList.appendChild(fragment);
  }

  // Update relative timestamps locally every 30s (zero REST polling)
  setInterval(renderStatusBar, 30000);

  // ── Socket.IO Connection ──
  const socket = io();
  socket.on('traffic:state', (state) => {
    if (!state || typeof state !== 'object') return;
    latestState = state;
    renderStatusBar();
    renderIncidents();
    renderAlerts();
  });

  // ── Place Search Autocomplete ──
  let searchTimer = null;

  async function runPlaceSearch(query, dropdownEl, onSelect) {
    if (query.trim().length < 2) {
      dropdownEl.classList.add('hidden');
      dropdownEl.innerHTML = '';
      return;
    }

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query.trim())}`);
      const data = await res.json();
      const items = Array.isArray(data.results) ? data.results : [];

      if (items.length === 0) {
        dropdownEl.classList.add('hidden');
        dropdownEl.innerHTML = '';
        return;
      }

      dropdownEl.innerHTML = '';
      for (const item of items) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'autocomplete-item';
        btn.innerHTML =
          `<span class="autocomplete-name">${escapeHtml(item.name)}</span>` +
          `<span class="autocomplete-address">${escapeHtml(item.address)}</span>`;
        btn.addEventListener('click', () => {
          dropdownEl.classList.add('hidden');
          onSelect(item);
        });
        dropdownEl.appendChild(btn);
      }
      dropdownEl.classList.remove('hidden');
    } catch (_) {
      dropdownEl.classList.add('hidden');
    }
  }

  function wireSearchInput(inputEl, dropdownEl, role) {
    inputEl.addEventListener('input', () => {
      clearTimeout(searchTimer);
      const val = inputEl.value;
      if (role === 'origin') routeState.origin = null;
      else routeState.destination = null;

      searchTimer = setTimeout(() => {
        runPlaceSearch(val, dropdownEl, (place) => {
          setEndpoint(role, place);
        });
      }, 260);
    });
  }

  wireSearchInput(originInput, originDropdown, 'origin');
  wireSearchInput(destInput, destDropdown, 'destination');

  // ── Routing & Polylines ──
  function setRouteMessage(text, isError) {
    if (!text) {
      routeStatus.classList.add('hidden');
      routeStatus.textContent = '';
      routeStatus.classList.remove('error');
      return;
    }
    routeStatus.textContent = text;
    routeStatus.classList.toggle('error', Boolean(isError));
    routeStatus.classList.remove('hidden');
  }

  function drawEndpointMarkers() {
    routeLayerGroup.clearLayers();
    routeState.fastestLine = null;
    routeState.shortestLine = null;

    if (routeState.origin) {
      L.circleMarker([routeState.origin.lat, routeState.origin.lng], {
        radius: 6,
        color: '#FFFFFF',
        weight: 2,
        fillColor: '#10B981',
        fillOpacity: 1
      })
        .bindPopup(`<div class="map-popup-title">Origin</div><div class="map-popup-meta">${escapeHtml(routeState.origin.name)}</div>`)
        .addTo(routeLayerGroup);
    }

    if (routeState.destination) {
      L.circleMarker([routeState.destination.lat, routeState.destination.lng], {
        radius: 6,
        color: '#FFFFFF',
        weight: 2,
        fillColor: '#2563EB',
        fillOpacity: 1
      })
        .bindPopup(`<div class="map-popup-title">Destination</div><div class="map-popup-meta">${escapeHtml(routeState.destination.name)}</div>`)
        .addTo(routeLayerGroup);
    }
  }

  function applyRouteHighlight() {
    const active = routeState.activeRouteType;
    cardFastest.classList.toggle('active', active === 'fastest');
    cardShortest.classList.toggle('active', active === 'shortest');

    if (routeState.fastestLine) {
      routeState.fastestLine.setStyle({
        opacity: active === 'fastest' ? 0.95 : 0.35,
        weight: active === 'fastest' ? 5 : 4
      });
      if (active === 'fastest') routeState.fastestLine.bringToFront();
    }

    if (routeState.shortestLine) {
      routeState.shortestLine.setStyle({
        opacity: active === 'shortest' ? 0.95 : 0.4,
        weight: active === 'shortest' ? 5 : 4
      });
      if (active === 'shortest') routeState.shortestLine.bringToFront();
    }
  }

  function renderRoutes(routes) {
    drawEndpointMarkers();
    routeState.routes = routes;

    const shortestCoords = routes.shortest.coordinates;
    const fastestCoords = routes.fastest.coordinates;

    routeState.shortestLine = L.polyline(shortestCoords, {
      color: '#64748B',
      weight: 4,
      opacity: 0.45,
      dashArray: '6, 8'
    }).addTo(routeLayerGroup);

    routeState.fastestLine = L.polyline(fastestCoords, {
      color: '#2563EB',
      weight: 5,
      opacity: 0.95
    }).addTo(routeLayerGroup);

    routeState.fastestLine.on('click', () => {
      routeState.activeRouteType = 'fastest';
      applyRouteHighlight();
    });
    routeState.shortestLine.on('click', () => {
      routeState.activeRouteType = 'shortest';
      applyRouteHighlight();
    });

    fastestTimeEl.textContent = `${routes.fastest.travelTimeMin} min`;
    fastestMetaEl.textContent =
      routes.fastest.trafficDelayMin > 0
        ? `${routes.fastest.distanceKm} km (+${routes.fastest.trafficDelayMin}m delay)`
        : `${routes.fastest.distanceKm} km`;

    shortestTimeEl.textContent = `${routes.shortest.travelTimeMin} min`;
    shortestMetaEl.textContent =
      routes.shortest.trafficDelayMin > 0
        ? `${routes.shortest.distanceKm} km (+${routes.shortest.trafficDelayMin}m delay)`
        : `${routes.shortest.distanceKm} km`;

    routeState.activeRouteType = 'fastest';
    applyRouteHighlight();
    routeCards.classList.remove('hidden');

    const bounds = L.latLngBounds([...fastestCoords, ...shortestCoords]);
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [70, 70] });
    }
  }

  async function calculateRoute() {
    if (!routeState.origin || !routeState.destination) {
      drawEndpointMarkers();
      return;
    }

    clearRouteBtn.classList.remove('hidden');
    setRouteMessage('Calculating live routes...', false);

    try {
      const params = new URLSearchParams({
        fromLat: String(routeState.origin.lat),
        fromLng: String(routeState.origin.lng),
        toLat: String(routeState.destination.lat),
        toLng: String(routeState.destination.lng)
      });
      const res = await fetch(`/api/route?${params.toString()}`);
      const data = await res.json();

      if (!res.ok) {
        setRouteMessage(data.error || 'Unable to compute route', true);
        routeCards.classList.add('hidden');
        return;
      }

      setRouteMessage('', false);
      renderRoutes(data);
    } catch (_) {
      setRouteMessage('Unable to reach routing service', true);
      routeCards.classList.add('hidden');
    }
  }

  function setEndpoint(role, place) {
    if (role === 'origin') {
      routeState.origin = place;
      originInput.value = place.name;
    } else {
      routeState.destination = place;
      destInput.value = place.name;
    }
    clearRouteBtn.classList.remove('hidden');
    calculateRoute();
  }

  // Quick-chips fill destination (or origin if origin is empty and destination already set)
  document.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const place = {
        name: chip.dataset.name,
        lat: Number(chip.dataset.lat),
        lng: Number(chip.dataset.lng)
      };
      if (!routeState.origin && !originInput.value.trim()) {
        setEndpoint('origin', place);
      } else {
        setEndpoint('destination', place);
      }
    });
  });

  // Map click sets Origin if unset, otherwise Destination
  map.on('click', (e) => {
    const lat = Math.round(e.latlng.lat * 10000) / 10000;
    const lng = Math.round(e.latlng.lng * 10000) / 10000;
    const place = { name: `${lat}, ${lng}`, lat, lng };
    if (!routeState.origin) {
      setEndpoint('origin', place);
    } else {
      setEndpoint('destination', place);
    }
  });

  swapBtn.addEventListener('click', () => {
    const prevOrigin = routeState.origin;
    const prevDest = routeState.destination;
    routeState.origin = prevDest;
    routeState.destination = prevOrigin;
    originInput.value = routeState.origin ? routeState.origin.name : '';
    destInput.value = routeState.destination ? routeState.destination.name : '';
    calculateRoute();
  });

  clearRouteBtn.addEventListener('click', () => {
    routeState.origin = null;
    routeState.destination = null;
    routeState.routes = null;
    originInput.value = '';
    destInput.value = '';
    routeLayerGroup.clearLayers();
    routeCards.classList.add('hidden');
    clearRouteBtn.classList.add('hidden');
    setRouteMessage('', false);
  });

  cardFastest.addEventListener('click', () => {
    routeState.activeRouteType = 'fastest';
    applyRouteHighlight();
  });

  cardShortest.addEventListener('click', () => {
    routeState.activeRouteType = 'shortest';
    applyRouteHighlight();
  });
})();
