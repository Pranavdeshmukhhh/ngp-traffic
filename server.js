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
const helmet = require('helmet');
const { Server } = require('socket.io');
const { LruCache } = require('./src/lru');
const {
  loadConfig,
  tileParamsSchema,
  tileQuerySchema,
  searchQuerySchema,
  routeQuerySchema,
  redactSecrets,
  safeFetch,
  createRateLimiter,
  UpstreamBudget,
  LatencyTracker
} = require('./src/security');
const {
  AIR_QUALITY_POLL_INTERVAL_MS,
  AIR_QUALITY_STALE_MS,
  HotspotObservationStore,
  parseForecastResponse,
  parseAirQualityResponse,
  computeRoadRiskAdvisories,
  findRouteHotspotWarnings
} = require('./src/weather-risk');

let activeConfig = loadConfig();
let fetchImpl = globalThis.fetch;
let hotspotStore = new HotspotObservationStore();

const PORT = activeConfig.port;
const NAGPUR_CENTER = { lat: 21.1458, lng: 79.0882 };
const NAGPUR_BBOX = '78.95,21.05,79.20,21.25';

const TILE_CACHE_TTL_MS = 120 * 1000;
const TILE_CACHE_MAX_ENTRIES = 500;
const BASEMAP_CACHE_TTL_MS = 10 * 60 * 1000;
const BASEMAP_CACHE_MAX_ENTRIES = 800;
const FLOW_POLL_INTERVAL_MS = 4 * 60 * 1000;
const INCIDENTS_POLL_INTERVAL_MS = 12 * 60 * 1000;
const WEATHER_POLL_INTERVAL_MS = 15 * 60 * 1000;
const FLOW_STALE_MS = 2 * FLOW_POLL_INTERVAL_MS;
const INCIDENTS_STALE_MS = 2 * INCIDENTS_POLL_INTERVAL_MS;
const WEATHER_STALE_MS = 2 * WEATHER_POLL_INTERVAL_MS;
const UPSTREAM_TIMEOUT_MS = 8000;
const MAX_SOCKETS_PER_IP = 8;

function getTomTomKey() {
  return activeConfig.tomtomApiKey;
}

const ROADWORKS_OR_CLOSURE_CODES = new Set([7, 8, 9]);
const ACCIDENT_OR_BREAKDOWN_CODES = new Set([1, 14]);
const INCIDENT_RADIUS_M = 150;
const ACCIDENT_FREEFLOW_RADIUS_M = 100;
const HISTORY_LIMIT = 3;

const junctionHistory = new Map();

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
 * Compute congestion trend from the last 2-3 snapshots for a junction.
 */
function computeTrend(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length < 2) return 'stable';
  const delta = snapshots[snapshots.length - 1] - snapshots[0];
  if (delta >= 8) return 'worsening';
  if (delta <= -8) return 'improving';
  return 'stable';
}

/**
 * Predict officer and road-clearing deployment advisories from live flow,
 * active incidents, rainfall, and Nagpur police station locations.
 */
function predictDeployments(
  junctionFlows,
  incidents,
  weather,
  stationList,
  historyMap = junctionHistory
) {
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
      return haversineMeters(j.lat, j.lng, inc.lat, inc.lng) <= INCIDENT_RADIUS_M;
    });

    const verifiedAccidentWithin100m = nearbyIncidents.find(
      (inc) =>
        Number(inc.iconCategory) === 1 &&
        haversineMeters(j.lat, j.lng, inc.lat, inc.lng) <= ACCIDENT_FREEFLOW_RADIUS_M
    );

    // Free-flow guard: never flag full-speed junctions unless roadClosure or verified accident <= 100m
    if (congestionPct < 15 && j.roadClosure !== true && !verifiedAccidentWithin100m) {
      continue;
    }

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
      (Boolean(clearingIncident) && congestionPct >= 25) ||
      (rainfallMm >= 5 && congestionPct >= 50)
    ) {
      severity = 'HIGH';
      category = 'clearing';
      badge = 'Clearing Needed';
      action = 'Road Clearing Needed';
      if (j.roadClosure === true) {
        reason = 'Active road closure reported on corridor';
      } else if (clearingIncident) {
        reason = clearingIncident.description || 'Roadworks or lane closure within 150 m';
      } else {
        reason = `Heavy rain (${rainfallMm.toFixed(1)} mm/hr) with ${congestionPct}% congestion`;
      }
    } else if (
      (congestionPct < 15 ? Boolean(verifiedAccidentWithin100m) : Boolean(officerIncident)) ||
      congestionPct >= 60
    ) {
      severity = 'HIGH';
      category = 'officer';
      badge = 'Officer Needed';
      action = 'Traffic Officer Needed';
      const activeOfficerInc = congestionPct < 15 ? verifiedAccidentWithin100m : officerIncident;
      if (activeOfficerInc) {
        reason = activeOfficerInc.description || 'Accident or breakdown within 150 m';
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

    const delaySec = Math.max(
      0,
      Number(j.currentTravelTime || 0) - Number(j.freeFlowTravelTime || 0)
    );
    const speedPart = 0.55 * congestionPct;
    const delayPart = Math.min(1, delaySec / 300) * 25;
    const incidentPart = nearbyIncidents.length > 0 || j.roadClosure === true ? 15 : 0;
    const rainPart = rainfallMm >= 5 ? 10 : rainfallMm >= 3 ? 5 : 0;
    const severityScore = Math.max(
      0,
      Math.min(100, Math.round(speedPart + delayPart + incidentPart + rainPart))
    );

    const snapshots = historyMap instanceof Map ? historyMap.get(j.id) || [] : [];
    const trend = computeTrend(snapshots);

    predictions.push({
      id: j.id,
      name: j.name,
      lat: j.lat,
      lng: j.lng,
      roadType: j.roadType || 'major_intersection',
      currentSpeed: Math.round(currentSpeed),
      freeFlowSpeed: Math.round(freeFlowSpeed),
      congestionPct,
      severityScore,
      trend,
      roadClosure: Boolean(j.roadClosure),
      severity,
      category,
      badge,
      action,
      reason,
      nearestStation:
        severity === 'HIGH' ? findNearestPoliceStation(j.lat, j.lng, stationList) : null
    });
  }

  predictions.sort((a, b) => {
    if (b.severityScore !== a.severityScore) return b.severityScore - a.severityScore;
    if (a.severity !== b.severity) return a.severity === 'HIGH' ? -1 : 1;
    return b.congestionPct - a.congestionPct;
  });

  return predictions;
}

// ── Upstream Fetchers ──
async function fetchJson(url) {
  const res = await safeFetch(url, { timeoutMs: UPSTREAM_TIMEOUT_MS }, fetchImpl);
  if (!res.ok) {
    throw new Error(`Upstream HTTP ${res.status}`);
  }
  return res.json();
}

async function fetchWeather() {
  upstreamBudget.tryConsume('openMeteo', 1);
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${NAGPUR_CENTER.lat}` +
    `&longitude=${NAGPUR_CENTER.lng}` +
    `&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m` +
    `&hourly=temperature_2m,apparent_temperature,precipitation_probability,precipitation,visibility,wind_speed_10m,weather_code` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,precipitation_sum,precipitation_probability_max,wind_speed_10m_max` +
    `&timezone=Asia%2FKolkata&forecast_days=7`;
  const data = await fetchJson(url);
  return parseForecastResponse(data, describeWeatherCode);
}

async function fetchAirQuality() {
  upstreamBudget.tryConsume('openMeteo', 1);
  const url =
    `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${NAGPUR_CENTER.lat}` +
    `&longitude=${NAGPUR_CENTER.lng}&current=pm2_5,pm10,us_aqi,european_aqi&timezone=Asia%2FKolkata`;
  const data = await fetchJson(url);
  return parseAirQualityResponse(data);
}

async function fetchJunctionFlow(junction) {
  const key = getTomTomKey();
  const url =
    `https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json` +
    `?point=${junction.lat},${junction.lng}&unit=KMPH&key=${encodeURIComponent(key)}`;
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
  if (!getTomTomKey()) return [];
  if (!upstreamBudget.tryConsume('tomtomNonTile', monitoredJunctions.length)) {
    console.warn('Daily TomTom non-tile quota guard paused flow poll');
    return [];
  }
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
  const key = getTomTomKey();
  if (!key) return [];
  if (!upstreamBudget.tryConsume('tomtomNonTile', 1)) {
    console.warn('Daily TomTom non-tile quota guard paused incidents poll');
    return [];
  }
  const fields = encodeURIComponent(
    '{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,events{description,code},startTime,endTime,from,to,length,delay,roadNumbers}}}'
  );
  const url =
    `https://api.tomtom.com/traffic/services/5/incidentDetails` +
    `?key=${encodeURIComponent(key)}` +
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
const latencyTracker = new LatencyTracker(500);
const upstreamBudget = new UpstreamBudget({
  tomtomNonTileLimit: activeConfig.dailyTomTomNonTileBudget,
  tomtomTileLimit: activeConfig.dailyTomTomTileBudget
});

class HttpError extends Error {
  /**
   * @param {number} statusCode
   * @param {string} message
   */
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

const helmetMiddleware = /** @type {any} */ (helmet);

app.disable('x-powered-by');
app.use(
  helmetMiddleware({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://unpkg.com'],
        styleSrc: ["'self'", 'https://unpkg.com', 'https://fonts.googleapis.com'],
        styleSrcAttr: ["'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https://tile.openstreetmap.org'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"]
      }
    },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginEmbedderPolicy: false
  })
);

function resolveCorsOrigin(origin, callback) {
  if (!origin || activeConfig.allowedOrigins === '*') {
    return callback(null, true);
  }
  if (Array.isArray(activeConfig.allowedOrigins) && activeConfig.allowedOrigins.includes(origin)) {
    return callback(null, true);
  }
  return callback(new Error('Origin not allowed by CORS'));
}

app.use(cors({ origin: resolveCorsOrigin }));
app.use(express.json({ limit: '16kb' }));
app.use((req, res, next) => {
  const start = performance.now();
  res.on('finish', () => {
    latencyTracker.record(performance.now() - start);
  });
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

const io = new Server(server, {
  cors: { origin: resolveCorsOrigin, methods: ['GET'] }
});

// ── Live State & Bounded LRU Tile Caches ──
const tileCache = new LruCache({
  maxEntries: TILE_CACHE_MAX_ENTRIES,
  defaultTtlMs: TILE_CACHE_TTL_MS
});
const basemapTileCache = new LruCache({
  maxEntries: BASEMAP_CACHE_MAX_ENTRIES,
  defaultTtlMs: BASEMAP_CACHE_TTL_MS
});

const liveState = {
  updatedAt: null,
  lastSuccessAt: {
    flow: null,
    incidents: null,
    weather: null,
    airQuality: null
  },
  stale: false,
  staleSources: [],
  features: {
    weatherRisk: activeConfig.featureWeatherRisk
  },
  tomtomConfigured: Boolean(getTomTomKey()),
  weather: null,
  weatherExtended: null,
  airQuality: null,
  roadRiskAdvisories: [],
  observedHotspots: [],
  junctions: [],
  incidents: [],
  predictions: []
};

const lastAttemptFailed = {
  flow: false,
  incidents: false,
  weather: false,
  airQuality: false
};
let hasAttemptedRefresh = false;
let lastFlowFetchMs = 0;
let lastIncidentsFetchMs = 0;
let lastWeatherFetchMs = 0;
let lastAirQualityFetchMs = 0;
let refreshInFlight = null;

/**
 * Validate integer slippy-map tile coordinates against zoom grid bounds [0, 2^z).
 */
function isValidTileCoord(z, x, y) {
  return (
    Number.isInteger(z) &&
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    z >= 0 &&
    z <= 19 &&
    x >= 0 &&
    y >= 0 &&
    x < Math.pow(2, z) &&
    y < Math.pow(2, z)
  );
}

/**
 * Redact configured secrets from diagnostic messages.
 */
function redactKey(text) {
  return redactSecrets(text, getTomTomKey());
}

/**
 * Derive overall updatedAt and per-source staleness strictly from successful fetches.
 */
function computeFreshness({
  lastSuccessAt,
  lastAttemptFailed: failedMap,
  tomtomConfigured,
  hasAttemptedRefresh: attempted,
  trackAirQuality = false,
  nowMs = Date.now()
}) {
  /** @type {{ flow: string | null, incidents: string | null, weather: string | null, airQuality: string | null }} */
  const normalized = {
    flow: lastSuccessAt?.flow || null,
    incidents: lastSuccessAt?.incidents || null,
    weather: lastSuccessAt?.weather || null,
    airQuality: lastSuccessAt?.airQuality || null
  };

  let updatedAt = null;
  let maxMs = -1;
  for (const ts of Object.values(normalized)) {
    if (!ts) continue;
    const parsed = Date.parse(ts);
    if (Number.isFinite(parsed) && parsed > maxMs) {
      maxMs = parsed;
      updatedAt = ts;
    }
  }

  const activeSources = tomtomConfigured ? ['flow', 'incidents', 'weather'] : ['weather'];
  if (trackAirQuality) activeSources.push('airQuality');

  const thresholds = {
    flow: FLOW_STALE_MS,
    incidents: INCIDENTS_STALE_MS,
    weather: WEATHER_STALE_MS,
    airQuality: AIR_QUALITY_STALE_MS
  };
  const staleSources = [];

  for (const src of activeSources) {
    const ts = normalized[src] || null;
    const failed = Boolean(failedMap?.[src]);
    const expired = ts !== null && nowMs - Date.parse(ts) > thresholds[src];
    const missingAfterAttempt = Boolean(attempted) && ts === null;
    if (failed || expired || missingAfterAttempt) {
      staleSources.push(src);
    }
  }

  const publicLastSuccess = {
    flow: normalized.flow,
    incidents: normalized.incidents,
    weather: normalized.weather
  };
  if (trackAirQuality || lastSuccessAt?.airQuality !== undefined) {
    publicLastSuccess.airQuality = normalized.airQuality;
  }

  return {
    updatedAt,
    lastSuccessAt: publicLastSuccess,
    stale: staleSources.length > 0,
    staleSources
  };
}

function getLiveStateSnapshot(nowMs = Date.now()) {
  const freshness = computeFreshness({
    lastSuccessAt: liveState.lastSuccessAt,
    lastAttemptFailed,
    tomtomConfigured: Boolean(getTomTomKey()),
    hasAttemptedRefresh,
    trackAirQuality: activeConfig.featureWeatherRisk,
    nowMs
  });
  liveState.updatedAt = freshness.updatedAt;
  liveState.lastSuccessAt = {
    flow: freshness.lastSuccessAt.flow,
    incidents: freshness.lastSuccessAt.incidents,
    weather: freshness.lastSuccessAt.weather,
    airQuality: freshness.lastSuccessAt.airQuality ?? null
  };
  liveState.stale = freshness.stale;
  liveState.staleSources = freshness.staleSources;
  liveState.features = { weatherRisk: activeConfig.featureWeatherRisk };
  liveState.tomtomConfigured = Boolean(getTomTomKey());
  return liveState;
}

function recomputePredictions() {
  liveState.predictions = predictDeployments(
    liveState.junctions,
    liveState.incidents,
    liveState.weather,
    stations
  );
  if (activeConfig.featureWeatherRisk) {
    liveState.observedHotspots = hotspotStore.getObservedHotspots(monitoredJunctions);
    liveState.roadRiskAdvisories = computeRoadRiskAdvisories(
      liveState.weatherExtended,
      liveState.airQuality,
      liveState.junctions
    );
  } else {
    liveState.observedHotspots = [];
    liveState.roadRiskAdvisories = [];
  }
  liveState.features = { weatherRisk: activeConfig.featureWeatherRisk };
  liveState.tomtomConfigured = Boolean(getTomTomKey());
}

async function refreshLiveState({
  forceFlow = false,
  forceIncidents = false,
  forceWeather = false,
  forceAirQuality = false
} = {}) {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const now = Date.now();
    const tasks = [];
    const hasKey = Boolean(getTomTomKey());

    if (
      activeConfig.featureWeatherRisk &&
      (forceWeather || now - lastWeatherFetchMs >= WEATHER_POLL_INTERVAL_MS || !liveState.weather)
    ) {
      tasks.push(
        fetchWeather()
          .then((ext) => {
            const ts = Date.now();
            liveState.weatherExtended = ext;
            liveState.weather = {
              temperatureC: ext.current.temperatureC,
              precipitation: ext.current.precipitationMm,
              weatherCode: ext.current.weatherCode,
              condition: ext.current.condition,
              updatedAt: ext.current.updatedAt
            };
            lastWeatherFetchMs = ts;
            liveState.lastSuccessAt.weather = new Date(ts).toISOString();
            lastAttemptFailed.weather = false;
          })
          .catch((err) => {
            lastAttemptFailed.weather = true;
            console.warn('Weather fetch failed:', redactKey(err.message));
          })
      );
    }

    if (
      activeConfig.featureWeatherRisk &&
      (forceAirQuality ||
        now - lastAirQualityFetchMs >= AIR_QUALITY_POLL_INTERVAL_MS ||
        !liveState.airQuality)
    ) {
      tasks.push(
        fetchAirQuality()
          .then((aq) => {
            const ts = Date.now();
            liveState.airQuality = aq;
            lastAirQualityFetchMs = ts;
            liveState.lastSuccessAt.airQuality = new Date(ts).toISOString();
            lastAttemptFailed.airQuality = false;
          })
          .catch((err) => {
            lastAttemptFailed.airQuality = true;
            console.warn('Air quality fetch failed:', redactKey(err.message));
          })
      );
    }

    if (
      hasKey &&
      (forceFlow || now - lastFlowFetchMs >= FLOW_POLL_INTERVAL_MS || liveState.junctions.length === 0)
    ) {
      tasks.push(
        fetchAllJunctionFlows()
          .then((flows) => {
            if (flows.length > 0) {
              const ts = Date.now();
              for (const flow of flows) {
                const list = junctionHistory.get(flow.id) || [];
                list.push(flow.congestionPct);
                if (list.length > HISTORY_LIMIT) list.shift();
                junctionHistory.set(flow.id, list);
              }
              if (activeConfig.featureWeatherRisk) {
                hotspotStore.recordSnapshot(
                  flows,
                  Number(liveState.weather?.precipitation ?? 0),
                  new Date(ts).toISOString()
                );
              }
              liveState.junctions = flows;
              lastFlowFetchMs = ts;
              liveState.lastSuccessAt.flow = new Date(ts).toISOString();
              lastAttemptFailed.flow = false;
            } else {
              lastAttemptFailed.flow = true;
              console.warn('Flow fetch failed: 0 junctions succeeded');
            }
          })
          .catch((err) => {
            lastAttemptFailed.flow = true;
            console.warn('Flow fetch failed:', redactKey(err.message));
          })
      );
    }

    if (
      hasKey &&
      (forceIncidents || now - lastIncidentsFetchMs >= INCIDENTS_POLL_INTERVAL_MS)
    ) {
      tasks.push(
        fetchIncidents()
          .then((incs) => {
            const ts = Date.now();
            liveState.incidents = incs;
            lastIncidentsFetchMs = ts;
            liveState.lastSuccessAt.incidents = new Date(ts).toISOString();
            lastAttemptFailed.incidents = false;
          })
          .catch((err) => {
            lastAttemptFailed.incidents = true;
            console.warn('Incidents fetch failed:', redactKey(err.message));
          })
      );
    }

    if (tasks.length === 0) return getLiveStateSnapshot();

    await Promise.all(tasks);
    hasAttemptedRefresh = true;
    recomputePredictions();
    const snapshot = getLiveStateSnapshot();
    io.emit('traffic:state', snapshot);
    return snapshot;
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

// ── Socket.IO Lifecycle (per-IP cap) ──
const socketCountsByIp = new Map();
io.use((socket, next) => {
  const ip = String(socket.handshake.address || 'unknown');
  const count = socketCountsByIp.get(ip) || 0;
  if (count >= MAX_SOCKETS_PER_IP) {
    return next(new Error('Too many concurrent connections from this IP'));
  }
  socketCountsByIp.set(ip, count + 1);
  socket.once('disconnect', () => {
    const nextCount = (socketCountsByIp.get(ip) || 1) - 1;
    if (nextCount <= 0) socketCountsByIp.delete(ip);
    else socketCountsByIp.set(ip, nextCount);
  });
  return next();
});

io.on('connection', (socket) => {
  socket.emit('traffic:state', getLiveStateSnapshot());

  const hasKey = Boolean(getTomTomKey());
  const shouldRefreshFlow =
    hasKey &&
    (!liveState.lastSuccessAt.flow || Date.now() - lastFlowFetchMs > FLOW_POLL_INTERVAL_MS);
  const shouldRefreshWeather =
    activeConfig.featureWeatherRisk &&
    (!liveState.lastSuccessAt.weather || Date.now() - lastWeatherFetchMs > WEATHER_POLL_INTERVAL_MS);
  const shouldRefreshAirQuality =
    activeConfig.featureWeatherRisk &&
    (!liveState.lastSuccessAt.airQuality ||
      Date.now() - lastAirQualityFetchMs > AIR_QUALITY_POLL_INTERVAL_MS);
  const shouldRefreshIncidents =
    hasKey &&
    (!liveState.lastSuccessAt.incidents ||
      Date.now() - lastIncidentsFetchMs > INCIDENTS_POLL_INTERVAL_MS);

  if (shouldRefreshFlow || shouldRefreshWeather || shouldRefreshAirQuality || shouldRefreshIncidents) {
    refreshLiveState({
      forceFlow: shouldRefreshFlow,
      forceWeather: shouldRefreshWeather,
      forceAirQuality: shouldRefreshAirQuality,
      forceIncidents: shouldRefreshIncidents
    });
  }
});

// ── Rate Limiters ──
const healthLimiter = createRateLimiter({ windowMs: 60_000, max: 120, name: 'health' });
const weatherLimiter = createRateLimiter({ windowMs: 60_000, max: 30, name: 'weather' });
const tileLimiter = createRateLimiter({ windowMs: 60_000, max: 500, name: 'tiles' });
const searchLimiter = createRateLimiter({ windowMs: 60_000, max: 40, name: 'search' });
const routeLimiter = createRateLimiter({ windowMs: 60_000, max: 20, name: 'route' });

// ── Routes ──
app.get('/api/health', healthLimiter, (_req, res) => {
  const snap = getLiveStateSnapshot();
  res.json({
    status: 'ok',
    tomtomConfigured: Boolean(getTomTomKey()),
    features: snap.features,
    updatedAt: snap.updatedAt,
    lastSuccessAt: snap.lastSuccessAt,
    stale: snap.stale,
    staleSources: snap.staleSources,
    activeClients: io.engine.clientsCount,
    monitoredJunctions: monitoredJunctions.length,
    alertsCount: snap.predictions.length,
    observedHotspotsCount: snap.observedHotspots.length,
    weatherLoaded: Boolean(snap.weather),
    metrics: {
      p95LatencyMs: latencyTracker.p95Ms(),
      trafficTileCache: tileCache.stats(),
      basemapTileCache: basemapTileCache.stats(),
      upstreamToday: upstreamBudget.snapshot()
    }
  });
});

app.get('/api/weather', weatherLimiter, (_req, res) => {
  if (!activeConfig.featureWeatherRisk) {
    return res.json({
      enabled: false,
      message: 'Weather & road-risk module disabled by feature flag'
    });
  }
  const snap = getLiveStateSnapshot();
  return res.json({
    enabled: true,
    updatedAt: snap.updatedAt,
    stale: snap.stale,
    staleSources: snap.staleSources,
    lastSuccessAt: snap.lastSuccessAt,
    weather: snap.weatherExtended,
    airQuality: snap.airQuality,
    roadRiskAdvisories: snap.roadRiskAdvisories,
    observedHotspots: snap.observedHotspots
  });
});

app.get('/tiles/basemap/:z/:x/:y.png', tileLimiter, async (req, res) => {
  const paramsParsed = tileParamsSchema.safeParse(req.params);
  const queryParsed = tileQuerySchema.safeParse(req.query);
  if (!paramsParsed.success || !queryParsed.success) {
    return res.status(400).json({ error: 'Invalid tile coordinates or parameters' });
  }

  const key = getTomTomKey();
  if (!key) {
    return res.status(204).end();
  }

  const { z, x, y } = paramsParsed.data;
  const theme = queryParsed.data.theme === 'dark' ? 'dark' : 'light';
  const style = theme === 'dark' ? 'night' : 'main';
  const cacheKey = `${theme}/${z}/${x}/${y}`;

  try {
    const { value: buffer } = await basemapTileCache.dedupeFetch(
      cacheKey,
      async () => {
        if (!upstreamBudget.tryConsume('tomtomTile', 1)) {
          throw new HttpError(503, 'Daily TomTom tile quota exceeded');
        }
        const upstreamUrl =
          `https://api.tomtom.com/map/1/tile/basic/${style}/${z}/${x}/${y}.png` +
          `?tileSize=512&view=IN&key=${encodeURIComponent(key)}`;
        const upstream = await safeFetch(upstreamUrl, { timeoutMs: UPSTREAM_TIMEOUT_MS }, fetchImpl);
        if (upstream.status !== 200) {
          const errText = redactKey(await upstream.text().catch(() => ''));
          console.warn('TomTom basemap tile error:', upstream.status, errText);
          throw new HttpError(
            upstream.status === 404 || upstream.status === 204 ? 204 : 502,
            `Upstream HTTP ${upstream.status}`
          );
        }
        return Buffer.from(await upstream.arrayBuffer());
      },
      BASEMAP_CACHE_TTL_MS
    );

    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=600');
    return res.send(buffer);
  } catch (err) {
    const status = Number(err?.statusCode) || 502;
    return res.status(status).end();
  }
});

app.get('/tiles/traffic/:z/:x/:y.png', tileLimiter, async (req, res) => {
  const paramsParsed = tileParamsSchema.safeParse(req.params);
  const queryParsed = tileQuerySchema.safeParse(req.query);
  if (!paramsParsed.success || !queryParsed.success) {
    return res.status(400).json({ error: 'Invalid tile coordinates or parameters' });
  }

  const key = getTomTomKey();
  if (!key) {
    return res.status(204).end();
  }

  const { z, x, y } = paramsParsed.data;
  const theme = queryParsed.data.theme === 'dark' ? 'dark' : 'light';
  const style = theme === 'dark' ? 'relative0-dark' : 'relative0';
  const cacheKey = `${theme}/${z}/${x}/${y}`;

  try {
    const { value: buffer } = await tileCache.dedupeFetch(
      cacheKey,
      async () => {
        if (!upstreamBudget.tryConsume('tomtomTile', 1)) {
          throw new HttpError(503, 'Daily TomTom tile quota exceeded');
        }
        const upstreamUrl =
          `https://api.tomtom.com/traffic/map/4/tile/flow/${style}/${z}/${x}/${y}.png` +
          `?tileSize=512&key=${encodeURIComponent(key)}`;
        const upstream = await safeFetch(upstreamUrl, { timeoutMs: UPSTREAM_TIMEOUT_MS }, fetchImpl);
        if (upstream.status !== 200) {
          const errText = redactKey(await upstream.text().catch(() => ''));
          console.warn('TomTom tile error:', upstream.status, errText);
          throw new HttpError(
            upstream.status === 404 || upstream.status === 204 ? 204 : 502,
            `Upstream HTTP ${upstream.status}`
          );
        }
        return Buffer.from(await upstream.arrayBuffer());
      },
      TILE_CACHE_TTL_MS
    );

    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=120');
    return res.send(buffer);
  } catch (err) {
    const status = Number(err?.statusCode) || 502;
    return res.status(status).end();
  }
});

app.get('/api/search', searchLimiter, async (req, res) => {
  const parsed = searchQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid search query: q must be 2-100 characters with no extra fields',
      results: []
    });
  }

  const key = getTomTomKey();
  if (!key) {
    return res.status(503).json({
      error: 'TOMTOM_API_KEY is not configured on the server',
      tomtomConfigured: false,
      results: []
    });
  }

  if (!upstreamBudget.tryConsume('tomtomNonTile', 1)) {
    return res.status(503).json({
      error: 'Daily upstream quota guard reached',
      results: []
    });
  }

  const { q } = parsed.data;
  try {
    const url =
      `https://api.tomtom.com/search/2/search/${encodeURIComponent(q)}.json` +
      `?key=${encodeURIComponent(key)}` +
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
  } catch (err) {
    console.warn('Search failed:', redactKey(err.message));
    return res.status(502).json({ error: 'Place search service unavailable', results: [] });
  }
});

async function fetchTomTomRoute(fromLat, fromLng, toLat, toLng, routeType) {
  const key = getTomTomKey();
  const url =
    `https://api.tomtom.com/routing/1/calculateRoute/${fromLat},${fromLng}:${toLat},${toLng}/json` +
    `?key=${encodeURIComponent(key)}` +
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

app.get('/api/route', routeLimiter, async (req, res) => {
  const parsed = routeQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Valid Nagpur coordinates (fromLat, fromLng, toLat, toLng) are required'
    });
  }

  const key = getTomTomKey();
  if (!key) {
    return res.status(503).json({
      error: 'TOMTOM_API_KEY is not configured on the server',
      tomtomConfigured: false
    });
  }

  if (!upstreamBudget.tryConsume('tomtomNonTile', 2)) {
    return res.status(503).json({ error: 'Daily upstream quota guard reached' });
  }

  const { fromLat, fromLng, toLat, toLng } = parsed.data;
  try {
    const [fastest, shortest] = await Promise.all([
      fetchTomTomRoute(fromLat, fromLng, toLat, toLng, 'fastest'),
      fetchTomTomRoute(fromLat, fromLng, toLat, toLng, 'shortest')
    ]);
    if (activeConfig.featureWeatherRisk) {
      const hotspots = hotspotStore.getObservedHotspots(monitoredJunctions);
      fastest.rainWarnings = findRouteHotspotWarnings(
        fastest.coordinates,
        hotspots,
        liveState.weatherExtended,
        haversineMeters
      );
      shortest.rainWarnings = findRouteHotspotWarnings(
        shortest.coordinates,
        hotspots,
        liveState.weatherExtended,
        haversineMeters
      );
    }
    return res.json({ fastest, shortest });
  } catch (err) {
    console.warn('Routing failed:', redactKey(err.message));
    return res.status(502).json({ error: 'Routing service unavailable' });
  }
});

let pollTimers = [];

function startPollingLoops() {
  pollTimers.push(
    setInterval(() => {
      if (io.engine.clientsCount > 0) {
        refreshLiveState({ forceFlow: true });
      }
    }, FLOW_POLL_INTERVAL_MS),
    setInterval(() => {
      if (io.engine.clientsCount > 0) {
        refreshLiveState({ forceIncidents: true });
      }
    }, INCIDENTS_POLL_INTERVAL_MS),
    setInterval(() => {
      if (io.engine.clientsCount > 0 && activeConfig.featureWeatherRisk) {
        refreshLiveState({ forceWeather: true });
      }
    }, WEATHER_POLL_INTERVAL_MS),
    setInterval(() => {
      if (io.engine.clientsCount > 0 && activeConfig.featureWeatherRisk) {
        refreshLiveState({ forceAirQuality: true });
      }
    }, AIR_QUALITY_POLL_INTERVAL_MS)
  );
}

function setupGracefulShutdown() {
  const shutdown = (signal) => {
    console.log(`Received ${signal}; shutting down gracefully...`);
    for (const timer of pollTimers) clearInterval(timer);
    pollTimers = [];
    io.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

/**
 * @param {{ fetch?: typeof fetch, config?: Partial<ReturnType<typeof loadConfig>>, hotspotStore?: InstanceType<typeof HotspotObservationStore> }} [overrides]
 */
function setTestOverrides({ fetch: customFetch, config: customConfig, hotspotStore: customStore } = {}) {
  if (customFetch) fetchImpl = customFetch;
  if (customConfig) activeConfig = { ...activeConfig, ...customConfig };
  if (customStore) hotspotStore = customStore;
}

function resetStateForTests() {
  fetchImpl = globalThis.fetch;
  activeConfig = loadConfig();
  tileCache.clear();
  basemapTileCache.clear();
  upstreamBudget.reset();
  latencyTracker.reset();
  healthLimiter.reset();
  weatherLimiter.reset();
  tileLimiter.reset();
  searchLimiter.reset();
  routeLimiter.reset();
  junctionHistory.clear();
  liveState.updatedAt = null;
  liveState.lastSuccessAt = { flow: null, incidents: null, weather: null, airQuality: null };
  liveState.stale = false;
  liveState.staleSources = [];
  liveState.features = { weatherRisk: activeConfig.featureWeatherRisk };
  liveState.tomtomConfigured = Boolean(getTomTomKey());
  liveState.weather = null;
  liveState.weatherExtended = null;
  liveState.airQuality = null;
  liveState.roadRiskAdvisories = [];
  liveState.observedHotspots = [];
  liveState.junctions = [];
  liveState.incidents = [];
  liveState.predictions = [];
  lastAttemptFailed.flow = false;
  lastAttemptFailed.incidents = false;
  lastAttemptFailed.weather = false;
  lastAttemptFailed.airQuality = false;
  hasAttemptedRefresh = false;
  lastFlowFetchMs = 0;
  lastIncidentsFetchMs = 0;
  lastWeatherFetchMs = 0;
  lastAirQualityFetchMs = 0;
}

if (require.main === module) {
  startPollingLoops();
  setupGracefulShutdown();
  server.listen(PORT, () => {
    console.log(
      `NGP-TRAFFIC listening on http://localhost:${PORT} (TomTom configured: ${Boolean(getTomTomKey())})`
    );
  });
}

module.exports = {
  app,
  server,
  io,
  predictDeployments,
  computeTrend,
  computeFreshness,
  isValidTileCoord,
  haversineMeters,
  findNearestPoliceStation,
  describeWeatherCode,
  extractIncidentPoint,
  setTestOverrides,
  resetStateForTests,
  refreshLiveState,
  upstreamBudget,
  tileCache,
  basemapTileCache
};
