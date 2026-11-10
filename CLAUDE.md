# MMM-WaStateFerry

A MagicMirror² module that shows the live state of one Washington State Ferries (WSF)
route: upcoming and recently departed sailings, scheduled vs. estimated departure,
drive-up space, and vessel, plus an optional map of Puget Sound with live ferry and terminal
markers. The route is set in MagicMirror's `config/config.js` via departing/arriving terminal
IDs. It can optionally log raw API data to MariaDB for later delay and fill prediction.

The repo is public. Machine-specific notes live in a git-ignored `CLAUDE.local.md`.

## Working rules

- **Never delete or overwrite data in a configured prediction database.** Only read and
  insert. No `DELETE`, `DROP`, `TRUNCATE`, `UPDATE`/`REPLACE` of existing rows, or
  destructive `ALTER TABLE`, in code, scripts, tests, or migrations. (Tests may use
  `TEMPORARY` tables, which MariaDB discards on its own.)
- **No refactoring, drive-by cleanups, reformatting, or renames.** Change only what the
  task requires, so each pull request stays small and easy to review and merge.
- **Periodically evaluate the architecture.** When a new feature would be better served
  by rearchitecting how the system works (rather than layering more onto the current
  design), call it out with the trade-offs. Do **not** implement a rearchitecture without
  explicit instructions.
- **Look for edge cases where the module breaks down, and consider disallowing them.**
  Before adding complexity to support an edge case, consider whether it should simply be
  explicitly unsupported and documented instead (e.g. multiple routes at once: see
  "Design constraint: one route"). Raise the choice rather than defaulting to support.
- **Tests use Node's built-in `node:test`;** no test-framework dependency. New or changed
  behavior gets tests.
- **Credentials live only in MagicMirror's `config/config.js`,** never in this repo or in
  log output. The repo is public: keep credentials, host names, and personal paths out of
  commits (they belong in `config/config.js` or `CLAUDE.local.md`).
- **Keep README.md up to date.** Any change to behavior, configuration options or
  defaults, install/update steps, display rules, or limitations updates the README in the
  same pull request.
- **Flag when `screenshot.png` is out of date.** If a change alters what the module looks
  like on screen (template, CSS, icons, colors, columns, display rules), say so in the
  pull request and remind the maintainer to retake the screenshot. When a new screenshot
  is added, strip its metadata first (keep only the PNG image chunks).
- **Keep this file current, not historical.** Describe how things work now, plus open
  work. No completion history (done markers, phases, dates of decisions): git and the pull
  requests hold that. Exception: brief "Rejected ideas" notes that stop a rejected idea
  from being proposed again.
- **Check the history to understand why things are the way they are.** Before changing or
  questioning a design decision, look at the repo history (`git log`, `git blame`, pull
  requests) and earlier versions of this file (`git log -p -- CLAUDE.md`), which record the
  reasoning, alternatives considered, and past decisions.

## Runtime

- Designed for a Raspberry Pi 3B: limited CPU and RAM, so keep overhead low (no heavy
  dependencies on the mirror). One exception, approved for GPIO only: a small Python helper
  using gpiozero (both come with Raspberry Pi OS; see GPIO). It must stay small, with no
  growing state, supervised from Node, and soak-tested on the Pi before merging changes to it.
- MagicMirror requires Node >= 22.21.1. `fetch` is used natively (no HTTP library).
- **When chasing a problem on the mirror, consider the Pi itself, not just the module.** Past
  issues came from the Pi: memory exhaustion from another desktop process filling RAM and swap
  (everything slowed, including the module), and modules failing to load because MagicMirror
  started before the desktop and network were ready at boot. Useful first checks: `free -h`,
  per-process memory and swap (`VmSwap` in `/proc/*/status`), load average, `pm2 logs`, and the
  refresh intervals in the prediction DB (gaps or drift past the usual ~5 min show when the Pi
  was struggling).

## Configuration

Settings go in the module's entry in `config/config.js`, grouped by function (user-facing
table in README.md "Options"):

- `type`: `"sailings"` (default, the list) or `"map"` (top level).
- `apiKeys.wsdot`: WSDOT Traveler Information API access code. (Future collector keys, e.g.
  Google Maps, go in `apiKeys` too.)
- `route`: `departingTerminalID`, `arrivingTerminalID` (default 3 → 7, Bainbridge Island → Seattle).
- `display`: `maxSailings`, `updateInterval`, `animationSpeed`, `fade`, `fadePoint`.
- `map`: map entries only; see "Map view".
- `predictionDb` (optional): `host`, `user`, `password`, `database` (all four turn DB logging
  on), optional `port` (default 3306). See Prediction database.
- `gpio` (optional, sailings entry only): `statusLed`, `refreshLed`, `buttons` (GPIO/BCM numbers;
  each part off unless set), and `buttonCooldown` (default 30 s): presses within this time of the
  last *button* refresh are ignored (timer and pre-departure refreshes don't count). See GPIO.

How it's handled:
- **Defaults per group:** MagicMirror merges only top-level defaults (unless an entry sets
  `configDeepMerge`), so the page's `start()` merges defaults into every group
  (`mergeDefaults`: plain objects merge, lists and values replace). A partial group keeps the
  rest of its defaults.
- **The helper's names are unchanged:** the page translates the groups into the flat names
  `node_helper.js`, `map/`, `predictive_helpers/`, and `gpio/` already use (e.g. `map.width` →
  `mapWidth`, `predictionDb.password` → `predictionDbPass`, `gpio.buttonCooldown` →
  `manualRefreshCooldown`) in its `REGISTER` message, sending DB and GPIO settings only if
  present. User-facing messages use the grouped names.
- **Old flat names are a clean break:** if any are still in `config.js` (list in the page's
  `oldSettings`), the entry doesn't start: it shows each old name and its new place on screen
  and sends `CONFIG_ERROR`, which the helper logs.

## Testing

Automated (`tests/`), from the module directory: `node --test` (or `npm test`).
- `display.test.js`, `sailings.test.js`, `fetching.test.js`: stand-in API data and a mock
  clock; no network or DB needed. `display.test.js` also renders the real template with
  MagicMirror's own Nunjucks (skipped if it isn't installed beside the module), and covers the
  grouped settings (per-group defaults, what the page sends the helper, old-name errors).
- `gpio.test.js`: GPIO settings, the helper supervisor (restarts, memory backstop, LED timing,
  stop), the Python helper against a stand-in gpiozero (skipped without python3), and
  node_helper's STATUS problems, REFRESH, buttons, and cooldown.
- `delays.test.js`: delay tracking and the end-of-day / new-day flush, through
  `buildSailings` directly (pure; no stand-ins needed).
- `refresh.test.js`: pre-departure refreshes, DB rows per refresh (and the daily timetable row),
  and the DB-problem status (including a real refused connection to port 1 on localhost).
- `timetable.test.js`: choosing the day's timetable (weekday/weekend/holiday, variants, special
  schedules), after-midnight and daylight-time edge cases, removed sailings in the list, and
  loading once per service day; stand-in timetables, no network.
- `mapBuilder.test.js`: map validation, view/aspect ratio, detail level, cache keys,
  background builds and caching, cross-hatching; mostly a tiny made-up data set, plus one
  smoke test on the real `map_data/low`.
- `mapMarkers.test.js`: vessel states and filtering, reference data (load, failure, daily
  refresh), `MAP_POSITIONS` messages, and the page's marker HTML (projection, rotation, icons,
  colors, sizes, escaping, overlay-only updates).
- `db.test.js`: connects to the configured DB and writes to a `TEMPORARY` test table;
  **skipped** (not failed) if any DB key is missing from config.js.
  `KEEP_TEST_TABLE=1 node --test` writes to a kept `test_api_snapshots_<timestamp>` table instead.

Manual: run `node --run server` from the MagicMirror root and open http://localhost:8080.
Check the module's log lines in the server output. Stop the server when done.

### Soak test on the Pi

Required before merging changes to the GPIO helper (see GPIO), and useful when chasing memory
or CPU growth. Run it for at least 48 hours on the Pi with the change deployed
(`git pull`, then `pm2 restart MagicMirror`).

1. Start the logger. It samples memory and CPU of the GPIO helper and MagicMirror every 10
   minutes into `~/gpio-soak.log`. `nohup` plus `disown` keep it running after the SSH
   session closes; a reboot stops it (start it again; the gap shows in the log).
   ```
   nohup bash -c 'while true; do echo "$(date "+%F %T") $(ps -eo rss,pcpu,etime,args --sort=-rss | grep -E "gpio_helper|electron|MagicMirror/js" | grep -v grep | awk "{printf \"%s|%sMB|%s%%|%s  \", \$4, int(\$1/1024), \$2, \$3}")" >> ~/gpio-soak.log; sleep 600; done' >/dev/null 2>&1 &
   disown
   ```
2. Check it's running: `pgrep -af gpio-soak` (one line) and `tail -2 ~/gpio-soak.log`. Each line
   is a timestamp, then per process `command|memory MB|CPU %|running time`; the GPIO helper
   shows as `python3`, MagicMirror as several `electron` processes and `node`.
3. After 48 hours, read `cat ~/gpio-soak.log`. **Pass:** the helper's memory stays flat (about
   20 MB) and MagicMirror's processes don't keep growing. The CPU % from `ps` is an average over
   each process's whole life; for the current load use
   `top -b -n 2 -d 5 -p $(pgrep -f gpio_helper.py) | tail -2`. Electron's processes share
   memory, so their numbers overlap and don't add up to the total in use.
4. Stop the logger: `pkill -f gpio-soak.log`.

## Data source

WSDOT Traveler Information APIs, WSF section: https://wsdot.wa.gov/traffic/api/
Every call needs `?apiaccesscode=<apiKey>`. Dates come back as `/Date(ms-0700)/`
(see `parseWsdotDate` in `sailings/buildSailings.js`). APIs fail intermittently (e.g. occasional
HTTP 400 "TerminalID is not valid"); the module tolerates this.

Endpoints in use (base `https://www.wsdot.wa.gov/ferries/api`):

| Endpoint | Gives | Used by | When |
|---|---|---|---|
| `/schedule/rest/scheduletoday/{dep}/{arr}/false` | today's sailings for one direction of the route | sailing list | every refresh (logged to DB) |
| `/vessels/rest/vessellocations` | live position, heading, dock status, `LeftDock` / `ScheduledDeparture`, whole fleet | sailing list (delays, departures), map markers | every refresh (logged to DB) |
| `/terminals/rest/terminalsailingspace/{dep}` | drive-up space and cancellations for upcoming departures from the departing terminal | sailing list | every refresh (logged to DB); optional: on failure spaces show `N/A` |
| `/vessels/rest/vesselbasics` | vessel abbreviations (`VesselAbbrev`, e.g. `PUY`) | map marker labels | when the sailings entry registers, then daily (`map/referenceData.js`); not logged |
| `/terminals/rest/terminallocations` | terminal names and latitude/longitude | map terminal markers | when the sailings entry registers, then daily (`map/referenceData.js`); not logged |
| `/schedule/rest/activeseasons` → `/schedule/rest/routes/{date}/{dep}/{arr}` → `/schedule/rest/schedroutes/{ScheduleID}` → `/schedule/rest/sailings/{SchedRouteID}` | the season's published timetable for the route (`sailings`): every day type, with date ranges | sailing list (removed sailings = cancelled) | first fetch of each service day (`sailings/timetable.js`); only `sailings` is logged |

Notes on cancellations (checked against logged data):
- **WSF cancels most sailings by removing them from `scheduletoday`**, not by flagging them.
  `IsCancelled` (space feed) is set only sometimes (e.g. weather). Removals can happen before
  the day starts, and can be undone (a sailing removed for 30 min and then restored, all run
  by a swapped vessel). WSF has also removed a sailing that then ran 45 min late.
- `/schedule/{date}/{dep}/{arr}` for today is identical to `scheduletoday` (also changes);
  past dates are rejected (HTTP 400). Future dates already apply holidays.
- The timetable (`sailings`) doesn't change during the day. Times are times of day on a
  1900-01-01 placeholder date (Pacific standard offset); journeys are in sailing order, so a
  time earlier than the previous one is after midnight. There is no holiday list: groups say
  e.g. "Saturday, Sunday and Holidays", and several variants (2-boat/3-boat, "HOLIDAYS ONLY")
  can be active on the same dates.
- Multi-stop timetables (e.g. `f-v-s`) list only the departure terminal of each journey, not
  where it goes, so they can't be compared with one direction's schedule.

Notes on `terminalsailingspace`:
- A sailing drops off this feed ~1.5–6.5 min after its *scheduled* time, even if the boat
  is late.
- Pick the `SpaceForArrivalTerminals[]` entry whose `TerminalID` (or `ArrivalTerminalIDs`)
  matches the arriving terminal; use `DriveUpSpaceCount` and `MaxSpaceCount`. `IsCancelled`
  is one of two cancellation sources (see notes on cancellations above).
- Matched to scheduled sailings on departure time only (WSF sometimes swaps vessels).

Reference only (not used by the module): `/terminals/rest/terminalbasics` (terminal ID →
name; some names have trailing whitespace, e.g. `"Coupeville "`). 3 = Bainbridge Island,
7 = Seattle.

## Architecture

- `MMM-WaStateFerry.js`: browser side. Sends `REGISTER` **once** on start with its merged
  settings (weather-module pattern), renders `FERRY_SCHEDULE` / `FERRY_ERROR`, pulses the
  icon on `FETCH_STARTED`, turns it red on `DB_STATUS` problems, and shows a one-route notice
  for results with a different `routeKey`. No timer on the page. **Formats every time in
  Seattle time** (`America/Los_Angeles`, not configurable) from the helper's UTC timestamps.
- `node_helper.js`: Node side, **owns the fetch cycle** for the one route. The first
  `REGISTER` stores the settings and starts it; later registrations get the latest result
  immediately with no new fetch. `refresh(trigger)` runs one full cycle (callers: startup,
  timer, pre-departure as `"departure"`, and GPIO buttons as `"manual"`): overlapping
  triggers join the fetch in progress, button presses inside `gpio.buttonCooldown` of the
  last button refresh are ignored, and the timer restarts `updateInterval` after every refresh. `fetchSchedule()` only
  fetches the three feeds, logs them to the DB, calls `buildSailings`, and sends the result
  via `sendResult()` (caches it and tags it with `routeKey`, e.g. `"3-7"`). After each result
  it plans the next pre-departure refresh (`scheduleDepartureRefresh`). It also relays DB
  problems to pages as `DB_STATUS`, and map data as `MAP_READY` / `MAP_POSITIONS`.
- `sailings/`: the sailing list's processing, separate from fetching. `buildSailings.js` is a
  pure step (WSF responses + state + now → rows with **UTC timestamps**); `delays.js` tracks
  per-vessel delays and flushes them at the end of the day; `timetable.js` loads the season's
  timetable once per service day and picks today's expected sailings.
- `MMM-WaStateFerry.njk` + `.css`: template and styles. `MMM-WaStateFerry-map.njk`: the
  map view's template (chosen when `type: "map"`).
- `predictive_helpers/`: prediction-related code, JS and (future) Python side by side.
  `dbWriter.js` writes raw API responses to MariaDB.
- `map/`: the map view, called from node_helper.js (which stays thin). `mapBuilder.js`
  validates settings, computes the view, names cache files, and queues builds;
  `mapWorker.mjs` runs a build in a background thread (`worker_threads`); `renderSvg.mjs`
  draws the SVG; `referenceData.js` keeps vessel abbreviations and terminal locations;
  `vesselPositions.js` turns the vessel feed into marker data. `map_data/`: the NOAA-derived
  map data (see its README). `map_cache/`: generated SVGs (git-ignored).
- `gpio/`: optional LEDs and buttons. `gpioController.js` (Node) validates the settings and
  supervises one `gpio_helper.py` (Python, gpiozero) over stdin/stdout lines; node_helper.js
  tells it the STATUS mode and when refreshes start and finish, and gets button presses back.
- `package.json`: dependencies `mariadb` (DB logging), `@turf/bbox-clip` and `d3-geo`
  (map view); `node_modules/` is git-ignored.

## Design constraint: one route

One route per MagicMirror installation; an entry for a different route is ignored with a
log warning and an on-screen notice. The user-facing explanation and the fork workaround
for a second route are in README.md ("One route per MagicMirror"); keep them in sync.

Notes on the fork workaround: the copy's CSS classes (`MMM-WaStateFerry-*`) and log
prefixes keep the original name (harmless). The "mariadb not installed" message in
`predictive_helpers/dbWriter.js` names the original folder.

## How sailings are interpreted

The WSF APIs don't publish delays, actual departures, or "sailed with" counts; the module
infers them. State is **in memory only** (never on disk) and rebuilds from the next API
calls after a restart.
- **Delay** (`sailings/delays.js`): for a route vessel underway, `LeftDock −
  ScheduledDeparture` on its latest crossing (either direction), added to that vessel's later
  sailings. If `ScheduledDeparture` is missing, the nearest scheduled sailing is used.
  **Flushed** once every sailing of the day has departed, and when the schedule moves to a new
  service day (checked *before* estimates are computed); crossings from before a flush are
  ignored, except that a crossing already underway on the new day's schedule still counts.
  Delays (per vessel) and `sailingMemory` (per sailing on this route) are deliberately
  separate: a vessel's delay can come from a crossing in the other direction.
- **Actual departure** (`sailingMemory`): a vessel is running a sailing when its `VesselID`
  and `ScheduledDeparture` both match it; its `LeftDock` is that sailing's actual departure.
  If WSF swaps the vessel, the match fails and the estimate is used.
- **Departed:** the boat actually left. A boat still at the dock for its sailing stays
  upcoming even if late. With no real data (e.g. after a restart), the estimate decides.
- **Spaces after departure:** the last count seen before the sailing dropped off the space
  feed (i.e. before its scheduled time).
- **Cancellations**, from two sources:
  - The space feed's `IsCancelled`, remembered once seen.
  - **Removed sailings:** a sailing in today's timetable but missing from `scheduletoday` is
    cancelled right away, and normal again if WSF restores it (recomputed every fetch, not
    remembered). Exception: if a vessel leaves this terminal with that sailing's
    `ScheduledDeparture` (any vessel, since WSF swaps them), it is a normal departure with that
    vessel's name. Today's timetable is the active group closest to `scheduletoday` (most
    matches, then fewest extras), so holidays need no list; with under 80% of today's sailings
    matched, or on multi-stop routes, no timetable is used. Times are matched by Seattle clock
    time (settles the repeated hour when daylight time ends). If the timetable fails to load,
    retried after an hour; meanwhile only `IsCancelled` applies.
  - Known gap: right after a restart, a removed sailing whose time has passed may show as
    cancelled even if a boat ran it late (the module didn't see it leave). Accepted.
- Memory entries are pruned 24 hours after their scheduled time.
- **Pre-departure refreshes:** besides the `updateInterval` timer, an extra refresh runs 1
  minute before the next upcoming (non-cancelled) sailing's scheduled and estimated
  departure; re-planned after every refresh, so only the next one is pending.

## Display rules

- **Rows:** every sailing that departed in the last 30 minutes (from the actual departure
  when known), or else the single most recent departure; then up to `maxSailings` upcoming
  sailings (departed rows don't count toward it). Before the first sailing of the day there
  may be no departed row.
- **Columns:** scheduled time | estimated/departed time | drive-up spaces | vessel.
- **Upcoming:** estimated time in italics (`Est:` when delayed), colored by delay: under
  5 min none, 5–30 yellow `#ffcc00`, over 30 to 60 red `#ff6b6b`, over 60 purple
  `#c77dff`. Spaces in italics with a car icon (`fa-car`), colored by percent left: 0%
  purple, up to 10% red, up to 50% yellow, otherwise none; `N/A` if unavailable.
- **Departed:** greyed row; `Dep: <actual time>` (estimate if unknown), not italic; spaces
  show the last count seen, uncolored, not italic.
- **Cancelled:** whole row struck through; estimated time, spaces, and vessel show `N/A`;
  the scheduled time places it in the departed or upcoming section, and it can be the
  "most recent departure".
- **Title:** ferry icon (`fa-ferry`) before the terminal names; it pulses for at least one
  full 2-second cycle during each refresh, and is **red** (`#ff6b6b`) while DB logging is
  configured but has a problem (writes failing or `mariadb` missing). Refreshes swap in
  without a fade (first load fades in).
- **Errors:** an error before any data shows the error message; after data has loaded, a
  failed update keeps the last data and the footer adds "(latest update failed)".
- **Times:** always Seattle time on screen; UTC everywhere in the backend and DB.
- **Fade:** rows fade toward the bottom like the calendar module (`fade`, `fadePoint`);
  the "last updated" line (75% size) is not faded.

## Map view

A display mode of this module: a config entry with `type: "map"` (like the weather
module's `type`). The user-facing description is in README.md ("Map view"); NOAA terms and
how the data was made are in `map_data/README.md`.

**Data:** `map_data/`, NOAA ENC-derived GeoJSON: water, land, coastline lines, and nested
depth layers 30–600 ft, at low/medium/high detail, covering lon −123.35…−122.15,
lat 47.00…48.80.

**Settings** (the entry's `map` group; validated; problems are listed on screen and in the
log; defaults are merged per group, so partial settings keep the rest):
- `map.upperLeft` / `map.lowerRight`: `{ lat, lon }` in decimal degrees, **required, no
  defaults**.
- `map.width` (px, default 400): MagicMirror doesn't tell modules their width, so the height
  follows the area's shape. The aspect ratio is limited to **5:1 … 1:5**, keeping the
  upper-left corner and trimming the right or bottom.
- `map.detail` (`auto` picks low/medium/high from metres per pixel), `map.layers` (depth,
  contours, coastline), `map.colors`, `map.lineWidths`, `map.edgeFade` (default 0.04 per side).
- `map.markers`: `size` (14), `labelSize` (11), `colors` (`otherBoat`, `dockedBoat`,
  `dockedBoatLabel`, `toDeparting`, `toArriving`, `departingTerminal`, `arrivingTerminal`,
  `otherTerminal`), `icons` (`underway`, `docked`, `terminal`: Font Awesome names).
- The page sends these to the helper under the helper's own names (`mapUpperLeft`, `mapWidth`,
  `mapMarkerColors`, …; see Configuration).

**Map image (Pi-friendly):** the helper builds the map **once as an SVG file**, in a
background thread (one build at a time), shown with `<img>` so the browser rasterizes it
once. The SVG is saved in `map_cache/`, named by a hash of everything that changes the
picture (area, size, detail, layers, colors, line widths, plus `DATA_VERSION` and
`BUILDER_VERSION` in `map/mapBuilder.js`); an existing file is reused, never rebuilt, and the
newest 5 are kept. Colors are baked into the SVG (an `<img>` SVG can't use page CSS).
- Default look: land `#333333`; water `#1f3a52`, darkening with depth (`#1a3247`, `#162b3d`,
  `#122433`, `#0e1d2a`, `#0a1620`, `#060f17` for 30→600 ft); contours `rgba(0,0,0,0.25)`
  at 0.5 px; coastline `#626e78` at 1 px.
- Outside the data's coverage: black with light cross-hatching plus an "outside map
  coverage" label (left out when the area is too small for it).
- Edge fade: all four edges fade **to black** via a CSS mask on the map container (so
  markers fade too), never to the land color.

**Markers** (drawn by the page in an overlay over the image; only the overlay's HTML changes
on updates, never the image; markers outside the map are skipped; names are HTML-escaped):
- **Vessels:** in-service only, colored by state: other boats (faint `#3d3d3d`); route boats
  at dock (black `#000000` anchor, so it reads as a mark on its terminal's square; its label
  keeps a light `dockedBoatLabel` color, `#9a9a9a`, to stay readable on water), heading to the
  departing terminal (`#7fa7c9`), or heading to the arriving terminal (`#d8c8a0`). Underway: `fa-location-arrow` rotated to the heading (the
  icon points north-east, so rotate by heading − 45°); at dock: `fa-anchor`, not rotated.
  The vessel **abbreviation** goes **below** the icon.
- **Terminals:** `fa-square`, colored as departing (`#7fa7c9`), arriving (`#d8c8a0`), or
  other (`#666`), with the **full name above** (WSF's abbreviations are unclear, e.g.
  Seattle is `P52`). Overlapping labels at busy terminals are accepted.

**Data flow:**
- Map pages register as **viewers**: they never set the route or start the fetch cycle. The
  sailings entry drives the one fetch cycle, and markers update whenever the list refreshes
  (no separate map timer or map-only fetches).
- The helper replies to each map with `MAP_READY` (image file, size, and view bounds/scale,
  so the page projects lat/lon exactly as the SVG was drawn), addressed by the page's
  identifier, so several maps (different areas) can be on screen at once.
- After each fetch, once a map is shown, the helper broadcasts `MAP_POSITIONS` (vessels and
  terminals, from `map/vesselPositions.js`) and keeps the latest for maps that register
  later; it re-sends when reference data arrives. The static map draws first; markers
  appear after the first fetch result.
- **Map-only configs (no sailings entry) are unsupported:** the static map draws, and the
  helper logs once (about 60 s after a map registers with no sailings entry, since pages
  register in any order) that the map doesn't function without a sailings entry.

**Example map area** used in the README and for testing (not a default): upper-left
47.73803, −122.61430; lower-right 47.57325, −122.29558 (400 × 307 px at `map.width` 400).

## Prediction database

Optional raw logging via `predictive_helpers/dbWriter.js`. The module only **saves** raw
data; parsing, dedup, analysis, and prediction happen in post-processing on the DB side.
- **Enabled when all four keys exist** in the entry's `predictionDb` group (`host`, `user`,
  `password`, `database`), whatever their values. Any key missing → silently off. The page
  forwards only the keys that exist (as `predictionDbHost`, `predictionDbUser`,
  `predictionDbPass`, `predictionDbName`; `port` as `predictionDbPort`).
- Each fetch writes three rows (one per response, same `snapshot_utc`), including HTTP
  errors. Duplicates are fine. The route's timetable (`sailings`) is written once per service
  day, when it loads (one more row per retry if it fails with an HTTP error).
- DB problems are reported to the page (`DB_STATUS`, sent when the status changes) and turn the
  list's title icon red. Every `FERRY_SCHEDULE` / `FERRY_ERROR` (including replays to pages that
  register later) also carries the current `dbProblem`, so a page that missed a `DB_STATUS`
  (e.g. its connection dropped while the Pi was out of memory) corrects itself at the next refresh.
- Schema (created with `CREATE DATABASE/TABLE IF NOT EXISTS`, uncompressed):
  `api_snapshots(id, snapshot_utc DATETIME(3) UTC, endpoint, departing_terminal_id,
  arriving_terminal_id, http_status, body LONGTEXT)`. `endpoint` uses the API's names.
  `http_status`/`body` are NULL if a request got no response.
- `mariadb` is loaded lazily; if the keys are present but the package is missing, one
  clear error says to run `npm install`, and the display keeps working.
- Writes are not awaited and never throw. One connection per flush. If the DB is
  unreachable: an in-memory queue (cap 288 batches, about a day), retried oldest-first;
  one warning when failing starts, one info line on recovery.
- Known gap: a network-level failure (no response) on the schedule or vessels request
  abandons that fetch, so no rows are written for that cycle.
- Querying: bodies are valid JSON (`JSON_VALUE` / `JSON_LENGTH` / `JSON_TABLE`); WSF dates
  stay in `/Date(...)/` form.

## GPIO

Optional STATUS and REFRESH LEDs and refresh buttons on a Raspberry Pi (user-facing
description and wiring in README.md). Each part runs only if its setting is present.
- **STATUS:** off until the first result; then a slow pulse (fade in 5 s, out 5 s: 0.1 Hz) or,
  while any problem is active, a fast pulse (0.25 s each way: 2 Hz). Problems: the latest
  refresh failed, the space feed failed, the timetable failed to load, the DB is failing, or a
  map failed. Resolved by the next successful refresh, a recovered DB write, or a map built.
- **REFRESH:** blinks at 2 Hz (0.25 s on/off) during every refresh, at least 5 blinks
  (2.5 s); a longer refresh blinks until it ends, stopping at the end of a blink.
- **Buttons:** press only (not hold or release), switch to ground with the internal pull-up,
  50 ms debounce; each calls `refresh("manual")`.
- **Both LEDs off** at start and when the module stops.
- **Why Python:** Node GPIO packages (`onoff`, `opengpio`, `node-libgpiod`) are compiled at
  install and have repeatedly broken on Raspberry Pi OS Bookworm / kernel 6.6+ in other
  MagicMirror modules; gpiozero comes with the OS, gives a real fade (software PWM on any pin),
  and handles debounce.
- **Safeguards** (keep them): the helper holds no growing state and changes an LED only on a new
  mode; it exits with both LEDs off on stdin EOF, parent exit, or SIGTERM; setup failures
  (gpiozero missing, pin busy) exit with code 2 and aren't retried; other exits are restarted
  after 10 s, then 60 s, at most 5 in an hour; the controller checks the helper's memory every
  10 min (`/proc/<pid>/status`) and restarts it above 60 MB; stdout lines over 200 characters
  and unknown lines are ignored. GPIO problems never affect the display.
- **Testing:** `tests/gpio.test.js` covers the controller with a stand-in process, the Python
  helper against a stand-in gpiozero (`tests/gpio_stub/`), and node_helper's use of it. Real
  pins only on the Pi: check by hand, and soak-test changes for at least 48 hours with the
  helper's memory and CPU sampled (it should stay flat, about 20 MB; see "Soak test on the Pi").

## Prediction data (planned; not built yet)

Goal: collect and preprocess everything needed to predict sailing **delays** and how fast
sailings **fill**. Modeling itself is a separate, later step, run ad hoc on more powerful
machines. **Built for this one setup:** it doesn't need to be general or work for other users;
anyone else can adapt the code. **Keep this section complete:** every change to the prediction
work updates it in the same pull request (jobs, tables, sources, schedule, how to run and
backfill), and it's checked against the code before merging.

### Data to collect (beyond the WSF feeds the module already logs)

| Data | Why | Source | Limits / cost | Backfill |
|---|---|---|---|---|
| **Weather** at both terminals: hourly temperature, precipitation, cloud cover, WMO weather code | Good weather brings more riders at some times of year | **Open-Meteo** (by coordinates) | Free, no key, non-commercial use; ~10,000 calls/day allowed | Yes: archive back to 1940; the most recent days via the forecast API's past days |
| **Traffic** leading to and from each terminal | Slow traffic leaving a terminal slows unloading and loading, causing backups | **Google Routes API**: traffic-aware vs. normal travel time (WSDOT's API doesn't have the road traffic needed) | Traffic-aware requests bill as Routes **Pro**: 5,000 free/month, then $10 per 1,000. 2 routes every 15 min during service hours ≈ 4,800/month (free); every 5 min around the clock ≈ 17,000 (~$120/month). Billing account required. | No (no historical traffic) |
| **Holidays** | e.g. summer 3-day weekends bring more vehicles | Python `holidays` library (`US`, subdivision `WA`) | Free, computed locally | Yes |
| **School calendars** | School breaks change ridership | No calendar feeds exist (Bainbridge Island SD, Seattle Public Schools): a small hand-maintained table from the districts' yearly calendars (OSPI also lists statewide breaks) | Free; update yearly | Yes |
| **Events** at **Lumen Field** and **T-Mobile Park** only (a short walk from Colman Dock) | Game and concert traffic delays sailings | **Ticketmaster Discovery API** (free key) for upcoming events | 5,000 calls/day | Later: past events from team schedules (MLB's free stats API for the Mariners; a small hand-entered table for others) |
| **WSF bulletins** | WSF posts notices when there are problems | **The WSDOT API already used**: `schedule/rest/alerts` (active alerts: ID, type, affected routes, publish date, text) and `terminals/rest/terminalbulletins/{id}` | Free, same key | No (only active alerts are listed); poll ~every 15 min, dedupe by bulletin ID in processing |

**Traffic is stored only as a score.** Google restricts caching or storing most Maps content
(lat/lng at most 30 days; stored travel times are a grey area). So raw traffic data isn't kept
beyond what processing needs: only a derived **score of general traffic conditions** to and
from each terminal is stored, never detailed data for specific routes or road segments.
Because nothing in `FERRY` can be deleted, raw traffic responses are **never written to
`FERRY`**: the collector computes the score in memory and writes only the score.

### Architecture

- **Runs on the NAS that hosts the DB, not the Pi.** The module on the Pi keeps logging only
  the WSF feeds it fetches for the display.
- **Code lives in this repo, in `predictive_helpers/`**, in Python wherever it doesn't run on
  the Pi. The NAS runs it from its own clone of the repo.
- **Scheduled jobs on the NAS** (DSM Task Scheduler or Docker): collectors (API calls and
  inserts, each source on its own interval), plus a **nightly processing job** after service
  ends that turns the day's raw data into derived tables: one row per sailing (scheduled and
  actual departure, delay, vessel, cancelled), each sailing's fill curve, and the matching
  weather, traffic, holiday, event, and bulletin features. These jobs need little CPU.
- **Raw data is kept; derived data goes in derived tables.** How derived data is written
  (inserted, versioned, or rebuilt) is still to be decided. Prefer doing processing as SQL
  inside MariaDB, including across databases (e.g. `INSERT INTO <derived db>.<table> SELECT
  ... FROM FERRY.api_snapshots ...`; MariaDB 10.11's `JSON_TABLE` can unpack the raw WSF
  JSON), so data never leaves the DB server. The never-delete rule applies to `FERRY`.
- **Settings come from `config.js`**, copied to the NAS like any other machine. Python reads it
  as plain text and pulls out the few values it needs (API keys, DB settings, route IDs) with
  simple regex written for this config, failing clearly if a value isn't found. New collector
  settings (e.g. Google Maps and Ticketmaster keys) go in the sailings entry's `apiKeys`.
- **Order of work:** set up collection for all sources first; then backfill what can be
  backfilled (weather, holidays, school calendars, events) to the start of logging
  (Oct 20, 2026).

### Open questions

- DB privileges: can the DB user create and write a second database (for derived tables)?
- How the traffic score is defined, and which routes feed it.
- Polling interval per source.

## Open work

- **Prediction data collection and processing:** see "Prediction data".
- **Delay prediction** and **fill prediction** (modeling): after the data is collected and
  processed; run ad hoc on more powerful machines, outside this module.

## Rejected ideas

Ideas that were considered and rejected, with the reason, so they aren't proposed again.
Raise one again only if circumstances change (and say what changed).

- **Reusing the schedule via WSF's `cacheflushdate`:** the schedule's flush date changes
  every 5 minutes regardless of content, so skipping unchanged schedules saved almost
  nothing for the added complexity.
- **NWS api.weather.gov for weather data:** it keeps only 7 days of station observations, so
  it can't backfill; Open-Meteo is used instead.
- **A separate indicator for when a backed-up DB queue has been flushed:** not needed. While
  writes are failing (so the queue is backing up), the DB problem is active: red title icon and
  STATUS LED fast pulse. Both clear only on a successful flush, which empties the queue.
- **More than one route per MagicMirror installation:** unsupported by design; a second
  route is ignored with a warning, and the README describes a fork workaround (see
  "Design constraint: one route").
- **Letting a map entry drive the fetch cycle** (map-only configs): unsupported by design;
  keep a sailings entry. (Don't detect "no sailings entry" via MagicMirror's browser
  `config` object.)
- **A durable automated test of the DB write queue and recovery:** not pursued.
