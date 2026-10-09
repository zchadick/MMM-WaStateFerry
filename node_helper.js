const NodeHelper = require("node_helper");
const Log = require("logger");
const { spawn } = require("child_process");

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

  runPredictiveModel(sailings, dbUser, dbPass) {
    return new Promise((resolve) => {
      const pythonProcess = spawn("python3", [`${__dirname}/predictive_helpers/predictive_model_update.py`]);

      let outputData = "";
      let errorData = "";

      // Send data to python script via stdin as JSON
      const payload = {
        sailings: sailings,
        dbUser: dbUser,
        dbPass: dbPass
      };

      pythonProcess.stdin.write(JSON.stringify(payload));
      pythonProcess.stdin.end();

      pythonProcess.stdout.on("data", (data) => {
        outputData += data.toString();
      });

      pythonProcess.stderr.on("data", (data) => {
        errorData += data.toString();
      });

      pythonProcess.on("close", (code) => {
        if (code !== 0) {
          Log.error(`[MMM-WaStateFerry] Python script exited with code ${code}: ${errorData}`);
          resolve(0); // Fallback integer value on failure
          return;
        }

        const predictiveStatus = parseInt(outputData.trim(), 10);
        resolve(isNaN(predictiveStatus) ? 0 : predictiveStatus);
      });
    });
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

  async fetchSchedule({ departingTerminalID, arrivingTerminalID, apiKey, maxSailings, predictionDbUser, predictionDbPass }) {
    // Note: OnlyRemainingTimes is set to 'false' to pull the entire day's schedule
    const scheduleUrl = `https://www.wsdot.wa.gov/ferries/api/schedule/rest/scheduletoday/${departingTerminalID}/${arrivingTerminalID}/false?apiaccesscode=${apiKey}`;
    const vesselsUrl = `https://www.wsdot.wa.gov/ferries/api/vessels/rest/vessellocations?apiaccesscode=${apiKey}`;

    try {
      const [scheduleRes, vesselsRes] = await Promise.all([
        fetch(scheduleUrl, { headers: { Accept: "application/json" } }),
        fetch(vesselsUrl, { headers: { Accept: "application/json" } })
      ]);

      if (!scheduleRes.ok) throw new Error(`HTTP ${scheduleRes.status} on schedule`);
      if (!vesselsRes.ok) throw new Error(`HTTP ${vesselsRes.status} on vessel locations`);

      const scheduleData = await scheduleRes.json();
      const vesselsData = await vesselsRes.json();

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

      // Step 4: Link delay info back with schedule to compute estimated departure time
      let processedSailings = sailings.map(sailing => {
        const delayMs = vesselDelayCache[sailing.vesselID] || 0;
        const estDepTimestamp = sailing.depDate.getTime() + delayMs;
        const estDepDate = new Date(estDepTimestamp);

        return {
          departingTime: this.formatTime(sailing.depDate),
          estDeptTime: this.formatTime(estDepDate),
          estDeptTimestamp: estDepTimestamp,
          vesselName: sailing.vesselName,
          delayMinutes: Math.round(delayMs / 60000),
          hasDeparted: estDepTimestamp < Date.now()
        };
      });

      processedSailings.sort((a, b) => a.estDeptTimestamp - b.estDeptTimestamp);

      // Step 5: Remove sailings that have an estimated departure more than 30 minutes ago
      const filteredSailings = processedSailings
        .filter(s => s.estDeptTimestamp >= Date.now() - (30 * 60 * 1000))
        .slice(0, maxSailings);

      // Get predictiveStatus integer from python script
      const predictiveStatus = await this.runPredictiveModel(filteredSailings, predictionDbUser, predictionDbPass);
      
      console.log(predictiveStatus)

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