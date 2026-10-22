const NodeHelper = require("node_helper");
const Log = require("logger");
const { createDbWriter } = require("./predictive_helpers/dbWriter");

// Persistent cache for vessel delays across requests
const vesselDelayCache = {};

// In-memory record per sailing: actual departure, last space count seen, cancellation.
// Never written to disk; rebuilt from the API after a restart. Keyed by "<departingTerminalID>:<scheduled ms>".
const sailingMemory = new Map();
const SAILING_MEMORY_MS = 24 * 60 * 60 * 1000;

// Writes raw API responses to the prediction DB (only if configured in config.js)
const dbWriter = createDbWriter(Log);

module.exports = NodeHelper.create({
  start() {
    Log.log(`Starting node helper for: ${this.name}`);
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "GET_SCHEDULE") {
      this.fetchSchedule(payload);
    }
  },

  // WSDOT API returns dates as .NET-style "/Date(milliseconds)/"
  parseWsdotDate(dateStr) {
    if (!dateStr) return null;
    const match = dateStr.match(/\/Date\((-?\d+)([+-]\d{4})?\)\//);
    if (match) return new Date(parseInt(match[1], 10));
    return new Date(dateStr);
  },

  formatTime(date) {
    if (!date || isNaN(date.getTime())) return "N/A";
    return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  },

  // Format last updated timestamp: DD-MMM-YYYY and h:mm am/pm in Seattle timezone
  formatLastUpdated(timestamp) {
    const dateObj = new Date(timestamp);

    const day = dateObj.toLocaleDateString("en-GB", { timeZone: "America/Los_Angeles", day: "2-digit" });
    const month = dateObj.toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short" });
    const year = dateObj.toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", year: "numeric" });
    const formattedDate = `${day}-${month}-${year}`;

    const time = dateObj.toLocaleTimeString("en-US", { 
      timeZone: "America/Los_Angeles", 
      hour: "numeric", 
      minute: "2-digit", 
      hour12: true 
    }).toLowerCase();

    return `${formattedDate} @ ${time}`;
  },

  // Any remaining payload keys are the prediction DB settings (present only if set in config.js)
  async fetchSchedule({ departingTerminalID, arrivingTerminalID, apiKey, maxSailings, ...dbConfig }) {
    // Note: OnlyRemainingTimes is set to 'false' to pull the entire day's schedule
    const scheduleUrl = `https://www.wsdot.wa.gov/ferries/api/schedule/rest/scheduletoday/${departingTerminalID}/${arrivingTerminalID}/false?apiaccesscode=${apiKey}`;
    const vesselsUrl = `https://www.wsdot.wa.gov/ferries/api/vessels/rest/vessellocations?apiaccesscode=${apiKey}`;
    // Sailing space is per departing terminal; filtered to arriving terminal below
    const spaceUrl = `https://www.wsdot.wa.gov/ferries/api/terminals/rest/terminalsailingspace/${departingTerminalID}?apiaccesscode=${apiKey}`;

    try {
      // Sailing space is optional: a failed request resolves to null instead of rejecting
      const [scheduleRes, vesselsRes, spaceRes] = await Promise.all([
        fetch(scheduleUrl, { headers: { Accept: "application/json" } }),
        fetch(vesselsUrl, { headers: { Accept: "application/json" } }),
        fetch(spaceUrl, { headers: { Accept: "application/json" } }).catch(() => null)
      ]);

      // Read each response once as raw text: stored as-is in the prediction DB, parsed below for display
      const scheduleText = await scheduleRes.text();
      const vesselsText = await vesselsRes.text();
      const spaceText = spaceRes ? await spaceRes.text().catch(() => null) : null;

      // Send raw responses (including HTTP errors) to the prediction DB; not awaited so it never delays the display
      const snapshotTime = new Date();
      dbWriter.write(dbConfig, [
        { snapshotTime, endpoint: "scheduletoday", departingTerminalID, arrivingTerminalID, httpStatus: scheduleRes.status, body: scheduleText },
        { snapshotTime, endpoint: "vessellocations", departingTerminalID, arrivingTerminalID, httpStatus: vesselsRes.status, body: vesselsText },
        { snapshotTime, endpoint: "terminalsailingspace", departingTerminalID, arrivingTerminalID, httpStatus: spaceRes ? spaceRes.status : null, body: spaceText }
      ]);

      if (!scheduleRes.ok) throw new Error(`HTTP ${scheduleRes.status} on schedule`);
      if (!vesselsRes.ok) throw new Error(`HTTP ${vesselsRes.status} on vessel locations`);

      const scheduleData = JSON.parse(scheduleText);
      const vesselsData = JSON.parse(vesselsText);

      // Sailing space failures are logged but never shown on screen; space fields fall back to null
      let spaceData = null;
      try {
        if (!spaceRes) throw new Error("request failed on sailing space");
        if (!spaceRes.ok) throw new Error(`HTTP ${spaceRes.status} on sailing space`);
        spaceData = JSON.parse(spaceText);
      } catch (spaceError) {
        Log.warn(`[MMM-WaStateFerry] ${spaceError.message}`);
      }

      let departingTerminalName = "";
      let arrivingTerminalName = "";
      let sailings = [];

      // Step 1: Get scheduled sailings and filter for correct route terminals
      if (scheduleData && Array.isArray(scheduleData.TerminalCombos) && scheduleData.TerminalCombos.length > 0) {
        const combo = scheduleData.TerminalCombos[0];
        departingTerminalName = combo.DepartingTerminalName || "";
        arrivingTerminalName = combo.ArrivingTerminalName || "";

        
        if (Array.isArray(combo.Times)) {
          sailings = combo.Times
            .map(time => ({
              depDate: this.parseWsdotDate(time.DepartingTime),
              arrDate: this.parseWsdotDate(time.ArrivingTime),
              vesselID: time.VesselID,
              vesselName: time.VesselName || ""
            }));
        }
      }
      
      // Step 2: Extract unique vessel IDs relevant to this route's schedule
      const routeVesselIDs = new Set(sailings.map(s => s.vesselID).filter(Boolean));

      // Step 3: Get current vessel info, calculate delay if atDock=false, otherwise use cache
      if (Array.isArray(vesselsData)) {
        vesselsData.forEach(liveVessel => {
          if (!liveVessel.VesselID || !routeVesselIDs.has(liveVessel.VesselID)) return;

          if (!liveVessel.AtDock && liveVessel.LeftDock) {
            const actualLeft = this.parseWsdotDate(liveVessel.LeftDock).getTime();
            let scheduledDepTime = liveVessel.ScheduledDeparture ? this.parseWsdotDate(liveVessel.ScheduledDeparture).getTime() : null;

            // Fallback match if ScheduledDeparture isn't explicitly populated on live feed item
            if (!scheduledDepTime) {
              const matchingRuns = sailings
                .filter(s => s.vesselID === liveVessel.VesselID && s.depDate.getTime() <= actualLeft + (30 * 60 * 1000))
                .sort((a, b) => Math.abs(a.depDate.getTime() - actualLeft) - Math.abs(b.depDate.getTime() - actualLeft));

              if (matchingRuns.length > 0) {
                scheduledDepTime = matchingRuns[0].depDate.getTime();
              }
            }

            if (scheduledDepTime) {
              const delayMs = Math.max(0, actualLeft - scheduledDepTime);
              vesselDelayCache[liveVessel.VesselID] = delayMs;
            }
          }

          // Initialize cache if vessel has no entry yet
          if (!(liveVessel.VesselID in vesselDelayCache)) {
            vesselDelayCache[liveVessel.VesselID] = 0;
          }
        });
      }

      Log.debug(`[MMM-WaStateFerry] Vessel delays (ms): ${JSON.stringify(vesselDelayCache)}`);

      // Step 3a: Record actual departures in sailingMemory. A vessel is running one of this route's
      // sailings when its VesselID and ScheduledDeparture both match the sailing (the vessel ID tells
      // apart same-time sailings from the other terminal). Also note vessels still at the dock for a sailing.
      const now = Date.now();
      const sailingKey = scheduledMs => `${departingTerminalID}:${scheduledMs}`;
      const rememberSailing = (scheduledMs, fields) => {
        const key = sailingKey(scheduledMs);
        sailingMemory.set(key, { ...sailingMemory.get(key), scheduledMs, ...fields });
      };

      // Forget sailings scheduled more than 24 hours ago
      for (const [key, entry] of sailingMemory) {
        if (entry.scheduledMs < now - SAILING_MEMORY_MS) sailingMemory.delete(key);
      }

      const waitingAtDock = new Set();
      if (Array.isArray(vesselsData)) {
        vesselsData.forEach(liveVessel => {
          if (!liveVessel.ScheduledDeparture) return;
          const scheduledMs = this.parseWsdotDate(liveVessel.ScheduledDeparture).getTime();
          const sailing = sailings.find(s => s.vesselID === liveVessel.VesselID && s.depDate.getTime() === scheduledMs);
          if (!sailing) return;

          if (liveVessel.AtDock) {
            waitingAtDock.add(scheduledMs);
          } else if (liveVessel.LeftDock) {
            rememberSailing(scheduledMs, { actualLeft: this.parseWsdotDate(liveVessel.LeftDock).getTime() });
          }
        });
      }

      // Step 3b: Map departure time to vehicle space for this route's arriving terminal
      const spaceByDeparture = new Map();
      if (spaceData && Array.isArray(spaceData.DepartingSpaces)) {
        spaceData.DepartingSpaces.forEach(dep => {
          const depDate = this.parseWsdotDate(dep.Departure);
          if (!depDate || !Array.isArray(dep.SpaceForArrivalTerminals)) return;

          // Remember cancellations; the feed drops sailings a few minutes after their scheduled time
          const isCancelled = dep.IsCancelled === true;
          if (isCancelled) rememberSailing(depDate.getTime(), { cancelled: true });

          // Multi-stop routes list several arrival terminals; pick the one for this route
          const arrival = dep.SpaceForArrivalTerminals.find(a =>
            a.TerminalID === arrivingTerminalID ||
            (Array.isArray(a.ArrivalTerminalIDs) && a.ArrivalTerminalIDs.includes(arrivingTerminalID))
          );
          if (!arrival) return;

          spaceByDeparture.set(depDate.getTime(), {
            driveUpSpaceCount: arrival.DriveUpSpaceCount,
            maxSpaceCount: arrival.MaxSpaceCount,
            isCancelled
          });

          // Remember the latest count so departed sailings can show what they sailed with
          rememberSailing(depDate.getTime(), {
            driveUpSpaceCount: arrival.DriveUpSpaceCount,
            maxSpaceCount: arrival.MaxSpaceCount
          });
        });
      }

      // Step 4: Link delay info back with schedule to compute estimated departure time
      let processedSailings = sailings.map(sailing => {
        const delayMs = vesselDelayCache[sailing.vesselID] || 0;
        const scheduledMs = sailing.depDate.getTime();
        const estDepTimestamp = scheduledMs + delayMs;
        const estDepDate = new Date(estDepTimestamp);

        // Space feed only covers upcoming sailings; departed or unmatched sailings get null
        const space = spaceByDeparture.get(scheduledMs);
        const memory = sailingMemory.get(sailingKey(scheduledMs)) || {};
        const isCancelled = Boolean((space && space.isCancelled) || memory.cancelled);
        const actualLeft = memory.actualLeft ?? null;

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

        // Live count while listed; after the feed drops a sailing, the last count seen before its scheduled time
        const spaceInfo = isCancelled ? {} : (space || memory);

        return {
          departingTime: this.formatTime(sailing.depDate),
          estDeptTime: this.formatTime(estDepDate),
          estDeptTimestamp: estDepTimestamp,
          vesselName: sailing.vesselName,
          delayMinutes: Math.round(delayMs / 60000),
          hasDeparted,
          driveUpSpaceCount: spaceInfo.driveUpSpaceCount ?? null,
          maxSpaceCount: spaceInfo.maxSpaceCount ?? null,
          isCancelled,
          // Shown after "Dep:": actual departure when known, otherwise the estimate
          departedTime: this.formatTime(new Date(actualLeft ?? estDepTimestamp)),
          // Used for the 30-minute window: actual departure, else scheduled time (cancelled), else estimate
          departedAt: actualLeft ?? (isCancelled ? scheduledMs : estDepTimestamp),
          // Upcoming order: cancelled sailings sort by scheduled time
          sortTimestamp: isCancelled ? scheduledMs : estDepTimestamp
        };
      });

      processedSailings.sort((a, b) => a.estDeptTimestamp - b.estDeptTimestamp);

      // Step 5: Departed rows: every sailing that departed in the last 30 minutes, or else the single most
      // recent one. Upcoming rows: up to maxSailings (departed rows don't count toward it).
      const departed = processedSailings
        .filter(s => s.hasDeparted)
        .sort((a, b) => a.departedAt - b.departedAt);
      const recentlyDeparted = departed.filter(s => s.departedAt >= now - (30 * 60 * 1000));
      const shownDeparted = recentlyDeparted.length > 0 ? recentlyDeparted : departed.slice(-1);

      const upcoming = processedSailings
        .filter(s => !s.hasDeparted)
        .sort((a, b) => a.sortTimestamp - b.sortTimestamp)
        .slice(0, maxSailings);

      const filteredSailings = [...shownDeparted, ...upcoming];

      const lastUpdated = this.formatLastUpdated(Date.now());

      this.sendSocketNotification("FERRY_SCHEDULE", { 
        sailings: filteredSailings, 
        departingTerminalName, 
        arrivingTerminalName,
        lastUpdated
      });

    } catch (error) {
      Log.error(`[MMM-WaStateFerry] ${error.message}`);
      this.sendSocketNotification("FERRY_ERROR", { message: error.message });
    }
  }
});