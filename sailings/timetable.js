// The season's published timetable for the route (WSF schedule API `sailings`). WSF cancels most
// sailings by removing them from today's schedule rather than flagging them, so a timetable sailing
// missing from `scheduletoday` is treated as cancelled (see buildSailings.js).
// Loaded once per service day (first fetch of the day), kept in memory only. Only simple two-terminal
// routes are supported: multi-stop timetables don't say where each departure goes.

const API = "https://www.wsdot.wa.gov/ferries/api/schedule/rest";
const TIME_ZONE = "America/Los_Angeles";
// After a failed load, try again on a fetch at least this much later
const RETRY_MS = 60 * 60 * 1000;
// The best-matching timetable must contain at least this share of today's scheduled sailings;
// otherwise today runs a special schedule and the timetable isn't used
const MIN_MATCH = 0.8;

const seattleFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
});
function seattleParts(ms) {
  return Object.fromEntries(seattleFormat.formatToParts(new Date(ms)).map(p => [p.type, p.value]));
}

// "YYYY-MM-DD" of a timestamp in Seattle
function seattleDate(ms) {
  const p = seattleParts(ms);
  return `${p.year}-${p.month}-${p.day}`;
}

// "YYYY-MM-DD HH:MM" clock time in Seattle
function seattleClock(ms) {
  const p = seattleParts(ms);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

// UTC timestamp of a Seattle date plus minutes after its midnight (may exceed 24 h for after-midnight sailings)
function seattleMs(date, minutes) {
  const [y, m, d] = date.split("-").map(Number);
  const local = new Date(Date.UTC(y, m - 1, d, 0, minutes));
  // Seattle is UTC−7 or UTC−8: keep the offset that reads back as the same local time
  for (const offsetHours of [7, 8]) {
    const ms = local.getTime() + offsetHours * 3600000;
    const p = seattleParts(ms);
    if (Number(p.day) === local.getUTCDate() && Number(p.hour) === local.getUTCHours() && Number(p.minute) === local.getUTCMinutes()) return ms;
  }
  return local.getTime() + 8 * 3600000;
}

// Timetable times are times of day on a placeholder date, e.g. "/Date(-2208940800000-0800)/" = 5:20 AM
function minutesOfDay(wsdotTime) {
  const match = /\((-?\d+)([+-])(\d{2})(\d{2})\)/.exec(String(wsdotTime));
  if (!match) return null;
  const offsetMs = (match[2] === "-" ? -1 : 1) * (Number(match[3]) * 60 + Number(match[4])) * 60000;
  const dayMs = 24 * 3600000;
  return (((Number(match[1]) + offsetMs) % dayMs) + dayMs) % dayMs / 60000;
}

const wsdotMs = value => Number((/\((-?\d+)/.exec(String(value)) || [])[1]);

// Pure: the timetable's sailings from the departing terminal on `date`, as UTC timestamps, or null when
// no timetable for the date matches today's schedule well. `scheduledMs` are today's scheduled departures.
function expectedSailings(groups, departingTerminalID, date, scheduledMs) {
  if (!Array.isArray(groups) || scheduledMs.length === 0) return null;
  const scheduled = new Set(scheduledMs);
  // A scheduled sailing at the same Seattle clock time is the same sailing (this settles the repeated hour
  // when daylight time ends: WSF's timestamp wins)
  const scheduledByClock = new Map(scheduledMs.map(ms => [seattleClock(ms), ms]));
  let best = null;

  for (const group of groups) {
    const active = (group.ActiveDateRanges || []).some(range =>
      seattleDate(wsdotMs(range.DateFrom)) <= date && date <= seattleDate(wsdotMs(range.DateThru)));
    if (!active) continue;

    // Journeys are in sailing order; a time earlier than the one before it is after midnight
    const sailings = [];
    let dayOffset = 0;
    let previous = -1;
    for (const journey of group.Journs || []) {
      const stop = (journey.TerminalTimes || []).find(t => t.TerminalID === departingTerminalID && t.DepArrIndicator === 1 && !t.IsNA);
      const minutes = stop ? minutesOfDay(stop.Time) : null;
      if (minutes === null) continue;
      if (minutes < previous) dayOffset += 24 * 60;
      previous = minutes;
      const ms = seattleMs(date, minutes + dayOffset);
      sailings.push({ scheduledMs: scheduledByClock.get(seattleClock(ms)) ?? ms, vesselID: journey.VesselID, vesselName: journey.VesselName || "" });
    }
    if (sailings.length === 0) continue;

    // Weekday, weekend/holiday, and special variants can all be active: keep the one closest to today's
    // schedule (most matches, then fewest extra sailings), so holidays need no list
    const matches = sailings.filter(s => scheduled.has(s.scheduledMs)).length;
    if (!best || matches > best.matches || (matches === best.matches && sailings.length < best.sailings.length)) {
      best = { matches, sailings };
    }
  }

  if (!best || best.matches < MIN_MATCH * scheduled.size) return null;
  return best.sailings;
}

function createTimetable({ Log }) {
  let loaded = null;     // { key, groups } for one route and service day; groups null = not available that day
  let lastFailure = null; // { key, at }
  let loading = null;

  async function getJson(pathName, apiKey) {
    const res = await fetch(`${API}/${pathName}?apiaccesscode=${apiKey}`, { headers: { Accept: "application/json" } });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} on ${pathName.split("/")[0]}`), { res, text });
    return { json: JSON.parse(text), res, text };
  }

  // Season → route → the route's timetable. `onResponse(httpStatus, body)` receives the raw timetable response.
  async function load({ apiKey, departingTerminalID, arrivingTerminalID, date, onResponse }) {
    const { json: seasons } = await getJson("activeseasons", apiKey);
    const season = (Array.isArray(seasons) ? seasons : []).find(s =>
      seattleDate(wsdotMs(s.ScheduleStart)) <= date && date <= seattleDate(wsdotMs(s.ScheduleEnd)));
    if (!season) return { groups: null, reason: "no active season" };

    const { json: routes } = await getJson(`routes/${date}/${departingTerminalID}/${arrivingTerminalID}`, apiKey);
    const route = Array.isArray(routes) ? routes[0] : null;
    if (!route) return { groups: null, reason: "route not found" };
    if (String(route.RouteAbbrev || "").split("-").length !== 2) return { groups: null, reason: `multi-stop route (${route.RouteAbbrev})` };

    const { json: schedRoutes } = await getJson(`schedroutes/${season.ScheduleID}`, apiKey);
    const schedRoute = (Array.isArray(schedRoutes) ? schedRoutes : []).find(r => r.RouteID === route.RouteID && !r.ContingencyOnly);
    if (!schedRoute) return { groups: null, reason: "no timetable for the route this season" };

    let response;
    try {
      response = await getJson(`sailings/${schedRoute.SchedRouteID}`, apiKey);
    } catch (error) {
      if (error.res) onResponse(error.res.status, error.text);
      throw error;
    }
    onResponse(response.res.status, response.text);

    // Only two departure terminals, so every departure from ours goes to the arriving terminal
    const groups = Array.isArray(response.json) ? response.json : [];
    const departureTerminals = new Set(groups.flatMap(g => (g.Journs || []).flatMap(j => (j.TerminalTimes || [])
      .filter(t => t.DepArrIndicator === 1).map(t => t.TerminalID))));
    if (departureTerminals.size > 2) return { groups: null, reason: "multi-stop route" };
    return { groups };
  }

  // Today's timetable sailings for the route, or null if unavailable. Loads at most once per service day
  // (failures retried after RETRY_MS). Never throws.
  async function expectedFor({ apiKey, departingTerminalID, arrivingTerminalID, scheduledMs, onResponse = () => {} }) {
    if (!scheduledMs.length) return null;
    const date = seattleDate(Math.min(...scheduledMs));
    const key = `${departingTerminalID}-${arrivingTerminalID} ${date}`;

    if (!loaded || loaded.key !== key) {
      const recentFailure = lastFailure && lastFailure.key === key && Date.now() - lastFailure.at < RETRY_MS;
      if (!recentFailure) {
        if (!loading) {
          loading = load({ apiKey, departingTerminalID, arrivingTerminalID, date, onResponse })
            .then(result => {
              loaded = { key, groups: result.groups };
              lastFailure = null;
              if (!result.groups) Log.info(`[MMM-WaStateFerry] Timetable not used for ${date} (${result.reason}); cancellations come only from WSF's cancelled flag.`);
            })
            .catch(error => {
              lastFailure = { key, at: Date.now() };
              Log.warn(`[MMM-WaStateFerry] Timetable not loaded (removed sailings won't show as cancelled until it is): ${error.message}`);
            })
            .finally(() => { loading = null; });
        }
        await loading;
      }
    }

    if (!loaded || loaded.key !== key || !loaded.groups) return null;
    return expectedSailings(loaded.groups, departingTerminalID, date, scheduledMs);
  }

  // True while the latest load attempt failed (cleared by the next successful load)
  return { expectedFor, isFailing: () => lastFailure !== null };
}

module.exports = { createTimetable, expectedSailings, seattleDate, seattleMs, minutesOfDay, RETRY_MS };
