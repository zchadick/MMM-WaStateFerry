const NodeHelper = require("node_helper");
const Log = require("logger");

module.exports = NodeHelper.create({
    start () {
        Log.log(`Starting node helper for: ${this.name}`);
    },

    socketNotificationReceived (notification, payload) {
        if (notification === "GET_SCHEDULE") {
            this.fetchSchedule(payload);
        }
    },

    // WSDOT API returns dates as .NET-style "/Date(milliseconds)/"
    parseWsdotDate (dateStr) {
        if (!dateStr) return null;
        const match = dateStr.match(/\/Date\((-?\d+)([+-]\d{4})?\)\//);
        if (match) return new Date(parseInt(match[1]));
        return new Date(dateStr);
    },

    formatTime (date) {
        if (!date || isNaN(date.getTime())) return "N/A";
        return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    },

    // Format last updated timestamp: DD-MMM-YYYY and h:mm am/pm in Seattle timezone
    formatLastUpdated (timestamp) {
        const dateObj = new Date(timestamp);
        
        // Date part: DD-MMM-YYYY in America/Los_Angeles (e.g., 07-Oct-2026)
        const day = dateObj.toLocaleDateString("en-GB", { timeZone: "America/Los_Angeles", day: "2-digit" });
        const month = dateObj.toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short" });
        const year = dateObj.toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", year: "numeric" });
        const formattedDate = `${day}-${month}-${year}`;

        // Time part: h:mm am/pm in America/Los_Angeles
        const time = dateObj.toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit", hour12: true }).toLowerCase();
        
        return `${formattedDate} @ ${time}`;
    },

    async fetchSchedule ({ departingTerminalID, arrivingTerminalID, apiKey, maxSailings }) {
        const forwardUrl = `https://www.wsdot.wa.gov/ferries/api/schedule/rest/scheduletoday/${departingTerminalID}/${arrivingTerminalID}/false?apiaccesscode=${apiKey}`;
        const reverseUrl = `https://www.wsdot.wa.gov/ferries/api/schedule/rest/scheduletoday/${arrivingTerminalID}/${departingTerminalID}/false?apiaccesscode=${apiKey}`;
        const vesselsUrl = `https://www.wsdot.wa.gov/ferries/api/vessels/rest/vessellocations?apiaccesscode=${apiKey}`;

        try {
            const [forwardRes, reverseRes, vesselsRes] = await Promise.all([
                fetch(forwardUrl, { headers: { Accept: "application/json" } }),
                fetch(reverseUrl, { headers: { Accept: "application/json" } }),
                fetch(vesselsUrl, { headers: { Accept: "application/json" } })
            ]);

            if (!forwardRes.ok) throw new Error(`HTTP ${forwardRes.status} on forward schedule`);
            if (!vesselsRes.ok) throw new Error(`HTTP ${vesselsRes.status} on vessel locations`);

            const forwardData = await forwardRes.json();
            const reverseData = reverseRes.ok ? await reverseRes.json() : null;
            const vesselsData = await vesselsRes.json();

            let departingTerminalName = "";
            let arrivingTerminalName = "";
            let allSailings = [];

            const extractSailings = (dataObj, isPrimaryDirection) => {
                if (dataObj && Array.isArray(dataObj.TerminalCombos) && dataObj.TerminalCombos.length > 0) {
                    const combo = dataObj.TerminalCombos[0];
                    if (isPrimaryDirection) {
                        departingTerminalName = combo.DepartingTerminalName || "";
                        arrivingTerminalName = combo.ArrivingTerminalName || "";
                    }
                    if (Array.isArray(combo.Times)) {
                        return combo.Times.map((time) => ({
                            depDate: this.parseWsdotDate(time.DepartingTime),
                            arrDate: this.parseWsdotDate(time.ArrivingTime),
                            vesselID: time.VesselID,
                            vesselName: time.VesselName || "",
                            isPrimary: isPrimaryDirection
                        }));
                    }
                }
                return [];
            };

            const forwardSailings = extractSailings(forwardData, true);
            const reverseSailings = reverseData ? extractSailings(reverseData, false) : [];
            allSailings = [...forwardSailings, ...reverseSailings];

            const vesselDelays = {};

            if (Array.isArray(vesselsData)) {
                vesselsData.forEach((liveVessel) => {
                    if (liveVessel.LeftDock && liveVessel.VesselID) {
                        const actualLeft = this.parseWsdotDate(liveVessel.LeftDock).getTime();
                        
                        const vesselRuns = allSailings
                            .filter(s => s.vesselID === liveVessel.VesselID && s.depDate.getTime() <= Date.now())
                            .sort((a, b) => b.depDate.getTime() - a.depDate.getTime());

                        if (vesselRuns.length > 0) {
                            const scheduledDep = vesselRuns[0].depDate.getTime();
                            const delayMs = actualLeft - scheduledDep;
                            vesselDelays[liveVessel.VesselID] = Math.max(0, delayMs);
                        }
                    }
                });
            }

            let processedSailings = allSailings.map((sailing) => {
                const delayMs = vesselDelays[sailing.vesselID] || 0;
                const estDepTimestamp = sailing.depDate.getTime() + delayMs;
                const estDepDate = new Date(estDepTimestamp);

                return {
                    departingTime: this.formatTime(sailing.depDate),
                    estDeptTime: this.formatTime(estDepDate),
                    estDeptTimestamp: estDepTimestamp,
                    vesselName: sailing.vesselName,
                    isPrimary: sailing.isPrimary,
                    delayMinutes: Math.round(delayMs / 60000),
                    hasDeparted: estDepTimestamp < Date.now()
                };
            });

            processedSailings.sort((a, b) => a.estDeptTimestamp - b.estDeptTimestamp);

            const primaryUpcoming = processedSailings
                .filter(s => s.isPrimary && s.estDeptTimestamp >= Date.now() - (30 * 60 * 1000))
                .slice(0, maxSailings);

            const lastUpdated = this.formatLastUpdated(Date.now());

            this.sendSocketNotification("FERRY_SCHEDULE", { 
                sailings: primaryUpcoming, 
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