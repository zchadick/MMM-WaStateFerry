// Background thread: draw one map SVG and write it to the cache (temporary name, then rename,
// so a half-written file is never served). Started by createMapBuilder in map/mapBuilder.js.

import fs from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { renderMapSvg } from "./renderSvg.mjs";

const started = performance.now();
const svg = renderMapSvg(workerData);
const temp = `${workerData.outFile}.${process.pid}.tmp`;
fs.writeFileSync(temp, svg);
fs.renameSync(temp, workerData.outFile);

parentPort.postMessage({
  buildMs: Math.round(performance.now() - started),
  memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
  bytes: Buffer.byteLength(svg)
});
