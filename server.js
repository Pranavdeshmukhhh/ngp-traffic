'use strict';

try {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile();
  }
} catch (_) {
  // .env is optional; environment variables may be injected directly.
}

const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3000;
const TOMTOM_API_KEY = (process.env.TOMTOM_API_KEY || '').trim();
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || '*').trim() || '*';

const NAGPUR_CENTER = { lat: 21.1458, lng: 79.0882 };
const NAGPUR_BBOX = '78.95,21.05,79.20,21.25';

const TILE_CACHE_TTL_MS = 120 * 1000;
const TILE_CACHE_MAX_ENTRIES = 500;
const FLOW_POLL_INTERVAL_MS = 4 * 60 * 1000;
const INCIDENTS_POLL_INTERVAL_MS = 12 * 60 * 1000;
const WEATHER_POLL_INTERVAL_MS = 15 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 8000;

const ROADWORKS_OR_CLOSURE_CODES = new Set([7, 8, 9]);
const ACCIDENT_OR_BREAKDOWN_CODES = new Set([1, 14]);

const junctions = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'data', 'nagpur-junctions.json'), 'utf8')
);
const stations = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'data', 'police-stations.json'), 'utf8')
);
const monitoredJunctions = junctions.filter((j) => j.key === true);

/**
 * Compute great-circle distance in meters between two WGS84 coordinates.
 */
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Find the nearest Nagpur police station to a coordinate.
 */
function findNearestPoliceStation(lat, lng, stationList) {
  if (!Array.isArray(stationList) || stationList.length === 0) return null;
  let best = null;
  let bestDist = Infinity;

  for (const s of stationList) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng)) continue;
    const d = haversineMeters(lat, lng, s.lat, s.lng);
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }

  if (!best) return null;
  return {
    id: best.id,
    name: best.name,
    shortName: best.name.replace(/Police Station/i, 'PS').trim(),
    zone: best.zone,
    lat: best.lat,
    lng: best.lng,
    distanceKm: Math.round((bestDist / 1000) * 10) / 10
  };
}

/**
 * Map Open-Meteo WMO weather codes to concise labels.
 */
function describeWeatherCode(code) {
  const c = Number(code);
  if (c === 0) return 'Clear';
  if (c === 1 || c === 2) return 'Partly Cloudy';
  if (c === 3) return 'Overcast';
  if (c === 45 || c === 48) return 'Fog';
  if (c >= 51 && c <= 57) return 'Drizzle';
  if ((c >= 61 && c <= 67) || (c >= 71 && c <= 77)) return 'Rain';
  if (c >= 80 && c <= 82) return 'Showers';
  if (c >= 95) return 'Thunderstorm';
  return 'Clear';
}

/**
 * Extract a representative { lat, lng } from GeoJSON Point or LineString geometry.
 */
function extractIncidentPoint(geometry) {
  if (!geometry || !Array.isArray(geometry.coordinates)) return null;
  if (geometry.type === 'Point' && geometry.coordinates.length >= 2) {
    const [lng, lat] = geometry.coordinates;
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  }
  if (geometry.type === 'LineString' && geometry.coordinates.length > 0) {
    const mid = geometry.coordinates[Math.floor(geometry.coordinates.length / 2)];
    if (Array.isArray(mid) && mid.length >= 2) {
      const [lng, lat] = mid;
      if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
    }
  }
  return null;
}

/**
 * Predict officer and road-clearing deployment advisories from live flow,
 * active incidents, rainfall, and Nagpur police station locations.
 */
function predictDeployments(junctionFlows, incidents, weather, stationList) {
  if (!Array.isArray(junctionFlows) || junctionFlows.length === 0) return [];

  const activeIncidents = Array.isArray(incidents) ? incidents : [];
  const rainfallMm = Number(weather?.precipitation || 0);
  const predictions = [];

  for (const j of junctionFlows) {
    if (!j || !Number.isFinite(j.lat) || !Number.isFinite(j.lng)) continue;

    const currentSpeed = Math.max(0, Number(j.currentSpeed ?? 0));
    const freeFlowSpeed = Math.max(1, Number(j.freeFlowSpeed ?? 1));
    const congestionPct = Math.max(
      0,
      Math.min(100, Math.round((1 - Math.min(1, currentSpeed / freeFlowSpeed)) * 100))
    );

    const nearbyIncidents = activeIncidents.filter((inc) => {
      if (!Number.isFinite(inc?.lat) || !Number.isFinite(inc?.lng)) return false;
      return haversineMeters(j.lat, j.lng, inc.lat, inc.lng) <= 500;
    });

    const clearingIncident = nearbyIncidents.find((inc) =>
      ROADWORKS_OR_CLOSURE_CODES.has(Number(inc.iconCategory))
    );
    const officerIncident = nearbyIncidents.find((inc) =>
      ACCIDENT_OR_BREAKDOWN_CODES.has(Number(inc.iconCategory))
    );

    let severity = null;
    let category = null;
    let badge = null;
    let action = null;
    let reason = null;

    if (
      j.roadClosure === true ||
      Boolean(clearingIncident) ||
      (rainfallMm >= 5 && congestionPct >= 50)
    ) {
      severity = 'HIGH';
      category = 'clearing';
      badge = 'Clearing Needed';
      action = 'Road Clearing Needed';
      if (j.roadClosure === true) {
        reason = 'Active road closure reported on corridor';
      } else if (clearingIncident) {
        reason = clearingIncident.description || 'Roadworks or lane closure within 500 m';
      } else {
        reason = `Heavy rain (${rainfallMm.toFixed(1)} mm/hr) with ${congestionPct}% congestion`;
      }
    } else if (Boolean(officerIncident) || congestionPct >= 60) {
      severity = 'HIGH';
      category = 'officer';
      badge = 'Officer Needed';
      action = 'Traffic Officer Needed';
      if (officerIncident) {
        reason = officerIncident.description || 'Accident or breakdown within 500 m';
      } else {
        reason = `Severe congestion (${congestionPct}% below free-flow speed)`;
      }
    } else if (congestionPct >= 40) {
      severity = 'MEDIUM';
      category = 'monitor';
      badge = 'Monitor';
      action = 'Standby / Monitor';
      reason = `Moderate slowdown (${congestionPct}% below free-flow speed)`;
    }

    if (!severity) continue;

    const entry = {
      id: j.id,
      name: j.name,
      lat: j.lat,
      lng: j.lng,
      roadType: j.roadType || 'major_intersection',
      currentSpeed: Math.round(currentSpeed),
      freeFlowSpeed: Math.round(freeFlowSpeed),
      congestionPct,
      roadClosure: Boolean(j.roadClosure),
      severity,
      category,
      badge,
      action,
      reason,
      nearestStation:
        severity === 'HIGH' ? findNearestPoliceStation(j.lat, j.lng, stationList) : null
    };

    predictions.push(entry);
  }

  predictions.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'HIGH' ? -1 : 1;
    return b.congestionPct - a.congestionPct;
  });

  return predictions;
}

// ── Upstream Fetchers ──
async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`Upstream HTTP ${res.status}`);
  }
  return res.json();
}

async function fetchWeather() {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${NAGPUR_CENTER.lat}` +
    `&longitude=${NAGPUR_CENTER.lng}&current=temperature_2m,precipitation,weather_code`;
  const data = await fetchJson(url);
  const current = data?.current || {};
  return {
    temperatureC: Math.round(Number(current.temperature_2m ?? 0)),
    precipitation: Number(current.precipitation ?? 0),
    weatherCode: Number(current.weather_code ?? 0),
    condition: describeWeatherCode(current.weather_code ?? 0),
    updatedAt: new Date().toISOString()
  };
}

async function fetchJunctionFlow(junction) {
  const url =
    `https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json` +
    `?point=${junction.lat},${junction.lng}&unit=KMPH&key=${encodeURIComponent(TOMTOM_API_KEY)}`;
  const data = await fetchJson(url);
  const seg = data?.flowSegmentData;
  if (!seg) return null;

  const currentSpeed = Math.max(0, Number(seg.currentSpeed ?? 0));
  const freeFlowSpeed = Math.max(1, Number(seg.freeFlowSpeed ?? 1));
  const congestionPct = Math.max(
    0,
    Math.min(100, Math.round((1 - Math.min(1, currentSpeed / freeFlowSpeed)) * 100))
  );

  return {
    id: junction.id,
    name: junction.name,
    lat: junction.lat,
    lng: junction.lng,
    roadType: junction.roadType,
    currentSpeed: Math.round(currentSpeed),
    freeFlowSpeed: Math.round(freeFlowSpeed),
    currentTravelTime: Number(seg.currentTravelTime ?? 0),
    freeFlowTravelTime: Number(seg.freeFlowTravelTime ?? 0),
    confidence: Number(seg.confidence ?? 0),
    roadClosure: Boolean(seg.roadClosure),
    congestionPct
  };
}

async function fetchAllJunctionFlows() {
  if (!TOMTOM_API_KEY) return [];
  const results = [];
  const batchSize = 4;

  for (let i = 0; i < monitoredJunctions.length; i += batchSize) {
    const batch = monitoredJunctions.slice(i, i + batchSize);
    const settled = await Promise.allSettled(batch.map((j) => fetchJunctionFlow(j)));
    for (const item of settled) {
      if (item.status === 'fulfilled' && item.value) {
        results.push(item.value);
      }
    }
  }
  return results;
}

async function fetchIncidents() {
  if (!TOMTOM_API_KEY) return [];
  const fields = encodeURIComponent(
    '{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,events{description,code},startTime,endTime,from,to,length,delay,roadNumbers}}}'
  );
  const url =
    `https://api.tomtom.com/traffic/services/5/incidentDetails` +
    `?key=${encodeURIComponent(TOMTOM_API_KEY)}` +
    `&bbox=${NAGPUR_BBOX}&fields=${fields}&language=en-GB&timeValidityFilter=present`;

  const data = await fetchJson(url);
  const list = Array.isArray(data?.incidents) ? data.incidents : [];

  return list
    .map((raw, idx) => {
      const point = extractIncidentPoint(raw.geometry);
      if (!point) return null;
      const props = raw.properties || {};
      const firstEvent = Array.isArray(props.events) && props.events[0] ? props.events[0] : {};
      return {
        id: props.id || `inc_${idx}`,
        lat: point.lat,
        lng: point.lng,
        iconCategory: Number(props.iconCategory ?? 0),
        magnitudeOfDelay: Number(props.magnitudeOfDelay ?? 0),
        description: firstEvent.description || 'Traffic incident',
        from: props.from || '',
        to: props.to || '',
        delaySec: Number(props.delay ?? 0),
        lengthMeters: Number(props.length ?? 0),
        roadNumbers: Array.isArray(props.roadNumbers) ? props.roadNumbers : []
      };
    })
    .filter(Boolean);
}

// ── Express & Socket.IO Setup ──
const app = express();
const server = http.createServer(app);

const corsOrigin = ALLOWED_ORIGIN === '*' ? '*' : ALLOWED_ORIGIN.split(',').map((s) => s.trim());
app.use(cors({ origin: corsOrigin }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const io = new Server(server, {
  cors: { origin: corsOrigin, methods: ['GET'] }
});

// ── Live State & Bounded Tile Cache ──
const tileCache = new Map();
const liveState = {
  updatedAt: null,
  tomtomConfigured: Boolean(TOMTOM_API_KEY),
  weather: null,
  junctions: [],
  incidents: [],
  predictions: []
};

let lastFlowFetchMs = 0;
let lastIncidentsFetchMs = 0;
let lastWeatherFetchMs = 0;
let refreshInFlight = null;

function recomputePredictions() {
  liveState.predictions = predictDeployments(
    liveState.junctions,
    liveState.incidents,
    liveState.weather,
    stations
  );
  liveState.tomtomConfigured = Boolean(TOMTOM_API_KEY);
}

async function refreshLiveState({ forceFlow = false, forceIncidents = false, forceWeather = false } = {}) {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const now = Date.now();
    const tasks = [];

    if (forceWeather || now - lastWeatherFetchMs >= WEATHER_POLL_INTERVAL_MS || !liveState.weather) {
      tasks.push(
        fetchWeather()
          .then((w) => {
            liveState.weather = w;
            lastWeatherFetchMs = Date.now();
          })
          .catch((err) => {
            console.warn('Weather fetch failed:', err.message);
          })
      );
    }

    if (
      TOMTOM_API_KEY &&
      (forceFlow || now - lastFlowFetchMs >= FLOW_POLL_INTERVAL_MS || liveState.junctions.length === 0)
    ) {
      tasks.push(
        fetchAllJunctionFlows()
          .then((flows) => {
            if (flows.length > 0) {
              liveState.junctions = flows;
              lastFlowFetchMs = Date.now();
            }
          })
          .catch((err) => {
            console.warn('Flow fetch failed:', err.message);
          })
      );
    }

    if (
      TOMTOM_API_KEY &&
      (forceIncidents || now - lastIncidentsFetchMs >= INCIDENTS_POLL_INTERVAL_MS)
    ) {
      tasks.push(
        fetchIncidents()
          .then((incs) => {
            liveState.incidents = incs;
            lastIncidentsFetchMs = Date.now();
          })
          .catch((err) => {
            console.warn('Incidents fetch failed:', err.message);
          })
      );
    }

    if (tasks.length === 0) return liveState;

    await Promise.all(tasks);
    liveState.updatedAt = new Date().toISOString();
    recomputePredictions();
    io.emit('traffic:state', liveState);
    return liveState;
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

// ── Socket.IO Lifecycle ──
io.on('connection', (socket) => {
  socket.emit('traffic:state', liveState);

  const stale =
    !liveState.updatedAt ||
    Date.now() - new Date(liveState.updatedAt).getTime() > FLOW_POLL_INTERVAL_MS;
  if (stale) {
    refreshLiveState({ forceFlow: Boolean(TOMTOM_API_KEY), forceWeather: !liveState.weather });
  }
});

// ── Routes ──
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    tomtomConfigured: Boolean(TOMTOM_API_KEY),
    updatedAt: liveState.updatedAt,
    activeClients: io.engine.clientsCount,
    monitoredJunctions: monitoredJunctions.length,
    alertsCount: liveState.predictions.length,
    weatherLoaded: Boolean(liveState.weather)
  });
});

app.get('/tiles/traffic/:z/:x/:y.png', async (req, res) => {
  const z = Number(req.params.z);
  const x = Number(req.params.x);
  const y = Number(req.params.y);

  if (
    !Number.isInteger(z) ||
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    z < 0 ||
    z > 22 ||
    x < 0 ||
    y < 0
  ) {
    return res.status(400).json({ error: 'Invalid tile coordinates' });
  }

  if (!TOMTOM_API_KEY) {
    return res.status(204).end();
  }

  const cacheKey = `${z}/${x}/${y}`;
  const cached = tileCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=120');
    return res.send(cached.buffer);
  }

  try {
    const upstreamUrl =
      `https://api.tomtom.com/traffic/map/4/tile/flow/relative0/${z}/${x}/${y}.png` +
      `?key=${encodeURIComponent(TOMTOM_API_KEY)}`;
    const upstream = await fetch(upstreamUrl, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });

    if (!upstream.ok) {
      return res.status(upstream.status === 404 ? 204 : 502).end();
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    if (tileCache.size >= TILE_CACHE_MAX_ENTRIES) {
      const oldestKey = tileCache.keys().next().value;
      if (oldestKey !== undefined) tileCache.delete(oldestKey);
    }
    tileCache.set(cacheKey, {
      buffer,
      expiresAt: Date.now() + TILE_CACHE_TTL_MS
    });

    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=120');
    return res.send(buffer);
  } catch (_) {
    return res.status(502).end();
  }
});

app.get('/api/search', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (q.length < 2 || q.length > 100) {
    return res.status(400).json({ error: 'Query must be between 2 and 100 characters', results: [] });
  }

  if (!TOMTOM_API_KEY) {
    return res.status(503).json({
      error: 'TOMTOM_API_KEY is not configured on the server',
      tomtomConfigured: false,
      results: []
    });
  }

  try {
    const url =
      `https://api.tomtom.com/search/2/search/${encodeURIComponent(q)}.json` +
      `?key=${encodeURIComponent(TOMTOM_API_KEY)}` +
      `&lat=${NAGPUR_CENTER.lat}&lon=${NAGPUR_CENTER.lng}&radius=25000&countrySet=IN&limit=6`;

    const data = await fetchJson(url);
    const results = (Array.isArray(data?.results) ? data.results : [])
      .map((item) => {
        const lat = Number(item?.position?.lat);
        const lng = Number(item?.position?.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        const name = item?.poi?.name || item?.address?.freeformAddress || q;
        const address = item?.address?.freeformAddress || 'Nagpur, Maharashtra';
        return { name, address, lat, lng };
      })
      .filter(Boolean);

    return res.json({ results });
  } catch (_) {
    return res.status(502).json({ error: 'Place search service unavailable', results: [] });
  }
});

async function fetchTomTomRoute(fromLat, fromLng, toLat, toLng, routeType) {
  const url =
    `https://api.tomtom.com/routing/1/calculateRoute/${fromLat},${fromLng}:${toLat},${toLng}/json` +
    `?key=${encodeURIComponent(TOMTOM_API_KEY)}` +
    `&traffic=true&travelMode=car&routeType=${routeType}`;

  const data = await fetchJson(url);
  const route = Array.isArray(data?.routes) ? data.routes[0] : null;
  if (!route || !route.summary) {
    throw new Error(`No ${routeType} route returned`);
  }

  const points = (route.legs || []).flatMap((leg) =>
    (leg.points || []).map((pt) => [pt.latitude, pt.longitude])
  );

  return {
    distanceKm: Math.round((Number(route.summary.lengthInMeters || 0) / 1000) * 10) / 10,
    travelTimeMin: Math.max(1, Math.round(Number(route.summary.travelTimeInSeconds || 0) / 60)),
    trafficDelayMin: Math.round(Number(route.summary.trafficDelayInSeconds || 0) / 60),
    coordinates: points
  };
}

app.get('/api/route', async (req, res) => {
  const fromLat = Number(req.query.fromLat);
  const fromLng = Number(req.query.fromLng);
  const toLat = Number(req.query.toLat);
  const toLng = Number(req.query.toLng);

  const valid =
    Number.isFinite(fromLat) &&
    Number.isFinite(fromLng) &&
    Number.isFinite(toLat) &&
    Number.isFinite(toLng) &&
    fromLat >= -90 &&
    fromLat <= 90 &&
    toLat >= -90 &&
    toLat <= 90 &&
    fromLng >= -180 &&
    fromLng <= 180 &&
    toLng >= -180 &&
    toLng <= 180;

  if (!valid) {
    return res.status(400).json({ error: 'Valid fromLat, fromLng, toLat, and toLng are required' });
  }

  if (!TOMTOM_API_KEY) {
    return res.status(503).json({
      error: 'TOMTOM_API_KEY is not configured on the server',
      tomtomConfigured: false
    });
  }

  try {
    const [fastest, shortest] = await Promise.all([
      fetchTomTomRoute(fromLat, fromLng, toLat, toLng, 'fastest'),
      fetchTomTomRoute(fromLat, fromLng, toLat, toLng, 'shortest')
    ]);
    return res.json({ fastest, shortest });
  } catch (_) {
    return res.status(502).json({ error: 'Routing service unavailable' });
  }
});

function startPollingLoops() {
  setInterval(() => {
    if (io.engine.clientsCount > 0) {
      refreshLiveState({ forceFlow: true });
    }
  }, FLOW_POLL_INTERVAL_MS);

  setInterval(() => {
    if (io.engine.clientsCount > 0) {
      refreshLiveState({ forceIncidents: true });
    }
  }, INCIDENTS_POLL_INTERVAL_MS);

  setInterval(() => {
    if (io.engine.clientsCount > 0) {
      refreshLiveState({ forceWeather: true });
    }
  }, WEATHER_POLL_INTERVAL_MS);
}

if (require.main === module) {
  startPollingLoops();
  server.listen(PORT, () => {
    console.log(`NGP-TRAFFIC listening on http://localhost:${PORT} (TomTom configured: ${Boolean(TOMTOM_API_KEY)})`);
  });
}

module.exports = {
  app,
  server,
  io,
  predictDeployments,
  haversineMeters,
  findNearestPoliceStation,
  describeWeatherCode,
  extractIncidentPoint
};
