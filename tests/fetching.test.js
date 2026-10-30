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
  terminalsailingspace: { DepartingSpaces: [] }
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
