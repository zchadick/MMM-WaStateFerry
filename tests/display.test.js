// Display rule tests (delay colors, space colors, bottom fade). Run from the module directory: node --test
// Loads MMM-WaStateFerry.js with a stand-in for MagicMirror's global Module.register.

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

// Capture the module definition instead of registering it with MagicMirror
let definition = null;
global.Module = { register: (name, def) => { definition = def; } };
require(path.resolve(__dirname, "../MMM-WaStateFerry.js"));

// Methods run with the module's default config, as they would in MagicMirror
// (MagicMirror merges top-level defaults; start() then merges each group's defaults)
const moduleWithConfig = (config = {}) => {
  const m = Object.assign(Object.create(definition), { config: { ...definition.defaults, ...config } });
  m.config = m.mergeDefaults(m.defaults, m.config);
  return m;
};

test("delay colors: none under 5, yellow 5-30, red over 30 to 60, purple over 60", () => {
  const m = moduleWithConfig();
  const cases = [
    [null, ""], [0, ""], [4, ""],
    [5, "delay-yellow"], [30, "delay-yellow"],
    [31, "delay-red"], [60, "delay-red"],
    [61, "delay-purple"], [120, "delay-purple"]
  ];
  for (const [minutes, expected] of cases) {
    assert.strictEqual(m.delayClass(minutes), expected, `delay ${minutes} min`);
  }
});

test("space colors: purple at 0%, red to 10%, yellow to 50%, none above 50%", () => {
  const m = moduleWithConfig();
  const cases = [
    [0, 200, "space-purple"],
    [1, 200, "space-red"], [20, 200, "space-red"],     // 0.5%, 10%
    [21, 200, "space-yellow"], [100, 200, "space-yellow"], // 10.5%, 50%
    [101, 200, ""], [200, 200, ""],                    // 50.5%, 100%
    [null, 200, ""],                                   // no space data (shown as N/A)
    [5, null, ""], [5, 0, ""]                          // no capacity to compare against
  ];
  for (const [count, max, expected] of cases) {
    assert.strictEqual(m.spaceClass(count, max), expected, `${count} of ${max}`);
  }
});

test("bottom fade matches the calendar/weather formula", () => {
  const m = moduleWithConfig();
  // 5 rows, fadePoint 0.25: fade starts at 1.25, so rows 0-1 are full and the rest fade
  const opacities = [0, 1, 2, 3, 4].map(i => Math.round(m.fadeOpacity(i, 5) * 100) / 100);
  assert.deepStrictEqual(opacities, [1, 1, 0.8, 0.53, 0.27]);
});

test("space colors apply only to upcoming, non-cancelled sailings", () => {
  const m = moduleWithConfig();
  m.sailings = [
    { hasDeparted: true, isCancelled: false, driveUpSpaceCount: 0, maxSpaceCount: 197 },
    { hasDeparted: false, isCancelled: true, driveUpSpaceCount: 0, maxSpaceCount: 197 },
    { hasDeparted: false, isCancelled: false, driveUpSpaceCount: 0, maxSpaceCount: 197 }
  ];
  const classes = m.getTemplateData().sailings.map(s => s.spaceClass);
  assert.deepStrictEqual(classes, ["", "", "space-purple"]);
});

test("a result for a different route shows the one-route notice, not sailings", () => {
  const m = moduleWithConfig({ departingTerminalID: 7, arrivingTerminalID: 3 });
  m.routeKey = "7-3";
  m.loaded = false;
  m.sailings = [];
  m.updateDom = () => {};
  m.socketNotificationReceived("FERRY_SCHEDULE", { routeKey: "3-7", sailings: [{ departingTime: "9:40 AM" }] });
  assert.match(m.error, /Only one ferry route is supported/);
  assert.match(m.error, /route \(7-3/);
  assert.match(m.error, /active route is 3-7/);
  assert.deepStrictEqual(m.sailings, [], "the other route's sailings are not shown");
});

test("default route is Bainbridge Island (3) to Seattle (7)", () => {
  assert.deepStrictEqual(definition.defaults.route, { departingTerminalID: 3, arrivingTerminalID: 7 });
});

test("no fade when fade is off", () => {
  const m = moduleWithConfig({ display: { fade: false } });
  assert.deepStrictEqual([0, 1, 2, 3, 4].map(i => m.fadeOpacity(i, 5)), [1, 1, 1, 1, 1]);
});

test("a map page only accepts its own map replies and shows errors", () => {
  const m = moduleWithConfig({ type: "map" });
  m.identifier = "module_9_MMM-WaStateFerry";
  m.data = { path: "modules/MMM-WaStateFerry" };
  m.file = definition.file || (name => `${m.data.path}/${name}`);
  m.map = { status: "loading" };
  m.updateDom = () => {};

  m.socketNotificationReceived("MAP_READY", { identifier: "module_10_MMM-WaStateFerry", file: "aaaaaaaaaaaaaaaa.svg", width: 1, height: 1 });
  assert.strictEqual(m.map.status, "loading", "another map's reply is ignored");
  m.socketNotificationReceived("FERRY_SCHEDULE", { routeKey: "3-7", sailings: [] });
  assert.strictEqual(m.map.status, "loading", "sailing results are not used by the map yet");

  const view = { west: -122.6143, north: 47.73803, east: -122.29558, south: 47.57325, k: 0.674, scale: 2032, width: 400, height: 307 };
  m.socketNotificationReceived("MAP_READY", { identifier: "module_9_MMM-WaStateFerry", file: "0123456789abcdef.svg", width: 400, height: 307, view });
  assert.deepStrictEqual(m.map, { status: "ready", src: "modules/MMM-WaStateFerry/map_cache/0123456789abcdef.svg", width: 400, height: 307, view });

  m.socketNotificationReceived("MAP_ERROR", { identifier: "module_9_MMM-WaStateFerry", errors: ["mapWidth must be a whole number"] });
  assert.deepStrictEqual(m.map, { status: "error", errors: ["mapWidth must be a whole number"] });
});

test("a map page merges nested defaults so partial settings keep the rest", () => {
  // MagicMirror's own merge would replace the whole map group; the module merges each level's defaults
  const m = moduleWithConfig({ type: "map", map: { colors: { land: "#222" }, layers: { contours: false }, markers: { size: 20 } } });
  m.identifier = "module_9_MMM-WaStateFerry";
  let sent = null;
  m.sendSocketNotification = (name, payload) => { sent = { name, payload }; };
  m.registerMap();
  assert.strictEqual(sent.name, "REGISTER");
  assert.strictEqual(sent.payload.type, "map");
  assert.strictEqual(sent.payload.mapColors.land, "#222");
  assert.strictEqual(sent.payload.mapColors.water, definition.defaults.map.colors.water);
  assert.deepStrictEqual(sent.payload.mapColors.depth, definition.defaults.map.colors.depth, "lists come from defaults whole");
  assert.deepStrictEqual(sent.payload.mapLayers, { depth: true, contours: false, coastline: true });
  assert.strictEqual(sent.payload.mapMarkerSize, 20);
  assert.strictEqual(sent.payload.mapLabelSize, 11, "a partial markers group keeps its other defaults");
  assert.strictEqual(sent.payload.mapWidth, 400);
});

test("map corners have no defaults (they must be set in config.js); map.width defaults to 400", () => {
  assert.strictEqual(definition.defaults.map.upperLeft, undefined);
  assert.strictEqual(definition.defaults.map.lowerRight, undefined);
  assert.strictEqual(definition.defaults.map.width, 400);
});

// ---- Grouped settings: what the page sends the helper, and old (flat) names ----

const registered = config => {
  const m = moduleWithConfig(config);
  const sent = [];
  m.sendSocketNotification = (name, payload) => sent.push({ name, payload });
  global.Log = { error() {}, log() {} };
  m.identifier = "module_9_MMM-WaStateFerry";
  m.start();
  delete global.Log;
  return { m, sent };
};

test("the sailings entry sends the grouped settings under the helper's names", () => {
  const { sent } = registered({
    apiKeys: { wsdot: "key" }, route: { departingTerminalID: 7, arrivingTerminalID: 3 }, display: { updateInterval: 60000 },
    predictionDb: { host: "h", user: "u", password: "p", database: "FERRY" }, gpio: { statusLed: 12, buttons: [24] }
  });
  assert.deepStrictEqual(sent, [{ name: "REGISTER", payload: {
    departingTerminalID: 7, arrivingTerminalID: 3, apiKey: "key", maxSailings: 5, updateInterval: 60000,
    manualRefreshCooldown: 30000,
    predictionDbUser: "u", predictionDbPass: "p", predictionDbHost: "h", predictionDbName: "FERRY",
    gpioStatusLed: 12, gpioButtons: [24]
  } }]);
});

test("without predictionDb or GPIO pins, none of their settings are sent (so both stay off)", () => {
  const { sent } = registered({ apiKeys: { wsdot: "key" } });
  const keys = Object.keys(sent[0].payload);
  assert.ok(!keys.some(k => k.startsWith("predictionDb") || k.startsWith("gpio")), keys.join());
  // A partial predictionDb group forwards only what's there (DB logging needs all four)
  const partial = registered({ predictionDb: { host: "h" } }).sent[0].payload;
  assert.strictEqual(partial.predictionDbHost, "h");
  assert.ok(!("predictionDbUser" in partial));
});

test("old (flat) setting names stop the entry with a message saying where each moved", () => {
  const { m, sent } = registered({ apiKey: "key", predictionDbPass: "p", mapWidth: 410 });
  assert.deepStrictEqual(sent.map(s => s.name), ["CONFIG_ERROR"], "no REGISTER: it doesn't run on defaults");
  assert.match(sent[0].payload.message, /apiKey → apiKeys\.wsdot/);
  assert.match(sent[0].payload.message, /predictionDbPass → predictionDb\.password/);
  assert.match(sent[0].payload.message, /mapWidth → map\.width/);
  assert.strictEqual(m.error, sent[0].payload.message, "shown on screen");
  assert.strictEqual(m.loaded, true);

  const map = registered({ type: "map", mapUpperLeft: { lat: 47.7, lon: -122.6 } });
  assert.deepStrictEqual(map.sent.map(s => s.name), ["CONFIG_ERROR"]);
  assert.strictEqual(map.m.map.status, "error");
  assert.match(map.m.map.errors[0], /mapUpperLeft → map\.upperLeft/);
});

test("times are shown in Seattle time, whatever the server's time zone", () => {
  const savedTz = process.env.TZ;
  process.env.TZ = "Asia/Tokyo";
  try {
    const m = moduleWithConfig();
    const t = Date.UTC(2026, 10, 3, 23, 5); // 3:05 PM in Seattle (PST), 8:05 AM next day in Tokyo
    assert.strictEqual(m.formatTime(t), "3:05 PM");
    assert.strictEqual(m.formatLastUpdated(t), "03-Nov-2026 @ 3:05 pm");
    assert.strictEqual(m.formatTime(undefined), "N/A");
  } finally {
    if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz;
  }
});

test("the page formats the helper's timestamps into the row text", () => {
  const m = moduleWithConfig();
  const t = Date.UTC(2026, 10, 3, 23, 5);
  m.sailings = [{ departingTimestamp: t, estDeptTimestamp: t + 7 * 60000, departedTimestamp: t + 2 * 60000, delayMinutes: 7, hasDeparted: false }];
  m.loaded = true; m.error = null; m.departingTerminalName = "A"; m.arrivingTerminalName = "B";
  m.lastUpdatedTimestamp = t; m.fetching = false; m.dbProblem = false;
  const row = m.getTemplateData().sailings[0];
  assert.deepStrictEqual([row.departingTime, row.estDeptTime, row.departedTime], ["3:05 PM", "3:12 PM", "3:07 PM"]);
  assert.strictEqual(m.getTemplateData().lastUpdated, "03-Nov-2026 @ 3:05 pm");
});

test("an error after a successful load keeps the last data; an error before any data shows the error", () => {
  const m = moduleWithConfig();
  m.routeKey = "3-7"; m.pulseUntil = 0; m.updateDom = () => {};
  m.sailings = []; m.loaded = false; m.error = null;
  m.socketNotificationReceived("FERRY_ERROR", { routeKey: "3-7", message: "HTTP 500 on schedule" });
  assert.strictEqual(m.error, "HTTP 500 on schedule");
  assert.deepStrictEqual(m.sailings, [], "nothing to keep yet: the template shows the error");

  m.socketNotificationReceived("FERRY_SCHEDULE", { routeKey: "3-7", sailings: [{ departingTimestamp: 1 }], departingTerminalName: "A", arrivingTerminalName: "B", lastUpdatedTimestamp: 1 });
  assert.strictEqual(m.error, null);
  m.socketNotificationReceived("FERRY_ERROR", { routeKey: "3-7", message: "HTTP 500 on schedule" });
  assert.strictEqual(m.sailings.length, 1, "last good data kept");
  assert.strictEqual(m.error, "HTTP 500 on schedule", "the footer notes the failed update");
});

test("DB_STATUS turns the title icon red and back, without re-rendering", () => {
  const m = moduleWithConfig();
  m.routeKey = "3-7";
  const classes = new Set();
  global.document = { querySelector: () => ({ classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), add: c => classes.add(c) } }) };
  let renders = 0;
  m.updateDom = () => renders++;
  m.socketNotificationReceived("DB_STATUS", { routeKey: "3-7", problem: true });
  assert.ok(classes.has("db-problem"));
  assert.strictEqual(m.dbProblem, true);
  m.socketNotificationReceived("DB_STATUS", { routeKey: "3-7", problem: false });
  assert.ok(!classes.has("db-problem"));
  assert.strictEqual(renders, 0);
  delete global.document;
});

test("each result carries the DB status, so a missed DB_STATUS corrects itself at the next refresh", () => {
  const m = moduleWithConfig();
  m.routeKey = "3-7"; m.pulseUntil = 0; m.sailings = []; m.loaded = true; m.error = null;
  m.updateDom = () => {};
  const result = { routeKey: "3-7", sailings: [], departingTerminalName: "A", arrivingTerminalName: "B", lastUpdatedTimestamp: 1 };
  m.dbProblem = true; // red, and the "cleared" DB_STATUS never arrived
  m.socketNotificationReceived("FERRY_SCHEDULE", { ...result, dbProblem: false });
  assert.strictEqual(m.getTemplateData().dbProblem, false, "cleared by the next result");
  m.socketNotificationReceived("FERRY_ERROR", { routeKey: "3-7", message: "HTTP 500", dbProblem: true });
  assert.strictEqual(m.dbProblem, true, "update errors carry it too");
  m.socketNotificationReceived("FERRY_SCHEDULE", result);
  assert.strictEqual(m.dbProblem, true, "a result without the field leaves the status as is");
});

// Render the real template with MagicMirror's own Nunjucks (skipped if it isn't installed beside this module)
const nunjucks = (() => {
  try { return require(path.resolve(__dirname, "../../../node_modules/nunjucks")); } catch { return null; }
})();
const render = data => new nunjucks.Environment(new nunjucks.FileSystemLoader(path.resolve(__dirname, ".."))).render("MMM-WaStateFerry.njk", data);
const templateData = overrides => ({
  loaded: true, error: null, departingTerminalName: "Bainbridge Island", arrivingTerminalName: "Seattle",
  lastUpdated: "03-Nov-2026 @ 3:05 pm", fetching: false, dbProblem: false,
  sailings: [{ departingTime: "3:50 PM", estDeptTime: "3:51 PM", departedTime: "3:51 PM", vesselName: "Wenatchee", delayMinutes: 1,
    hasDeparted: false, isCancelled: false, driveUpSpaceCount: 170, maxSpaceCount: 197, opacity: 1, delayClass: "", spaceClass: "" }],
  ...overrides
});

test("template: an error before any data shows the error, not Loading", { skip: !nunjucks && "MagicMirror's nunjucks not found" }, () => {
  const html = render(templateData({ loaded: false, sailings: [], error: "HTTP 500 on schedule" }));
  assert.match(html, /Error: HTTP 500 on schedule/);
  assert.doesNotMatch(html, /Loading/);
});

test("template: an error after a load keeps the table and notes the failed update", { skip: !nunjucks && "MagicMirror's nunjucks not found" }, () => {
  const html = render(templateData({ error: "HTTP 500 on schedule" }));
  assert.match(html, /Wenatchee/);
  assert.match(html, /last updated on 03-Nov-2026 @ 3:05 pm \(latest update failed\)/);
  assert.doesNotMatch(html, /Error:/);
});

test("template: the title icon gets the DB-problem class", { skip: !nunjucks && "MagicMirror's nunjucks not found" }, () => {
  assert.match(render(templateData({ dbProblem: true })), /ferry-icon normal db-problem/);
  assert.doesNotMatch(render(templateData({})), /db-problem/);
  assert.match(render(templateData({ loaded: false, sailings: [] })), /Loading ferry schedule/);
});
