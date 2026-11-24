# NGP-TRAFFIC — Nagpur Live Traffic Intelligence

A fast, minimal, 100% real-data live traffic map, dual-route planner, and police deployment advisory dashboard for **Nagpur, India**.

Powered by **TomTom Traffic & Routing APIs** and **Open-Meteo** weather telemetry — zero mock data, zero simulation loops, and zero frontend API key exposure.

## Screenshots

> _Placeholder: Add light/dark desktop and mobile map screenshots or a short walkthrough GIF here._

## Live Architecture

1. **Tile Proxy (`/tiles/traffic/:z/:x/:y.png`)**
   - Proxies TomTom Traffic Flow Raster Tiles (`relative0`) on the backend so `TOMTOM_API_KEY` never reaches the browser.
   - Uses an in-memory 120s TTL cache (bounded at 500 tiles) with `Cache-Control: public, max-age=120`.
2. **Quota-Safe Real-Time Polling + Instant First Load**
   - **Flow Segment Data**: Polls 16 key Nagpur corridors from `data/nagpur-junctions.json` every 4 minutes **only while active Socket.IO clients are connected**.
   - **Traffic Incidents v5**: Polls Nagpur bounding box (`78.95,21.05,79.20,21.25`) every 12 minutes while clients are online.
   - **Open-Meteo Weather**: Polls Nagpur weather (`21.1458, 79.0882`) every 15 minutes (free, no API key required).
   - **Socket.IO Push (`traffic:state`)**: Sends cached state immediately on connection and triggers an instant refresh if stale (> 4 minutes), eliminating redundant client-side polling.
3. **Deployment Advisory Engine (`predictDeployments`)**
   - **Road Clearing Needed (`HIGH`)**: Active `roadClosure`, roadworks/closure incident within 500 m, or Nagpur rainfall `>= 5 mm/hr` with `>= 50%` congestion.
   - **Traffic Officer Needed (`HIGH`)**: Accident/breakdown within 500 m or `>= 60%` congestion.
   - **Standby / Monitor (`MEDIUM`)**: `>= 40%` congestion.
   - Attaches the nearest Nagpur police station (`data/police-stations.json`) via Haversine distance to every `HIGH` alert.
4. **Shortest vs. Fastest Live Routing (`/api/search`, `/api/route`)**
   - Autocomplete search biased to Nagpur (`radius=25000`, `countrySet=IN`).
   - Parallel TomTom Routing requests comparing **Fastest (Live)** vs. **Shortest** distance routes with live traffic delay.

## Setup

### Prerequisites
- Node.js `>= 20.12.0`
- A free [TomTom Developer](https://developer.tomtom.com/) API key (Traffic, Search, and Routing products enabled)

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

> If `TOMTOM_API_KEY` is omitted, the server still boots cleanly with Open-Meteo weather and displays a subtle setup banner in the UI.

### Environment Variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `TOMTOM_API_KEY` | Yes (for live traffic/search/routing) | `""` | Server-only TomTom API key |
| `PORT` | No | `3000` | HTTP server port |
| `ALLOWED_ORIGIN` | No | `*` | Allowed CORS origin(s), comma-separated |

## API Endpoints

- `GET /api/health` — Server status, `tomtomConfigured` flag, active Socket.IO clients, alert count
- `GET /tiles/traffic/:z/:x/:y.png` — Cached TomTom live traffic flow tile proxy
- `GET /api/search?q=...` — Nagpur-biased place autocomplete
- `GET /api/route?fromLat=&fromLng=&toLat=&toLng=` — Parallel fastest & shortest live routes

## Testing

```bash
npm test
```
