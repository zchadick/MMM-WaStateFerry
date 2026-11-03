// Delay tracking (sailings/delays.js) and the end-of-day flush, through buildSailings directly.
// No network, no DB, no MagicMirror stand-ins needed: buildSailings is a pure step.

const { test } = require("node:test");
const assert = require("node:assert");
const { createDelayTracker } = require("../sailings/delays");
const { buildSailings } = require("../sailings/buildSailings");

const MIN = 60 * 1000;
// Pacific daylight time (UTC-7) on 2026-10-23 and 2026-10-24
const day1 = (h, m) => Date.UTC(2026, 9, 23, h + 7, m);
const day2 = (h, m) => Date.UTC(2026, 9, 24, h + 7, m);
const wsdot = ms => `/Date(${ms}-0700)/`;

const schedule = sailings => ({ TerminalCombos: [{ DepartingTerminalName: "Bainbridge Island", ArrivingTerminalName: "Seattle",
  Times: sailings.map(s => ({ DepartingTime: wsdot(s.at), VesselID: s.vessel, VesselName: s.vessel === 25 ? "Puyallup" : "Wenatchee" })) }] });
const underway = (id, scheduled, left) => ({ VesselID: id, AtDock: false, ScheduledDeparture: wsdot(scheduled), LeftDock: wsdot(left) });
const atDock = id => ({ VesselID: id, AtDock: true });

// One fetch: returns the sailing rows
const fetchAt = (state, now, sailings, vessels) => buildSailings({
  scheduleData: schedule(sailings), vesselsData: vessels, spaceData: null,
  departingTerminalID: 3, arrivingTerminalID: 7, maxSailings: 5, now, delays: state.delays, sailingMemory: state.memory
}).sailings;
const newState = () => ({ delays: createDelayTracker(), memory: new Map() });

const EVENING = [{ at: day1(21, 0), vessel: 25 }, { at: day1(22, 0), vessel: 37 }, { at: day1(23, 30), vessel: 25 }];
const MORNING = [{ at: day2(5, 20), vessel: 25 }, { at: day2(6, 20), vessel: 37 }, { at: day2(7, 5), vessel: 25 }];

test("a vessel's delay is added to its later sailings the same day", () => {
  const state = newState();
  const rows = fetchAt(state, day1(21, 20), EVENING, [underway(25, day1(21, 0), day1(21, 12))]);
  const later = rows.find(r => r.departingTimestamp === day1(23, 30));
  assert.strictEqual(later.delayMinutes, 12);
  assert.strictEqual(later.estDeptTimestamp, day1(23, 42));
});

test("last night's delay does not reach the first sailings of the morning (new service day)", () => {
  const state = newState();
  fetchAt(state, day1(21, 20), EVENING, [underway(25, day1(21, 0), day1(21, 12))]);
  // Next morning: the schedule has moved to a new day and the boats are still docked
  const rows = fetchAt(state, day2(5, 0), MORNING, [atDock(25), atDock(37)]);
  const first = rows.find(r => r.departingTimestamp === day2(5, 20));
  assert.strictEqual(first.delayMinutes, 0);
  assert.strictEqual(first.estDeptTimestamp, day2(5, 20));
});

test("delays are flushed once the day's last sailing has departed", () => {
  const state = newState();
  // 11:30 PM sailing left 12 min late; after it departs, every sailing of the day is gone
  fetchAt(state, day1(23, 50), EVENING, [underway(25, day1(23, 30), day1(23, 42))]);
  assert.strictEqual(state.delays.delayMs(25), 0, "flushed at the end of the day");
});

test("a crossing that left before the flush isn't re-recorded while still underway", () => {
  const state = newState();
  fetchAt(state, day1(23, 50), EVENING, [underway(25, day1(23, 30), day1(23, 42))]);
  // Five minutes later the same boat is still crossing with the same LeftDock
  fetchAt(state, day1(23, 55), EVENING, [underway(25, day1(23, 30), day1(23, 42))]);
  assert.strictEqual(state.delays.delayMs(25), 0);
});

test("the next day's first crossing records a fresh delay", () => {
  const state = newState();
  fetchAt(state, day1(23, 50), EVENING, [underway(25, day1(23, 30), day1(23, 42))]);
  fetchAt(state, day2(5, 0), MORNING, [atDock(25), atDock(37)]);
  const rows = fetchAt(state, day2(5, 30), MORNING, [underway(25, day2(5, 20), day2(5, 24))]);
  assert.strictEqual(state.delays.delayMs(25), 4 * MIN);
  assert.strictEqual(rows.find(r => r.departingTimestamp === day2(7, 5)).delayMinutes, 4);
});

test("rows carry UTC timestamps, not formatted text", () => {
  const rows = fetchAt(newState(), day1(20, 0), EVENING, []);
  for (const row of rows) {
    assert.ok(Number.isFinite(row.departingTimestamp) && Number.isFinite(row.estDeptTimestamp) && Number.isFinite(row.departedTimestamp));
    assert.strictEqual(row.departingTime, undefined);
  }
});

test("a crossing already underway on the first fetch of a new day is recorded", () => {
  const state = newState();
  fetchAt(state, day1(21, 20), EVENING, [underway(25, day1(21, 0), day1(21, 12))]);
  // MagicMirror's first fetch of the morning happens while the 5:20 boat is already crossing (left 5:24)
  const rows = fetchAt(state, day2(5, 30), MORNING, [underway(25, day2(5, 20), day2(5, 24))]);
  assert.strictEqual(state.delays.delayMs(25), 4 * MIN);
  assert.strictEqual(rows.find(r => r.departingTimestamp === day2(7, 5)).delayMinutes, 4);
});

test("a crossing from last night still underway when the new day's schedule arrives is ignored", () => {
  const state = newState();
  fetchAt(state, day1(23, 50), EVENING, [underway(25, day1(23, 30), day1(23, 42))]);
  // Just after midnight the schedule has moved to the new day, but the 11:30 PM boat is still crossing
  const rows = fetchAt(state, day2(0, 5), MORNING, [underway(25, day1(23, 30), day1(23, 42))]);
  assert.strictEqual(rows.find(r => r.departingTimestamp === day2(5, 20)).delayMinutes, 0);
});
