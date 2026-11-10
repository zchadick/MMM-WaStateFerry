// Map view tests: validation, view/aspect ratio, detail level, cache keys, building and caching.
// Mostly uses a tiny made-up data set (fast); one smoke test uses the real low-detail map_data.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  COVERAGE, validateMapConfig, computeView, cacheKey, cleanupCache, createMapBuilder
} = require("../map/mapBuilder");

const MAP_DATA = path.resolve(__dirname, "../map_data");
const quietLog = { info() {}, warn() {}, error() {} };

// Settings shaped like what a map page sends (defaults from MMM-WaStateFerry.js)
const config = (overrides = {}) => ({
  mapUpperLeft: { lat: 47.73803, lon: -122.61430 },
  mapLowerRight: { lat: 47.57325, lon: -122.32455 },
  mapWidth: 400,
  mapDetail: "auto",
  mapLayers: { depth: true, contours: true, coastline: true },
  mapColors: {
    land: "#3a3a3a", water: "#1f3a52",
    depth: ["#1a3247", "#162b3d", "#122433", "#0e1d2a", "#0a1620", "#060f17"],
    contour: "rgba(0,0,0,0.25)", coastline: "#626e78"
  },
  mapLineWidths: { coastline: 1, contour: 0.5 },
  mapEdgeFade: 0.06,
  mapMarkerSize: 14,
  mapLabelSize: 11,
  mapMarkerColors: { otherBoat: "#3d3d3d", dockedBoat: "#000000", dockedBoatLabel: "#9a9a9a", toDeparting: "#7fa7c9", toArriving: "#d8c8a0",
    departingTerminal: "#7fa7c9", arrivingTerminal: "#d8c8a0", otherTerminal: "#666" },
  mapIcons: { underway: "fa-location-arrow", docked: "fa-anchor", terminal: "fa-square" },
  ...overrides
});

// A tiny data set: one square of water (with a square of each depth inside) and a coastline
function makeFixtureData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ferry-map-data-"));
  const square = (w, s, e, n) => ({ type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
  const write = (level, name, geometry) => {
    fs.mkdirSync(path.join(dir, level), { recursive: true });
    fs.writeFileSync(path.join(dir, level, `${name}.geojson`),
      JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry }] }));
  };
  for (const level of ["low", "medium", "high"]) {
    write(level, "water", square(-122.6, 47.6, -122.4, 47.7));
    write(level, "land", square(-122.7, 47.5, -122.3, 47.8));
    ["depth_30ft", "depth_60ft", "depth_120ft", "depth_180ft", "depth_300ft", "depth_600ft"].forEach((name, i) => {
      const inset = 0.01 * (i + 1);
      write(level, name, square(-122.6 + inset, 47.6 + inset / 2, -122.4 - inset, 47.7 - inset / 2));
    });
    write(level, "coastline", { type: "LineString", coordinates: [[-122.6, 47.6], [-122.6, 47.7]] });
  }
  return dir;
}

const tempDir = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test("valid default settings pass validation", () => {
  assert.deepStrictEqual(validateMapConfig(config()), []);
});

test("validation catches bad corners, width, detail, layers, colors, line widths, and fade", () => {
  const cases = [
    [{ mapUpperLeft: undefined }, /map\.upperLeft is required/],
    [{ mapLowerRight: undefined }, /map\.lowerRight is required/],
    [{ mapUpperLeft: null }, /map\.upperLeft is required/],
    [{ mapUpperLeft: { lat: "47.7", lon: -122.6 } }, /map\.upperLeft must be \{ lat, lon \}/],
    [{ mapUpperLeft: { lat: 95, lon: -122.6 } }, /map\.upperLeft\.lat must be between -90 and 90/],
    [{ mapLowerRight: { lat: 47.5, lon: -190 } }, /map\.lowerRight\.lon must be between -180 and 180/],
    [{ mapUpperLeft: { lat: 47.5, lon: -122.6 } }, /must be north of map\.lowerRight/],
    [{ mapUpperLeft: { lat: 47.7, lon: -122.2 } }, /must be west of map\.lowerRight/],
    [{ mapWidth: 400.5 }, /map\.width must be a whole number/],
    [{ mapWidth: 0 }, /map\.width must be a whole number/],
    [{ mapWidth: 2001 }, /map\.width must be a whole number/],
    [{ mapDetail: "ultra" }, /map\.detail must be one of/],
    [{ mapLayers: { depth: "yes", contours: true, coastline: true } }, /map\.layers\.depth must be true or false/],
    [{ mapColors: { ...config().mapColors, water: "red\"/><script>" } }, /map\.colors\.water must be a CSS color/],
    [{ mapColors: { ...config().mapColors, depth: ["#000"] } }, /map\.colors\.depth must be a list of 6/],
    [{ mapLineWidths: { coastline: -1, contour: 0.5 } }, /map\.lineWidths\.coastline must be a number/],
    [{ mapEdgeFade: 0.8 }, /map\.edgeFade must be a number from 0 to 0.5/],
    [{ mapMarkerSize: 2 }, /map\.markers\.size must be a number of pixels from 4 to 64/],
    [{ mapLabelSize: "big" }, /map\.markers\.labelSize must be a number of pixels from 4 to 64/],
    [{ mapMarkerColors: { ...config().mapMarkerColors, toArriving: "red;}</style>" } }, /map\.markers\.colors\.toArriving must be a CSS color/],
    [{ mapIcons: { ...config().mapIcons, underway: "ship\" onerror=\"x" } }, /map\.markers\.icons\.underway must be a Font Awesome icon name/]
  ];
  for (const [overrides, expected] of cases) {
    const errors = validateMapConfig(config(overrides));
    assert.ok(errors.some(e => expected.test(e)), `${JSON.stringify(overrides)} → ${JSON.stringify(errors)}`);
  }
});

test("view: width is fixed and height follows the area's aspect ratio", () => {
  const view = computeView(config());
  assert.strictEqual(view.width, 400);
  assert.strictEqual(view.height, 338);
  assert.strictEqual(view.level, "medium");
});

test("view: aspect ratio is clamped to 5:1 and 1:5, keeping the upper-left corner", () => {
  // Very wide area → trimmed on the right to 5:1
  const wide = computeView(config({ mapUpperLeft: { lat: 47.70, lon: -123.30 }, mapLowerRight: { lat: 47.65, lon: -122.20 } }));
  assert.strictEqual(wide.west, -123.30);
  assert.strictEqual(wide.north, 47.70);
  assert.ok(wide.east < -122.20, "right side trimmed");
  assert.strictEqual(wide.height, 80, "400 px wide at 5:1");

  // Very tall area → trimmed at the bottom to 1:5
  const tall = computeView(config({ mapUpperLeft: { lat: 48.70, lon: -122.50 }, mapLowerRight: { lat: 47.10, lon: -122.45 } }));
  assert.strictEqual(tall.west, -122.50);
  assert.strictEqual(tall.north, 48.70);
  assert.ok(tall.south > 47.10, "bottom trimmed");
  assert.ok(Math.abs(tall.height - 2000) <= 1, `400 px wide at 1:5 → ${tall.height}`);

  // Inside the limits → unchanged
  const normal = computeView(config());
  assert.strictEqual(normal.east, -122.32455);
  assert.strictEqual(normal.south, 47.57325);
});

test("view: detail level follows metres per pixel unless set explicitly", () => {
  assert.strictEqual(computeView(config({ mapWidth: 2000 })).level, "high");
  assert.strictEqual(computeView(config({ mapWidth: 400 })).level, "medium");
  assert.strictEqual(computeView(config({ mapWidth: 100 })).level, "low");
  assert.strictEqual(computeView(config({ mapDetail: "low" })).level, "low");
});

test("cache key: same settings give the same key; any visual change gives a new one", () => {
  const base = config();
  const key = cacheKey(computeView(base), base);
  assert.match(key, /^[0-9a-f]{16}$/);
  assert.strictEqual(cacheKey(computeView(config()), config()), key);

  const changed = [
    config({ mapColors: { ...base.mapColors, land: "#333" } }),
    config({ mapLayers: { ...base.mapLayers, contours: false } }),
    config({ mapLineWidths: { coastline: 2, contour: 0.5 } }),
    config({ mapWidth: 401 }),
    config({ mapDetail: "high" }),
    config({ mapLowerRight: { lat: 47.57, lon: -122.32455 } })
  ];
  for (const c of changed) assert.notStrictEqual(cacheKey(computeView(c), c), key, JSON.stringify(c));
  // The edge fade is applied in the browser, not baked into the SVG
  assert.strictEqual(cacheKey(computeView(config({ mapEdgeFade: 0 })), config({ mapEdgeFade: 0 })), key);
});

test("cache cleanup keeps the newest files and only touches cache files", () => {
  const dir = tempDir("ferry-map-cache-");
  const names = Array.from({ length: 7 }, (_, i) => `${String(i).repeat(16)}.svg`);
  names.forEach((name, i) => {
    fs.writeFileSync(path.join(dir, name), "<svg/>");
    const t = new Date(Date.UTC(2026, 10, 1, 0, i));
    fs.utimesSync(path.join(dir, name), t, t);
  });
  fs.writeFileSync(path.join(dir, "notes.txt"), "not a cache file");
  cleanupCache(dir, 5);
  const left = fs.readdirSync(dir).sort();
  assert.deepStrictEqual(left, [...names.slice(2), "notes.txt"].sort());
});

test("builds in the background, then reuses the cached file", async () => {
  const builder = createMapBuilder({ dataDir: makeFixtureData(), cacheDir: tempDir("ferry-map-out-"), Log: quietLog });
  const first = await builder.getOrBuildMap(config());
  assert.strictEqual(first.cached, false);
  const second = await builder.getOrBuildMap(config());
  assert.strictEqual(second.cached, true);
  assert.strictEqual(second.file, first.file);
});

test("the same map requested twice at once is built once", async () => {
  const builds = [];
  const countingLog = { ...quietLog, info: message => { if (message.includes("Built map")) builds.push(message); } };
  const builder = createMapBuilder({ dataDir: makeFixtureData(), cacheDir: tempDir("ferry-map-out-"), Log: countingLog });
  const [a, b] = await Promise.all([builder.getOrBuildMap(config()), builder.getOrBuildMap(config())]);
  assert.strictEqual(a.file, b.file);
  assert.strictEqual(builds.length, 1, "one build shared by both requests");
});

test("different maps are built one at a time", async () => {
  const builder = createMapBuilder({ dataDir: makeFixtureData(), cacheDir: tempDir("ferry-map-out-"), Log: quietLog });
  const finished = [];
  const one = builder.getOrBuildMap(config()).then(r => finished.push(["one", r.file]));
  const two = builder.getOrBuildMap(config({ mapWidth: 300 })).then(r => finished.push(["two", r.file]));
  await Promise.all([one, two]);
  assert.deepStrictEqual(finished.map(f => f[0]), ["one", "two"]);
  assert.notStrictEqual(finished[0][1], finished[1][1]);
});

test("a build failure is reported and doesn't block later builds", async () => {
  const builder = createMapBuilder({ dataDir: tempDir("ferry-map-empty-"), cacheDir: tempDir("ferry-map-out-"), Log: quietLog });
  await assert.rejects(builder.getOrBuildMap(config()));
  const working = createMapBuilder({ dataDir: makeFixtureData(), cacheDir: tempDir("ferry-map-out-"), Log: quietLog });
  assert.strictEqual((await working.getOrBuildMap(config())).cached, false);
});

test("SVG: layers can be turned off, and colors are applied", async () => {
  const { renderMapSvg } = await import("../map/renderSvg.mjs");
  const dataDir = makeFixtureData();
  const c = config();
  const style = layers => ({ layers, colors: c.mapColors, lineWidths: c.mapLineWidths });
  const view = computeView(c);
  const all = renderMapSvg({ view, style: style(c.mapLayers), coverage: COVERAGE, dataDir });
  assert.match(all, /fill="#1f3a52"/);
  assert.match(all, /fill="#060f17"/);
  assert.match(all, /stroke="#626e78"/);
  const bare = renderMapSvg({ view, style: style({ depth: false, contours: false, coastline: false }), coverage: COVERAGE, dataDir });
  assert.doesNotMatch(bare, /#060f17/);
  assert.doesNotMatch(bare, /#626e78/);
});

test("SVG: areas outside the data's coverage are cross-hatched and labelled", async () => {
  const { renderMapSvg } = await import("../map/renderSvg.mjs");
  const dataDir = makeFixtureData();
  const c = config();
  const style = { layers: c.mapLayers, colors: c.mapColors, lineWidths: c.mapLineWidths };
  const inside = renderMapSvg({ view: computeView(c), style, coverage: COVERAGE, dataDir });
  assert.doesNotMatch(inside, /hatch/);

  // Half the area west of the coverage edge (-123.35): wide enough for the label
  const half = config({ mapUpperLeft: { lat: 47.8, lon: -123.6 }, mapLowerRight: { lat: 47.5, lon: -123.1 } });
  const partly = renderMapSvg({ view: computeView(half), style, coverage: COVERAGE, dataDir });
  assert.match(partly, /url\(#hatch\)/);
  assert.match(partly, /outside map coverage/);

  // Entirely outside
  const away = config({ mapUpperLeft: { lat: 46.5, lon: -124.5 }, mapLowerRight: { lat: 46.2, lon: -124.0 } });
  const outside = renderMapSvg({ view: computeView(away), style, coverage: COVERAGE, dataDir });
  assert.match(outside, /outside map coverage/);
});

test("real map_data: the default area builds at medium detail inside coverage", async () => {
  const { renderMapSvg } = await import("../map/renderSvg.mjs");
  const c = config();
  const svg = renderMapSvg({
    view: computeView(c), style: { layers: c.mapLayers, colors: c.mapColors, lineWidths: c.mapLineWidths }, coverage: COVERAGE, dataDir: MAP_DATA
  });
  assert.match(svg, /^<svg [^>]*width="400" height="338"/);
  assert.ok(svg.length > 50000, `expected a detailed map, got ${svg.length} bytes`);
  assert.doesNotMatch(svg, /hatch/);
});
