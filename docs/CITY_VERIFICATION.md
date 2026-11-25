# City Configuration Verification Checklist

All newly added starter cities begin with `"status": "experimental"` in `config/cities/<city>.json`. A maintainer must complete and record all checks below before promoting a city's status to `"community"` or `"verified"`.

> **Prerequisite:** You need a valid server-side `TOMTOM_API_KEY` with **Traffic**, **Map Display**, **Search**, and **Routing** products enabled to run live upstream checks.

---

## 1. Junction Snapping Against TomTom `flowSegmentData`

OpenStreetMap node coordinates may still snap onto an unintended parallel lane, flyover ramp, or opposite carriageway in TomTom's map matching. Check every junction with `"key": true`:

1. Call the TomTom Flow Segment Data API (same endpoint pattern used by `fetchJunctionFlow` in `server.js`):
   ```text
   GET https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json?point=<lat>,<lng>&unit=KMPH&key=<TOMTOM_API_KEY>
   ```
2. Verify all of the following for **each** `key: true` junction:
   - Response returns HTTP `200` with a non-empty `flowSegmentData` object.
   - `freeFlowSpeed` is positive and plausible for the class of road (e.g., not `10 km/h` from snapping onto a parking lot or side alley).
   - **Suggested heuristic check (`confidence > 0.5`):** Confirm `flowSegmentData.confidence` is generally above `0.5` during normal daytime traffic. *Note: `confidence > 0.5` is a suggested maintainer heuristic only, not an official TomTom threshold rule.*
   - Inspect `flowSegmentData.coordinates.coordinate` on a map to verify the snapped road segment lies on the **intended at-grade arterial** rather than a parallel service road, flyover deck, or slip ramp.
   - Record any coordinate adjustments back to the exact verified point (and update `sourceUrl` / `sources` if needed).

## 2. Bounding Boxes, Incidents & Search Verification

1. **Incidents bbox (`map.bbox`):** Call `/traffic/services/5/incidentDetails` with `bbox=<west>,<south>,<east>,<north>` and confirm real corridor incidents appear inside the city bounds without overflowing into neighbouring cities.
2. **Routing bbox (`routeBbox`):** Confirm `routeBbox` encloses `map.bbox` and key outer hubs (e.g., airport, ring-road interchanges) while still bounding TomTom Routing abuse.
3. **Place search (`search.biasRadiusM`, `search.countrySet`):** Query `/api/search?q=<landmark>` and verify top autocomplete hits stay relevant to the city.
4. **Basemap view (`tomtomView`):** Confirm `/tiles/basemap/12/<x>/<y>.png` returns valid map tiles (for `IN` cities `tomtomView` should be `"IN"`; for non-`IN` cities omit `tomtomView` unless verified against TomTom docs/API).

## 3. Police Stations & Landmarks Verification

- **Police stations (`policeStations`):** Keep `[]` unless an authoritative, openly licensed municipal or government dataset is verified. Do **not** scrape closed directories or invent coordinates. When populated, record exact dataset URL, retrieval date, and licence in `sources.policeStations`.
- **Landmarks (`landmarks`):** Verify every landmark displays well as a quick-pick chip, lies inside `map.bbox`, and carries an accurate `https://` `sourceUrl`.

## 4. Schema, Tests & Licensing Gates

1. Ensure every coordinate and dataset attribution complies with [`config/cities/DATA_LICENSE.md`](../config/cities/DATA_LICENSE.md) (city data keeps its upstream source licence; MIT covers code only).
2. Run all repository verification commands and confirm 0 errors:
   ```bash
   npm run validate:cities
   npm run lint
   npm run typecheck
   npm test
   ```
3. Only after live verification and review may `status` be raised from `"experimental"` to `"community"` (community-verified points) or `"verified"` (all junctions snapped & checked against live TomTom `flowSegmentData`, provenance & licence confirmed).
