# Map data

Land, water, coastline, and depth layers for the Puget Sound region, used by the module's map
view. Derived from NOAA Electronic Navigational Charts (ENCs) and simplified for display on a
MagicMirror.

> **NOT FOR NAVIGATION.** This data has been merged, simplified, and reformatted for a wall
> display. It is not an official NOAA ENC, is not current with NOAA chart updates, and must not
> be used for navigation or safety decisions.

## Source

- **NOAA Electronic Navigational Charts (ENC), S-57 format,** Washington state set, edition
  as of October 2026: https://www.charts.noaa.gov/ENCs/ENCs.shtml
- About 150 chart cells were merged. Where charts overlap, the most detailed chart is used.
- Use of NOAA ENCs is governed by the NOAA ENC User Agreement:
  https://www.charts.noaa.gov/ENCs/ENC_Agreement.shtml

Citation requested by NOAA:

> Office of Coast Survey. (2001). NOAA Electronic Navigational Charts (ENC) [Dataset].
> National Oceanic and Atmospheric Administration. Accessed October 2026.
> https://doi.org/10.25923/jyyk-j845

## NOAA terms and disclaimers

- NOAA permits ENCs to be used and redistributed without restriction or payment (User
  Agreement, "Permitted Use").
- Redistributed and modified ENC data is **not considered official NOAA ENC data** and does not
  meet federal chart carriage requirements. This data is a derived, simplified product; the
  producer of a derived product assumes full liability for it (User Agreement, "Limitations on
  Use").
- NOAA notes that much of the charted depth information comes from old surveys and that
  shoreline data can be decades old. Simplification here adds further error (see below).
- "NOAA" and "NOAA ENC" are registered trademarks of the National Oceanic and Atmospheric
  Administration. This project is not affiliated with or endorsed by NOAA.

## Coverage

Longitude −123.35 to −122.15, latitude 47.00 to 48.80: Olympia to the San Juan Islands and
Anacortes, Hood Canal to Everett and Seattle. Outside this box there is no data (the module
draws it black with cross-hatching and labels it "outside map coverage").

## Layers

One GeoJSON file per layer (WGS84 longitude/latitude, one feature per file):

| File | Contents |
|---|---|
| `water.geojson` | All charted water: salt water plus navigable lakes such as Lake Washington and Lake Union |
| `land.geojson` | Land within chart coverage (kept for completeness; the module draws land as the background) |
| `coastline.geojson` | **Lines**, not polygons: only true land/water edges (not the edges of chart coverage) |
| `depth_30ft.geojson` … `depth_600ft.geojson` | Water deeper than 30, 60, 120, 180, 300, and 600 ft |

The depth layers are **nested, not banded**: each deeper layer lies entirely inside the shallower
ones. Drawn shallow to deep, each paints over the previous one to form depth bands, and each
layer's edge is the contour line for that depth. Depths are chart depths relative to mean lower
low water (MLLW), taken from NOAA's fathom contours: 5, 10, 20, 30, 50, and 100 fathoms.

## Detail levels

| Folder | Simplification | Suited to | Size |
|---|---|---|---|
| `high/` | about 5 m | under 15 m per screen pixel (a harbor or one crossing) | ~13 MB |
| `medium/` | about 20 m | 15–60 m per pixel (a stretch of the Sound) | ~4.3 MB |
| `low/` | about 80 m | over 60 m per pixel (the whole region) | ~1.2 MB |

All layers were simplified together, so coastline and depth edges stay aligned.

## Limitations

- **Small inland lakes and rivers** aren't in nautical charts, so they appear as land.
- **Simplification** moves shorelines and contours by up to roughly the amount in the table above.
- **The data is a snapshot** of the October 2026 chart edition and isn't updated automatically.

## How this data was made (to recreate or update it)

Broad strokes; the build was done once on a desktop machine, not on the mirror.

1. **Download** the Washington ENC set from NOAA (link above) and unzip it. Each chart cell is an
   S-57 file (`*.000`), with update files applied on read.
2. **Read each cell's layers** (for example with Python using `pyogrio`/GDAL and `shapely`):
   - `M_COVR` with `CATCOV = 1`: the area the cell covers;
   - `LNDARE`: land areas;
   - `DEPARE` and `DRGARE`: depth areas, with their minimum and maximum depths (`DRVAL1`, `DRVAL2`).

   Keep only cells that overlap the coverage box.
3. **Merge with the most detailed chart winning:** sort cells from most to least detailed (the
   navigational-purpose band, the third character of the cell name) and take each cell's
   contribution only where no more detailed cell already covers.
4. **Land and water:** land = the merged `LNDARE`; water = the merged coverage minus land, both
   clipped to the coverage box.
5. **Depth layers:** for each depth (30, 60, 120, 180, 300, 600 ft = 9.1, 18.2, 36.5, 54.8, 91.4,
   182.8 m), take the depth areas whose minimum depth is at least that deep, using for each
   place the most detailed chart that resolves that depth, then limit the result to water.
6. **Save** full-resolution GeoJSON layers (one feature each).
7. **Simplify into the three detail levels together** (for example with `mapshaper`: combine the
   layers, snap shared vertices, simplify at about 5 m / 20 m / 80 m keeping shapes, and drop
   tiny islands and slivers), so shared edges stay aligned.
8. **Coastline:** derive lines only where land and water touch (for example `mapshaper -innerlines`
   on land + water), so the edges of chart coverage are not drawn as shoreline.

After replacing the data, **change `DATA_VERSION` in `map/mapBuilder.js`** so maps cached from the
old data are rebuilt.
