'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { z } = require('zod');

const rootDir = path.join(__dirname, '..');

const junctionSchema = z
  .object({
    id: z.string().regex(/^J\d{3}$/),
    name: z.string().min(2).max(80),
    lat: z.number().min(20.8).max(21.4),
    lng: z.number().min(78.8).max(79.4),
    roadType: z.enum([
      'major_intersection',
      'highway_entry',
      'school_zone',
      'commercial',
      'landmark_junction'
    ]),
    key: z.literal(true).optional()
  })
  .strict();

const policeStationSchema = z
  .object({
    id: z.string().regex(/^PS\d{2}$/),
    name: z.string().min(4).max(80),
    lat: z.number().min(20.8).max(21.4),
    lng: z.number().min(78.8).max(79.4),
    zone: z.string().min(2).max(40)
  })
  .strict();

test('nagpur-junctions.json passes strict Zod schema with 50 unique junctions and 16 key corridors', () => {
  const raw = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'data', 'nagpur-junctions.json'), 'utf8')
  );
  const parsed = z.array(junctionSchema).length(50).parse(raw);

  const ids = new Set(parsed.map((j) => j.id));
  assert.equal(ids.size, 50);

  const keyCount = parsed.filter((j) => j.key === true).length;
  assert.equal(keyCount, 16);
});

test('police-stations.json passes strict Zod schema with 10 unique stations', () => {
  const raw = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'data', 'police-stations.json'), 'utf8')
  );
  const parsed = z.array(policeStationSchema).length(10).parse(raw);

  const ids = new Set(parsed.map((s) => s.id));
  assert.equal(ids.size, 10);
});

test('removed mock files remain absent and README/app.js stay aligned', () => {
  const removedFiles = [
    'public/simulation.html',
    'public/js/simulation.js',
    'public/officer.html',
    'public/citizen.html',
    'data/officer-credentials.json',
    'data/officers.json',
    'data/preset-incidents.json',
    'data/road-segments.json',
    'ml-engine.js',
    'training_data.csv',
    'routing-engine.js'
  ];
  for (const rel of removedFiles) {
    assert.equal(fs.existsSync(path.join(rootDir, rel)), false, `${rel} should not exist`);
  }

  const readme = fs.readFileSync(path.join(rootDir, 'README.md'), 'utf8');
  assert.equal(readme.includes('150 m'), true);
  assert.equal(readme.includes('within 500 m'), false);

  const appJs = fs.readFileSync(path.join(rootDir, 'public', 'js', 'app.js'), 'utf8');
  const lightMatch = appJs.match(/light:\s*'([^']+)'/);
  const darkMatch = appJs.match(/dark:\s*'([^']+)'/);
  assert.ok(lightMatch && darkMatch);
  assert.notEqual(lightMatch[1], darkMatch[1]);
});
