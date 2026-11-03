// Per-vessel delay estimates for the sailing list.
// A vessel's delay is LeftDock − ScheduledDeparture on its most recent crossing (either direction),
// applied to its later sailings. Delays are flushed once the day's last sailing has departed, and
// whenever the schedule moves to a new service day, so last night's delay never reaches the first
// sailings of the morning. Kept in memory only.

// On a new service day, crossings that left more than this long before its first sailing are ignored
const NEW_DAY_MARGIN_MS = 60 * 60 * 1000;

function createDelayTracker() {
  const delays = new Map(); // vessel ID → delay in ms
  let clearedAt = -Infinity; // crossings that left at or before this time are ignored after a flush
  let serviceDay = null;     // first scheduled departure of the current schedule (identifies the day)

  function clear(now) {
    delays.clear();
    clearedAt = now;
  }

  // Record delays from underway route vessels. `sailings` are this route's scheduled sailings
  // ({ depDate, vesselID }), used only when the live feed has no ScheduledDeparture.
  function observe(vessels, routeVesselIDs, sailings, parseWsdotDate) {
    if (!Array.isArray(vessels)) return;
    for (const vessel of vessels) {
      if (!vessel.VesselID || !routeVesselIDs.has(vessel.VesselID)) continue;
      if (vessel.AtDock || !vessel.LeftDock) continue;

      const actualLeft = parseWsdotDate(vessel.LeftDock).getTime();
      if (actualLeft <= clearedAt) continue; // a crossing from before the last flush

      let scheduledDepTime = vessel.ScheduledDeparture ? parseWsdotDate(vessel.ScheduledDeparture).getTime() : null;
      // Fallback match if ScheduledDeparture isn't populated on the live feed item
      if (!scheduledDepTime) {
        const nearest = sailings
          .filter(s => s.vesselID === vessel.VesselID && s.depDate.getTime() <= actualLeft + (30 * 60 * 1000))
          .sort((a, b) => Math.abs(a.depDate.getTime() - actualLeft) - Math.abs(b.depDate.getTime() - actualLeft))[0];
        if (nearest) scheduledDepTime = nearest.depDate.getTime();
      }
      if (scheduledDepTime) delays.set(vessel.VesselID, Math.max(0, actualLeft - scheduledDepTime));
    }
  }

  // Before using delays: start fresh when the schedule has moved to a new service day. Only crossings
  // from before the new day's schedule are ignored, so a crossing already underway is still recorded.
  function newDayCheck(firstDepartureMs, now) {
    if (firstDepartureMs == null) return;
    if (serviceDay !== null && firstDepartureMs !== serviceDay) {
      delays.clear();
      clearedAt = Math.max(clearedAt, Math.min(now, firstDepartureMs - NEW_DAY_MARGIN_MS));
    }
    serviceDay = firstDepartureMs;
  }

  // After building the rows: start fresh once every sailing of the day has departed
  function endOfDayCheck(allDeparted, now) {
    if (allDeparted) clear(now);
  }

  return {
    observe,
    newDayCheck,
    endOfDayCheck,
    delayMs: vesselID => delays.get(vesselID) || 0,
    snapshot: () => Object.fromEntries(delays)
  };
}

module.exports = { createDelayTracker };
