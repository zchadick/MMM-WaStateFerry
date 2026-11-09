// Map view phase 2: vessel/terminal marker data, reference data, helper messages, and the page's markers.
// Stand-in API data and a mock clock; no network or DB.

const { test, mock } = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");
const path = require("node:path");
const { buildVesselPositions } = require("../map/vesselPositions");
const { createReferenceData, REFRESH_MS } = require("../map/referenceData");

// ---- Marker data (map/vesselPositions.js) ----

const vessel = (overrides = {}) => ({
  VesselID: 25, VesselName: "Puyallup", InService: true, AtDock: false, Latitude: 47.61, Longitude: -122.43,
  Heading: 100, ArrivingTerminalID: 7, ...overrides
});
const reference = {
  abbrevById: { 25: "PUY", 37: "WEN", 15: "ISS" },
  terminals: [
    { id: 3, name: "Bainbridge Island", lat: 47.622339, lon: -122.509617 },
    { id: 7, name: "Seattle", lat: 47.602501, lon: -122.340472 },
    { id: 12, name: "Kingston", lat: 47.796, lon: -122.496 }
  ]
};
const build = vessels => buildVesselPositions({
  vessels, routeVesselIDs: new Set([25, 37]), departingTerminalID: 3, arrivingTerminalID: 7, reference
});

test("vessel states: to departing, to arriving, docked, and other", () => {
  const { vessels } = build([
    vessel({ VesselID: 25, ArrivingTerminalID: 7 }),
    vessel({ VesselID: 37, VesselName: "Wenatchee", ArrivingTerminalID: 3 }),
    vessel({ VesselID: 37, VesselName: "Wenatchee", AtDock: true, ArrivingTerminalID: null }),
    vessel({ VesselID: 15, VesselName: "Issaquah", ArrivingTerminalID: 4 }),
    vessel({ VesselID: 25, ArrivingTerminalID: 4 }) // a route boat running some other trip
  ]);
  assert.deepStrictEqual(vessels.map(v => v.state), ["toArriving", "toDeparting", "docked", "other", "other"]);
});

test("out-of-service vessels and vessels without a position are not shown", () => {
  const { vessels } = build([
    vessel(), vessel({ VesselID: 37, InService: false }), vessel({ VesselID: 15, Latitude: null })
  ]);
  assert.deepStrictEqual(vessels.map(v => v.id), [25]);
});

test("vessel labels are abbreviations, falling back to the name", () => {
  const { vessels } = build([vessel(), vessel({ VesselID: 99, VesselName: "Newboat" })]);
  assert.deepStrictEqual(vessels.map(v => v.label), ["PUY", "Newboat"]);
});

test("terminals are marked departing, arriving, or other, with full names", () => {
  const { terminals } = build([]);
  assert.deepStrictEqual(terminals.map(t => [t.label, t.kind]),
    [["Bainbridge Island", "departing"], ["Seattle", "arriving"], ["Kingston", "other"]]);
});

// ---- Reference data (map/referenceData.js) ----

const API_BODIES = {
  vesselbasics: [{ VesselID: 25, VesselAbbrev: "PUY" }, { VesselID: 37, VesselAbbrev: "WEN" }],
  terminallocations: [{ TerminalID: 7, TerminalName: "Seattle ", Latitude: 47.6025, Longitude: -122.3405 }]
};
const stubFetch = (bodies, calls) => async url => {
  calls.push(url);
  const name = Object.keys(bodies).find(n => url.includes(n));
  const body = bodies[name];
  return body instanceof Error ? new Response("{}", { status: 500 }) : new Response(JSON.stringify(body), { status: 200 });
};

test("reference data: loads abbreviations and terminals (names trimmed), and notifies", async () => {
  const calls = [];
  global.fetch = stubFetch(API_BODIES, calls);
  let updates = 0;
  const ref = createReferenceData({ Log: { warn() {} }, onUpdate: () => updates++ });
  await ref.start("test-key");
  ref.stop();
  assert.deepStrictEqual(ref.get().abbrevById, { 25: "PUY", 37: "WEN" });
  assert.deepStrictEqual(ref.get().terminals, [{ id: 7, name: "Seattle", lat: 47.6025, lon: -122.3405 }]);
  assert.strictEqual(updates, 1);
  assert.strictEqual(calls.length, 2);
});

test("reference data: a failed refresh keeps the previous data and logs a warning", async () => {
  const warnings = [];
  global.fetch = stubFetch(API_BODIES, []);
  const ref = createReferenceData({ Log: { warn: w => warnings.push(w) } });
  await ref.start("test-key");
  global.fetch = stubFetch({ vesselbasics: new Error("down"), terminallocations: new Error("down") }, []);
  await ref.refresh();
  ref.stop();
  assert.deepStrictEqual(ref.get().abbrevById, { 25: "PUY", 37: "WEN" });
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /not updated: HTTP 500/);
});

test("reference data: starts once, then refreshes daily", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const calls = [];
    global.fetch = stubFetch(API_BODIES, calls);
    const ref = createReferenceData({ Log: { warn() {} } });
    await ref.start("test-key");
    await ref.start("test-key"); // ignored
    assert.strictEqual(calls.length, 2);
    mock.timers.tick(REFRESH_MS);
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(calls.length, 4);
    ref.stop();
  } finally {
    mock.timers.reset();
  }
});

// ---- Helper: MAP_POSITIONS ----

const HELPER_PATH = path.resolve(__dirname, "../node_helper.js");
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "node_helper") return { create: def => def };
  if (request === "logger") return { log() {}, info() {}, warn() {}, error() {}, debug() {} };
  return originalLoad.call(this, request, ...rest);
};
function loadHelper() {
  delete require.cache[HELPER_PATH];
  const helper = require(HELPER_PATH);
  helper.sent = [];
  helper.sendSocketNotification = (notification, payload) => helper.sent.push({ notification, payload });
  helper.start();
  helper.mapBuilder = { getOrBuildMap: async () => ({ file: "0123456789abcdef.svg", view: { west: 0, north: 0, east: 1, south: -1, k: 1, scale: 1, width: 1, height: 1 } }) };
  return helper;
}
const mapSettings = {
  type: "map", identifier: "module_9_MMM-WaStateFerry",
  mapUpperLeft: { lat: 47.73803, lon: -122.61430 }, mapLowerRight: { lat: 47.57325, lon: -122.29558 }, mapWidth: 400, mapDetail: "auto",
  mapLayers: { depth: true, contours: true, coastline: true },
  mapColors: { land: "#3a3a3a", water: "#1f3a52", depth: ["#1a3247", "#162b3d", "#122433", "#0e1d2a", "#0a1620", "#060f17"], contour: "rgba(0,0,0,0.25)", coastline: "#626e78" },
  mapLineWidths: { coastline: 1, contour: 0.5 }, mapEdgeFade: 0.06, mapMarkerSize: 14, mapLabelSize: 11,
  mapMarkerColors: { otherBoat: "#3d3d3d", dockedBoat: "#000000", dockedBoatLabel: "#9a9a9a", toDeparting: "#7fa7c9", toArriving: "#d8c8a0", departingTerminal: "#7fa7c9", arrivingTerminal: "#d8c8a0", otherTerminal: "#666" },
  mapIcons: { underway: "fa-location-arrow", docked: "fa-anchor", terminal: "fa-square" }
};
const names = helper => helper.sent.map(m => m.notification);

test("helper: no MAP_POSITIONS until a map is shown", () => {
  const helper = loadHelper();
  helper.recordVesselFeed([vessel()], new Set([25]), 3, 7);
  assert.deepStrictEqual(names(helper), []);
});

test("helper: a map gets MAP_READY with its view, then the latest positions", async () => {
  const helper = loadHelper();
  helper.recordVesselFeed([vessel()], new Set([25]), 3, 7);
  await helper.registerMap(mapSettings);
  assert.deepStrictEqual(names(helper), ["MAP_READY", "MAP_POSITIONS"]);
  assert.ok(helper.sent[0].payload.view, "MAP_READY carries the view");
  assert.strictEqual(helper.sent[1].payload.vessels[0].state, "toArriving");
});

test("helper: each fetch sends positions; reference data arriving later re-sends them", async () => {
  const helper = loadHelper();
  await helper.registerMap(mapSettings);
  helper.sent.length = 0;
  helper.recordVesselFeed([vessel()], new Set([25]), 3, 7);
  assert.deepStrictEqual(names(helper), ["MAP_POSITIONS"]);
  assert.strictEqual(helper.sent[0].payload.vessels[0].label, "Puyallup", "no abbreviations yet");

  global.fetch = stubFetch(API_BODIES, []);
  await helper.getReference().start("test-key");
  helper.getReference().stop();
  const last = helper.sent[helper.sent.length - 1];
  assert.strictEqual(last.notification, "MAP_POSITIONS");
  assert.strictEqual(last.payload.vessels[0].label, "PUY");
  assert.strictEqual(last.payload.terminals[0].label, "Seattle");
});

// ---- Page: marker HTML ----

let definition = null;
global.Module = { register: (name, def) => { definition = def; } };
require(path.resolve(__dirname, "../MMM-WaStateFerry.js"));
const mapPage = (configOverrides = {}) => {
  const m = Object.assign(Object.create(definition), { config: { ...definition.defaults, type: "map", ...configOverrides } });
  m.identifier = "module_9_MMM-WaStateFerry";
  // A 100 x 100 px view covering lon -122.5…-122.4 (k = 1 for easy numbers) and lat 47.7…47.6
  m.map = { status: "ready", view: { west: -122.5, north: 47.7, east: -122.4, south: 47.6, k: 1, scale: 1000, width: 100, height: 100 } };
  return m;
};

test("page: markers are placed by projection, with arrows rotated to the heading", () => {
  const m = mapPage();
  m.positions = { terminals: [], vessels: [{ id: 25, label: "PUY", lat: 47.65, lon: -122.45, heading: 100, state: "toArriving" }] };
  const html = m.markersHtml();
  assert.match(html, /left: 50\.0px; top: 50\.0px;/);
  assert.match(html, /fa-location-arrow" style="transform: rotate\(55deg\);"/);
  assert.match(html, /color: #d8c8a0/);
  assert.match(html, /map-label below[^>]*>PUY</);
});

test("page: docked boats use the docked icon without rotation; colors follow the state", () => {
  const m = mapPage();
  m.positions = { terminals: [], vessels: [
    { id: 37, label: "WEN", lat: 47.65, lon: -122.45, heading: 300, state: "docked" },
    { id: 15, label: "ISS", lat: 47.65, lon: -122.45, heading: 10, state: "other" },
    { id: 25, label: "PUY", lat: 47.65, lon: -122.45, heading: 10, state: "toDeparting" }
  ] };
  const html = m.markersHtml();
  assert.match(html, /color: #000000;[^>]*><i class="fa-solid fa-anchor"><\/i>/, "dark anchor by default");
  assert.match(html, /map-label below" style="font-size: 11px; color: #9a9a9a;">WEN</, "its label stays light");
  assert.match(html, /color: #3d3d3d/);
  assert.match(html, /color: #7fa7c9/);
  assert.match(html, /map-label below" style="font-size: 11px;">PUY</, "underway labels take the icon's color");
});

test("page: the docked colors can be set separately for the icon and the label", () => {
  const m = mapPage({ mapMarkerColors: { dockedBoat: "#222", dockedBoatLabel: "#ccc" } });
  m.positions = { terminals: [], vessels: [{ id: 37, label: "WEN", lat: 47.65, lon: -122.45, heading: 300, state: "docked" }] };
  const html = m.markersHtml();
  assert.match(html, /color: #222;[^>]*><i class="fa-solid fa-anchor">/);
  assert.match(html, /color: #ccc;">WEN</);
});

test("page: terminals show a square with the name above; names are escaped", () => {
  const m = mapPage();
  m.positions = { vessels: [], terminals: [
    { id: 7, label: "Seattle <Pier 52>", lat: 47.65, lon: -122.45, kind: "arriving" },
    { id: 12, label: "Kingston", lat: 47.65, lon: -122.42, kind: "other" }
  ] };
  const html = m.markersHtml();
  assert.match(html, /fa-square/);
  assert.match(html, /map-label above[^>]*>Seattle &lt;Pier 52&gt;</);
  assert.match(html, /color: #666/);
});

test("page: markers outside the map are skipped; nothing before the map and positions are ready", () => {
  const m = mapPage();
  m.positions = { terminals: [], vessels: [{ id: 25, label: "PUY", lat: 47.9, lon: -122.45, heading: 0, state: "other" }] };
  assert.strictEqual(m.markersHtml(), "");
  const loading = mapPage();
  loading.map = { status: "loading" };
  loading.positions = { terminals: [], vessels: [] };
  assert.strictEqual(loading.markersHtml(), "");
});

test("page: sizes and partial color/icon settings are applied", () => {
  const m = mapPage({ mapMarkerSize: 22, mapLabelSize: 15, mapMarkerColors: { toArriving: "#ff0000" }, mapIcons: { underway: "fa-ship" } });
  m.positions = { terminals: [], vessels: [{ id: 25, label: "PUY", lat: 47.65, lon: -122.45, heading: 45, state: "toArriving" }] };
  const html = m.markersHtml();
  assert.match(html, /color: #ff0000; font-size: 22px;/);
  assert.match(html, /fa-ship" style="transform: rotate\(0deg\);"/);
  assert.match(html, /font-size: 15px;/);
});

test("page: MAP_POSITIONS updates only the marker overlay", () => {
  const m = mapPage();
  const overlay = { innerHTML: "" };
  global.document = { querySelector: selector => (selector.includes(".MMM-WaStateFerry-map-markers") ? overlay : null) };
  let domUpdates = 0;
  m.updateDom = () => domUpdates++;
  m.socketNotificationReceived("MAP_POSITIONS", { terminals: [], vessels: [{ id: 25, label: "PUY", lat: 47.65, lon: -122.45, heading: 0, state: "toArriving" }] });
  assert.match(overlay.innerHTML, /PUY/);
  assert.strictEqual(domUpdates, 0, "the map is not re-rendered");
  delete global.document;
});
