'use strict';

const { z } = require('zod');

const CITY_SCHEMA_VERSION = 1;
const CITY_ID_REGEX = /^[a-z][a-z0-9-]{1,31}$/;

const DEFAULT_THRESHOLDS = Object.freeze({
  incidentRadiusM: 150,
  accidentFreeflowRadiusM: 100,
  historyLimit: 3,
  trendDeltaPct: 8,
  freeFlowGuardPct: 15,
  clearingIncidentCongestionPct: 25,
  heavyRainMmHr: 5,
  moderateRainMmHr: 3,
  rainClearingCongestionPct: 50,
  officerCongestionPct: 60,
  monitorCongestionPct: 40,
  delayCapSec: 300
});

/**
 * Derive TomTom basemap political border view from ISO-2 country code.
 * Note: 'Unified' vs country-specific view availability should be verified per city.
 * @param {string} country
 * @returns {string}
 */
function deriveTomTomView(country) {
  return country === 'IN' ? 'IN' : 'Unified';
}

/**
 * Validate an IANA timezone identifier via Intl.DateTimeFormat.
 * @param {string} tz
 * @returns {boolean}
 */
function isValidIanaTimezone(tz) {
  if (typeof tz !== 'string' || tz.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Validate YYYY-MM-DD calendar date strictly.
 * @param {string} dateStr
 * @returns {boolean}
 */
function isValidIsoDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

/**
 * @param {number} lat
 * @param {number} lng
 * @param {{ south: number, west: number, north: number, east: number }} bbox
 * @returns {boolean}
 */
function isInsideBbox(lat, lng, bbox) {
  return lat >= bbox.south && lat <= bbox.north && lng >= bbox.west && lng <= bbox.east;
}

/**
 * @param {{ south: number, west: number, north: number, east: number }} outer
 * @param {{ south: number, west: number, north: number, east: number }} inner
 * @returns {boolean}
 */
function bboxEncloses(outer, inner) {
  return (
    outer.south <= inner.south &&
    outer.north >= inner.north &&
    outer.west <= inner.west &&
    outer.east >= inner.east
  );
}

const latSchema = z.number().finite().min(-90).max(90);
const lngSchema = z.number().finite().min(-180).max(180);

const coordSchema = z
  .object({
    lat: latSchema,
    lng: lngSchema
  })
  .strict();

const bboxSchema = z
  .object({
    south: latSchema,
    west: lngSchema,
    north: latSchema,
    east: lngSchema
  })
  .strict()
  .superRefine((box, ctx) => {
    if (box.south >= box.north) {
      ctx.addIssue({
        code: 'custom',
        path: ['south'],
        message: 'south must be strictly less than north'
      });
    }
    if (box.west >= box.east) {
      ctx.addIssue({
        code: 'custom',
        path: ['west'],
        message: 'west must be strictly less than east'
      });
    }
  });

const landmarkSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
    label: z.string().trim().min(1).max(60),
    name: z.string().trim().min(1).max(100).optional(),
    lat: latSchema,
    lng: lngSchema
  })
  .strict();

const junctionSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
    name: z.string().trim().min(2).max(100),
    lat: latSchema,
    lng: lngSchema,
    key: z.boolean().optional(),
    roadType: z
      .enum([
        'major_intersection',
        'highway_entry',
        'school_zone',
        'commercial',
        'landmark_junction'
      ])
      .optional(),
    zone: z.string().trim().min(1).max(60).optional()
  })
  .strict();

const policeStationSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
    name: z.string().trim().min(2).max(100),
    lat: latSchema,
    lng: lngSchema,
    zone: z.string().trim().min(1).max(60).optional()
  })
  .strict();

const thresholdsOverrideSchema = z
  .object({
    incidentRadiusM: z.number().finite().min(10).max(2000).optional(),
    accidentFreeflowRadiusM: z.number().finite().min(10).max(2000).optional(),
    historyLimit: z.number().int().min(2).max(20).optional(),
    trendDeltaPct: z.number().finite().min(1).max(50).optional(),
    freeFlowGuardPct: z.number().finite().min(0).max(50).optional(),
    clearingIncidentCongestionPct: z.number().finite().min(0).max(100).optional(),
    heavyRainMmHr: z.number().finite().min(0.5).max(100).optional(),
    moderateRainMmHr: z.number().finite().min(0.1).max(100).optional(),
    rainClearingCongestionPct: z.number().finite().min(0).max(100).optional(),
    officerCongestionPct: z.number().finite().min(0).max(100).optional(),
    monitorCongestionPct: z.number().finite().min(0).max(100).optional(),
    delayCapSec: z.number().finite().min(30).max(3600).optional()
  })
  .strict();

const cityConfigSchema = z
  .object({
    schemaVersion: z.literal(CITY_SCHEMA_VERSION),
    id: z.string().regex(CITY_ID_REGEX, 'id must match ^[a-z][a-z0-9-]{1,31}$'),
    name: z.string().trim().min(2).max(80),
    country: z.string().regex(/^[A-Z]{2}$/, 'country must be a 2-letter uppercase ISO-2 code'),
    timezone: z
      .string()
      .min(1)
      .max(64)
      .refine(isValidIanaTimezone, 'timezone must be a valid IANA timezone'),
    locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'locale must be like en or en-IN'),
    status: z.enum(['verified', 'community', 'experimental']),
    tomtomView: z.string().regex(/^[A-Za-z]{2,16}$/).optional(),
    map: z
      .object({
        center: coordSchema,
        zoom: z.number().int().min(1).max(20),
        minZoom: z.number().int().min(1).max(20),
        maxZoom: z.number().int().min(1).max(20),
        bbox: bboxSchema
      })
      .strict(),
    routeBbox: bboxSchema.optional(),
    search: z
      .object({
        biasRadiusM: z.number().int().min(1000).max(200_000),
        countrySet: z
          .string()
          .regex(/^[A-Z]{2}(,[A-Z]{2})*$/)
          .optional()
      })
      .strict(),
    incidents: z
      .object({
        language: z
          .string()
          .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
          .optional()
      })
      .strict()
      .optional(),
    landmarks: z.array(landmarkSchema).min(1).max(20),
    junctions: z.array(junctionSchema).min(1).max(200),
    policeStations: z.array(policeStationSchema).max(100),
    thresholds: thresholdsOverrideSchema.optional(),
    sources: z
      .object({
        junctions: z.string().trim().min(2).max(300),
        policeStations: z.string().trim().min(2).max(300),
        retrievedOn: z
          .string()
          .refine(isValidIsoDate, 'retrievedOn must be a valid YYYY-MM-DD date'),
        licence: z.string().trim().min(2).max(200),
        notes: z.string().trim().max(600).optional()
      })
      .strict()
  })
  .strict()
  .superRefine((city, ctx) => {
    const { minZoom, zoom, maxZoom, center, bbox } = city.map;
    if (minZoom > maxZoom) {
      ctx.addIssue({
        code: 'custom',
        path: ['map', 'minZoom'],
        message: 'minZoom must be <= maxZoom'
      });
    }
    if (zoom < minZoom || zoom > maxZoom) {
      ctx.addIssue({
        code: 'custom',
        path: ['map', 'zoom'],
        message: `zoom (${zoom}) must be within minZoom..maxZoom (${minZoom}..${maxZoom})`
      });
    }
    if (!isInsideBbox(center.lat, center.lng, bbox)) {
      ctx.addIssue({
        code: 'custom',
        path: ['map', 'center'],
        message: 'map.center must lie inside map.bbox'
      });
    }
    if (city.routeBbox && !bboxEncloses(city.routeBbox, bbox)) {
      ctx.addIssue({
        code: 'custom',
        path: ['routeBbox'],
        message: 'routeBbox must enclose map.bbox'
      });
    }

    const landmarkIds = new Set();
    city.landmarks.forEach((lm, idx) => {
      if (landmarkIds.has(lm.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['landmarks', idx, 'id'],
          message: `Duplicate landmark id "${lm.id}"`
        });
      }
      landmarkIds.add(lm.id);
      if (!isInsideBbox(lm.lat, lm.lng, bbox)) {
        ctx.addIssue({
          code: 'custom',
          path: ['landmarks', idx],
          message: `Landmark "${lm.id}" lies outside map.bbox`
        });
      }
    });

    const junctionIds = new Set();
    let keyCount = 0;
    city.junctions.forEach((j, idx) => {
      if (junctionIds.has(j.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['junctions', idx, 'id'],
          message: `Duplicate junction id "${j.id}"`
        });
      }
      junctionIds.add(j.id);
      if (!isInsideBbox(j.lat, j.lng, bbox)) {
        ctx.addIssue({
          code: 'custom',
          path: ['junctions', idx],
          message: `Junction "${j.id}" lies outside map.bbox`
        });
      }
      if (j.key === true) keyCount += 1;
    });

    if (keyCount < 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['junctions'],
        message: 'At least 1 junction must have key: true'
      });
    } else if (keyCount > 50) {
      ctx.addIssue({
        code: 'custom',
        path: ['junctions'],
        message: `At most 50 junctions may have key: true (found ${keyCount})`
      });
    }

    const stationIds = new Set();
    city.policeStations.forEach((s, idx) => {
      if (stationIds.has(s.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['policeStations', idx, 'id'],
          message: `Duplicate policeStation id "${s.id}"`
        });
      }
      stationIds.add(s.id);
      if (!isInsideBbox(s.lat, s.lng, bbox)) {
        ctx.addIssue({
          code: 'custom',
          path: ['policeStations', idx],
          message: `Police station "${s.id}" lies outside map.bbox`
        });
      }
    });

    const mergedThresholds = { ...DEFAULT_THRESHOLDS, ...(city.thresholds || {}) };
    if (mergedThresholds.moderateRainMmHr > mergedThresholds.heavyRainMmHr) {
      ctx.addIssue({
        code: 'custom',
        path: ['thresholds', 'moderateRainMmHr'],
        message: 'moderateRainMmHr must be <= heavyRainMmHr'
      });
    }
    if (mergedThresholds.monitorCongestionPct > mergedThresholds.officerCongestionPct) {
      ctx.addIssue({
        code: 'custom',
        path: ['thresholds', 'monitorCongestionPct'],
        message: 'monitorCongestionPct must be <= officerCongestionPct'
      });
    }
  });

/**
 * Validate and normalize a raw city JSON object.
 * @param {unknown} raw
 * @param {{ expectedId?: string }} [options]
 */
function validateCityConfig(raw, { expectedId } = {}) {
  const parsed = cityConfigSchema.safeParse(raw);
  /** @type {Array<{ path: string, message: string }>} */
  const issues = [];

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({
        path: issue.path.length > 0 ? issue.path.join('.') : '<root>',
        message: issue.message
      });
    }
  } else if (expectedId !== undefined && parsed.data.id !== expectedId) {
    issues.push({
      path: 'id',
      message: `id "${parsed.data.id}" must match filename "${expectedId}.json"`
    });
  }

  if (issues.length > 0 || !parsed.success) {
    return { ok: false, issues };
  }

  const data = parsed.data;
  /** @type {string[]} */
  const warnings = [];
  if (data.policeStations.length === 0) {
    warnings.push(
      'policeStations is empty; HIGH severity advisories will run without nearest-station info'
    );
  }

  const normalized = {
    schemaVersion: data.schemaVersion,
    id: data.id,
    name: data.name,
    country: data.country,
    timezone: data.timezone,
    locale: data.locale,
    status: data.status,
    tomtomView: data.tomtomView ?? deriveTomTomView(data.country),
    map: {
      center: { ...data.map.center },
      zoom: data.map.zoom,
      minZoom: data.map.minZoom,
      maxZoom: data.map.maxZoom,
      bbox: { ...data.map.bbox }
    },
    routeBbox: data.routeBbox ? { ...data.routeBbox } : { ...data.map.bbox },
    search: {
      biasRadiusM: data.search.biasRadiusM,
      countrySet: data.search.countrySet ?? data.country
    },
    incidents: {
      language: data.incidents?.language ?? 'en-GB'
    },
    landmarks: data.landmarks.map((lm) => ({
      ...lm,
      name: lm.name ?? lm.label
    })),
    junctions: data.junctions.map((j) => ({ ...j })),
    policeStations: data.policeStations.map((s) => ({ ...s })),
    thresholds: {
      ...DEFAULT_THRESHOLDS,
      ...(data.thresholds || {})
    },
    sources: { ...data.sources }
  };

  return { ok: true, data: normalized, warnings };
}

module.exports = {
  CITY_SCHEMA_VERSION,
  CITY_ID_REGEX,
  DEFAULT_THRESHOLDS,
  deriveTomTomView,
  isValidIanaTimezone,
  isValidIsoDate,
  isInsideBbox,
  bboxEncloses,
  bboxSchema,
  cityConfigSchema,
  validateCityConfig
};
