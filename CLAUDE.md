# MMM-WaStateFerry

A MagicMirror² module that shows the live state of one Washington State Ferries (WSF)
route: upcoming and recently departed sailings, scheduled vs. estimated departure,
drive-up space, and vessel. The route is set in MagicMirror's `config/config.js` via
departing/arriving terminal IDs. It can optionally log raw API data to MariaDB for
later delay and fill prediction.

Personal project being prepared for public release. Machine-specific notes live in a
git-ignored `CLAUDE.local.md`.

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
  log output.
- **Keep README.md up to date.** Any change to behavior, configuration options or
  defaults, install/update steps, display rules, or limitations updates the README in the
  same pull request.
- **Flag when `screenshot.png` is out of date.** If a change alters what the module looks
  like on screen (template, CSS, icons, colors, columns, display rules), say so in the
  pull request and remind the maintainer to retake the screenshot. When a new screenshot
  is added, strip its metadata first (keep only the PNG image chunks).

## Runtime

- Designed for a Raspberry Pi 3B: limited CPU and RAM, so keep overhead low (no extra
  interpreters or heavy dependencies on the mirror).
- MagicMirror requires Node >= 22.21.1. `fetch` is used natively (no HTTP library).

## Configuration

Settings go in the module's entry in `config/config.js`:

- `apiKey`: WSDOT Traveler Information API access code
- `departingTerminalID`, `arrivingTerminalID`: the route (default 3 → 7, Bainbridge Island → Seattle)
- `maxSailings`, `updateInterval`, `animationSpeed`, `fade`, `fadePoint`
- `manualRefreshCooldown` (optional, default 30 s): manual (e.g. GPIO) refreshes within
  this time of the last refresh don't fetch; they only pulse the icon
- `predictionDbUser`, `predictionDbPass`, `predictionDbHost`, `predictionDbName`, and
  optional `predictionDbPort` (default 3306): MariaDB logging (see Prediction database)

## Testing

Automated (`tests/`), from the module directory: `node --test` (or `npm test`).
- `display.test.js`, `sailings.test.js`, `fetching.test.js`: stand-in API data and a mock
  clock; no network or DB needed.
- `db.test.js`: connects to the configured DB and writes to a `TEMPORARY` test table;
  **skipped** (not failed) if any DB key is missing from config.js.
  `KEEP_TEST_TABLE=1 node --test` writes to a kept `test_api_snapshots_<timestamp>` table instead.

Manual: run `node --run server` from the MagicMirror root and open http://localhost:8080.
Check the module's log lines in the server output. Stop the server when done.

## Data source

WSDOT Traveler Information APIs, WSF section: https://wsdot.wa.gov/traffic/api/
Every call needs `?apiaccesscode=<apiKey>`. Dates come back as `/Date(ms-0700)/`
(see `parseWsdotDate` in node_helper.js). APIs fail intermittently (e.g. occasional
HTTP 400 "TerminalID is not valid"); the module tolerates this.

Endpoints in use:
- `/ferries/api/schedule/rest/scheduletoday/{dep}/{arr}/false`: today's sailings for one
  direction of the route.
- `/ferries/api/vessels/rest/vessellocations`: live position and dock status, whole fleet.
- `/ferries/api/terminals/rest/terminalsailingspace/{dep}`: drive-up space for upcoming
  departures from the departing terminal. Optional (on failure, spaces show `N/A`).
  - A sailing drops off this feed ~1.5–6.5 min after its *scheduled* time, even if the
    boat is late.
  - Pick the `SpaceForArrivalTerminals[]` entry whose `TerminalID` (or
    `ArrivalTerminalIDs`) matches the arriving terminal; use `DriveUpSpaceCount` and
    `MaxSpaceCount`. `IsCancelled` is the only source of cancellations.
  - Matched to scheduled sailings on departure time only (WSF sometimes swaps vessels).

Reference: `/ferries/api/terminals/rest/terminalbasics` (terminal ID → name; some names
have trailing whitespace, e.g. `"Coupeville "`). 3 = Bainbridge Island, 7 = Seattle.

## Architecture

- `MMM-WaStateFerry.js`: browser side. Sends `REGISTER` **once** on start with its merged
  settings (weather-module pattern), renders `FERRY_SCHEDULE` / `FERRY_ERROR`, pulses the
  icon on `FETCH_STARTED`, and shows a one-route notice for results with a different
  `routeKey`. No timer on the page.
- `node_helper.js`: Node side, **owns the fetch cycle** for the one route. The first
  `REGISTER` stores the settings and starts it; later registrations get the latest result
  immediately with no new fetch. `refresh(trigger)` runs one full cycle (callers: startup,
  timer, and in future pre-departure and GPIO as `"manual"`): overlapping triggers join the
  fetch in progress, manual triggers inside `manualRefreshCooldown` only pulse, and the
  timer restarts `updateInterval` after every refresh. `fetchSchedule()` fetches the three
  feeds, logs them to the DB, builds the sailing rows, and sends the result via
  `sendResult()` (caches it and tags it with `routeKey`, e.g. `"3-7"`).
- `MMM-WaStateFerry.njk` + `.css`: template and styles.
- `predictive_helpers/`: prediction-related code, JS and (future) Python side by side.
  `dbWriter.js` writes raw API responses to MariaDB.
- `package.json`: only dependency is `mariadb` (needed only for DB logging);
  `node_modules/` is git-ignored.

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
- **Delay:** for a route vessel underway, `LeftDock − ScheduledDeparture`, cached per vessel
  (`vesselDelayCache`) and added to that vessel's later sailings. If `ScheduledDeparture`
  is missing, the nearest scheduled sailing is used.
- **Actual departure** (`sailingMemory`): a vessel is running a sailing when its `VesselID`
  and `ScheduledDeparture` both match it; its `LeftDock` is that sailing's actual departure.
  If WSF swaps the vessel, the match fails and the estimate is used.
- **Departed:** the boat actually left. A boat still at the dock for its sailing stays
  upcoming even if late. With no real data (e.g. after a restart), the estimate decides.
- **Spaces after departure:** the last count seen before the sailing dropped off the space
  feed (i.e. before its scheduled time); "close enough" for now.
- **Cancellations:** remembered from the space feed's `IsCancelled`.
- Memory entries are pruned 24 hours after their scheduled time.

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
  full 2-second cycle during each refresh. Refreshes swap in without a fade (first load
  fades in).
- **Fade:** rows fade toward the bottom like the calendar module (`fade`, `fadePoint`);
  the "last updated" line (75% size) is not faded.

## Prediction database

Optional raw logging via `predictive_helpers/dbWriter.js`. The module only **saves** raw
data; parsing, dedup, analysis, and prediction happen in post-processing on the DB side.
- **Enabled when all four keys exist** in the module's config (`predictionDbUser`,
  `predictionDbPass`, `predictionDbHost`, `predictionDbName`), whatever their values.
  Any key missing → silently off. The page forwards only the keys that exist.
- Each fetch writes three rows (one per response, same `snapshot_utc`), including HTTP
  errors. Duplicates are fine.
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

## Roadmap

1. **Data collection** to MariaDB: done (raw API logging).
2. **Delay prediction:** not started.
3. **Drive-up space display:** done (live and last-seen counts).
4. **Fill prediction:** not started.
5. **Pi GPIO** (status LEDs and buttons): planned; see below.
6. **Map view** of live vessel positions: future idea, as a second *view* of the same
   route (e.g. `display: "map"`), not a second route.

## Backlog

- **Refresh just before departures:** an extra fetch ~1 minute before each scheduled
  and/or estimated departure, to catch the latest space count and status.
- **Use the WSF `/cacheflushdate` endpoints** (`schedule`, `vessels`, `terminals`) to skip
  re-fetching unchanged data. Open: which calls it governs (likely only `scheduletoday`);
  the conflict with logging every raw response; the midnight rollover.
- **A durable test of the DB write cache and recovery:** never yet exercised. Ideas: an
  opt-in test driving `createDbWriter` with a wrong then right password; or a real DB
  outage longer than a fetch interval.
- **Visual indicators** on the display for active DB write problems, and for a backed-up
  queue being flushed.
- **Errors:** the template checks "loaded" before "error", so an error on the first fetch
  shows "Loading…" forever; after a successful load, a later error replaces the whole
  table instead of keeping the last data.
- **Time zones:** `formatTime` uses the server's zone; `formatLastUpdated` forces
  America/Los_Angeles.
- `vesselDelayCache` is never reset, so delays can carry over to the next day.
- **Lower-priority architecture findings:** `vesselDelayCache` and `sailingMemory` overlap;
  `fetchSchedule()` is one large function; times are formatted server-side.

## Pi GPIO plan (not started)

Two status LEDs and two push buttons on the Pi's GPIO pins: the LEDs show service status;
a button triggers a manual refresh via `refresh("manual")` (cooldown already built).
- Optional, like DB logging: off unless configured; the module must work without GPIO.
- Runs in node_helper.js. Newer Raspberry Pi OS versions changed GPIO access (the old
  sysfs approach used by `onoff` may not work); libgpiod is an option. Check the OS first.
- Open: pin numbers and wiring; what each LED shows (on/off/blinking); what the second
  button does.

## Before going public

Done: git history audited for secrets (clean, all branches, 2026-10-30); README.md written
(including the one-route constraint and the browser-visible config note); LICENSE.md
reviewed (MIT, zchadick). Remaining: the maintainer switches the repo to public on GitHub.
