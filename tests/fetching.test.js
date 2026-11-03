// Helper-driven fetch cycle tests: registration, timer, cooldown, overlap, one route. Run: node --test
// Uses a mock clock and stand-in API responses; no live API or DB (no DB keys are passed).

const { test, mock } = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");
const path = require("node:path");

const HELPER_PATH = path.resolve(__dirname, "../node_helper.js");

const warnings = [];
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "node_helper") return { create: def => def };
  if (request === "logger") return { log() {}, info() {}, warn: msg => warnings.push(msg), error() {}, debug() {} };
  return originalLoad.call(this, request, ...rest);
};

const MINUTE = 60 * 1000;
const START = Date.UTC(2026, 9, 29, 17, 0); // 10:00 AM PDT

// Minimal API responses: one sailing later today
const BODIES = {
  scheduletoday: { TerminalCombos: [{ DepartingTerminalName: "Bainbridge Island", ArrivingTerminalName: "Seattle",
    Times: [{ DepartingTime: `/Date(${START + 60 * MINUTE}-0700)/`, ArrivingTime: null, VesselID: 25, VesselName: "Puyallup" }] }] },
  vessellocations: [],
  terminalsailingspace: { DepartingSpaces: [] },
  vesselbasics: [],
  terminallocations: []
};

// The helper under test, stopped after each test (even a failing one) so no real timer outlives the mock clock
let current = null;

// Fresh helper with a fetch counter and a record of every message sent to pages
function setup() {
  delete require.cache[HELPER_PATH];
  const helper = require(HELPER_PATH);
  current = helper;
  helper.sent = [];
  helper.sendSocketNotification = (notification, payload) => helper.sent.push({ notification, payload });
  helper.start();
  helper.fetchCycles = 0;
  global.fetch = async url => {
    if (url.includes("scheduletoday")) helper.fetchCycles++;
    const endpoint = Object.keys(BODIES).find(name => url.includes(name));
    return new Response(JSON.stringify(BODIES[endpoint]), { status: 200 });
  };
  warnings.length = 0;
  return helper;
}

const settings = (overrides = {}) => ({
  departingTerminalID: 3, arrivingTerminalID: 7, apiKey: "test", maxSailings: 5,
  updateInterval: 5 * MINUTE, manualRefreshCooldown: 30 * 1000, ...overrides
});

const sentNames = helper => helper.sent.map(m => m.notification);

// Let pending promise callbacks (the async fetch cycle) finish
const settle = async helper => { for (let i = 0; i < 5; i++) { if (helper.inFlight) await helper.inFlight; await Promise.resolve(); } };

// Advance the mock clock and let any refresh it triggers finish
const advance = async (helper, ms) => { mock.timers.tick(ms); await settle(helper); };

test.beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "Date"], now: START }));
test.afterEach(async () => {
  if (current) {
    await settle(current);
    current.stop();
    current = null;
  }
  mock.timers.reset();
});

test("first REGISTER triggers one fetch; the result carries the route key", async () => {
  const helper = setup();
  helper.register(settings());
  await settle(helper);
  assert.strictEqual(helper.fetchCycles, 1);
  assert.deepStrictEqual(sentNames(helper), ["FETCH_STARTED", "FERRY_SCHEDULE"]);
  assert.strictEqual(helper.sent[1].payload.routeKey, "3-7");
});

test("the timer fetches again at updateInterval, not before", async () => {
  const helper = setup();
  helper.register(settings());
  await settle(helper);
  await advance(helper, 5 * MINUTE - 1000);
  assert.strictEqual(helper.fetchCycles, 1);
  await advance(helper, 1000);
  assert.strictEqual(helper.fetchCycles, 2);
});

test("a manual refresh resets the countdown", async () => {
  const helper = setup();
  helper.register(settings());
  await settle(helper);
  await advance(helper, 4 * MINUTE);
  await helper.refresh("manual");
  assert.strictEqual(helper.fetchCycles, 2);
  // The old 5-minute mark passes with no timer fetch...
  await advance(helper, 2 * MINUTE);
  assert.strictEqual(helper.fetchCycles, 2);
  // ...the next one is 5 minutes after the manual refresh
  await advance(helper, 3 * MINUTE);
  assert.strictEqual(helper.fetchCycles, 3);
});

test("overlapping triggers produce one fetch", async () => {
  const helper = setup();
  helper.register(settings());
  const first = helper.inFlight;
  const joined = helper.refresh("manual");
  assert.strictEqual(joined, first, "the second trigger joins the fetch in progress");
  await settle(helper);
  assert.strictEqual(helper.fetchCycles, 1);
});

test("manual refresh within the cooldown pulses but doesn't fetch; after it, fetches", async () => {
  const helper = setup();
  helper.register(settings());
  await settle(helper);
  await advance(helper, 10 * 1000);
  helper.sent.length = 0;
  await helper.refresh("manual");
  assert.strictEqual(helper.fetchCycles, 1, "no fetch inside the cooldown");
  assert.deepStrictEqual(sentNames(helper), ["FETCH_STARTED", "FERRY_SCHEDULE"], "pulse, then the latest result");

  await advance(helper, 20 * 1000);
  await helper.refresh("manual");
  assert.strictEqual(helper.fetchCycles, 2, "fetches once the cooldown has passed");
});

test("a custom manualRefreshCooldown is respected", async () => {
  const helper = setup();
  helper.register(settings({ manualRefreshCooldown: 2 * MINUTE }));
  await settle(helper);
  await advance(helper, 90 * 1000);
  await helper.refresh("manual");
  assert.strictEqual(helper.fetchCycles, 1, "still inside a 2-minute cooldown");
  await advance(helper, 30 * 1000);
  await helper.refresh("manual");
  assert.strictEqual(helper.fetchCycles, 2);
});

test("a second REGISTER for the same route reuses the cycle and gets the latest result", async () => {
  const helper = setup();
  helper.register(settings());
  await settle(helper);
  helper.sent.length = 0;
  helper.register(settings());
  await settle(helper);
  assert.strictEqual(helper.fetchCycles, 1, "no new fetch");
  assert.deepStrictEqual(sentNames(helper), ["FERRY_SCHEDULE"]);
  assert.strictEqual(helper.sent[0].payload.routeKey, "3-7");
});

test("a REGISTER for a different route is ignored with one warning", async () => {
  const helper = setup();
  helper.register(settings());
  await settle(helper);
  helper.register(settings({ departingTerminalID: 7, arrivingTerminalID: 3 }));
  helper.register(settings({ departingTerminalID: 7, arrivingTerminalID: 3 }));
  await settle(helper);
  assert.strictEqual(helper.fetchCycles, 1, "no fetch for the ignored route");
  assert.strictEqual(helper.routeKey, "3-7", "active route unchanged");
  assert.strictEqual(warnings.filter(w => w.includes("route 7-3")).length, 1, "one warning naming both routes");
  assert.ok(warnings[0].includes("active route is 3-7"));
});

// ---- Map view registrations (the map never starts the fetch cycle) ----

const mapSettings = (overrides = {}) => ({
  type: "map", identifier: "module_9_MMM-WaStateFerry",
  mapUpperLeft: { lat: 47.73803, lon: -122.61430 }, mapLowerRight: { lat: 47.57325, lon: -122.32455 },
  mapWidth: 400, mapDetail: "auto", mapLayers: { depth: true, contours: true, coastline: true },
  mapColors: { land: "#3a3a3a", water: "#1f3a52", depth: ["#1a3247", "#162b3d", "#122433", "#0e1d2a", "#0a1620", "#060f17"],
    contour: "rgba(0,0,0,0.25)", coastline: "#626e78" },
  mapLineWidths: { coastline: 1, contour: 0.5 }, mapEdgeFade: 0.06,
  mapMarkerSize: 14,
  mapLabelSize: 11,
  mapMarkerColors: { otherBoat: "#3d3d3d", dockedBoat: "#9a9a9a", toDeparting: "#7fa7c9", toArriving: "#d8c8a0",
    departingTerminal: "#7fa7c9", arrivingTerminal: "#d8c8a0", otherTerminal: "#666" },
  mapIcons: { underway: "fa-location-arrow", docked: "fa-anchor", terminal: "fa-square" },
  ...overrides
});

const VIEW = { west: -122.6143, north: 47.73803, east: -122.29558, south: 47.57325, k: 0.674, scale: 2032, width: 400, height: 307 };

// Stand-in builder so these tests don't build real maps
const stubBuilder = helper => {
  helper.mapBuilder = { getOrBuildMap: async () => ({ file: "0123456789abcdef.svg", view: VIEW }) };
};

test("a map registration doesn't start fetching and gets its own MAP_READY", async () => {
  const helper = setup();
  stubBuilder(helper);
  // Through the same entry point MagicMirror uses, so the type: "map" routing is tested too
  helper.socketNotificationReceived("REGISTER", mapSettings());
  await settle(helper);
  await Promise.resolve();
  assert.strictEqual(helper.fetchCycles, 0, "no fetch from a map");
  assert.strictEqual(helper.routeKey, null, "the map doesn't set the route");
  assert.deepStrictEqual(helper.sent, [{ notification: "MAP_READY",
    payload: { identifier: "module_9_MMM-WaStateFerry", file: "0123456789abcdef.svg", width: 400, height: 307, view: VIEW } }]);
});

test("invalid map settings get MAP_ERROR with the messages", async () => {
  const helper = setup();
  stubBuilder(helper);
  await helper.registerMap(mapSettings({ mapWidth: -5 }));
  assert.strictEqual(helper.sent.length, 1);
  assert.strictEqual(helper.sent[0].notification, "MAP_ERROR");
  assert.strictEqual(helper.sent[0].payload.identifier, "module_9_MMM-WaStateFerry");
  assert.ok(helper.sent[0].payload.errors.some(e => /mapWidth/.test(e)));
});

test("map without a sailings entry: one log warning after 60 seconds", async () => {
  const helper = setup();
  stubBuilder(helper);
  await helper.registerMap(mapSettings());
  await helper.registerMap(mapSettings({ identifier: "module_10_MMM-WaStateFerry" }));
  await advance(helper, 59 * 1000);
  assert.strictEqual(warnings.length, 0);
  await advance(helper, 1000);
  assert.strictEqual(warnings.filter(w => /does not function without a sailings entry/.test(w)).length, 1);
});

test("no map warning when a sailings entry registers (before or after the map)", async () => {
  const before = setup();
  stubBuilder(before);
  before.register(settings());
  await settle(before);
  await before.registerMap(mapSettings());
  await advance(before, 2 * MINUTE);
  assert.strictEqual(warnings.filter(w => /sailings entry/.test(w)).length, 0);

  const after = setup();
  stubBuilder(after);
  await after.registerMap(mapSettings());
  after.register(settings());
  await settle(after);
  await advance(after, 2 * MINUTE);
  assert.strictEqual(warnings.filter(w => /sailings entry/.test(w)).length, 0);
  assert.strictEqual(after.routeKey, "3-7", "the sailings entry sets the route");
});
