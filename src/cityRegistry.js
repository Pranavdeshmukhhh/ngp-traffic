'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validateCityConfig } = require('./citySchema');

const DEFAULT_CITY_ID = 'nagpur';
const DEFAULT_CITIES_DIR = path.join(__dirname, '..', 'config', 'cities');

/**
 * Recursively freeze objects and arrays to prevent accidental runtime mutation.
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
  } else {
    for (const prop of Object.values(value)) {
      deepFreeze(prop);
    }
  }
  return Object.freeze(value);
}

/**
 * Load, validate, and freeze all city JSON files from `citiesDir`.
 * Fails closed on missing directory, invalid JSON, schema errors, or invalid `CITY`.
 *
 * @param {{ citiesDir?: string, envCity?: string | undefined }} [options]
 */
function loadCityRegistry({ citiesDir = DEFAULT_CITIES_DIR, envCity = process.env.CITY } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(citiesDir, { withFileTypes: true });
  } catch (err) {
    throw new Error(
      `Fail-closed city registry error: cannot read "${citiesDir}": ${/** @type {Error} */ (err).message}`,
      { cause: err }
    );
  }

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('_'))
    .map((entry) => entry.name)
    .sort();

  if (files.length === 0) {
    throw new Error(`Fail-closed city registry error: no city config files found in "${citiesDir}"`);
  }

  /** @type {Map<string, ReturnType<typeof validateCityConfig>['data']>} */
  const citiesMap = new Map();
  /** @type {Array<{ file: string, id: string, warnings: string[] }>} */
  const warningsList = [];

  for (const file of files) {
    const expectedId = file.slice(0, -5);
    const fullPath = path.join(citiesDir, file);
    let rawJson;
    try {
      const text = fs.readFileSync(fullPath, 'utf8');
      rawJson = JSON.parse(text);
    } catch (err) {
      throw new Error(
        `Fail-closed city registry error in ${file}: invalid JSON (${/** @type {Error} */ (err).message})`,
        { cause: err }
      );
    }

    const result = validateCityConfig(rawJson, { expectedId });
    if (!result.ok || !result.data) {
      const details = (result.issues || [])
        .map((issue) => `${file} ${issue.path}: ${issue.message}`)
        .join('; ');
      throw new Error(`Fail-closed city registry validation error: ${details}`);
    }

    if (citiesMap.has(result.data.id)) {
      throw new Error(`Fail-closed city registry error: duplicate city id "${result.data.id}"`);
    }

    citiesMap.set(result.data.id, deepFreeze(result.data));
    if (result.warnings && result.warnings.length > 0) {
      warningsList.push({ file, id: result.data.id, warnings: [...result.warnings] });
    }
  }

  const availableIds = Array.from(citiesMap.keys()).join(', ');
  let defaultCityId;

  if (envCity === undefined || envCity === '') {
    if (!citiesMap.has(DEFAULT_CITY_ID)) {
      throw new Error(
        `Fail-closed city registry error: default city "${DEFAULT_CITY_ID}" was not found (available: ${availableIds})`
      );
    }
    defaultCityId = DEFAULT_CITY_ID;
  } else {
    if (typeof envCity !== 'string' || !citiesMap.has(envCity)) {
      const safeEcho = JSON.stringify(String(envCity).slice(0, 64));
      throw new Error(
        `Fail-closed config error: CITY=${safeEcho} does not match any registered city (available: ${availableIds})`
      );
    }
    defaultCityId = envCity;
  }

  const frozenList = Object.freeze(Array.from(citiesMap.values()));

  return Object.freeze({
    DEFAULT_CITY_ID,
    defaultCityId,
    /**
     * Allow-list lookup only; user input never reaches the filesystem.
     * @param {unknown} id
     */
    getCity(id) {
      if (typeof id !== 'string') return undefined;
      return citiesMap.get(id);
    },
    /**
     * @param {unknown} id
     * @returns {boolean}
     */
    hasCity(id) {
      return typeof id === 'string' && citiesMap.has(id);
    },
    listCities() {
      return frozenList;
    },
    getDefaultCityId() {
      return defaultCityId;
    },
    getWarnings() {
      return warningsList;
    }
  });
}

const defaultRegistry = loadCityRegistry();

module.exports = {
  DEFAULT_CITY_ID,
  DEFAULT_CITIES_DIR,
  deepFreeze,
  loadCityRegistry,
  getCity: defaultRegistry.getCity,
  hasCity: defaultRegistry.hasCity,
  listCities: defaultRegistry.listCities,
  getDefaultCityId: defaultRegistry.getDefaultCityId,
  getWarnings: defaultRegistry.getWarnings
};
