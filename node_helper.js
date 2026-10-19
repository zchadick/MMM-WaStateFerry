const NodeHelper = require("node_helper");
const Log = require("logger");

// Persistent cache for vessel delays across requests
const vesselDelayCache = {};

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

  async fetchSchedule({ departingTerminalID, arrivingTerminalID, apiKey, maxSailings }) {
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

      if (!scheduleRes.ok) throw new Error(`HTTP ${scheduleRes.status} on schedule`);
      if (!vesselsRes.ok) throw new Error(`HTTP ${vesselsRes.status} on vessel locations`);

      const scheduleData = await scheduleRes.json();
      const vesselsData = await vesselsRes.json();

      // Sailing space failures are logged but never shown on screen; space fields fall back to null
      let spaceData = null;
      try {
        if (!spaceRes) throw new Error("request failed on sailing space");
        if (!spaceRes.ok) throw new Error(`HTTP ${spaceRes.status} on sailing space`);
        spaceData = await spaceRes.json();
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

      console.log(vesselDelayCache)
      console.log(vesselsUrl)
      console.log(vesselsData)

      // Step 3b: Map departure time to vehicle space for this route's arriving terminal
      const spaceByDeparture = new Map();
      if (spaceData && Array.isArray(spaceData.DepartingSpaces)) {
        spaceData.DepartingSpaces.forEach(dep => {
          const depDate = this.parseWsdotDate(dep.Departure);
          if (!depDate || !Array.isArray(dep.SpaceForArrivalTerminals)) return;

          // Multi-stop routes list several arrival terminals; pick the one for this route
          const arrival = dep.SpaceForArrivalTerminals.find(a =>
            a.TerminalID === arrivingTerminalID ||
            (Array.isArray(a.ArrivalTerminalIDs) && a.ArrivalTerminalIDs.includes(arrivingTerminalID))
          );
          if (!arrival) return;

          spaceByDeparture.set(depDate.getTime(), {
            driveUpSpaceCount: arrival.DriveUpSpaceCount,
            maxSpaceCount: arrival.MaxSpaceCount
          });
        });
      }

      // Step 4: Link delay info back with schedule to compute estimated departure time
      let processedSailings = sailings.map(sailing => {
        const delayMs = vesselDelayCache[sailing.vesselID] || 0;
        const estDepTimestamp = sailing.depDate.getTime() + delayMs;
        const estDepDate = new Date(estDepTimestamp);

        // Space feed only covers upcoming sailings; departed or unmatched sailings get null
        const space = spaceByDeparture.get(sailing.depDate.getTime());

        return {
          departingTime: this.formatTime(sailing.depDate),
          estDeptTime: this.formatTime(estDepDate),
          estDeptTimestamp: estDepTimestamp,
          vesselName: sailing.vesselName,
          delayMinutes: Math.round(delayMs / 60000),
          hasDeparted: estDepTimestamp < Date.now(),
          driveUpSpaceCount: space ? space.driveUpSpaceCount : null,
          maxSpaceCount: space ? space.maxSpaceCount : null
        };
      });

      processedSailings.sort((a, b) => a.estDeptTimestamp - b.estDeptTimestamp);

      // Step 5: Remove sailings that have an estimated departure more than 30 minutes ago
      const filteredSailings = processedSailings
        .filter(s => s.estDeptTimestamp >= Date.now() - (30 * 60 * 1000))
        .slice(0, maxSailings);

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