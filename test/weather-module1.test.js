'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  HotspotObservationStore,
  parseForecastResponse,
  parseAirQualityResponse,
  computeRoadRiskAdvisories,
  findRouteHotspotWarnings
} = require('../src/weather-risk');
const {
  app,
  describeWeatherCode,
  haversineMeters,
  setTestOverrides,
  resetStateForTests
} = require('../server');

const sampleForecastRaw = {
  current: {
    temperature_2m: 28.4,
    relative_humidity_2m: 78,
    apparent_temperature: 31.2,
    precipitation: 6.4,
    weather_code: 63,
    wind_speed_10m: 18.2
  },
  hourly: {
    time: [
      '2026-11-24T10:00',
      '2026-11-24T11:00',
      '2026-11-24T12:00',
      '2026-11-24T13:00',
      '2026-11-24T14:00',
      '2026-11-24T15:00'
    ],
    temperature_2m: [28, 29, 30, 30, 29, 28],
    apparent_temperature: [31, 32, 33, 33, 31, 30],
    precipitation_probability: [85, 80, 65, 40, 20, 10],
    precipitation: [6.4, 4.2, 1.5, 0, 0, 0],
    visibility: [420, 900, 3500, 8000, 10000, 10000],
    wind_speed_10m: [18, 17, 15, 14, 12, 10],
    weather_code: [63, 61, 80, 3, 2, 1]
  },
  daily: {
    time: [
      '2026-11-24',
      '2026-11-25',
      '2026-11-26',
      '2026-11-27',
      '2026-11-28',
      '2026-11-29',
      '2026-11-30'
    ],
    weather_code: [63, 3, 1, 0, 0, 2, 0],
    temperature_2m_max: [31, 32, 33, 33, 34, 34, 35],
    temperature_2m_min: [21, 20, 19, 19, 20, 20, 21],
    apparent_temperature_max: [34, 34, 35, 35, 36, 36, 37],
    precipitation_sum: [14.5, 2.0, 0, 0, 0, 0, 0],
    precipitation_probability_max: [85, 30, 10, 5, 5, 10, 5],
    wind_speed_10m_max: [20, 16, 14, 12, 11, 12, 12]
  }
};

const sampleAqRaw = {
  current: {
    pm2_5: 42.3,
    pm10: 46.1,
    us_aqi: 102,
    european_aqi: 56
  }
};

test('parseForecastResponse & parseAirQualityResponse parse valid data and reject malformed payloads', () => {
  const nowMs = Date.parse('2026-11-24T10:15:00Z');
  const forecast = parseForecastResponse(sampleForecastRaw, describeWeatherCode, nowMs);
  assert.equal(forecast.current.temperatureC, 28);
  assert.equal(forecast.current.apparentTempC, 31);
  assert.equal(forecast.current.precipitationMm, 6.4);
  assert.equal(forecast.current.visibilityM, 420);
  assert.equal(forecast.next6h.length, 6);
  assert.equal(forecast.daily7d.length, 7);

  const aq = parseAirQualityResponse(sampleAqRaw, nowMs);
  assert.equal(aq.pm25, 42.3);
  assert.equal(aq.usAqi, 102);
  assert.equal(aq.category, 'Unhealthy (Sensitive)');

  assert.throws(() => parseForecastResponse({ bad: true }, describeWeatherCode));
  assert.throws(() => parseAirQualityResponse({}));
});

test('computeRoadRiskAdvisories flags heavy rain + congestion, fog, heat, and AQI', () => {
  const forecast = parseForecastResponse(sampleForecastRaw, describeWeatherCode, Date.parse('2026-11-24T10:00:00'));
  const advisories = computeRoadRiskAdvisories(
    forecast,
    { pm25: 68, pm10: 90, usAqi: 162, europeanAqi: 85, category: 'Unhealthy', source: '', updatedAt: '' },
    [{ congestionPct: 55 }]
  );
  const ids = advisories.map((a) => a.id);
  assert.equal(ids.includes('risk_rain_congestion'), true);
  assert.equal(ids.includes('risk_fog_severe'), true);
  assert.equal(ids.includes('risk_aqi'), true);

  const heatForecast = parseForecastResponse(
    {
      ...sampleForecastRaw,
      current: { ...sampleForecastRaw.current, precipitation: 0, apparent_temperature: 46, weather_code: 0 },
      hourly: { ...sampleForecastRaw.hourly, visibility: [10000, 10000, 10000, 10000, 10000, 10000], precipitation_probability: [0, 0, 0, 0, 0, 0] }
    },
    describeWeatherCode,
    Date.parse('2026-11-24T10:00:00')
  );
  const heatAdvisories = computeRoadRiskAdvisories(heatForecast, null, []);
  assert.equal(heatAdvisories.some((a) => a.id === 'risk_heat_severe'), true);
});

test('HotspotObservationStore returns empty on cold start and marks observed hotspots after >=3 rain slowdowns', () => {
  const tmpFile = path.join(os.tmpdir(), `ngp-hotspots-${Date.now()}.json`);
  try {
    const store = new HotspotObservationStore(tmpFile);
    const meta = [{ id: 'J001', name: 'Variety Square', lat: 21.1458, lng: 79.0882 }];

    // Cold start -> empty
    assert.deepEqual(store.getObservedHotspots(meta), []);

    // Record 3 dry snapshots (~40 km/h) and only 2 rain snapshots (<3 -> still empty)
    for (let i = 0; i < 3; i++) store.recordSnapshot([{ id: 'J001', currentSpeed: 40 }], 0);
    for (let i = 0; i < 2; i++) store.recordSnapshot([{ id: 'J001', currentSpeed: 18 }], 7);
    assert.deepEqual(store.getObservedHotspots(meta), []);

    // 3rd rain snapshot (~18 km/h <= 0.65 * 40) -> observed hotspot
    store.recordSnapshot([{ id: 'J001', currentSpeed: 18 }], 7);
    const reloaded = new HotspotObservationStore(tmpFile);
    const hotspots = reloaded.getObservedHotspots(meta);
    assert.equal(hotspots.length, 1);
    assert.equal(hotspots[0].status, 'observed');
    assert.equal(hotspots[0].rainMedianKmh, 18);
    assert.equal(hotspots[0].dryMedianKmh, 40);

    // Rain-aware routing warning within 150m during rain
    const forecast = parseForecastResponse(sampleForecastRaw, describeWeatherCode, Date.parse('2026-11-24T10:00:00'));
    const warnings = findRouteHotspotWarnings(
      [
        [21.1459, 79.0883],
        [21.1500, 79.0950]
      ],
      hotspots,
      forecast,
      haversineMeters
    );
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].id, 'J001');
    assert.equal(warnings[0].status, 'observed');

    // Dry weather -> 0 route warnings
    const dryForecast = { ...forecast, current: { ...forecast.current, precipitationMm: 0 }, next6h: [{ ...forecast.next6h[0], precipProbPct: 10 }] };
    assert.deepEqual(findRouteHotspotWarnings([[21.1459, 79.0883]], hotspots, dryForecast, haversineMeters), []);
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
});

test('i18n dictionaries (en, hi, mr) have identical keys', () => {
  const { STRINGS } = require('../public/js/i18n.js');
  const enKeys = Object.keys(STRINGS.en).sort();
  assert.deepEqual(Object.keys(STRINGS.hi).sort(), enKeys);
  assert.deepEqual(Object.keys(STRINGS.mr).sort(), enKeys);
});

test('GET /api/weather respects feature flag and returns forecast + air quality + hotspots', async (t) => {
  const httpServer = app.listen(0);
  await new Promise((resolve) => httpServer.once('listening', resolve));
  const { port } = httpServer.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(async () => {
    resetStateForTests();
    await new Promise((resolve) => httpServer.close(resolve));
  });

  // Feature flag OFF -> disabled response
  resetStateForTests();
  setTestOverrides({ config: { featureWeatherRisk: false } });
  const offRes = await fetch(`${baseUrl}/api/weather`);
  assert.equal(offRes.status, 200);
  const offBody = await offRes.json();
  assert.equal(offBody.enabled, false);

  // Feature flag ON + mocked Open-Meteo
  resetStateForTests();
  setTestOverrides({
    config: { featureWeatherRisk: true },
    fetch: async (url) => {
      const u = String(url);
      if (u.includes('air-quality-api.open-meteo.com')) {
        return new Response(JSON.stringify(sampleAqRaw), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      return new Response(JSON.stringify(sampleForecastRaw), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  // Trigger state refresh via /api/health or direct import
  const { refreshLiveState } = require('../server');
  await refreshLiveState({ forceWeather: true, forceAirQuality: true });

  const onRes = await fetch(`${baseUrl}/api/weather`);
  assert.equal(onRes.status, 200);
  const onBody = await onRes.json();
  assert.equal(onBody.enabled, true);
  assert.equal(onBody.weather.current.temperatureC, 28);
  assert.equal(onBody.airQuality.usAqi, 102);
  assert.equal(Array.isArray(onBody.roadRiskAdvisories), true);
  assert.equal(Array.isArray(onBody.observedHotspots), true);
});
