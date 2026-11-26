# NGP-TRAFFIC — Nagpur Live Traffic Intelligence

A fast, minimal, real-data live traffic map, dual-route planner, and police deployment advisory dashboard for **Nagpur, India**.

Powered by **TomTom Traffic, Map Display & Routing APIs** and **Open-Meteo** weather telemetry ([CC BY 4.0](https://open-meteo.com/)) — zero mock data, zero simulation loops, and zero frontend API key exposure.

## Screenshots

> _Placeholder: Add light/dark desktop and mobile map screenshots or a short walkthrough GIF here._

## Live Architecture

1. **Basemap & Traffic Tile Proxies (`/tiles/basemap/:z/:x/:y.png`, `/tiles/traffic/:z/:x/:y.png`)**
   - Proxies TomTom Map Display raster basemaps (`main` for light mode, `night` for dark mode, `tileSize=512`, `view=IN`) with a 10-minute bounded in-memory cache (`800` tiles max), falling back cleanly to OpenStreetMap if keyless.
   - Proxies TomTom Traffic Flow Raster Tiles (`relative0` / `relative0-dark`, `tileSize=512`) on the backend so `TOMTOM_API_KEY` never reaches the browser, with a 120s bounded cache (`500` tiles max) and `Cache-Control: public, max-age=120`.
2. **Quota-Safe Real-Time Polling + Per-Source Freshness**
   - **Flow Segment Data**: Polls 16 key Nagpur corridors from `config/cities/nagpur.json` using a budget-aware interval **only while active Socket.IO clients are connected**. With the default budget the server refreshes flow about every 15 min; raise `DAILY_TOMTOM_NON_TILE_BUDGET` to match your real plan for faster updates. The default `2000` is a conservative safety net, not a verified TomTom plan limit.
   - **Traffic Incidents v5**: Polls Nagpur bounding box (`78.95,21.05,79.20,21.25`) using a budget-aware cadence while clients are online.
   - **Open-Meteo Weather**: Polls Nagpur weather (`21.1458, 79.0882`) every 15 minutes (free non-commercial tier, CC BY 4.0, no API key required).
   - **Freshness Telemetry**: Tracks per-source `lastSuccessAt` (`flow`, `incidents`, `weather`) and computes `stale` + `staleSources` over Socket.IO (`traffic:state`) and `/api/health` (`2 * intervalMs + 60s grace`). Inactive cities report `polled: false, stale: true` without making upstream calls. Failed polls never advance `updatedAt`.
3. **Deployment Advisory Engine (`predictDeployments` — Heuristic Model Estimates)**
   - **Free-Flow Guard**: Never flags free-flowing junctions (`congestionPct < 15%`) unless `roadClosure === true` or a verified accident (`iconCategory === 1`) is within `100 m`.
   - **Road Clearing Needed (`HIGH`)**: Active `roadClosure`, roadworks/closure incident within `150 m` with `>= 25%` congestion, or Nagpur rainfall `>= 5 mm/hr` with `>= 50%` congestion.
   - **Traffic Officer Needed (`HIGH`)**: Accident/breakdown within `150 m` (`100 m` if free-flowing) or `>= 60%` congestion.
   - **Standby / Monitor (`MEDIUM`)**: `>= 40%` congestion.
   - Computes a composite `severityScore` (`0–100`) and 3-snapshot `trend` (`worsening`, `improving`, `stable`), and attaches the nearest Nagpur police station (`config/cities/nagpur.json`) via Haversine distance to every `HIGH` alert. Advisories are heuristic estimates for operator assistance.
4. **Shortest vs. Fastest Live Routing (`/api/search`, `/api/route`)**
   - Autocomplete search biased to Nagpur (`radius=25000`, `countrySet=IN`).
   - Parallel TomTom Routing requests comparing **Fastest (Live)** vs. **Shortest** distance routes with live traffic delay.

## Setup

### Prerequisites
- Node.js `>= 20.12.0`
- A free [TomTom Developer](https://developer.tomtom.com/) API key (Traffic, Map Display, Search, and Routing products enabled)

### Local Run

```bash
npm install
```

Set `TOMTOM_API_KEY` in your environment (or a local `.env` file, which is gitignored):

```bash
# PowerShell
$env:TOMTOM_API_KEY="your_tomtom_api_key"
npm start
```

Open `http://localhost:3000`.

> If `TOMTOM_API_KEY` is omitted, the server still boots cleanly with Open-Meteo weather + OpenStreetMap fallback tiles and displays a setup banner in the UI.

### Environment Variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `TOMTOM_API_KEY` | Yes (for live traffic/search/routing/TomTom basemaps) | `""` | Server-only TomTom API key |
| `PORT` | No | `3000` | HTTP server port |
| `TRUST_PROXY` | No | `0` | Trusted reverse-proxy hop count (`0–5`; set `1` behind Render/Nginx — verify hop count for your host) |
| `ALLOWED_ORIGIN` | No | `*` | Allowed CORS origin(s), comma-separated |
| `CITY` | No | `nagpur` | Default city ID loaded from `config/cities/<id>.json` |
| `MAX_ACTIVE_CITIES` | No | `1` | Maximum concurrent active cities for background polling (`1–10`) |
| `DAILY_TOMTOM_NON_TILE_BUDGET` | No | `2000` | Daily cap for non-tile TomTom calls (`10–100000`; default is a conservative safety net, not a verified plan limit — raise to match your plan) |
| `METRICS_TOKEN` | No | `""` | Bearer token protecting `GET /api/metrics` (endpoint returns `404` when unset) |

## API Endpoints

- `GET /api/cities` — `{ defaultCityId, ids, cities }` catalog of registered cities
- `GET /api/cities/:id` — Full public metadata, landmarks, junctions, and thresholds for a registered city
- `GET /api/state?city=<id>` — Live traffic, incidents, weather, and advisory snapshot for an actively polled city; returns `{ polled: false, stale: true, lastSuccessAt: null, ... }` for unpolled cities with zero upstream calls
- `GET /api/health?city=<id>` — Minimal public health status (`status`, `city`, `defaultCityId`, `tomtomConfigured`, `monitoredJunctions`, `polled`, `stale`, `lastSuccessAt`, `flowIntervalMs`)
- `GET /api/metrics?city=<id>` — Bearer-protected (`METRICS_TOKEN`) operational diagnostics, cache stats, budget snapshot, and `pollSchedule` (`404` when token unset, `401` on invalid bearer)
- `GET /tiles/basemap/:z/:x/:y.png?theme=light|dark&city=<id>` — Cached TomTom light/dark basemap tile proxy (view-isolated per city)
- `GET /tiles/traffic/:z/:x/:y.png?theme=light|dark&city=<id>` — Cached TomTom live traffic flow tile proxy (view-isolated per city)
- `GET /api/search?q=...&city=<id>` — City-biased place autocomplete (defaults to `CITY`)
- `GET /api/route?fromLat=&fromLng=&toLat=&toLng=&city=<id>` — Parallel fastest & shortest live routes validated against the city's `routeBbox`

## Testing

```bash
npm test
npm run validate:cities
```

## Licensing & City Data

- **Code:** Software source code is licensed under the **MIT License** ([`LICENSE`](LICENSE)).
- **City Data (`config/cities/`):** City data files are **not** covered by the MIT License:
  - **Nagpur (`nagpur.json`):** Origin not recorded; maintainer to document.
  - **Pune & Bengaluru (`pune.json`, `bengaluru.json`):** OpenStreetMap (**ODbL 1.0**, © OpenStreetMap contributors attribution) and Wikipedia (**CC BY-SA 4.0**).
  - **Share-alike:** Implications for bundled/derived datasets are **UNVERIFIED** (needs legal review). See [`config/cities/DATA_LICENSE.md`](config/cities/DATA_LICENSE.md).
