// Pre-departure refreshes, DB logging per refresh, and the DB status for the title icon.
// Stand-in API data and a mock clock; no network, no live DB.

const { test, mock } = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");
const path = require("node:path");

const HELPER_PATH = path.resolve(__dirname, "../node_helper.js");
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "node_helper") return { create: def => def };
  if (request === "logger") return { log() {}, info() {}, warn() {}, error() {}, debug() {} };
  return originalLoad.call(this, request, ...rest);
};

const MIN = 60 * 1000;
const at = (h, m) => Date.UTC(2026, 9, 23, h + 7, m); // Pacific daylight time
const wsdot = ms => `/Date(${ms}-0700)/`;

let current = null;
let api = null;
function setup({ sailings, vessels = [] }) {
  delete require.cache[HELPER_PATH];
  const helper = require(HELPER_PATH);
  current = helper;
  helper.sent = [];
  helper.sendSocketNotification = (notification, payload) => helper.sent.push({ notification, payload });
  helper.start();
  api = { calls: [], sailings, vessels };
  global.fetch = async url => {
    api.calls.push(url.split("?")[0].split("/rest/")[1]);
    let body;
    if (url.includes("scheduletoday")) {
      body = { TerminalCombos: [{ DepartingTerminalName: "Bainbridge Island", ArrivingTerminalName: "Seattle",
        Times: api.sailings.map(s => ({ DepartingTime: wsdot(s.at), VesselID: s.vessel, VesselName: "Puyallup" })) }] };
    } else if (url.includes("vessellocations")) {
      body = api.vessels;
    } else if (url.includes("terminalsailingspace")) {
      body = { DepartingSpaces: [] };
    } else {
      body = [];
    }
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return helper;
}
const settings = { departingTerminalID: 3, arrivingTerminalID: 7, apiKey: "test", maxSailings: 5, updateInterval: 5 * MIN, manualRefreshCooldown: 30 * 1000 };
const settle = async helper => { for (let i = 0; i < 6; i++) { if (helper.inFlight) await helper.inFlight; await new Promise(r => setImmediate(r)); } };
// Advance the clock a minute at a time (like real time), letting each refresh finish and schedule the next
const advance = async (helper, ms) => {
  for (let left = ms; left > 0; left -= Math.min(left, MIN)) { mock.timers.tick(Math.min(left, MIN)); await settle(helper); }
};
const vesselFetches = () => api.calls.filter(c => c === "vessellocations").length;

test.beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "Date"], now: at(10, 0) }));
test.afterEach(async () => {
  if (current) { await settle(current); current.stop(); current = null; }
  mock.timers.reset();
});

test("pre-departure: refreshes 1 minute before the scheduled departure", async () => {
  // Next sailing 10:03 (on time); the regular 5-minute refresh would come at 10:05
  const helper = setup({ sailings: [{ at: at(10, 3), vessel: 25 }, { at: at(11, 0), vessel: 25 }] });
  helper.register(settings);
  await settle(helper);
  assert.strictEqual(vesselFetches(), 1);
  await advance(helper, 2 * MIN - 1000);
  assert.strictEqual(vesselFetches(), 1, "not yet");
  await advance(helper, 1000);
  assert.strictEqual(vesselFetches(), 2, "refreshed at 10:02, one minute before 10:03");
});

test("pre-departure: also refreshes 1 minute before the estimated departure of a late boat", async () => {
  // The 10:03 boat is running 8 minutes late (its previous crossing left 8 min after schedule): estimate 10:11
  const helper = setup({
    sailings: [{ at: at(9, 15), vessel: 25 }, { at: at(10, 3), vessel: 25 }, { at: at(11, 0), vessel: 25 }],
    vessels: [{ VesselID: 25, AtDock: false, ScheduledDeparture: wsdot(at(9, 15)), LeftDock: wsdot(at(9, 23)) }]
  });
  helper.register(settings);
  await settle(helper);
  await advance(helper, 2 * MIN);   // 10:02 = scheduled − 1 min
  assert.strictEqual(vesselFetches(), 2);
  await advance(helper, 5 * MIN);   // 10:07 = regular timer (5 min after 10:02)
  assert.strictEqual(vesselFetches(), 3);
  await advance(helper, 3 * MIN);   // 10:10 = estimated (10:11) − 1 min, between regular timers
  assert.strictEqual(vesselFetches(), 4);
});

test("pre-departure: no extra refreshes for cancelled or departed sailings, and only the next one is pending", async () => {
  const helper = setup({ sailings: [{ at: at(9, 50), vessel: 25 }, { at: at(13, 0), vessel: 25 }] });
  helper.register(settings);
  await settle(helper);
  // 9:50 has departed (by estimate); 13:00 is far away: only the regular 5-minute timer runs
  await advance(helper, 15 * MIN);
  assert.strictEqual(vesselFetches(), 4, "10:00, 10:05, 10:10, 10:15");
});

test("DB status: a problem is sent to pages, and replayed to pages that register later", async () => {
  const helper = setup({ sailings: [{ at: at(11, 0), vessel: 25 }] });
  helper.register(settings);
  await settle(helper);
  helper.setDbProblem(true);
  assert.deepStrictEqual(helper.sent.at(-1), { notification: "DB_STATUS", payload: { problem: true, routeKey: "3-7" } });
  helper.sent.length = 0;
  helper.register(settings); // a page reloads
  assert.ok(helper.sent.some(m => m.notification === "DB_STATUS" && m.payload.problem === true));
  helper.setDbProblem(false);
  assert.deepStrictEqual(helper.sent.at(-1), { notification: "DB_STATUS", payload: { problem: false, routeKey: "3-7" } });
});

test("DB status: every result carries the current status, including results replayed to pages that register later", async () => {
  const helper = setup({ sailings: [{ at: at(11, 0), vessel: 25 }] });
  helper.register(settings);
  await settle(helper);
  assert.strictEqual(helper.sent.find(m => m.notification === "FERRY_SCHEDULE").payload.dbProblem, false);
  helper.setDbProblem(true);
  await advance(helper, 5 * MIN);
  assert.strictEqual(helper.sent.filter(m => m.notification === "FERRY_SCHEDULE").at(-1).payload.dbProblem, true);
  // The problem clears after the latest result was sent: a page registering now must not get the stale status
  helper.setDbProblem(false);
  helper.sent.length = 0;
  helper.register(settings);
  assert.strictEqual(helper.sent.find(m => m.notification === "FERRY_SCHEDULE").payload.dbProblem, false);
});

test("DB writer reports a problem when writes fail, and only once", async () => {
  mock.timers.reset();
  const { createDbWriter } = require("../predictive_helpers/dbWriter");
  const changes = [];
  const writer = createDbWriter({ info() {}, warn() {}, error() {}, debug() {} }, { onStatusChange: p => changes.push(p) });
  // Nothing listens on port 1, so the connection is refused immediately
  const dbConfig = { predictionDbUser: "u", predictionDbPass: "p", predictionDbHost: "127.0.0.1", predictionDbName: "FERRY", predictionDbPort: 1 };
  await writer.write(dbConfig, [{ snapshotTime: new Date(), endpoint: "test", httpStatus: 200, body: "{}" }]);
  await writer.write(dbConfig, [{ snapshotTime: new Date(), endpoint: "test", httpStatus: 200, body: "{}" }]);
  assert.deepStrictEqual(changes, [true]);
  assert.strictEqual(writer.getStatus().problem, true);
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: at(10, 0) });
});

test("DB writer: no problem reported when DB logging isn't configured", async () => {
  const { createDbWriter } = require("../predictive_helpers/dbWriter");
  const changes = [];
  const writer = createDbWriter({ info() {}, warn() {}, error() {}, debug() {} }, { onStatusChange: p => changes.push(p) });
  await writer.write({}, [{ snapshotTime: new Date(), endpoint: "test", httpStatus: 200, body: "{}" }]);
  assert.deepStrictEqual(changes, []);
});

test("the timetable is logged once a day, and a sailing removed from the schedule reaches the page as cancelled", async () => {
  // Timetable (Friday): 10:30, 11:00, 12:00; WSF's schedule today has dropped 11:00
  const helper = setup({ sailings: [{ at: at(10, 30), vessel: 25 }, { at: at(12, 0), vessel: 25 }] });
  const tod = (h, m) => `/Date(${Date.UTC(1900, 0, 1, h + 8, m)}-0800)/`; // timetable times are in Pacific standard time
  const timetable = JSON.stringify([{ DayOpDescription: "Monday through Friday",
    ActiveDateRanges: [{ DateFrom: wsdot(Date.UTC(2026, 8, 20, 7)), DateThru: wsdot(Date.UTC(2026, 11, 26, 8)) }],
    Journs: [[10, 30], [11, 0], [12, 0]].map(([h, m]) => ({ VesselID: 25, VesselName: "Puyallup",
      TerminalTimes: [{ TerminalID: 3, Time: tod(h, m), DepArrIndicator: 1, IsNA: false }] })) }]);
  const stand = global.fetch;
  global.fetch = async url => {
    if (url.includes("/activeseasons")) return Response.json([{ ScheduleID: 198, ScheduleStart: wsdot(Date.UTC(2026, 8, 20, 7)), ScheduleEnd: wsdot(Date.UTC(2026, 11, 26, 8)) }]);
    if (url.includes("/routes/")) return Response.json([{ RouteID: 5, RouteAbbrev: "sea-bi" }]);
    if (url.includes("/schedroutes/")) return Response.json([{ RouteID: 5, SchedRouteID: 2486, ContingencyOnly: false }]);
    if (url.includes("/sailings/2486")) return new Response(timetable, { status: 200 });
    return stand(url);
  };
  const logged = [];
  helper.dbWriter = { write: (dbConfig, rows) => logged.push(...rows.map(r => r.endpoint)) };
  helper.register(settings);
  await settle(helper);
  await advance(helper, 5 * MIN);
  assert.strictEqual(logged.filter(e => e === "sailings").length, 1, "timetable logged once");
  assert.strictEqual(logged.filter(e => e === "scheduletoday").length, 2);
  const rows = helper.latestResult.payload.sailings;
  assert.deepStrictEqual(rows.map(r => [r.departingTimestamp, r.isCancelled]),
    [[at(10, 30), false], [at(11, 0), true], [at(12, 0), false]]);
});

test("each refresh logs all three responses to the DB", async () => {
  const helper = setup({ sailings: [{ at: at(11, 0), vessel: 25 }] });
  const logged = [];
  helper.dbWriter = { write: (dbConfig, rows) => logged.push(rows.map(r => r.endpoint)) };
  helper.register(settings);
  await settle(helper);
  await advance(helper, 5 * MIN);
  assert.deepStrictEqual(logged, [
    ["scheduletoday", "vessellocations", "terminalsailingspace"],
    ["scheduletoday", "vessellocations", "terminalsailingspace"]
  ]);
});
