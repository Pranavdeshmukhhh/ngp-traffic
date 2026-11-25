'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validateCityConfig } = require('../src/citySchema');

const CITIES_DIR = path.join(__dirname, '..', 'config', 'cities');

/**
 * Validate every `config/cities/*.json` file (ignoring `_`-prefixed templates).
 * @param {string} [citiesDir]
 */
function runValidation(citiesDir = CITIES_DIR) {
  if (!fs.existsSync(citiesDir)) {
    console.error(`ERROR: Cities directory not found: ${citiesDir}`);
    return 1;
  }

  const files = fs
    .readdirSync(citiesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('_'))
    .map((entry) => entry.name)
    .sort();

  if (files.length === 0) {
    console.error(`ERROR: No city configuration JSON files found in ${citiesDir}`);
    return 1;
  }

  /** @type {Array<{ file: string, path: string, message: string }>} */
  const allErrors = [];
  /** @type {Array<{ file: string, id: string, name: string, status: string, junctions: number, keyJunctions: number, stations: number, landmarks: number, warnings: string[] }>} */
  const summary = [];

  for (const file of files) {
    const expectedId = file.slice(0, -5);
    const fullPath = path.join(citiesDir, file);
    let parsedJson;

    try {
      parsedJson = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    } catch (err) {
      allErrors.push({
        file,
        path: '<json>',
        message: /** @type {Error} */ (err).message
      });
      continue;
    }

    const result = validateCityConfig(parsedJson, { expectedId });
    if (!result.ok || !result.data) {
      for (const issue of result.issues || []) {
        allErrors.push({ file, path: issue.path, message: issue.message });
      }
      continue;
    }

    const city = result.data;
    const keyJunctions = city.junctions.filter((j) => j.key === true).length;
    summary.push({
      file,
      id: city.id,
      name: city.name,
      status: city.status,
      junctions: city.junctions.length,
      keyJunctions,
      stations: city.policeStations.length,
      landmarks: city.landmarks.length,
      warnings: result.warnings || []
    });
  }

  if (allErrors.length > 0) {
    for (const err of allErrors) {
      console.error(`ERROR ${err.file} ${err.path}: ${err.message}`);
    }
    console.error(`\nValidation failed: ${allErrors.length} error(s) found.`);
    return 1;
  }

  console.log('City configuration validation summary:');
  console.log('id           | name       | status      | junctions (key) | stations | landmarks | warnings');
  console.log('-------------|------------|-------------|-----------------|----------|-----------|---------');
  for (const row of summary) {
    const warnCount = row.warnings.length;
    console.log(
      `${row.id.padEnd(12)} | ${row.name.padEnd(10)} | ${row.status.padEnd(11)} | ` +
        `${`${row.junctions} (${row.keyJunctions} key)`.padEnd(15)} | ` +
        `${String(row.stations).padEnd(8)} | ${String(row.landmarks).padEnd(9)} | ${warnCount}`
    );
    for (const warning of row.warnings) {
      console.warn(`WARN ${row.file}: ${warning}`);
    }
  }
  console.log(`\nValidated ${summary.length} city config(s) successfully.`);
  return 0;
}

if (require.main === module) {
  process.exitCode = runValidation();
}

module.exports = { runValidation };
