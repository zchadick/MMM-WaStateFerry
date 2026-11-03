const path = require("node:path");
const NodeHelper = require("node_helper");
const Log = require("logger");
const { createDbWriter } = require("./predictive_helpers/dbWriter");
const { validateMapConfig, createMapBuilder } = require("./map/mapBuilder");
const { createReferenceData } = require("./map/referenceData");
const { buildVesselPositions } = require("./map/vesselPositions");
const { buildSailings } = require("./sailings/buildSailings");
const { createDelayTracker } = require("./sailings/delays");

// A map needs a sailings entry to drive the fetch cycle; warn once if none registers within this time
const MAP_ONLY_WARNING_MS = 60 * 1000;

const API = "https://www.wsdot.wa.gov/ferries/api";

// Extra refreshes this long before each upcoming sailing's scheduled and estimated departure
const PRE_DEPARTURE_MS = 60 * 1000;

// Per-vessel delays, flushed after the day's last sailing (see sailings/delays.js)
const delayTracker = createDelayTracker();

// In-memory record per sailing: actual departure, last space count seen, cancellation.
// Never written to disk; rebuilt from the API after a restart. Keyed by "<departingTerminalID>:<scheduled ms>".
const sailingMemory = new Map();

// Writes raw API responses to the prediction DB (only if configured in config.js); reports DB problems
let dbStatusListener = () => {};
const dbWriter = createDbWriter(Log, { onStatusChange: problem => dbStatusListener(problem) });

module.exports = NodeHelper.create({
  // The prediction-DB writer (a property so tests can observe what gets logged)
  dbWriter,

  start() {
    Log.log(`Starting node helper for: ${this.name}`);
    // One route per installation (see README): settings come from the first page to register
    this.settings = null;
    this.routeKey = null;
    this.latestResult = null;
    this.refreshTimer = null;
    this.inFlight = null;
    this.lastRefreshAt = 0;
    this.warnedRoutes = new Set();
    // Map view: built lazily; a map never sets the route or starts fetching
    this.mapBuilder = null;
    this.sailingsRegistered = false;
    this.mapWarningTimer = null;
    // Map markers: reference data (abbreviations, terminals), the latest vessel feed, and whether any map is shown
    this.reference = null;
    this.latestVesselFeed = null;
    this.latestPositions = null;
    this.mapRegistered = false;
    // Pre-departure refreshes and the DB status for the title icon
    this.departureTimer = null;
    this.dbProblem = false;
    dbStatusListener = problem => this.setDbProblem(problem);
  },

  stop() {
    clearTimeout(this.refreshTimer);
    clearTimeout(this.departureTimer);
    clearTimeout(this.mapWarningTimer);
    if (this.reference) this.reference.stop();
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "REGISTER") {
      if (payload && payload.type === "map") {
        this.registerMap(payload);
      } else {
        this.register(payload);
      }
    }
  },

  // Each page registers once with its merged settings (weather-module pattern); the helper runs the fetch cycle
  register(settings) {
    this.sailingsRegistered = true;
    const routeKey = `${settings.departingTerminalID}-${settings.arrivingTerminalID}`;

    if (!this.settings) {
      this.settings = settings;
      this.routeKey = routeKey;
      this.getReference().start(settings.apiKey);
      this.refresh("startup");
      return;
    }

    if (routeKey !== this.routeKey && !this.warnedRoutes.has(routeKey)) {
      this.warnedRoutes.add(routeKey);
      Log.warn(`[MMM-WaStateFerry] Only one route is supported per MagicMirror. Ignoring an entry for route ${routeKey} `
        + `(departing-arriving terminal IDs); the active route is ${this.routeKey}. See the README.`);
    }

    // Reloads, extra pages, and other entries reuse the one cycle: send the latest result right away.
    // A page for a different route sees the active routeKey and shows a notice instead of sailings.
    if (this.latestResult) {
      this.sendSocketNotification(this.latestResult.notification, this.latestResult.payload);
    }
    if (this.dbProblem) this.sendSocketNotification("DB_STATUS", { problem: true, routeKey: this.routeKey });
  },

  // An active prediction-DB problem starts or clears: the list's title icon turns red while it lasts
  setDbProblem(problem) {
    this.dbProblem = problem;
    this.sendSocketNotification("DB_STATUS", { problem, routeKey: this.routeKey });
  },

  // Map pages register once with their merged map settings and get back their own map
  // (replies carry the page's identifier, so several maps can be on screen at once)
  registerMap(settings) {
    const { identifier } = settings;
    this.warnIfMapOnly();

    const errors = validateMapConfig(settings);
    if (errors.length > 0) {
      Log.warn(`[MMM-WaStateFerry] Invalid map settings (${identifier}): ${errors.join("; ")}`);
      this.sendSocketNotification("MAP_ERROR", { identifier, errors });
      return Promise.resolve();
    }

    this.mapRegistered = true;
    return this.getMapBuilder().getOrBuildMap(settings)
      .then(({ file, view }) => {
        // The view lets the page place markers with the same projection the SVG was drawn with
        const { west, north, east, south, k, scale, width, height } = view;
        this.sendSocketNotification("MAP_READY", { identifier, file, width, height, view: { west, north, east, south, k, scale, width, height } });
        if (this.latestPositions) this.sendSocketNotification("MAP_POSITIONS", this.latestPositions);
      })
      .catch(error => {
        Log.error(`[MMM-WaStateFerry] Map could not be built (${identifier}): ${error.message}`);
        this.sendSocketNotification("MAP_ERROR", { identifier, errors: [`Map could not be built: ${error.message}`] });
      });
  },

  getMapBuilder() {
    if (!this.mapBuilder) {
      this.mapBuilder = createMapBuilder({
        dataDir: path.join(this.path, "map_data"),
        cacheDir: path.join(this.path, "map_cache"),
        Log
      });
    }
    return this.mapBuilder;
  },

  getReference() {
    if (!this.reference) {
      this.reference = createReferenceData({ Log, onUpdate: () => this.publishPositions() });
    }
    return this.reference;
  },

  // Called by fetchSchedule() after each successful fetch: keep the vessel feed for the map markers
  recordVesselFeed(vessels, routeVesselIDs, departingTerminalID, arrivingTerminalID) {
    this.latestVesselFeed = { vessels, routeVesselIDs, departingTerminalID, arrivingTerminalID };
    this.publishPositions();
  },

  // Send marker data to map pages (only once a map is shown; also re-sent when reference data arrives)
  publishPositions() {
    if (!this.latestVesselFeed) return;
    const reference = this.reference ? this.reference.get() : { abbrevById: {}, terminals: [] };
    this.latestPositions = buildVesselPositions({ ...this.latestVesselFeed, reference });
    if (this.mapRegistered) this.sendSocketNotification("MAP_POSITIONS", this.latestPositions);
  },

  // Pages register in any order, so only warn if no sailings entry has registered a while after a map did
  warnIfMapOnly() {
    if (this.sailingsRegistered || this.mapWarningTimer) return;
    this.mapWarningTimer = setTimeout(() => {
      if (!this.sailingsRegistered) {
        Log.warn("[MMM-WaStateFerry] The map does not function without a sailings entry: add an MMM-WaStateFerry "
          + "entry without type \"map\" (or with type \"sailings\") to config.js. Ferries and terminals won't appear until then.");
      }
    }, MAP_ONLY_WARNING_MS);
    // Only a log message: never keeps the process running on its own
    if (this.mapWarningTimer.unref) this.mapWarningTimer.unref();
  },

  // One full fetch cycle. Callers: startup, timer, pre-departure ("departure"), and later GPIO ("manual").
  refresh(trigger) {
    if (!this.settings) return Promise.resolve();

    // Overlapping triggers join the fetch in progress
    if (this.inFlight) return this.inFlight;

    // Manual triggers inside the cooldown don't fetch, but still pulse the icon so the press registers
    if (trigger === "manual" && Date.now() - this.lastRefreshAt < this.settings.manualRefreshCooldown) {
      this.sendSocketNotification("FETCH_STARTED", { routeKey: this.routeKey });
      if (this.latestResult) this.sendSocketNotification(this.latestResult.notification, this.latestResult.payload);
      return Promise.resolve();
    }

    clearTimeout(this.refreshTimer);
    this.sendSocketNotification("FETCH_STARTED", { routeKey: this.routeKey });

    // Timer settings stay with the helper; the rest are fetch settings (route, API key, DB keys if present)
    const { updateInterval, manualRefreshCooldown, ...fetchSettings } = this.settings;
    this.inFlight = this.fetchSchedule(fetchSettings).finally(() => {
      this.inFlight = null;
      this.lastRefreshAt = Date.now();
      // The countdown restarts after every refresh, whatever triggered it
      this.refreshTimer = setTimeout(() => this.refresh("timer"), updateInterval);
    });
    return this.inFlight;
  },

  // Send a result to every page (tagged with its route) and keep it for pages that register later
  sendResult(notification, payload, routeKey) {
    const tagged = { ...payload, routeKey };
    this.latestResult = { notification, payload: tagged };
    this.sendSocketNotification(notification, tagged);
  },

  // Extra refreshes 1 minute before the next upcoming sailing's scheduled and estimated departures.
  // Each refresh re-plans this, so only the next one is ever pending.
  scheduleDepartureRefresh(rows) {
    clearTimeout(this.departureTimer);
    if (!this.settings) return;
    const now = Date.now();
    const targets = rows
      .filter(row => !row.hasDeparted && !row.isCancelled)
      .flatMap(row => [row.departingTimestamp, row.estDeptTimestamp])
      .map(departure => departure - PRE_DEPARTURE_MS)
      .filter(target => target > now + 5000);
    if (targets.length === 0) return;
    const next = Math.min(...targets);
    this.departureTimer = setTimeout(() => this.refresh("departure"), next - now);
  },

  // Any remaining payload keys are the prediction DB settings (present only if set in config.js)
  async fetchSchedule({ departingTerminalID, arrivingTerminalID, apiKey, maxSailings, ...dbConfig }) {
    const routeKey = `${departingTerminalID}-${arrivingTerminalID}`;
    // Note: OnlyRemainingTimes is set to 'false' to pull the entire day's schedule
    const scheduleUrl = `${API}/schedule/rest/scheduletoday/${departingTerminalID}/${arrivingTerminalID}/false?apiaccesscode=${apiKey}`;
    const vesselsUrl = `${API}/vessels/rest/vessellocations?apiaccesscode=${apiKey}`;
    // Sailing space is per departing terminal; filtered to arriving terminal below
    const spaceUrl = `${API}/terminals/rest/terminalsailingspace/${departingTerminalID}?apiaccesscode=${apiKey}`;

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
      this.dbWriter.write(dbConfig, [
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

      // Rows for the display (see sailings/buildSailings.js); all times are UTC timestamps
      const built = buildSailings({
        scheduleData, vesselsData, spaceData, departingTerminalID, arrivingTerminalID, maxSailings,
        now: Date.now(), delays: delayTracker, sailingMemory
      });
      Log.debug(`[MMM-WaStateFerry] Vessel delays (ms): ${JSON.stringify(delayTracker.snapshot())}`);

      // Map view: hand the vessel feed to the helper for ferry markers
      this.recordVesselFeed(vesselsData, built.routeVesselIDs, departingTerminalID, arrivingTerminalID);

      this.sendResult("FERRY_SCHEDULE", {
        sailings: built.sailings,
        departingTerminalName: built.departingTerminalName,
        arrivingTerminalName: built.arrivingTerminalName,
        lastUpdatedTimestamp: Date.now()
      }, routeKey);
      this.scheduleDepartureRefresh(built.sailings);

    } catch (error) {
      Log.error(`[MMM-WaStateFerry] ${error.message}`);
      this.sendResult("FERRY_ERROR", { message: error.message }, routeKey);
    }
  }
});
