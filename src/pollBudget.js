'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BASE_FLOW_INTERVAL_MS = 4 * 60 * 1000;
const DEFAULT_BASE_INCIDENTS_INTERVAL_MS = 12 * 60 * 1000;
const DEFAULT_POLL_BUDGET_RATIO = 0.80;

/**
 * Project daily TomTom non-tile calls for flow + incidents polling across cities.
 * Models round-robin active city slots: when occupiedCities > activeCities,
 * each city receives turns spaced by `roundsPerCity = occupiedCities / activeCities`.
 *
 * @param {{
 *   flowIntervalMs: number,
 *   perCityIncidentsIntervalMs: number,
 *   keyJunctionCounts: number[],
 *   activeCities?: number,
 *   occupiedCities?: number
 * }} params
 */
function projectDailyNonTileCalls({
  flowIntervalMs,
  perCityIncidentsIntervalMs,
  keyJunctionCounts,
  activeCities = 1,
  occupiedCities
}) {
  const counts =
    Array.isArray(keyJunctionCounts) && keyJunctionCounts.length > 0
      ? keyJunctionCounts.map((n) => Math.max(0, Math.floor(Number(n) || 0)))
      : [0];
  const nOccupied = Math.max(1, Math.floor(occupiedCities ?? counts.length));
  const nActive = Math.max(1, Math.min(nOccupied, Math.floor(activeCities)));

  // Normalize per-city key junction list conservatively to length nOccupied
  const sortedDesc = [...counts].sort((a, b) => b - a);
  const maxCount = sortedDesc[0] ?? 0;
  /** @type {number[]} */
  const effectiveCounts = [];
  for (let i = 0; i < nOccupied; i++) {
    effectiveCounts.push(i < sortedDesc.length ? sortedDesc[i] : maxCount);
  }

  const slotTicksPerDay = Math.floor(DAY_MS / Math.max(1, flowIntervalMs));
  const turnsPerCity = Math.ceil((slotTicksPerDay * nActive) / nOccupied);
  const flowCallsPerDay = effectiveCounts.reduce((sum, c) => sum + c * turnsPerCity, 0);

  const incidentPollsPerCity = Math.min(
    turnsPerCity,
    Math.floor(DAY_MS / Math.max(1, perCityIncidentsIntervalMs))
  );
  const incidentCallsPerDay = nOccupied * incidentPollsPerCity;

  return {
    flowCallsPerDay,
    incidentCallsPerDay,
    totalCallsPerDay: flowCallsPerDay + incidentCallsPerDay,
    turnsPerCity,
    incidentPollsPerCity
  };
}

/**
 * Compute budget-aware polling intervals so projected daily TomTom non-tile calls
 * (flow + incidents) stay within `floor(dailyBudget * pollBudgetRatio)`, reserving
 * the remainder (default 20%) for user-triggered /api/search and /api/route calls.
 *
 * Under round-robin scheduling (occupiedCities > activeCities), enforces:
 *   perCityIncidentsIntervalMs = min(DAY_MS, max(ratio * flowIntervalMs, ratio * cityTurnIntervalMs))
 * so incidents do not fire on every active turn and exhaust the polling budget.
 *
 * @param {{
 *   dailyBudget: number,
 *   pollBudgetRatio?: number,
 *   keyJunctionCounts: number[],
 *   activeCities?: number,
 *   occupiedCities?: number,
 *   baseFlowIntervalMs?: number,
 *   baseIncidentsIntervalMs?: number
 * }} options
 */
function computeBudgetAwarePollIntervals({
  dailyBudget,
  pollBudgetRatio = DEFAULT_POLL_BUDGET_RATIO,
  keyJunctionCounts,
  activeCities = 1,
  occupiedCities,
  baseFlowIntervalMs = DEFAULT_BASE_FLOW_INTERVAL_MS,
  baseIncidentsIntervalMs = DEFAULT_BASE_INCIDENTS_INTERVAL_MS
}) {
  if (!Number.isFinite(dailyBudget) || dailyBudget <= 0) {
    throw new RangeError('dailyBudget must be a positive finite number');
  }
  if (!Number.isFinite(pollBudgetRatio) || pollBudgetRatio <= 0 || pollBudgetRatio > 1) {
    throw new RangeError('pollBudgetRatio must be in (0, 1]');
  }
  if (!Number.isFinite(baseFlowIntervalMs) || baseFlowIntervalMs <= 0) {
    throw new RangeError('baseFlowIntervalMs must be a positive finite number');
  }
  if (!Number.isFinite(baseIncidentsIntervalMs) || baseIncidentsIntervalMs <= 0) {
    throw new RangeError('baseIncidentsIntervalMs must be a positive finite number');
  }

  const counts =
    Array.isArray(keyJunctionCounts) && keyJunctionCounts.length > 0
      ? keyJunctionCounts.map((n) => Math.max(0, Math.floor(Number(n) || 0)))
      : [0];
  const nOccupied = Math.max(1, Math.floor(occupiedCities ?? counts.length));
  const nActive = Math.max(1, Math.min(nOccupied, Math.floor(activeCities)));
  const roundsPerCity = Math.max(1, nOccupied / nActive);
  const incidentToFlowRatio = Math.max(1, baseIncidentsIntervalMs / baseFlowIntervalMs);
  const pollingBudget = Math.max(1, Math.floor(dailyBudget * pollBudgetRatio));

  /** @param {number} flowMs */
  const deriveIncidentsMs = (flowMs) => {
    const cityTurnIntervalMs = roundsPerCity * flowMs;
    return Math.min(
      DAY_MS,
      Math.max(
        Math.round(incidentToFlowRatio * flowMs),
        Math.round(incidentToFlowRatio * cityTurnIntervalMs)
      )
    );
  };

  /** @param {number} flowMs */
  const evaluate = (flowMs) => {
    const perCityIncidentsIntervalMs = deriveIncidentsMs(flowMs);
    const projection = projectDailyNonTileCalls({
      flowIntervalMs: flowMs,
      perCityIncidentsIntervalMs,
      keyJunctionCounts: counts,
      activeCities: nActive,
      occupiedCities: nOccupied
    });
    return { perCityIncidentsIntervalMs, projection };
  };

  const minSec = Math.max(1, Math.ceil(baseFlowIntervalMs / 1000));
  const maxSec = Math.floor(DAY_MS / 1000);

  let chosenFlowMs = minSec * 1000;
  let { perCityIncidentsIntervalMs, projection } = evaluate(chosenFlowMs);
  let budgetConstrained = false;
  let cappedAtMaxInterval = false;

  if (projection.totalCallsPerDay > pollingBudget) {
    budgetConstrained = true;
    let low = minSec;
    let high = maxSec;
    let bestSec = maxSec;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const { projection: midProj } = evaluate(mid * 1000);
      if (midProj.totalCallsPerDay <= pollingBudget) {
        bestSec = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    chosenFlowMs = bestSec * 1000;
    ({ perCityIncidentsIntervalMs, projection } = evaluate(chosenFlowMs));

    while (projection.totalCallsPerDay > pollingBudget && chosenFlowMs < DAY_MS) {
      chosenFlowMs = Math.min(DAY_MS, chosenFlowMs + 1000);
      ({ perCityIncidentsIntervalMs, projection } = evaluate(chosenFlowMs));
    }
    if (projection.totalCallsPerDay > pollingBudget) {
      cappedAtMaxInterval = true;
    }
  }

  return {
    flowIntervalMs: chosenFlowMs,
    perCityIncidentsIntervalMs,
    incidentsIntervalMs: perCityIncidentsIntervalMs,
    cityTurnIntervalMs: Math.round(roundsPerCity * chosenFlowMs),
    roundsPerCity,
    activeCities: nActive,
    occupiedCities: nOccupied,
    dailyBudget,
    pollBudgetRatio,
    pollingBudget,
    reservedOnDemandBudget: Math.max(0, Math.floor(dailyBudget) - pollingBudget),
    projectedDailyCalls: projection.totalCallsPerDay,
    projectedFlowCalls: projection.flowCallsPerDay,
    projectedIncidentCalls: projection.incidentCallsPerDay,
    budgetConstrained,
    cappedAtMaxInterval
  };
}

module.exports = {
  DAY_MS,
  DEFAULT_BASE_FLOW_INTERVAL_MS,
  DEFAULT_BASE_INCIDENTS_INTERVAL_MS,
  DEFAULT_POLL_BUDGET_RATIO,
  projectDailyNonTileCalls,
  computeBudgetAwarePollIntervals
};
