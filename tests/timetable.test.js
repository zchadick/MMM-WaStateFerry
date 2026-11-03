// Cancellations from the season's timetable (sailings/timetable.js): sailings WSF removed from today's
// schedule show as cancelled. Stand-in timetables shaped like WSF's `sailings` response; no network or DB.

const { test, mock } = require("node:test");
const assert = require("node:assert");
const { createTimetable, expectedSailings, seattleMs, RETRY_MS } = require("../sailings/timetable");
const { createDelayTracker } = require("../sailings/delays");
const { buildSailings } = require("../sailings/buildSailings");

const MIN = 60 * 1000;
// Saturday 2026-10-31 (PDT, UTC−7) and Sunday 2026-11-01 (DST ends at 2 AM: PST, UTC−8, from then on)
const sat = (h, m) => Date.UTC(2026, 9, 31, h + 7, m);
const wsdot = ms => `/Date(${ms}-0700)/`;

// Timetable times are times of day on 1900-01-01, in Pacific standard time
const tod = (h, m) => `/Date(${Date.UTC(1900, 0, 1, h + 8, m)}-0800)/`;
const range = (from, thru) => ({ DateFrom: wsdot(Date.UTC(2026, ...from, 7)), DateThru: wsdot(Date.UTC(2026, ...thru, 7)) });
const FALL = range([8, 20], [11, 26]);
const group = (dayOps, times, { terminal = 3, ranges = [FALL], vessel = 37 } = {}) => ({
  DayOpDescription: dayOps, ActiveDateRanges: ranges,
  Journs: times.map(([h, m]) => ({ VesselID: vessel, VesselName: vessel === 37 ? "Wenatchee" : "Puyallup",
    TerminalTimes: [{ TerminalID: terminal, Time: tod(h, m), DepArrIndicator: 1, IsNA: false }] }))
});

const WEEKDAY = [[4, 45], [5, 20], [6, 20], [7, 5], [16, 45], [22, 0]];
const WEEKEND = [[5, 20], [7, 5], [7, 55], [16, 40], [18, 30], [0, 0], [1, 25]]; // the last two are after midnight
const GROUPS = [group("Monday through Friday", WEEKDAY), group("Saturday, Sunday and Holidays", WEEKEND),
  group("Monday through Friday", [[5, 30]], { terminal: 7 })];
const satWeekend = () => [sat(5, 20), sat(7, 5), sat(7, 55), sat(16, 40), sat(18, 30), sat(24, 0), sat(25, 25)];

// ---- Which timetable applies, and its times ----

test("picks the timetable closest to today's schedule (weekend on a Saturday)", () => {
  const scheduled = satWeekend().filter(ms => ms !== sat(16, 40)); // one removed
  const expected = expectedSailings(GROUPS, 3, "2026-10-31", scheduled);
  assert.deepStrictEqual(expected.map(s => s.scheduledMs), satWeekend());
  assert.strictEqual(expected[0].vesselName, "Wenatchee");
});

test("a holiday on a weekday uses whichever timetable matches (no holiday list needed)", () => {
  // Thursday 2026-11-26 (PST) running the weekend timetable
  const thu = (h, m) => Date.UTC(2026, 10, 26, h + 8, m);
  const scheduled = [thu(5, 20), thu(7, 5), thu(7, 55), thu(16, 40), thu(18, 30), thu(24, 0), thu(25, 25)];
  assert.deepStrictEqual(expectedSailings(GROUPS, 3, "2026-11-26", scheduled).map(s => s.scheduledMs), scheduled);
});

test("after-midnight sailings belong to the service day, across the end of daylight time", () => {
  // Sunday 2026-11-01: 5:20 AM is PST; Monday's 12:00 AM and 1:25 AM too
  const expected = expectedSailings(GROUPS, 3, "2026-11-01",
    [Date.UTC(2026, 10, 1, 13, 20), Date.UTC(2026, 10, 1, 15, 55)]); // 5:20 and 7:55 AM: the weekend timetable
  const times = expected.map(s => s.scheduledMs);
  assert.strictEqual(times[0], Date.UTC(2026, 10, 1, 13, 20), "5:20 AM PST");
  assert.strictEqual(times.at(-2), Date.UTC(2026, 10, 2, 8, 0), "12:00 AM Monday");
  assert.strictEqual(times.at(-1), Date.UTC(2026, 10, 2, 9, 25), "1:25 AM Monday");
  assert.strictEqual(seattleMs("2026-10-31", 5 * 60 + 20), sat(5, 20), "5:20 AM PDT the day before");
});

test("between variants that both contain today's schedule (e.g. 2-boat and 3-boat), the one without extras wins", () => {
  const scheduled = satWeekend();
  const threeBoat = group("Saturday, Sunday and Holidays", [...WEEKEND, [9, 0], [11, 0]]);
  const expected = expectedSailings([threeBoat, ...GROUPS], 3, "2026-10-31", scheduled);
  assert.deepStrictEqual(expected.map(s => s.scheduledMs), scheduled, "no extra sailings called cancelled");
});

test("a 1:25 AM sailing in the repeated hour when daylight time ends matches WSF's timestamp", () => {
  // Saturday 2026-10-31's 1:25 AM sailing is on Sunday morning, which has 1:25 AM twice; WSF uses standard time
  const scheduled = satWeekend().map(ms => ms === sat(25, 25) ? Date.UTC(2026, 10, 1, 9, 25) : ms);
  assert.deepStrictEqual(expectedSailings(GROUPS, 3, "2026-10-31", scheduled).map(s => s.scheduledMs), scheduled,
    "not reported as removed");
});

test("no timetable is used when none is active for the date, or today runs a special schedule", () => {
  assert.strictEqual(expectedSailings(GROUPS, 3, "2026-12-30", [Date.UTC(2026, 11, 30, 13, 20)]), null, "season over");
  // Only 1 of 3 scheduled sailings is in any timetable: a special schedule, so nothing is called removed
  assert.strictEqual(expectedSailings(GROUPS, 3, "2026-10-31", [sat(5, 20), sat(9, 0), sat(11, 0)]), null);
});

// ---- Removed sailings in the sailing list (buildSailings) ----

const schedule = times => ({ TerminalCombos: [{ DepartingTerminalName: "Bainbridge Island", ArrivingTerminalName: "Seattle",
  Times: times.map(ms => ({ DepartingTime: wsdot(ms), VesselID: 37, VesselName: "Wenatchee" })) }] });
const build = (state, now, times, vessels = []) => buildSailings({
  scheduleData: schedule(times), vesselsData: vessels, spaceData: null, departingTerminalID: 3, arrivingTerminalID: 7,
  maxSailings: 10, now, delays: state.delays, sailingMemory: state.memory,
  expected: expectedSailings(GROUPS, 3, "2026-10-31", times)
}).sailings;
const newState = () => ({ delays: createDelayTracker(), memory: new Map() });
const row = (rows, ms) => rows.find(r => r.departingTimestamp === ms);

test("a sailing removed from today's schedule shows as cancelled right away, and normal again if restored", () => {
  const state = newState();
  // 2:26 PM: WSF removes the 4:40 and 6:30 PM sailings
  let rows = build(state, sat(14, 26), satWeekend().filter(ms => ms !== sat(16, 40) && ms !== sat(18, 30)));
  assert.strictEqual(row(rows, sat(16, 40)).isCancelled, true);
  assert.strictEqual(row(rows, sat(18, 30)).isCancelled, true);
  assert.strictEqual(row(rows, sat(16, 40)).hasDeparted, false, "still upcoming, in time order");
  assert.deepStrictEqual(rows.filter(r => !r.hasDeparted).map(r => r.departingTimestamp), satWeekend().slice(3));
  // 2:56 PM: restored
  rows = build(state, sat(14, 56), satWeekend());
  assert.strictEqual(row(rows, sat(16, 40)).isCancelled, false);
  assert.strictEqual(row(rows, sat(18, 30)).isCancelled, false);
});

test("a removed sailing that a boat still ran shows as departed, with that boat and its real time", () => {
  const state = newState();
  // The 4:40 PM was removed, but the Puyallup (not the timetable's Wenatchee) left on it at 4:52
  const puyallup = { VesselID: 25, VesselName: "Puyallup", DepartingTerminalID: 3, AtDock: false,
    ScheduledDeparture: wsdot(sat(16, 40)), LeftDock: wsdot(sat(16, 52)) };
  const rows = build(state, sat(17, 0), satWeekend().filter(ms => ms !== sat(16, 40)), [puyallup]);
  const r = row(rows, sat(16, 40));
  assert.strictEqual(r.isCancelled, false);
  assert.strictEqual(r.hasDeparted, true);
  assert.strictEqual(r.departedTimestamp, sat(16, 52));
  assert.strictEqual(r.vesselName, "Puyallup");
});

test("a removed sailing is not matched to a boat leaving the other terminal at the same time", () => {
  const state = newState();
  const fromSeattle = { VesselID: 25, VesselName: "Puyallup", DepartingTerminalID: 7, AtDock: false,
    ScheduledDeparture: wsdot(sat(16, 40)), LeftDock: wsdot(sat(16, 41)) };
  const rows = build(state, sat(17, 0), satWeekend().filter(ms => ms !== sat(16, 40)), [fromSeattle]);
  assert.strictEqual(row(rows, sat(16, 40)).isCancelled, true);
});

test("a sailing missing from the schedule all day (removed before the day began) shows as cancelled", () => {
  const rows = build(newState(), sat(8, 0), satWeekend().filter(ms => ms !== sat(7, 55)));
  const r = row(rows, sat(7, 55));
  assert.strictEqual(r.isCancelled, true);
  assert.strictEqual(r.hasDeparted, true, "listed as the most recent departure once its time has passed");
});

// ---- Loading (once per service day) and DB logging ----

const SAILINGS_BODY = JSON.stringify(GROUPS);
function stubApi({ abbrev = "sea-bi", fail = false } = {}) {
  const calls = [];
  global.fetch = async url => {
    const name = url.split("/rest/")[1].split("?")[0];
    calls.push(name);
    if (fail) return new Response("nope", { status: 500 });
    if (name === "activeseasons") return Response.json([{ ScheduleID: 198, ScheduleStart: wsdot(Date.UTC(2026, 8, 20, 7)), ScheduleEnd: wsdot(Date.UTC(2026, 11, 26, 8)) }]);
    if (name.startsWith("routes/")) return Response.json([{ RouteID: 5, RouteAbbrev: abbrev }]);
    if (name.startsWith("schedroutes/")) return Response.json([{ RouteID: 5, SchedRouteID: 2486, ContingencyOnly: false }]);
    if (name === "sailings/2486") return new Response(SAILINGS_BODY, { status: 200 });
    return new Response("[]", { status: 404 });
  };
  return calls;
}
const logs = () => {
  const log = { info: [], warn: [] };
  return { log, Log: { info: m => log.info.push(m), warn: m => log.warn.push(m), debug() {}, error() {} } };
};

test("the timetable loads once per service day, and its response is logged once", async () => {
  const calls = stubApi();
  const { Log } = logs();
  const timetable = createTimetable({ Log });
  const logged = [];
  const ask = scheduledMs => timetable.expectedFor({ apiKey: "k", departingTerminalID: 3, arrivingTerminalID: 7, scheduledMs,
    onResponse: (status, body) => logged.push({ status, body }) });

  const first = await ask(satWeekend());
  await ask(satWeekend());
  assert.strictEqual(first.length, 7);
  assert.deepStrictEqual(calls, ["activeseasons", "routes/2026-10-31/3/7", "schedroutes/198", "sailings/2486"]);
  assert.deepStrictEqual(logged, [{ status: 200, body: SAILINGS_BODY }]);

  // Next service day: loads again
  await ask([Date.UTC(2026, 10, 1, 13, 20)]);
  assert.strictEqual(calls.filter(c => c === "sailings/2486").length, 2);
  assert.strictEqual(logged.length, 2);
});

test("multi-stop routes don't use the timetable (it doesn't say where each departure goes)", async () => {
  const calls = stubApi({ abbrev: "f-v-s" });
  const { log, Log } = logs();
  const timetable = createTimetable({ Log });
  const ask = () => timetable.expectedFor({ apiKey: "k", departingTerminalID: 22, arrivingTerminalID: 13, scheduledMs: satWeekend() });
  assert.strictEqual(await ask(), null);
  assert.strictEqual(await ask(), null);
  assert.strictEqual(calls.length, 2, "not retried the same day");
  assert.match(log.info[0], /multi-stop/);
});

test("a failed load is retried after an hour, not on every fetch", async () => {
  mock.timers.enable({ apis: ["Date"], now: sat(10, 0) });
  try {
    const calls = stubApi({ fail: true });
    const { log, Log } = logs();
    const timetable = createTimetable({ Log });
    const ask = () => timetable.expectedFor({ apiKey: "k", departingTerminalID: 3, arrivingTerminalID: 7, scheduledMs: satWeekend() });
    assert.strictEqual(await ask(), null);
    mock.timers.tick(5 * MIN);
    await ask();
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(log.warn.length, 1);
    mock.timers.tick(RETRY_MS);
    stubApi();
    assert.strictEqual((await ask()).length, 7, "loaded on the retry");
  } finally {
    mock.timers.reset();
  }
});
