'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { z } = require('zod');

const AIR_QUALITY_POLL_INTERVAL_MS = 30 * 60 * 1000;
const AIR_QUALITY_STALE_MS = 2 * AIR_QUALITY_POLL_INTERVAL_MS;
const MAX_SAMPLES_PER_BUCKET = 60;
const MIN_OBSERVED_RAIN_SAMPLES = 3;
const MIN_OBSERVED_DRY_SAMPLES = 3;
const RAIN_SLOWDOWN_RATIO = 0.65; // >= 35% drop from dry median
const HOTSPOT_ROUTE_RADIUS_M = 150;

const forecastResponseSchema = z.object({
  current: z.object({
    temperature_2m: z.number(),
    relative_humidity_2m: z.number().optional().default(0),
    apparent_temperature: z.number().optional(),
    precipitation: z.number().default(0),
    weather_code: z.number().default(0),
    wind_speed_10m: z.number().optional().default(0)
  }),
  hourly: z
    .object({
      time: z.array(z.string()),
      temperature_2m: z.array(z.number()),
      apparent_temperature: z.array(z.number()).optional(),
      precipitation_probability: z.array(z.number()).optional(),
      precipitation: z.array(z.number()).optional(),
      visibility: z.array(z.number()).optional(),
      wind_speed_10m: z.array(z.number()).optional(),
      weather_code: z.array(z.number()).optional()
    })
    .optional(),
  daily: z
    .object({
      time: z.array(z.string()),
      weather_code: z.array(z.number()),
      temperature_2m_max: z.array(z.number()),
      temperature_2m_min: z.array(z.number()),
      apparent_temperature_max: z.array(z.number()).optional(),
      precipitation_sum: z.array(z.number()).optional(),
      precipitation_probability_max: z.array(z.number()).optional(),
      wind_speed_10m_max: z.array(z.number()).optional()
    })
    .optional()
});

const airQualityResponseSchema = z.object({
  current: z.object({
    pm2_5: z.number().nullable().optional(),
    pm10: z.number().nullable().optional(),
    us_aqi: z.number().nullable().optional(),
    european_aqi: z.number().nullable().optional()
  })
});

/**
 * Compute numeric median of a non-empty array.
 * @param {number[]} values
 */
function median(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Parse and validate Open-Meteo Forecast payload (current, next 6h, 7-day).
 * @param {unknown} raw
 * @param {(code: number) => string} describeWeatherCode
 * @param {number} [nowMs]
 */
function parseForecastResponse(raw, describeWeatherCode, nowMs = Date.now()) {
  const parsed = forecastResponseSchema.parse(raw);
  const cur = parsed.current;
  const hourly = parsed.hourly;

  let startIdx = 0;
  if (hourly && hourly.time.length > 0) {
    const found = hourly.time.findIndex((t) => Date.parse(t) >= nowMs - 30 * 60 * 1000);
    startIdx = found >= 0 ? found : 0;
  }

  /** @type {Array<{ time: string, tempC: number, apparentTempC: number, precipProbPct: number, precipMm: number, visibilityM: number | null, windSpeedKmh: number, weatherCode: number, condition: string }>} */
  const next6h = [];
  if (hourly) {
    const endIdx = Math.min(hourly.time.length, startIdx + 6);
    for (let i = startIdx; i < endIdx; i++) {
      const code = Number(hourly.weather_code?.[i] ?? cur.weather_code ?? 0);
      next6h.push({
        time: hourly.time[i],
        tempC: Math.round(Number(hourly.temperature_2m[i] ?? cur.temperature_2m)),
        apparentTempC: Math.round(
          Number(hourly.apparent_temperature?.[i] ?? hourly.temperature_2m[i] ?? cur.temperature_2m)
        ),
        precipProbPct: Math.round(Number(hourly.precipitation_probability?.[i] ?? 0)),
        precipMm: Math.round(Number(hourly.precipitation?.[i] ?? 0) * 10) / 10,
        visibilityM:
          hourly.visibility?.[i] !== undefined ? Math.round(Number(hourly.visibility[i])) : null,
        windSpeedKmh: Math.round(Number(hourly.wind_speed_10m?.[i] ?? cur.wind_speed_10m ?? 0)),
        weatherCode: code,
        condition: describeWeatherCode(code)
      });
    }
  }

  /** @type {Array<{ date: string, weatherCode: number, condition: string, tempMaxC: number, tempMinC: number, apparentMaxC: number, precipSumMm: number, precipProbMaxPct: number, windMaxKmh: number }>} */
  const daily7d = [];
  const daily = parsed.daily;
  if (daily) {
    const len = Math.min(7, daily.time.length);
    for (let i = 0; i < len; i++) {
      const code = Number(daily.weather_code[i] ?? 0);
      daily7d.push({
        date: daily.time[i],
        weatherCode: code,
        condition: describeWeatherCode(code),
        tempMaxC: Math.round(Number(daily.temperature_2m_max[i] ?? 0)),
        tempMinC: Math.round(Number(daily.temperature_2m_min[i] ?? 0)),
        apparentMaxC: Math.round(
          Number(daily.apparent_temperature_max?.[i] ?? daily.temperature_2m_max[i] ?? 0)
        ),
        precipSumMm: Math.round(Number(daily.precipitation_sum?.[i] ?? 0) * 10) / 10,
        precipProbMaxPct: Math.round(Number(daily.precipitation_probability_max?.[i] ?? 0)),
        windMaxKmh: Math.round(Number(daily.wind_speed_10m_max?.[i] ?? 0))
      });
    }
  }

  const currentVisibilityM = next6h[0]?.visibilityM ?? null;
  const currentPrecipProbPct = next6h[0]?.precipProbPct ?? 0;

  return {
    current: {
      temperatureC: Math.round(cur.temperature_2m),
      relativeHumidityPct: Math.round(cur.relative_humidity_2m),
      apparentTempC: Math.round(cur.apparent_temperature ?? cur.temperature_2m),
      precipitationMm: Math.round(cur.precipitation * 10) / 10,
      weatherCode: Number(cur.weather_code),
      condition: describeWeatherCode(cur.weather_code),
      windSpeedKmh: Math.round(cur.wind_speed_10m),
      visibilityM: currentVisibilityM,
      precipProbPct: currentPrecipProbPct,
      updatedAt: new Date(nowMs).toISOString()
    },
    next6h,
    daily7d,
    source: 'Open-Meteo Forecast (CC BY 4.0)'
  };
}

/**
 * Categorize US EPA AQI value.
 * @param {number | null} usAqi
 */
function describeUsAqi(usAqi) {
  if (usAqi === null || !Number.isFinite(usAqi)) return 'Unavailable';
  if (usAqi <= 50) return 'Good';
  if (usAqi <= 100) return 'Moderate';
  if (usAqi <= 150) return 'Unhealthy (Sensitive)';
  if (usAqi <= 200) return 'Unhealthy';
  return 'Very Unhealthy';
}

/**
 * Parse and validate Open-Meteo / CAMS Air Quality payload.
 * @param {unknown} raw
 * @param {number} [nowMs]
 */
function parseAirQualityResponse(raw, nowMs = Date.now()) {
  const parsed = airQualityResponseSchema.parse(raw);
  const cur = parsed.current;
  const pm25 = cur.pm2_5 !== undefined && cur.pm2_5 !== null ? Math.round(cur.pm2_5 * 10) / 10 : null;
  const pm10 = cur.pm10 !== undefined && cur.pm10 !== null ? Math.round(cur.pm10 * 10) / 10 : null;
  const usAqi = cur.us_aqi !== undefined && cur.us_aqi !== null ? Math.round(cur.us_aqi) : null;
  const europeanAqi =
    cur.european_aqi !== undefined && cur.european_aqi !== null ? Math.round(cur.european_aqi) : null;

  return {
    pm25,
    pm10,
    usAqi,
    europeanAqi,
    category: describeUsAqi(usAqi),
    source: 'Open-Meteo / CAMS model estimate (CC BY 4.0)',
    updatedAt: new Date(nowMs).toISOString()
  };
}

/**
 * Derive road-risk advisories from weather forecast, air quality, and junction congestion.
 * @param {ReturnType<typeof parseForecastResponse> | null} weatherExtended
 * @param {ReturnType<typeof parseAirQualityResponse> | null} airQuality
 * @param {Array<{ congestionPct?: number }>} junctions
 */
function computeRoadRiskAdvisories(weatherExtended, airQuality, junctions = []) {
  /** @type {Array<{ id: string, type: 'rain' | 'fog' | 'heat' | 'aqi', severity: 'HIGH' | 'MEDIUM', key: string, detail: string }>} */
  const advisories = [];

  if (weatherExtended?.current) {
    const cur = weatherExtended.current;
    const maxCongestion = junctions.reduce(
      (max, j) => Math.max(max, Number(j?.congestionPct || 0)),
      0
    );
    const max6hProb = (weatherExtended.next6h || []).reduce(
      (max, h) => Math.max(max, Number(h?.precipProbPct || 0)),
      0
    );

    if (cur.precipitationMm >= 5 && maxCongestion >= 45) {
      advisories.push({
        id: 'risk_rain_congestion',
        type: 'rain',
        severity: 'HIGH',
        key: 'riskRainCongestion',
        detail: `${cur.precipitationMm} mm/hr · ${maxCongestion}% peak slowdown`
      });
    } else if (cur.precipitationMm >= 5 || max6hProb >= 75) {
      advisories.push({
        id: 'risk_rain_watch',
        type: 'rain',
        severity: 'MEDIUM',
        key: 'riskRainWatch',
        detail:
          cur.precipitationMm >= 5
            ? `${cur.precipitationMm} mm/hr rainfall`
            : `${max6hProb}% rain chance (next 6h)`
      });
    }

    if (cur.visibilityM !== null && cur.visibilityM < 500) {
      advisories.push({
        id: 'risk_fog_severe',
        type: 'fog',
        severity: 'HIGH',
        key: 'riskFogSevere',
        detail: `${cur.visibilityM} m visibility`
      });
    } else if (
      (cur.visibilityM !== null && cur.visibilityM < 1500) ||
      cur.weatherCode === 45 ||
      cur.weatherCode === 48
    ) {
      advisories.push({
        id: 'risk_fog_moderate',
        type: 'fog',
        severity: 'MEDIUM',
        key: 'riskFogModerate',
        detail: cur.visibilityM !== null ? `${cur.visibilityM} m visibility` : 'Fog reported'
      });
    }

    if (cur.apparentTempC >= 45) {
      advisories.push({
        id: 'risk_heat_severe',
        type: 'heat',
        severity: 'HIGH',
        key: 'riskHeatSevere',
        detail: `Feels like ${cur.apparentTempC}°C`
      });
    } else if (cur.apparentTempC >= 40) {
      advisories.push({
        id: 'risk_heat_moderate',
        type: 'heat',
        severity: 'MEDIUM',
        key: 'riskHeatModerate',
        detail: `Feels like ${cur.apparentTempC}°C`
      });
    }
  }

  if (airQuality && ((airQuality.usAqi ?? 0) >= 151 || (airQuality.pm25 ?? 0) >= 55.5)) {
    advisories.push({
      id: 'risk_aqi',
      type: 'aqi',
      severity: 'MEDIUM',
      key: 'riskAqi',
      detail: `US AQI ${airQuality.usAqi ?? '--'} · PM2.5 ${airQuality.pm25 ?? '--'} µg/m³ (CAMS estimate)`
    });
  }

  advisories.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'HIGH' ? -1 : 1));
  return advisories;
}

/**
 * Persistent store of dry vs. rainy junction speed observations for identifying observed waterlogging hotspots.
 */
class HotspotObservationStore {
  /**
   * @param {string} [storePath]
   */
  constructor(storePath = path.join(__dirname, '..', 'data', 'runtime', 'rain-observations.json')) {
    this.storePath = storePath;
    /** @type {Record<string, { drySamples: number[], rainSamples: number[], firstObservedAt: string | null, lastObservedAt: string | null }>} */
    this.junctions = {};
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.storePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
      if (raw && typeof raw.junctions === 'object' && raw.junctions !== null) {
        this.junctions = raw.junctions;
      }
    } catch {
      this.junctions = {};
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      fs.writeFileSync(
        this.storePath,
        JSON.stringify({ junctions: this.junctions }, null, 2) + '\n',
        'utf8'
      );
    } catch {
      // Read-only container filesystems skip disk persistence gracefully
    }
  }

  /**
   * Record junction speeds under dry (<0.5 mm/hr) or rainy (>=5 mm/hr) conditions.
   * @param {Array<{ id: string, currentSpeed: number }>} junctionFlows
   * @param {number} precipitationMm
   * @param {string} [nowIso]
   */
  recordSnapshot(junctionFlows, precipitationMm, nowIso = new Date().toISOString()) {
    if (!Array.isArray(junctionFlows) || junctionFlows.length === 0) return;
    const isRain = Number(precipitationMm) >= 5;
    const isDry = Number(precipitationMm) < 0.5;
    if (!isRain && !isDry) return;

    let changed = false;
    for (const j of junctionFlows) {
      if (!j?.id || !Number.isFinite(j.currentSpeed)) continue;
      if (!this.junctions[j.id]) {
        this.junctions[j.id] = {
          drySamples: [],
          rainSamples: [],
          firstObservedAt: null,
          lastObservedAt: null
        };
      }
      const bucket = this.junctions[j.id];
      const target = isRain ? bucket.rainSamples : bucket.drySamples;
      target.push(Math.round(j.currentSpeed));
      if (target.length > MAX_SAMPLES_PER_BUCKET) target.shift();
      if (isRain) {
        if (!bucket.firstObservedAt) bucket.firstObservedAt = nowIso;
        bucket.lastObservedAt = nowIso;
      }
      changed = true;
    }

    if (changed) this._save();
  }

  /**
   * Return only junctions with empirically observed speed drops during >= 5 mm/hr rain.
   * @param {Array<{ id: string, name: string, lat: number, lng: number }>} junctionMetaList
   */
  getObservedHotspots(junctionMetaList) {
    /** @type {Array<{ id: string, name: string, lat: number, lng: number, rainMedianKmh: number, dryMedianKmh: number, dropPct: number, observations: number, firstObservedAt: string | null, lastObservedAt: string | null, status: 'observed', source: string }>} */
    const hotspots = [];

    for (const meta of junctionMetaList) {
      const rec = this.junctions[meta.id];
      if (!rec) continue;
      if (
        rec.rainSamples.length < MIN_OBSERVED_RAIN_SAMPLES ||
        rec.drySamples.length < MIN_OBSERVED_DRY_SAMPLES
      ) {
        continue;
      }

      const dryMed = median(rec.drySamples);
      const rainMed = median(rec.rainSamples);
      if (dryMed <= 0) continue;

      if (rainMed <= dryMed * RAIN_SLOWDOWN_RATIO) {
        const dropPct = Math.round(((dryMed - rainMed) / dryMed) * 100);
        hotspots.push({
          id: meta.id,
          name: meta.name,
          lat: meta.lat,
          lng: meta.lng,
          rainMedianKmh: Math.round(rainMed),
          dryMedianKmh: Math.round(dryMed),
          dropPct,
          observations: rec.rainSamples.length,
          firstObservedAt: rec.firstObservedAt,
          lastObservedAt: rec.lastObservedAt,
          status: 'observed',
          source: 'Observed speed drop during rainfall >= 5 mm/hr'
        });
      }
    }

    hotspots.sort((a, b) => b.dropPct - a.dropPct);
    return hotspots;
  }

  clear() {
    this.junctions = {};
    this._save();
  }
}

/**
 * Flag route segments passing within 150 m of an observed waterlogging hotspot during rain.
 * @param {Array<[number, number]>} coordinates
 * @param {ReturnType<HotspotObservationStore['getObservedHotspots']>} observedHotspots
 * @param {ReturnType<typeof parseForecastResponse> | null} weatherExtended
 * @param {(lat1: number, lng1: number, lat2: number, lng2: number) => number} haversineMeters
 */
function findRouteHotspotWarnings(coordinates, observedHotspots, weatherExtended, haversineMeters) {
  if (!Array.isArray(coordinates) || coordinates.length === 0) return [];
  if (!Array.isArray(observedHotspots) || observedHotspots.length === 0) return [];

  const curRain = Number(weatherExtended?.current?.precipitationMm || 0);
  const max6hProb = (weatherExtended?.next6h || []).reduce(
    (max, h) => Math.max(max, Number(h?.precipProbPct || 0)),
    0
  );
  if (curRain < 2 && max6hProb < 60) return [];

  const warnings = [];
  for (const hotspot of observedHotspots) {
    let minMeters = Infinity;
    for (const pt of coordinates) {
      if (!Array.isArray(pt) || pt.length < 2) continue;
      const d = haversineMeters(pt[0], pt[1], hotspot.lat, hotspot.lng);
      if (d < minMeters) minMeters = d;
    }
    if (minMeters <= HOTSPOT_ROUTE_RADIUS_M) {
      warnings.push({
        id: hotspot.id,
        name: hotspot.name,
        distanceMeters: Math.round(minMeters),
        rainMedianKmh: hotspot.rainMedianKmh,
        dryMedianKmh: hotspot.dryMedianKmh,
        observations: hotspot.observations,
        status: hotspot.status
      });
    }
  }
  return warnings;
}

module.exports = {
  AIR_QUALITY_POLL_INTERVAL_MS,
  AIR_QUALITY_STALE_MS,
  HotspotObservationStore,
  parseForecastResponse,
  parseAirQualityResponse,
  computeRoadRiskAdvisories,
  findRouteHotspotWarnings
};
