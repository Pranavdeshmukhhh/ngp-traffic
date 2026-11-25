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

---

## Candidates Dropped

The following starter candidates were omitted from `pune.json` and `bengaluru.json` because the OpenStreetMap intersection audit flagged `*_link` ramps, elevated flyover ways (`bridge=yes` / `layer > 0`), unnamed streets, or missing arterial intersections nearby. Re-test them once a live `TOMTOM_API_KEY` is available before adding them back:

| City | Candidate | Reason Dropped (OSM Audit) | What to Re-Test with a Live TomTom Key |
|---|---|---|---|
| Bengaluru | Central Silk Board | Multi-level interchange with unnamed `trunk_link` ramps and under-construction flyover deck; nearest clean node (`164.0 m`) was a minor 4th Cross residential T-junction on Outer Ring Road. | Test an at-grade Outer Ring Road or Hosur Road approach ~150 m upstream of the flyover split and verify `flowSegmentData` snaps to the main carriageway rather than a ramp. |
| Bengaluru | Dairy Circle | Every roundabout node carried `primary_link` approaches (3 unnamed), with 0 clean at-grade intersections inside the 280 m search box. | Test an at-grade Bannerghatta Road or Hosur Road coordinate 100–200 m outside the link ring and inspect the returned `flowSegmentData` polyline. |
| Bengaluru | Mekhri Circle | Nominatim resolved to a bus stop; nearest node crossed an unnamed residential lane, with `294.6 m` to the nearest clean crossing. | Test an at-grade Bellary Road (NH44) or Jayamahal Road coordinate clear of the underpass and verify segment snapping. |
| Bengaluru | Iblur Junction | Arterial node touched two unnamed tertiary ways (`181.5 m` to only a residential T-junction on Outer Ring Road). | Test an Outer Ring Road or Sarjapura Road carriageway coordinate away from slip lanes and confirm `flowSegmentData` matches the intended corridor. |
| Bengaluru | Nayandahalli | Nominatim resolved to the railway station node with 0 arterial intersections within 330 m. | Locate the Mysore Road × Outer Ring Road at-grade crossing directly on imagery/OSM and verify `flowSegmentData` response and `freeFlowSpeed`. |
| Pune | Bhumkar Chowk | Core node sits on the elevated Katraj–Dehu Road Bypass (`bridge=yes, layer=1`; `234.9 m` to next clean crossing). | Test separate at-grade Hinjawadi–Wakad Road vs NH48 bypass points and confirm each snaps to its intended road level. |
| Pune | Dange Chowk | Roundabout nodes carried unnamed `primary_link` approaches (`256.7 m` to next clean node). | Test an approach coordinate on Ravet–Aundh BRTS Road or Hinjawadi–Chinchwad Road just outside the link ring. |
| Pune | Nashik Phata | Multi-tier flyover ramp intersection (`primary_link`) with unnamed primary approaches (`356.8 m` to next clean node). | Test an at-grade Old Pune–Mumbai Highway or Pune–Nashik Highway coordinate clear of the flyover ramps. |
| Pune | Yerwada (Nagar Road) | Nominatim resolved to a station node and the closest road crossing (`19.9 m`) met an unnamed residential street (`244.0 m` to `National Games Marg × Nagar Road`). | Test OSM `node/1416042243` (*Nagar Road × National Games Marg*) or Golf Course Chowk against `flowSegmentData` and inspect the snapped polyline. |
