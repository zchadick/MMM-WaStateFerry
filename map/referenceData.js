// Map view reference data that rarely changes: vessel abbreviations (vesselbasics) and terminal
// positions (terminallocations). Fetched when the sailings entry registers, then once a day.
// Kept in memory only; not logged to the prediction DB. A failed fetch keeps the previous data.

const REFRESH_MS = 24 * 60 * 60 * 1000;
const API = "https://www.wsdot.wa.gov/ferries/api";

function createReferenceData({ Log, onUpdate = () => {} }) {
  let data = { abbrevById: {}, terminals: [] };
  let apiKey = null;
  let timer = null;

  async function getJson(pathName) {
    const res = await fetch(`${API}/${pathName}?apiaccesscode=${apiKey}`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${pathName.split("/").pop()}`);
    return res.json();
  }

  async function refresh() {
    try {
      const [basics, locations] = await Promise.all([
        getJson("vessels/rest/vesselbasics"),
        getJson("terminals/rest/terminallocations")
      ]);
      data = {
        abbrevById: Object.fromEntries(basics.map(v => [v.VesselID, v.VesselAbbrev])),
        terminals: locations
          .filter(t => Number.isFinite(t.Latitude) && Number.isFinite(t.Longitude))
          .map(t => ({ id: t.TerminalID, name: String(t.TerminalName || "").trim(), lat: t.Latitude, lon: t.Longitude }))
      };
      onUpdate(data);
    } catch (error) {
      Log.warn(`[MMM-WaStateFerry] Map reference data (vessel abbreviations, terminal locations) not updated: ${error.message}`);
    }
  }

  // Start once (later calls are ignored); refresh daily from then on
  function start(key) {
    if (apiKey) return Promise.resolve();
    apiKey = key;
    timer = setInterval(refresh, REFRESH_MS);
    // A background timer: never keeps the process running on its own
    if (timer.unref) timer.unref();
    return refresh();
  }

  function stop() {
    clearInterval(timer);
  }

  return { start, stop, refresh, get: () => data };
}

module.exports = { createReferenceData, REFRESH_MS };
