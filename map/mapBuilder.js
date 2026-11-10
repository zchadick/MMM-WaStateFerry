// Map view: validate map settings, work out the view, and build/cache the map SVG.
// The SVG drawing itself runs in a background thread (map/mapWorker.mjs) so the helper stays responsive.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Worker } = require("node:worker_threads");

// Bump DATA_VERSION when map_data changes, BUILDER_VERSION when the drawing changes,
// so cached SVGs from older data or code are never reused
const DATA_VERSION = "noaa-enc-2026-10";
const BUILDER_VERSION = "1";

// Area covered by map_data (outside it: black with cross-hatching)
const COVERAGE = { west: -123.35, south: 47.00, east: -122.15, north: 48.80 };

// Map aspect ratio (width:height) is limited to 5:1 … 1:5
const MAX_ASPECT = 5;
const MIN_ASPECT = 1 / 5;

const MAX_WIDTH = 2000;
const DETAIL_LEVELS = ["auto", "low", "medium", "high"];
const DEPTH_LAYERS = ["depth_30ft", "depth_60ft", "depth_120ft", "depth_180ft", "depth_300ft", "depth_600ft"];
const CACHE_KEEP = 5;

// Colors are written into the SVG and page, so only allow plain CSS color syntax
const SAFE_COLOR = /^[#a-zA-Z0-9(),.%\s]+$/;
const ICON_NAME = /^fa-[a-z0-9-]+$/;
const MARKER_COLORS = ["otherBoat", "dockedBoat", "dockedBoatLabel", "toDeparting", "toArriving", "departingTerminal", "arrivingTerminal", "otherTerminal"];

const isNumber = value => typeof value === "number" && Number.isFinite(value);

function validateCorner(corner, name, errors) {
  // Missing settings can arrive as undefined or null (depending on how the page's message was serialized)
  if (corner === undefined || corner === null) {
    errors.push(`${name} is required: { lat, lon } in decimal degrees`);
    return false;
  }
  if (!corner || typeof corner !== "object" || !isNumber(corner.lat) || !isNumber(corner.lon)) {
    errors.push(`${name} must be { lat, lon } in decimal degrees`);
    return false;
  }
  if (corner.lat < -90 || corner.lat > 90) errors.push(`${name}.lat must be between -90 and 90`);
  if (corner.lon < -180 || corner.lon > 180) errors.push(`${name}.lon must be between -180 and 180`);
  return true;
}

// Returns a list of error messages (empty when the map settings are valid)
function validateMapConfig(config) {
  const errors = [];
  const ulOk = validateCorner(config.mapUpperLeft, "map.upperLeft", errors);
  const lrOk = validateCorner(config.mapLowerRight, "map.lowerRight", errors);
  if (ulOk && lrOk) {
    if (config.mapUpperLeft.lat <= config.mapLowerRight.lat) errors.push("map.upperLeft must be north of map.lowerRight");
    if (config.mapUpperLeft.lon >= config.mapLowerRight.lon) errors.push("map.upperLeft must be west of map.lowerRight");
  }

  if (!Number.isInteger(config.mapWidth) || config.mapWidth < 1 || config.mapWidth > MAX_WIDTH) {
    errors.push(`map.width must be a whole number of pixels from 1 to ${MAX_WIDTH}`);
  }
  if (!DETAIL_LEVELS.includes(config.mapDetail)) errors.push(`map.detail must be one of: ${DETAIL_LEVELS.join(", ")}`);

  const layers = config.mapLayers || {};
  for (const layer of ["depth", "contours", "coastline"]) {
    if (typeof layers[layer] !== "boolean") errors.push(`map.layers.${layer} must be true or false`);
  }

  const colors = config.mapColors || {};
  for (const name of ["land", "water", "contour", "coastline"]) {
    if (typeof colors[name] !== "string" || !SAFE_COLOR.test(colors[name])) errors.push(`map.colors.${name} must be a CSS color`);
  }
  if (!Array.isArray(colors.depth) || colors.depth.length !== DEPTH_LAYERS.length
    || colors.depth.some(c => typeof c !== "string" || !SAFE_COLOR.test(c))) {
    errors.push(`map.colors.depth must be a list of ${DEPTH_LAYERS.length} CSS colors (30 ft to 600 ft)`);
  }

  const widths = config.mapLineWidths || {};
  for (const name of ["coastline", "contour"]) {
    if (!isNumber(widths[name]) || widths[name] < 0 || widths[name] > 10) errors.push(`map.lineWidths.${name} must be a number from 0 to 10`);
  }

  if (!isNumber(config.mapEdgeFade) || config.mapEdgeFade < 0 || config.mapEdgeFade > 0.5) {
    errors.push("map.edgeFade must be a number from 0 to 0.5");
  }

  // Ferry and terminal markers (drawn by the page over the map, not part of the SVG)
  for (const [name, label] of [["mapMarkerSize", "map.markers.size"], ["mapLabelSize", "map.markers.labelSize"]]) {
    if (!isNumber(config[name]) || config[name] < 4 || config[name] > 64) errors.push(`${label} must be a number of pixels from 4 to 64`);
  }
  const markerColors = config.mapMarkerColors || {};
  for (const name of MARKER_COLORS) {
    if (typeof markerColors[name] !== "string" || !SAFE_COLOR.test(markerColors[name])) errors.push(`map.markers.colors.${name} must be a CSS color`);
  }
  const icons = config.mapIcons || {};
  for (const name of ["underway", "docked", "terminal"]) {
    if (typeof icons[name] !== "string" || !ICON_NAME.test(icons[name])) {
      errors.push(`map.markers.icons.${name} must be a Font Awesome icon name like "fa-location-arrow"`);
    }
  }
  return errors;
}

// Work out the map's area, pixel size, scale, and detail level from (validated) settings.
// Planar projection: longitude scaled by cos(mid-latitude). Aspect ratio is clamped to 5:1 … 1:5,
// keeping the upper-left corner and trimming the right or bottom.
function computeView(config) {
  const west = config.mapUpperLeft.lon;
  const north = config.mapUpperLeft.lat;
  let east = config.mapLowerRight.lon;
  let south = config.mapLowerRight.lat;

  const cosMid = (n, s) => Math.cos(((n + s) / 2) * Math.PI / 180);
  let k = cosMid(north, south);
  const ratio = ((east - west) * k) / (north - south);
  if (ratio > MAX_ASPECT) {
    east = west + (MAX_ASPECT * (north - south)) / k;
  } else if (ratio < MIN_ASPECT) {
    // Trimming the bottom moves the mid-latitude; one refinement pass is plenty at this scale
    south = north - ((east - west) * k) / MIN_ASPECT;
    k = cosMid(north, south);
    south = north - ((east - west) * k) / MIN_ASPECT;
  }
  k = cosMid(north, south);

  const width = config.mapWidth;
  const scale = width / ((east - west) * k); // pixels per (scaled) degree
  const height = Math.max(1, Math.round((north - south) * scale));
  const metresPerPixel = ((east - west) * k * 111320) / width;
  const autoLevel = metresPerPixel < 15 ? "high" : metresPerPixel < 60 ? "medium" : "low";
  const level = config.mapDetail === "auto" ? autoLevel : config.mapDetail;

  return { west, north, east, south, width, height, k, scale, level, metresPerPixel };
}

// Everything that changes the picture goes into the cache file name
function cacheKey(view, config) {
  const round = n => Math.round(n * 1e6) / 1e6;
  const params = {
    data: DATA_VERSION,
    builder: BUILDER_VERSION,
    area: [round(view.west), round(view.north), round(view.east), round(view.south)],
    size: [view.width, view.height],
    level: view.level,
    layers: config.mapLayers,
    colors: config.mapColors,
    lineWidths: config.mapLineWidths
  };
  return crypto.createHash("sha256").update(JSON.stringify(params)).digest("hex").slice(0, 16);
}

const CACHE_FILE = /^[0-9a-f]{16}\.svg$/;

// Keep only the newest cached maps (never deletes anything except our own cache files)
function cleanupCache(cacheDir, keep = CACHE_KEEP, inUse = new Set()) {
  let files;
  try {
    files = fs.readdirSync(cacheDir).filter(name => CACHE_FILE.test(name));
  } catch {
    return;
  }
  files
    .map(name => ({ name, mtime: fs.statSync(path.join(cacheDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(keep)
    .filter(file => !inUse.has(file.name))
    .forEach(file => fs.rmSync(path.join(cacheDir, file.name), { force: true }));
}

// Builds maps in a background thread, one at a time; reuses cached SVGs.
// getOrBuildMap(config) → Promise<{ file, view, cached, buildMs, memoryMB }>
function createMapBuilder({ dataDir, cacheDir, Log, workerPath = path.join(__dirname, "mapWorker.mjs") }) {
  let queue = Promise.resolve();
  const inFlight = new Map(); // cache key → promise (same map requested twice builds once)

  function build(view, config, file) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(workerPath, {
        workerData: {
          view,
          style: { layers: config.mapLayers, colors: config.mapColors, lineWidths: config.mapLineWidths },
          coverage: COVERAGE,
          dataDir,
          outFile: path.join(cacheDir, file)
        }
      });
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", code => { if (code !== 0) reject(new Error(`map worker exited with code ${code}`)); });
    });
  }

  function getOrBuildMap(config) {
    const view = computeView(config);
    const key = cacheKey(view, config);
    const file = `${key}.svg`;
    if (inFlight.has(key)) return inFlight.get(key);

    const job = queue.then(async () => {
      if (fs.existsSync(path.join(cacheDir, file))) return { file, view, cached: true };
      fs.mkdirSync(cacheDir, { recursive: true });
      const result = await build(view, config, file);
      Log.info(`[MMM-WaStateFerry] Built map ${file} (${view.width}x${view.height}, ${view.level} detail) `
        + `in ${result.buildMs} ms; MagicMirror process memory ${result.memoryMB} MB`);
      cleanupCache(cacheDir, CACHE_KEEP, new Set([file]));
      return { file, view, cached: false, buildMs: result.buildMs, memoryMB: result.memoryMB };
    });

    // The queue continues even if this build fails
    queue = job.catch(() => {});
    const tracked = job.finally(() => inFlight.delete(key));
    inFlight.set(key, tracked);
    return tracked;
  }

  return { getOrBuildMap };
}

module.exports = {
  DATA_VERSION,
  BUILDER_VERSION,
  COVERAGE,
  MAX_ASPECT,
  MIN_ASPECT,
  DEPTH_LAYERS,
  MARKER_COLORS,
  validateMapConfig,
  computeView,
  cacheKey,
  cleanupCache,
  createMapBuilder
};
