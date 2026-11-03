// Turn the three WSF responses into the sailing rows sent to the display (no network, no DB).
// All times are UTC milliseconds; the page formats them in Seattle time.
// State that must survive between fetches (delays, per-sailing memory) is passed in.

// Forget remembered sailings scheduled more than this long ago
const SAILING_MEMORY_MS = 24 * 60 * 60 * 1000;
const RECENT_DEPARTURE_MS = 30 * 60 * 1000;

// WSDOT API returns dates as .NET-style "/Date(milliseconds-0700)/"
function parseWsdotDate(dateStr) {
  if (!dateStr) return null;
  const match = String(dateStr).match(/\/Date\((-?\d+)([+-]\d{4})?\)\//);
  if (match) return new Date(parseInt(match[1], 10));
  return new Date(dateStr);
}

// `expected` (optional): the timetable's sailings for today ({ scheduledMs, vesselID, vesselName }, see
// sailings/timetable.js); any missing from the schedule were removed by WSF and count as cancelled
function buildSailings({ scheduleData, vesselsData, spaceData, departingTerminalID, arrivingTerminalID, maxSailings, now, delays, sailingMemory, expected = null }) {
  let departingTerminalName = "";
  let arrivingTerminalName = "";
  let sailings = [];

  // Step 1: Get scheduled sailings for this route
  if (scheduleData && Array.isArray(scheduleData.TerminalCombos) && scheduleData.TerminalCombos.length > 0) {
    const combo = scheduleData.TerminalCombos[0];
    departingTerminalName = combo.DepartingTerminalName || "";
    arrivingTerminalName = combo.ArrivingTerminalName || "";
    if (Array.isArray(combo.Times)) {
      sailings = combo.Times.map(time => ({
        depDate: parseWsdotDate(time.DepartingTime),
        vesselID: time.VesselID,
        vesselName: time.VesselName || ""
      }));
    }
  }

  // Step 2: Unique vessel IDs on this route's schedule
  const routeVesselIDs = new Set(sailings.map(s => s.vesselID).filter(Boolean));

  // Step 3: Per-vessel delays from underway route vessels (see sailings/delays.js).
  // A new service day starts fresh first, so last night's delays never reach this morning's rows.
  delays.newDayCheck(sailings.length > 0 ? Math.min(...sailings.map(s => s.depDate.getTime())) : null, now);
  delays.observe(vesselsData, routeVesselIDs, sailings, parseWsdotDate);

  // Timetable sailings WSF removed from today's schedule (how most cancellations appear). Matched on time
  // only, since WSF swaps vessels; they come back as normal rows if WSF restores them.
  if (Array.isArray(expected)) {
    const scheduledTimes = new Set(sailings.map(s => s.depDate.getTime()));
    for (const s of expected) {
      if (!scheduledTimes.has(s.scheduledMs)) {
        sailings.push({ depDate: new Date(s.scheduledMs), vesselID: s.vesselID, vesselName: s.vesselName, removed: true });
      }
    }
  }

  // Step 3a: Record actual departures in sailingMemory. A vessel is running one of this route's
  // sailings when its VesselID and ScheduledDeparture both match the sailing (the vessel ID tells
  // apart same-time sailings from the other terminal). Also note vessels still at the dock for a sailing.
  const sailingKey = scheduledMs => `${departingTerminalID}:${scheduledMs}`;
  const rememberSailing = (scheduledMs, fields) => {
    const key = sailingKey(scheduledMs);
    sailingMemory.set(key, { ...sailingMemory.get(key), scheduledMs, ...fields });
  };
  for (const [key, entry] of sailingMemory) {
    if (entry.scheduledMs < now - SAILING_MEMORY_MS) sailingMemory.delete(key);
  }

  const waitingAtDock = new Set();
  if (Array.isArray(vesselsData)) {
    for (const vessel of vesselsData) {
      if (!vessel.ScheduledDeparture) continue;
      const scheduledMs = parseWsdotDate(vessel.ScheduledDeparture).getTime();
      // A removed sailing may be run by any vessel leaving this terminal at that time (WSF sometimes
      // removes a sailing that still runs, e.g. very late or with a swapped vessel)
      const sailing = sailings.find(s => s.depDate.getTime() === scheduledMs &&
        (s.removed ? vessel.DepartingTerminalID === departingTerminalID : s.vesselID === vessel.VesselID));
      if (!sailing) continue;
      if (vessel.AtDock) {
        waitingAtDock.add(scheduledMs);
      } else if (vessel.LeftDock) {
        rememberSailing(scheduledMs, { actualLeft: parseWsdotDate(vessel.LeftDock).getTime(),
          ...(sailing.removed && { vesselName: vessel.VesselName || "" }) });
      }
    }
  }

  // Step 3b: Vehicle space for this route's arriving terminal (and cancellations)
  const spaceByDeparture = new Map();
  if (spaceData && Array.isArray(spaceData.DepartingSpaces)) {
    for (const dep of spaceData.DepartingSpaces) {
      const depDate = parseWsdotDate(dep.Departure);
      if (!depDate || !Array.isArray(dep.SpaceForArrivalTerminals)) continue;

      // Remember cancellations; the feed drops sailings a few minutes after their scheduled time
      const isCancelled = dep.IsCancelled === true;
      if (isCancelled) rememberSailing(depDate.getTime(), { cancelled: true });

      // Multi-stop routes list several arrival terminals; pick the one for this route
      const arrival = dep.SpaceForArrivalTerminals.find(a =>
        a.TerminalID === arrivingTerminalID ||
        (Array.isArray(a.ArrivalTerminalIDs) && a.ArrivalTerminalIDs.includes(arrivingTerminalID))
      );
      if (!arrival) continue;

      spaceByDeparture.set(depDate.getTime(), { driveUpSpaceCount: arrival.DriveUpSpaceCount, maxSpaceCount: arrival.MaxSpaceCount, isCancelled });
      // Remember the latest count so departed sailings can show what they sailed with
      rememberSailing(depDate.getTime(), { driveUpSpaceCount: arrival.DriveUpSpaceCount, maxSpaceCount: arrival.MaxSpaceCount });
    }
  }

  // Step 4: Rows with estimated departures (scheduled + the vessel's delay)
  const rows = sailings.map(sailing => {
    const delayMs = sailing.removed ? 0 : delays.delayMs(sailing.vesselID);
    const scheduledMs = sailing.depDate.getTime();
    const estDepTimestamp = scheduledMs + delayMs;

    // Space feed only covers upcoming sailings; after that, the last count seen before the scheduled time
    const space = spaceByDeparture.get(scheduledMs);
    const memory = sailingMemory.get(sailingKey(scheduledMs)) || {};
    const actualLeft = memory.actualLeft ?? null;
    // Cancelled: flagged by WSF, or removed from the schedule and no vessel left on it
    const isCancelled = Boolean((space && space.isCancelled) || memory.cancelled || (sailing.removed && actualLeft === null));

    // Departed: a cancelled sailing once its scheduled time passes; otherwise the boat actually left.
    // Without real data (e.g. after a restart), use the estimate unless the boat is still at the dock for it.
    let hasDeparted;
    if (isCancelled) {
      hasDeparted = scheduledMs < now;
    } else if (actualLeft !== null) {
      hasDeparted = true;
    } else {
      hasDeparted = estDepTimestamp < now && !waitingAtDock.has(scheduledMs);
    }

    const spaceInfo = isCancelled ? {} : (space || memory);
    return {
      departingTimestamp: scheduledMs,
      estDeptTimestamp: estDepTimestamp,
      vesselName: (sailing.removed && memory.vesselName) || sailing.vesselName,
      delayMinutes: Math.round(delayMs / 60000),
      hasDeparted,
      driveUpSpaceCount: spaceInfo.driveUpSpaceCount ?? null,
      maxSpaceCount: spaceInfo.maxSpaceCount ?? null,
      isCancelled,
      // Shown after "Dep:": actual departure when known, otherwise the estimate
      departedTimestamp: actualLeft ?? estDepTimestamp,
      // Used for the 30-minute window: actual departure, else scheduled time (cancelled), else estimate
      departedAt: actualLeft ?? (isCancelled ? scheduledMs : estDepTimestamp),
      // Upcoming order: cancelled sailings sort by scheduled time
      sortTimestamp: isCancelled ? scheduledMs : estDepTimestamp
    };
  });

  // End of day: once every sailing of the day has departed, flush delays
  delays.endOfDayCheck(rows.length > 0 && rows.every(r => r.hasDeparted), now);

  // Step 5: Departed rows: every sailing that departed in the last 30 minutes, or else the single most
  // recent one. Upcoming rows: up to maxSailings (departed rows don't count toward it).
  const departed = rows.filter(r => r.hasDeparted).sort((a, b) => a.departedAt - b.departedAt);
  const recentlyDeparted = departed.filter(r => r.departedAt >= now - RECENT_DEPARTURE_MS);
  const shownDeparted = recentlyDeparted.length > 0 ? recentlyDeparted : departed.slice(-1);
  const upcoming = rows.filter(r => !r.hasDeparted).sort((a, b) => a.sortTimestamp - b.sortTimestamp).slice(0, maxSailings);

  return { departingTerminalName, arrivingTerminalName, sailings: [...shownDeparted, ...upcoming], routeVesselIDs };
}

module.exports = { buildSailings, parseWsdotDate, SAILING_MEMORY_MS };
