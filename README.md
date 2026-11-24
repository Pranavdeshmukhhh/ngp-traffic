# NGP Mobility (NGP-TRAFFIC)

Real-time Nagpur live traffic intelligence, dual-route planner, weather & road-risk advisories, and police deployment support for **Nagpur, India**.

Zero mock data, zero simulation loops, and zero frontend API key exposure.

## Data Sources & Quota Math

| Data Source | Provider & Licence | Poll Frequency / Cache TTL | Max Quota Cost / Day | Failure Behaviour |
| --- | --- | --- | --- | --- |
| **Traffic Flow Segments** | TomTom Flow Segment v4 (Freemium / Commercial key) | Every **4 min** for 16 key corridors only while `clients > 0`; paused when idle | `16 × 15/hr × 24h` = **5,760 max** (far lower with active-user gating; guarded by `DAILY_TOMTOM_NON_TILE_BUDGET=2000`) | Preserves last good `lastSuccessAt.flow`, marks `flow` stale, shows `Stale` pill |
| **Traffic Incidents** | TomTom Incident Details v5 (`78.95,21.05,79.20,21.25`) | Every **12 min** while `clients > 0` | `5/hr × 24h` = **<= 120 calls/day** | Preserves last good `lastSuccessAt.incidents`, marks `incidents` stale |
| **Traffic & Basemap Tiles** | TomTom Flow Raster (`relative0`/`relative0-dark`) & Map Display (`main`/`night`) | Traffic **120s** LRU (`500` tiles); Basemap **10m** LRU (`800` tiles) + in-flight dedupe | Guarded by `DAILY_TOMTOM_TILE_BUDGET=45000` (50,000/day TomTom free tier); OSM fallback if keyless | `502`/`204` handled cleanly; basemap auto-falls back to OpenStreetMap |
| **Place Search & Routing** | TomTom Search v2 & Routing v1 (`fastest` + `shortest`) | On-demand (rate-limited `40/min` search, `20/min` route per IP) | Shares `DAILY_TOMTOM_NON_TILE_BUDGET` | Returns `502` or `503` quota guard without leaking secrets |
| **Weather Forecast (Current, 6h, 7d)** | [Open-Meteo](https://open-meteo.com/) Forecast API (**CC BY 4.0**, non-commercial, keyless) | Every **15 min** while `clients > 0`; TTL **15 min** | **<= 96 calls/day** (10,000/day Open-Meteo free limit) | Preserves last snapshot, marks `weather` stale in UI |
| **Air Quality (PM2.5, US AQI)** | Open-Meteo / Copernicus CAMS (**CC BY 4.0**, ~45 km model estimate) | Every **30 min** while `clients > 0`; TTL **30 min** | **<= 48 calls/day** (10,000/day free limit) | Marks `airQuality` stale; explicitly labelled as a **CAMS model estimate** |
| **Observed Waterlogging Hotspots** | Derived internally from stored dry vs. `>= 5 mm/hr` rain junction speed snapshots | Recomputed on flow polls (`data/runtime/rain-observations.json`) | **0 external calls** | Cold start / `< 3` rainy polls honestly returns `[]` with empty-state notice |

## Architecture & Feature Flags

- **Deployment Advisory Engine (`predictDeployments` — Heuristic Model Estimates):**
  - Free-flow guard skips junctions with `congestionPct < 15%` unless `roadClosure === true` or a verified accident (`iconCategory === 1`) is within `100 m`.
  - Flags `Road Clearing Needed (HIGH)` on `roadClosure === true`, roadworks/closure within `150 m` with `>= 25%` congestion, or rainfall `>= 5 mm/hr` with `>= 50%` congestion.
  - Flags `Traffic Officer Needed (HIGH)` on accident/breakdown within `150 m` (`100 m` if free-flowing) or `>= 60%` congestion; `Standby / Monitor (MEDIUM)` for `>= 40%` congestion.
  - Ranks alerts by composite `severityScore` (`0–100`) and 3-snapshot `trend`, attaching the nearest station from `data/police-stations.json`.
- **Module 1 (`FEATURE_WEATHER_RISK=true`):** Current/6h/7d weather, CAMS PM2.5 + US AQI estimate, road-risk advisories (heavy rain + congestion, low visibility fog, heat index, AQI), empirical `Observed` waterlogging hotspots, rain-aware route warnings, and English/Hindi/Marathi (`en`/`hi`/`mr`) localization.

## Setup & Environment Variables

```bash
npm install
cp .env.example .env
# Set TOMTOM_API_KEY in .env
npm start
```

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `TOMTOM_API_KEY` | Recommended | `""` | Server-only TomTom API key |
| `PORT` | No | `3000` | HTTP server port |
| `ALLOWED_ORIGIN` | Yes in `production` | `*` | Comma-separated CORS origin allow-list (fails closed if `*` in production) |
| `FEATURE_WEATHER_RISK` | No | `true` | Enables/disables Module 1 weather, AQI & hotspot layer |
| `DAILY_TOMTOM_NON_TILE_BUDGET` | No | `2000` | Daily server circuit-breaker for non-tile TomTom calls |
| `DAILY_TOMTOM_TILE_BUDGET` | No | `45000` | Daily server circuit-breaker for TomTom tile calls |

## API Endpoints

- `GET /api/health` — Server status, feature flags, `lastSuccessAt`, `stale`, `staleSources`, `p95LatencyMs`, cache hit rates, and daily upstream counters
- `GET /api/weather` — Current, 6h & 7d forecast, CAMS air quality estimate, road-risk advisories, and observed waterlogging hotspots
- `GET /tiles/basemap/:z/:x/:y.png` — LRU-cached TomTom light/dark basemap tile proxy (`z <= 19`, `[0, 2^z)`)
- `GET /tiles/traffic/:z/:x/:y.png` — LRU-cached TomTom live traffic flow tile proxy
- `GET /api/search?q=...` — Nagpur-biased place autocomplete (rate-limited `40/min/IP`)
- `GET /api/route?fromLat=&fromLng=&toLat=&toLng=` — Parallel fastest & shortest Nagpur-bounded routes + rain hotspot warnings (`20/min/IP`)

## Quality Gates

```bash
npm run lint
npm run typecheck
npm run test:coverage
npm audit --audit-level=moderate
```
