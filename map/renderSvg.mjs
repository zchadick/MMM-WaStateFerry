// Draws the map as an SVG string: clip map_data layers to the view and project them to pixels.
// Runs inside the background worker (map/mapWorker.mjs); also used directly by tests.

import fs from "node:fs";
import path from "node:path";
import bboxClip from "@turf/bbox-clip";
import { geoPath, geoTransform } from "d3-geo";

const DEPTH_LAYERS = ["depth_30ft", "depth_60ft", "depth_120ft", "depth_180ft", "depth_300ft", "depth_600ft"];
const HATCH_COLOR = "#555";
const LABEL_COLOR = "#999";
const OUTSIDE_LABEL = "outside map coverage";

const fixed = n => Number(n.toFixed(1));

export function renderMapSvg({ view, style, coverage, dataDir }) {
  const { west, north, east, south, width, height, k, scale, level } = view;
  const { layers, colors, lineWidths } = style;

  // Clip to the view padded by 2%, so the straight clip edges stay outside the visible area
  const padX = (east - west) * 0.02;
  const padY = (north - south) * 0.02;
  const box = [west - padX, south - padY, east + padX, north + padY];
  const load = name => JSON.parse(fs.readFileSync(path.join(dataDir, level, `${name}.geojson`), "utf8"))
    .features.map(feature => bboxClip(feature, box))
    .filter(feature => feature.geometry.coordinates.length > 0);

  const project = (lon, lat) => [(lon - west) * k * scale, (north - lat) * scale];
  const pathGen = geoPath(geoTransform({ point(x, y) { this.stream.point(...project(x, y)); } })).digits(1);
  const pathOf = features => features.map(feature => pathGen(feature) || "").join("");

  const parts = [];
  // Land is the background (outside the water polygons everything reads as land)
  parts.push(`<rect width="${width}" height="${height}" fill="${colors.land}"/>`);
  parts.push(`<path d="${pathOf(load("water"))}" fill="${colors.water}"/>`);

  // Depth layers are nested: draw shallow to deep, each painting over the last
  if (layers.depth || layers.contours) {
    DEPTH_LAYERS.forEach((name, i) => {
      const fill = layers.depth ? colors.depth[i] : "none";
      const stroke = layers.contours ? `stroke="${colors.contour}" stroke-width="${lineWidths.contour}" stroke-linejoin="round"` : "";
      parts.push(`<path d="${pathOf(load(name))}" fill="${fill}" ${stroke}/>`);
    });
  }

  if (layers.coastline) {
    parts.push(`<path d="${pathOf(load("coastline"))}" fill="none" stroke="${colors.coastline}" `
      + `stroke-width="${lineWidths.coastline}" stroke-linejoin="round"/>`);
  }

  parts.push(outsideCoverage(view, coverage, project));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + parts.join("") + "</svg>";
}

// Black with light cross-hatching wherever the view extends beyond the data, plus a label
function outsideCoverage(view, coverage, project) {
  const { width, height } = view;
  // Coverage rectangle in pixels, limited to the view
  const [cx1, cy1] = project(coverage.west, coverage.north);
  const [cx2, cy2] = project(coverage.east, coverage.south);
  const x1 = Math.max(0, Math.min(width, cx1)), x2 = Math.max(0, Math.min(width, cx2));
  const y1 = Math.max(0, Math.min(height, cy1)), y2 = Math.max(0, Math.min(height, cy2));
  const covered = x2 > x1 && y2 > y1;
  if (covered && x1 === 0 && y1 === 0 && x2 === width && y2 === height) return "";

  // Outside area = view minus coverage (even-odd clip)
  const hole = covered ? `M${fixed(x1)},${fixed(y1)}H${fixed(x2)}V${fixed(y2)}H${fixed(x1)}Z` : "";
  const outside = `<defs>
<pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M0,0L8,8M8,0L0,8" stroke="${HATCH_COLOR}" stroke-width="0.6"/></pattern>
<clipPath id="outside"><path clip-rule="evenodd" d="M0,0H${width}V${height}H0Z${hole}"/></clipPath>
</defs>
<g clip-path="url(#outside)"><rect width="${width}" height="${height}" fill="#000"/><rect width="${width}" height="${height}" fill="url(#hatch)"/></g>`;

  // Label in the largest outside strip, if it has room
  const strips = covered
    ? [
      { x: 0, y: 0, w: x1, h: height },
      { x: x2, y: 0, w: width - x2, h: height },
      { x: x1, y: 0, w: x2 - x1, h: y1 },
      { x: x1, y: y2, w: x2 - x1, h: height - y2 }
    ]
    : [{ x: 0, y: 0, w: width, h: height }];
  const largest = strips.sort((a, b) => b.w * b.h - a.w * a.h)[0];
  const label = largest.w >= 130 && largest.h >= 24
    ? `<text x="${fixed(largest.x + largest.w / 2)}" y="${fixed(largest.y + largest.h / 2)}" fill="${LABEL_COLOR}" `
      + `font-family="sans-serif" font-size="13" text-anchor="middle" dominant-baseline="middle">${OUTSIDE_LABEL}</text>`
    : "";
  return outside + label;
}
