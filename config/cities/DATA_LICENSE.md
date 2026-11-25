# City Configuration Data Licences

The **source code** of this repository (`server.js`, `src/`, `public/`, `scripts/`, `test/`) is licensed under the **MIT License** (see [`LICENSE`](../../LICENSE)).

The **city data files** under `config/cities/*.json` are **NOT covered by the MIT License**. Each city dataset retains the licence of its original upstream source(s), and attribution requirements follow the upstream source terms:

| City Config | Content | Upstream Source & Attribution | Licence | Status |
|---|---|---|---|---|
| `nagpur.json` | 50 junctions, 10 police stations, 5 landmarks, centre/bboxes | Migrated from legacy `data/` repository files | `UNVERIFIED` (legacy files had no recorded source or licence) | Original source and licence not recorded |
| `pune.json` | 10 at-grade road-intersection nodes (`junctions`) | [OpenStreetMap](https://www.openstreetmap.org/) (`api.openstreetmap.org/0.6`), `retrievedOn: 2026-11-25` | © OpenStreetMap contributors, **ODbL 1.0** | Experimental (not snapped to TomTom `flowSegmentData`) |
| `pune.json` | City centre & 5 landmark coordinates (`landmarks`) | [English Wikipedia](https://en.wikipedia.org/) articles linked in `sourceUrl`, `retrievedOn: 2026-11-25` | Wikipedia contributors, **CC BY-SA 4.0** | Experimental |
| `bengaluru.json` | City centre (`relation/7902476`) & 10 at-grade road-intersection nodes (`junctions`) | [OpenStreetMap](https://www.openstreetmap.org/) (`api.openstreetmap.org/0.6`), `retrievedOn: 2026-11-25` | © OpenStreetMap contributors, **ODbL 1.0** | Experimental (not snapped to TomTom `flowSegmentData`) |
| `bengaluru.json` | 5 landmark coordinates (`landmarks`) | [English Wikipedia](https://en.wikipedia.org/) articles linked in `sourceUrl`, `retrievedOn: 2026-11-25` | Wikipedia contributors, **CC BY-SA 4.0** | Experimental (`Whitefield` and `Electronic City` are rounded area centres) |

## Attribution & Licence Links

- **OpenStreetMap:** © OpenStreetMap contributors — Open Database License (ODbL 1.0): https://opendatacommons.org/licenses/odbl/
- **Wikipedia:** Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0): https://creativecommons.org/licenses/by-sa/4.0/

## Share-Alike Notice (`UNVERIFIED`)

Both ODbL 1.0 and CC BY-SA 4.0 include share-alike provisions. How those share-alike obligations apply to bundled configuration files, mixed-source JSON files, or future persisted/redistributed datasets in this project is **UNVERIFIED and requires legal review**. Do not assume MIT terms cover `config/cities/*.json` or persist/redistribute derived datasets until maintainers complete a licensing review.
