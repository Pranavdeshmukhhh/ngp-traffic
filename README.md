# NGP-TRAFFIC

## AI-Based Traffic Risk Heatmap & Police Deployment Decision Support for Nagpur City

> Built for Manthan4Yuva Hackathon | Problem Statement B: Intelligent Traffic Management System

---

## Problem

Nagpur city has limited police personnel to manage traffic across 50+ major junctions. Current deployment is based on intuition rather than data, leading to:
- High-risk junctions left unmanned during peak hours
- Officers deployed at low-risk locations unnecessarily
- No dynamic response mechanism for incidents

## Solution

**NGP-TRAFFIC** is an AI-powered control room dashboard that:

1. **Scores traffic risk** at every junction using a weighted 7-factor model (accident history, traffic volume, road type, time-of-day, pedestrian density, proximity to sensitive zones, active incidents)
2. **Visualizes risk as an interactive heatmap** with color-coded markers on a real Nagpur map
3. **Ranks all locations** in a sortable table showing which junctions need police attention most
4. **Auto-allocates officers** using a greedy optimization algorithm that assigns limited personnel to highest-risk junctions first
5. **Simulates incidents** and dynamically redeploys officers in real-time
6. **Identifies gaps** — flags high-risk junctions that are currently unmanned
7. **Explains every recommendation** — click any junction to see exactly WHY it scored high
8. **Compares deployments** — baseline (current) vs optimized (AI-recommended) with coverage metrics
9. **Supports manual overrides** — control room operators can reassign officers manually

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla HTML/CSS/JS |
| Map | Leaflet.js + OpenStreetMap |
| Heatmap | leaflet.heat plugin |
| Charts | Chart.js |
| Backend | Node.js + Express |
| Data | JSON (50 real Nagpur junctions + synthetic overlay) |

## Architecture

```
ngp-traffic/
+-- server.js               # Express server + Risk Engine + Allocation Algorithm
+-- data/
|   +-- nagpur-junctions.json   # 50 real Nagpur junctions with coordinates
|   +-- officers.json           # 25 police officers across 10 stations
|   +-- police-stations.json    # 10 Nagpur police stations
|   +-- preset-incidents.json   # 4 demo incident scenarios
+-- public/
    +-- index.html              # Dashboard (single page)
    +-- css/styles.css          # Dark command-center theme
    +-- js/app.js               # Map, table, controls, simulation logic
```

## Risk Scoring Model

Each junction receives a **Risk Score (0-100)** using:

```
RiskScore = 0.30 x AccidentHistory
          + 0.25 x TrafficVolume (time-aware)
          + 0.15 x RoadTypeFactor
          + 0.10 x TimeOfDayFactor
          + 0.10 x PedestrianDensity
          + 0.05 x ProximityBonus (school/hospital)
          + 0.05 x ActiveIncidentBoost
```

- **High Risk**: Score >= 70 (Red)
- **Medium Risk**: Score 40-69 (Yellow)
- **Low Risk**: Score < 40 (Green)

## Allocation Algorithm

**Greedy Priority Allocation:**
1. Sort junctions by risk score (descending)
2. Assign officers to highest-risk junctions first
3. Flag unmanned high-risk junctions as alerts

**Dynamic Redeployment (on incident):**
1. Boost risk scores of nearby junctions
2. Re-run allocation with updated scores
3. Reassign officers from lower-risk posts to incident zone

## Quick Start

```bash
# Install dependencies
npm install

# Start the server
node server.js

# Open in browser
# http://localhost:3000
```

## Demo Scenarios

1. **Evening Rush (Default)**: See how 18 junctions become high-risk during peak hours
2. **Simulate Accident**: Click "Simulate Incident" and click on the map to trigger dynamic redeployment
3. **Preset Scenarios**: Use dropdown to trigger "Major Accident at Variety Square" or "VIP Movement on Airport Road"
4. **Reduce Officers**: Lower officer count to 15 and see which high-risk junctions go unmanned
5. **Compare Deployments**: Toggle between Baseline and Optimized to see the coverage improvement

## Key Features

- Interactive heatmap with Nagpur-specific data
- Real-time risk scoring with explainable breakdowns
- Greedy police allocation with dynamic redeployment
- Incident simulation with animated response
- Baseline vs Optimized deployment comparison
- Manual override controls for operators
- Dark command-center aesthetic

## Team

Built for Manthan4Yuva Hackathon 2026

## License

MIT