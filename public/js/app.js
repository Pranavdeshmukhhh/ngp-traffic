(function () {
  'use strict';

  const NAGPUR_CENTER = [21.1458, 79.0882];
  const BASEMAPS = {
    light: '/tiles/basemap/{z}/{x}/{y}.png?theme=light',
    dark: '/tiles/basemap/{z}/{x}/{y}.png?theme=dark',
    osmFallback: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
  };
  const STALE_THRESHOLDS_MS = {
    flow: 8 * 60 * 1000,
    incidents: 24 * 60 * 1000,
    weather: 30 * 60 * 1000
  };

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

  let tileVersion = Date.now();
  let lastTileRefreshMs = tileVersion;

  function buildTrafficTileUrl(theme, version) {
    return `/tiles/traffic/{z}/{x}/{y}.png?theme=${encodeURIComponent(theme)}&v=${version}`;
  }

  let usingOsmFallback = false;

  function createBaseLayer(theme, forceOsmFallback) {
    usingOsmFallback = Boolean(forceOsmFallback);
    if (usingOsmFallback) {
      return L.tileLayer(BASEMAPS.osmFallback, {
        attribution: '&copy; OpenStreetMap contributors &middot; Weather: Open-Meteo (CC BY 4.0)',
        className: theme === 'dark' ? 'basemap-osm-dark' : 'basemap-osm-light',
        maxZoom: 19
      });
    }

    const layer = L.tileLayer(BASEMAPS[theme], {
      attribution: '&copy; TomTom &copy; OpenStreetMap contributors &middot; Weather: Open-Meteo (CC BY 4.0)',
      className: 'basemap-tiles',
      maxZoom: 19
    });
    layer.once('tileerror', () => {
      if (usingOsmFallback) return;
      const activeTheme = document.documentElement.getAttribute('data-theme') || 'light';
      if (baseLayer) map.removeLayer(baseLayer);
      baseLayer = createBaseLayer(activeTheme, true).addTo(map);
      baseLayer.bringToBack();
    });
    return layer;
  }

  let baseLayer = createBaseLayer(savedTheme, false).addTo(map);

  const trafficFlowLayer = L.tileLayer(buildTrafficTileUrl(savedTheme, tileVersion), {
    maxZoom: 19,
    opacity: 0.9
  }).addTo(map);

  const incidentsLayerGroup = L.layerGroup();
  const alertsLayerGroup = L.layerGroup().addTo(map);
  const routeLayerGroup = L.layerGroup().addTo(map);

  // ── State ──
  let latestState = {
    updatedAt: null,
    lastSuccessAt: { flow: null, incidents: null, weather: null },
    stale: false,
    staleSources: [],
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
  const liveIndicator = document.getElementById('live-indicator');
  const updatedText = document.getElementById('updated-text');
  const staleBadge = document.getElementById('stale-badge');
  const sourcesFreshness = document.getElementById('sources-freshness');
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
    baseLayer = createBaseLayer(theme, usingOsmFallback || latestState.tomtomConfigured === false).addTo(map);
    baseLayer.bringToBack();

    tileVersion = Date.now();
    lastTileRefreshMs = tileVersion;
    trafficFlowLayer.setUrl(buildTrafficTileUrl(theme, tileVersion));
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
  function formatShortAge(isoString) {
    if (!isoString) return 'offline';
    const diffSec = Math.max(0, Math.floor((Date.now() - Date.parse(isoString)) / 1000));
    if (diffSec < 60) return 'now';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m`;
    return `${Math.floor(diffMin / 60)}h`;
  }

  function isClientDetectedStale(state) {
    if (!state) return false;
    if (state.stale === true) return true;
    const sources = state.lastSuccessAt || {};
    const now = Date.now();
    const active = state.tomtomConfigured ? ['flow', 'incidents', 'weather'] : ['weather'];
    return active.some((src) => {
      const ts = sources[src];
      if (!ts) return false;
      return now - Date.parse(ts) > STALE_THRESHOLDS_MS[src];
    });
  }

  function renderStatusBar() {
    setupBanner.classList.toggle('hidden', Boolean(latestState.tomtomConfigured));
    if (latestState.tomtomConfigured === false && !usingOsmFallback) {
      const activeTheme = document.documentElement.getAttribute('data-theme') || 'light';
      if (baseLayer) map.removeLayer(baseLayer);
      baseLayer = createBaseLayer(activeTheme, true).addTo(map);
      baseLayer.bringToBack();
    }

    const isStale = isClientDetectedStale(latestState);
    const sources = latestState.lastSuccessAt || {};
    const summaryText = latestState.tomtomConfigured
      ? `Flow ${formatShortAge(sources.flow)} · Inc ${formatShortAge(sources.incidents)} · Weather ${formatShortAge(sources.weather)}`
      : `Weather ${formatShortAge(sources.weather)}`;

    updatedText.textContent = latestState.updatedAt ? formatRelativeTime(latestState.updatedAt) : 'No live feed';
    updatedText.title = summaryText;
    liveIndicator.classList.toggle('stale', isStale || !latestState.updatedAt);
    staleBadge.classList.toggle('hidden', !isStale);
    staleBadge.title = summaryText;

    sourcesFreshness.textContent = summaryText;
    sourcesFreshness.classList.toggle('stale', isStale);

    if (latestState.weather) {
      weatherSep.classList.remove('hidden');
      weatherText.classList.remove('hidden');
      weatherText.textContent = `${latestState.weather.temperatureC}°C · ${latestState.weather.condition}`;
    } else {
      weatherSep.classList.add('hidden');
      weatherText.classList.add('hidden');
    }
  }

  function buildPopupEl(title, lines) {
    const wrap = document.createElement('div');
    const titleEl = document.createElement('div');
    titleEl.className = 'map-popup-title';
    titleEl.textContent = title;
    wrap.appendChild(titleEl);

    lines.forEach((line, idx) => {
      if (!line) return;
      const lineEl = document.createElement('div');
      lineEl.className = idx === 0 ? 'map-popup-meta' : 'map-popup-meta map-popup-sub';
      lineEl.textContent = line;
      wrap.appendChild(lineEl);
    });
    return wrap;
  }

  function createShieldIcon() {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', '13');
    svg.setAttribute('height', '13');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.75');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(svgNS, 'path');
    p.setAttribute('d', 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z');
    svg.appendChild(p);
    return svg;
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
      const corridor = inc.from ? `${inc.from}${inc.to ? ` to ${inc.to}` : ''}` : 'Nagpur corridor';

      marker.bindPopup(() =>
        buildPopupEl(inc.description || 'Traffic Incident', [`${corridor} · ${delayMin}`])
      );
      marker.addTo(incidentsLayerGroup);
    }
  }

  function formatTrendLabel(trend) {
    if (trend === 'worsening') return 'Rising';
    if (trend === 'improving') return 'Clearing';
    return 'Stable';
  }

  function renderAlerts() {
    alertsLayerGroup.clearLayers();
    alertMarkersById.clear();

    const predictions = Array.isArray(latestState.predictions) ? latestState.predictions : [];
    alertsCount.textContent = String(predictions.length);
    drawerOpenCount.textContent = String(predictions.length);

    if (predictions.length === 0) {
      alertsList.replaceChildren();
      const empty = document.createElement('div');
      empty.className = 'alerts-empty';
      const p = document.createElement('p');
      p.textContent = 'Traffic flowing smoothly across monitored Nagpur junctions.';
      empty.appendChild(p);
      alertsList.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();

    for (const alert of predictions) {
      const stationLine = alert.nearestStation
        ? `Nearest: ${alert.nearestStation.shortName} (${alert.nearestStation.distanceKm} km)`
        : '';
      const popupLines = [
        `${alert.badge} · Score ${alert.severityScore}/100 · ${alert.currentSpeed} km/h vs ${alert.freeFlowSpeed} km/h`,
        alert.reason,
        stationLine
      ];

      let marker = null;
      if (alert.severity === 'HIGH') {
        const pulseIcon = L.divIcon({
          className: 'alert-pulse-wrapper',
          html: '<span class="alert-pulse-ring"></span><span class="alert-pulse-core"></span>',
          iconSize: [20, 20],
          iconAnchor: [10, 10]
        });

        marker = L.marker([alert.lat, alert.lng], { icon: pulseIcon });
        marker.bindTooltip(
          `${alert.name} · ${alert.currentSpeed} km/h · ${alert.badge}`,
          { direction: 'top', offset: [0, -10] }
        );
        marker.bindPopup(() => buildPopupEl(alert.name, popupLines));
        marker.addTo(alertsLayerGroup);
        alertMarkersById.set(alert.id, marker);
      }

      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'alert-card';

      const top = document.createElement('div');
      top.className = 'alert-card-top';
      const junctionEl = document.createElement('span');
      junctionEl.className = 'alert-junction';
      junctionEl.textContent = alert.name;
      const badgeEl = document.createElement('span');
      badgeEl.className = `alert-badge ${alert.category}`;
      badgeEl.textContent = alert.badge;
      top.append(junctionEl, badgeEl);

      const metaRow = document.createElement('div');
      metaRow.className = 'alert-meta-row';
      const scoreEl = document.createElement('span');
      scoreEl.className = 'alert-score';
      scoreEl.textContent = `Score ${alert.severityScore}/100`;
      const trendKey = alert.trend || 'stable';
      const trendEl = document.createElement('span');
      trendEl.className = `trend-badge ${trendKey}`;
      trendEl.textContent = formatTrendLabel(trendKey);
      metaRow.append(scoreEl, trendEl);

      const speedEl = document.createElement('div');
      speedEl.className = 'alert-speed';
      speedEl.textContent = `${alert.currentSpeed} km/h vs ${alert.freeFlowSpeed} km/h`;

      const reasonEl = document.createElement('div');
      reasonEl.className = 'alert-reason';
      reasonEl.textContent = alert.reason;

      card.append(top, metaRow, speedEl, reasonEl);

      if (alert.nearestStation) {
        const stationDiv = document.createElement('div');
        stationDiv.className = 'alert-station';
        const stationText = document.createElement('span');
        stationText.textContent = `${alert.nearestStation.shortName} · ${alert.nearestStation.distanceKm} km`;
        stationDiv.append(createShieldIcon(), stationText);
        card.appendChild(stationDiv);
      }

      card.addEventListener('click', () => {
        if (!layerAlertsCheckbox.checked) {
          layerAlertsCheckbox.checked = true;
          alertsLayerGroup.addTo(map);
        }
        map.flyTo([alert.lat, alert.lng], 15, { duration: 0.6 });
        if (marker) {
          marker.openPopup();
        } else {
          L.popup()
            .setLatLng([alert.lat, alert.lng])
            .setContent(buildPopupEl(alert.name, popupLines))
            .openOn(map);
        }
      });

      fragment.appendChild(card);
    }

    alertsList.replaceChildren(fragment);
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

    const now = Date.now();
    if (now - lastTileRefreshMs >= 120000) {
      lastTileRefreshMs = now;
      tileVersion = now;
      const activeTheme = document.documentElement.getAttribute('data-theme') || 'light';
      trafficFlowLayer.setUrl(buildTrafficTileUrl(activeTheme, tileVersion));
    }
  });

  // ── Place Search Autocomplete ──
  let searchTimer = null;

  async function runPlaceSearch(query, dropdownEl, onSelect) {
    if (query.trim().length < 2) {
      dropdownEl.classList.add('hidden');
      dropdownEl.replaceChildren();
      return;
    }

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query.trim())}`);
      const data = await res.json();
      const items = Array.isArray(data.results) ? data.results : [];

      if (items.length === 0) {
        dropdownEl.classList.add('hidden');
        dropdownEl.replaceChildren();
        return;
      }

      dropdownEl.replaceChildren();
      for (const item of items) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'autocomplete-item';
        const nameEl = document.createElement('span');
        nameEl.className = 'autocomplete-name';
        nameEl.textContent = item.name;
        const addrEl = document.createElement('span');
        addrEl.className = 'autocomplete-address';
        addrEl.textContent = item.address;
        btn.append(nameEl, addrEl);
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
        .bindPopup(() => buildPopupEl('Origin', [routeState.origin.name]))
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
        .bindPopup(() => buildPopupEl('Destination', [routeState.destination.name]))
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
