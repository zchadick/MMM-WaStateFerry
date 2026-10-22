// Departed-sailing tests (Appearance #3, #10, #11). Run from the module directory: node --test
// Runs the real node_helper fetchSchedule() with hand-made API responses and a mock clock.
// No live API or DB is used (no DB keys are passed, so DB logging stays off).

process.env.TZ = "America/Los_Angeles";

const { test, mock } = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");
const path = require("node:path");

const HELPER_PATH = path.resolve(__dirname, "../node_helper.js");

// Stand-ins for MagicMirror's node_helper and logger modules
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "node_helper") return { create: def => def };
  if (request === "logger") return { log() {}, info() {}, warn() {}, error() {}, debug() {} };
  return originalLoad.call(this, request, ...rest);
};

// Load a fresh helper (its in-memory caches start empty, like after a restart)
function loadHelper() {
  delete require.cache[HELPER_PATH];
  const helper = require(HELPER_PATH);
  helper.payloads = [];
  helper.sendSocketNotification = (notification, payload) => helper.payloads.push({ notification, payload });
  return helper;
}

// Times on 2026-10-23 (Pacific daylight time)
const at = (h, m) => Date.UTC(2026, 9, 23, h + 7, m);
const wsdot = ms => `/Date(${ms}-0700)/`;
const NAMES = { 25: "Puyallup", 37: "Wenatchee" };

const scheduleBody = sailings => ({
  TerminalCombos: [{
    DepartingTerminalName: "Bainbridge Island",
    ArrivingTerminalName: "Seattle",
    Times: sailings.map(s => ({ DepartingTime: wsdot(s.at), ArrivingTime: null, VesselID: s.vessel, VesselName: NAMES[s.vessel] }))
  }]
});

const vessel = ({ id, atDock, from = 3, scheduled, left }) => ({
  VesselID: id,
  VesselName: NAMES[id],
  AtDock: atDock,
  DepartingTerminalID: from,
  ScheduledDeparture: scheduled ? wsdot(scheduled) : null,
  LeftDock: left ? wsdot(left) : null
});

const spaceBody = departures => ({
  DepartingSpaces: departures.map(d => ({
    Departure: wsdot(d.at),
    IsCancelled: Boolean(d.cancelled),
    SpaceForArrivalTerminals: [{ TerminalID: 7, ArrivalTerminalIDs: [7], DriveUpSpaceCount: d.count ?? 197, MaxSpaceCount: 197 }]
  }))
});

// Run one fetch at time `now` with the given API responses; returns the sailings sent to the display
async function fetchAt(helper, now, { sailings, vessels = [], space = [] }, maxSailings = 5) {
  mock.timers.setTime(now);
  const bodies = {
    scheduletoday: scheduleBody(sailings),
    vessellocations: vessels.map(vessel),
    terminalsailingspace: spaceBody(space)
  };
  global.fetch = async url => {
    const endpoint = Object.keys(bodies).find(name => url.includes(name));
    return new Response(JSON.stringify(bodies[endpoint]), { status: 200 });
  };
  await helper.fetchSchedule({ departingTerminalID: 3, arrivingTerminalID: 7, apiKey: "test", maxSailings });
  const last = helper.payloads[helper.payloads.length - 1];
  assert.strictEqual(last.notification, "FERRY_SCHEDULE", JSON.stringify(last.payload));
  return last.payload.sailings;
}

const row = (sailings, departingTime) => sailings.find(s => s.departingTime === departingTime);

const DAY = [
  { at: at(9, 40), vessel: 25 },
  { at: at(10, 25), vessel: 37 },
  { at: at(11, 30), vessel: 25 },
  { at: at(12, 20), vessel: 37 },
  { at: at(13, 15), vessel: 25 },
  { at: at(14, 5), vessel: 25 },
  { at: at(15, 0), vessel: 37 }
];

test.beforeEach(() => mock.timers.enable({ apis: ["Date"], now: at(0, 0) }));
test.afterEach(() => mock.timers.reset());

test("#3: a boat underway shows its real departure time after Dep:", async () => {
  const helper = loadHelper();
  const sailings = await fetchAt(helper, at(9, 50), {
    sailings: DAY,
    vessels: [{ id: 25, atDock: false, scheduled: at(9, 40), left: at(9, 43) }]
  });
  const r = row(sailings, "9:40 AM");
  assert.strictEqual(r.hasDeparted, true);
  assert.strictEqual(r.departedTime, "9:43 AM");
});

test("#3: the real departure time is remembered after the boat docks", async () => {
  const helper = loadHelper();
  await fetchAt(helper, at(9, 50), {
    sailings: DAY,
    vessels: [{ id: 25, atDock: false, scheduled: at(9, 40), left: at(9, 43) }]
  });
  // Later: Puyallup is docked in Seattle, waiting for a Seattle departure (not on this route)
  const sailings = await fetchAt(helper, at(10, 20), {
    sailings: DAY,
    vessels: [{ id: 25, atDock: true, from: 7, scheduled: at(10, 35) }]
  });
  assert.strictEqual(row(sailings, "9:40 AM").departedTime, "9:43 AM");
});

test("#3: a different vessel with the same scheduled time is not matched", async () => {
  const helper = loadHelper();
  // Wenatchee leaves Seattle at a scheduled 2:05 PM; this route's 2:05 PM is Puyallup's
  const sailings = await fetchAt(helper, at(14, 20), {
    sailings: DAY,
    vessels: [{ id: 37, atDock: false, from: 7, scheduled: at(14, 5), left: at(14, 7) }]
  });
  const r = row(sailings, "2:05 PM");
  assert.strictEqual(r.hasDeparted, true, "departed by estimate (no real data for Puyallup)");
  assert.strictEqual(r.departedTime, "2:05 PM", "must not use Wenatchee's 2:07 PM");
});

test("#11: a late boat still at the dock stays upcoming", async () => {
  const helper = loadHelper();
  // 2:05 PM sailing, now 2:12 PM, Puyallup still docked at Bainbridge waiting to run it
  const sailings = await fetchAt(helper, at(14, 12), {
    sailings: DAY,
    vessels: [{ id: 25, atDock: true, scheduled: at(14, 5) }]
  });
  const r = row(sailings, "2:05 PM");
  assert.strictEqual(r.hasDeparted, false);
  assert.ok(sailings.indexOf(r) >= sailings.findIndex(s => !s.hasDeparted), "in the upcoming section");
});

test("#10: a departed sailing keeps the last space count seen", async () => {
  const helper = loadHelper();
  await fetchAt(helper, at(9, 38), {
    sailings: DAY,
    vessels: [{ id: 25, atDock: true, scheduled: at(9, 40) }],
    space: [{ at: at(9, 40), count: 75 }, { at: at(10, 25), count: 190 }]
  });
  // The space feed has dropped 9:40; the boat is underway
  const sailings = await fetchAt(helper, at(9, 50), {
    sailings: DAY,
    vessels: [{ id: 25, atDock: false, scheduled: at(9, 40), left: at(9, 42) }],
    space: [{ at: at(10, 25), count: 180 }]
  });
  const r = row(sailings, "9:40 AM");
  assert.strictEqual(r.hasDeparted, true);
  assert.strictEqual(r.driveUpSpaceCount, 75);
  assert.strictEqual(r.maxSpaceCount, 197);
  assert.strictEqual(row(sailings, "10:25 AM").driveUpSpaceCount, 180, "upcoming uses the live count");
});

test("#11: shows every departure in the last 30 minutes, else only the most recent", async () => {
  const twoRecent = [{ at: at(10, 0), vessel: 25 }, { at: at(10, 20), vessel: 37 }, { at: at(11, 0), vessel: 25 }];
  let sailings = await fetchAt(loadHelper(), at(10, 25), { sailings: twoRecent });
  assert.deepStrictEqual(sailings.filter(s => s.hasDeparted).map(s => s.departingTime), ["10:00 AM", "10:20 AM"]);

  // 9:40 left 60 min ago, 10:25 left 15 min ago: only 10:25 is in the window
  sailings = await fetchAt(loadHelper(), at(10, 40), { sailings: DAY });
  assert.deepStrictEqual(sailings.filter(s => s.hasDeparted).map(s => s.departingTime), ["10:25 AM"]);

  // Nothing in the last 30 minutes: still show the single most recent departure
  sailings = await fetchAt(loadHelper(), at(11, 10), { sailings: DAY });
  assert.deepStrictEqual(sailings.filter(s => s.hasDeparted).map(s => s.departingTime), ["10:25 AM"]);
});

test("#11: departed rows don't count toward maxSailings", async () => {
  const sailings = await fetchAt(loadHelper(), at(10, 40), { sailings: DAY }, 2);
  assert.strictEqual(sailings.filter(s => s.hasDeparted).length, 1);
  assert.strictEqual(sailings.filter(s => !s.hasDeparted).length, 2);
  assert.ok(sailings[0].hasDeparted, "departed rows come first");
});

test("#11: cancelled sailings show, are remembered, and count as the most recent departure", async () => {
  const helper = loadHelper();
  let sailings = await fetchAt(helper, at(11, 0), {
    sailings: DAY,
    space: [{ at: at(11, 30), cancelled: true, count: 197 }, { at: at(12, 20), count: 150 }]
  });
  let r = row(sailings, "11:30 AM");
  assert.strictEqual(r.isCancelled, true);
  assert.strictEqual(r.hasDeparted, false, "upcoming until its scheduled time");
  assert.strictEqual(r.driveUpSpaceCount, null, "spaces N/A");

  // The space feed has dropped 11:30; the cancellation is remembered and it is now the latest "departure"
  sailings = await fetchAt(helper, at(11, 40), { sailings: DAY, space: [{ at: at(12, 20), count: 140 }] });
  r = row(sailings, "11:30 AM");
  assert.strictEqual(r.isCancelled, true);
  assert.strictEqual(r.hasDeparted, true);
  assert.deepStrictEqual(sailings.filter(s => s.hasDeparted).map(s => s.departingTime), ["11:30 AM"]);
});

test("after a restart (no real data), departures fall back to the estimate", async () => {
  const sailings = await fetchAt(loadHelper(), at(10, 40), { sailings: DAY });
  const r = row(sailings, "10:25 AM");
  assert.strictEqual(r.hasDeparted, true);
  assert.strictEqual(r.departedTime, "10:25 AM");
  assert.strictEqual(r.driveUpSpaceCount, null);
});
