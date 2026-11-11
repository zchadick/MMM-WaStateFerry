"""Covariate collector: weather at both terminals of the route (see CLAUDE.md "Prediction data").

Normal run (every ~30 min, through events_collect.py): the terminals' coordinates come from
WSDOT's terminallocations (so weather collection fails if WSDOT is down; backfill covers the
gaps), then Open-Meteo's current weather at each terminal. Each response is stored raw in
FERRY_COVARIATES.weather_snapshots (source "current"), one row per terminal. Insert-only.

Backfill: hourly weather for any range of Seattle dates from Open-Meteo's historical forecast
API (the same weather models as "current"), one row per terminal per request (source
"backfill"). Backfilling a range again adds rows; processing keeps the latest per hour.

  python3 events_weather.py                          # one normal run
  python3 events_weather.py backfill 2026-10-20 2026-11-10
  python3 events_weather.py gaps 2026-11-01 2026-11-10   # read-only: half-hours with no snapshot

Units are Open-Meteo's metric defaults (°C, mm, km/h, m).
"""

import argparse
import datetime
import json
import sys
from zoneinfo import ZoneInfo

import events_common as common

TABLE = "weather_snapshots"
COLUMNS = ["snapshot_utc", "source", "terminal_id", "latitude", "longitude", "range_start", "range_end",
           "http_status", "body"]
CREATE_SQL = """CREATE TABLE IF NOT EXISTS {table} (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    snapshot_utc  DATETIME(3) NOT NULL,
    source        VARCHAR(16) NOT NULL,
    terminal_id   INT NOT NULL,
    latitude      DOUBLE NOT NULL,
    longitude     DOUBLE NOT NULL,
    range_start   DATE NULL,
    range_end     DATE NULL,
    http_status   SMALLINT NULL,
    body          LONGTEXT NULL,
    KEY idx_snapshot (snapshot_utc),
    KEY idx_source_terminal_snapshot (source, terminal_id, snapshot_utc)
) DEFAULT CHARSET=utf8mb4"""

FIELDS = ["temperature_2m", "apparent_temperature", "precipitation", "rain", "showers", "snowfall",
          "weather_code", "cloud_cover", "relative_humidity_2m", "visibility", "is_day",
          "wind_speed_10m", "wind_gusts_10m", "wind_direction_10m"]
CURRENT_API = "https://api.open-meteo.com/v1/forecast"
BACKFILL_API = "https://historical-forecast-api.open-meteo.com/v1/forecast"
SEATTLE = ZoneInfo("America/Los_Angeles")
SLOT = datetime.timedelta(minutes=30)


class WeatherError(Exception):
    """The terminals' coordinates couldn't be found."""


def terminal_coordinates(settings, fetch):
    """{terminal_id: (lat, lon)} for both terminals of the route, from WSDOT's terminallocations."""
    status, body = fetch(f"{common.WSDOT_API}/terminals/rest/terminallocations?apiaccesscode={settings['wsdot_key']}")
    if status != 200 or not body:
        raise WeatherError(f"terminal locations unavailable from WSDOT (HTTP {status})")
    locations = {t.get("TerminalID"): t for t in json.loads(body)}
    coordinates = {}
    for terminal in (settings["departing_terminal_id"], settings["arriving_terminal_id"]):
        t = locations.get(terminal)
        if not t or t.get("Latitude") is None or t.get("Longitude") is None:
            raise WeatherError(f"no coordinates for terminal {terminal} in WSDOT's terminal locations")
        coordinates[terminal] = (t["Latitude"], t["Longitude"])
    return coordinates


def current_rows(settings, fetch, now):
    """One normal run: current weather at each terminal, one row each."""
    rows = []
    for terminal, (lat, lon) in terminal_coordinates(settings, fetch).items():
        status, body = fetch(f"{CURRENT_API}?latitude={lat}&longitude={lon}&current={','.join(FIELDS)}&timezone=GMT")
        rows.append([now, "current", terminal, lat, lon, None, None, status, body])
    return rows


def utc_dates(start, end):
    """UTC dates that cover Seattle dates start..end (inclusive), for the historical API."""
    first = datetime.datetime.combine(start, datetime.time(), SEATTLE).astimezone(datetime.timezone.utc)
    after = datetime.datetime.combine(end + datetime.timedelta(days=1), datetime.time(), SEATTLE).astimezone(datetime.timezone.utc)
    return first.date(), after.date()


def backfill_rows(settings, fetch, now, start, end):
    """Hourly weather for Seattle dates start..end at each terminal, one row each (UTC times)."""
    first, last = utc_dates(start, end)
    rows = []
    for terminal, (lat, lon) in terminal_coordinates(settings, fetch).items():
        status, body = fetch(f"{BACKFILL_API}?latitude={lat}&longitude={lon}&start_date={first}&end_date={last}"
                             f"&hourly={','.join(FIELDS)}&timezone=GMT")
        rows.append([now, "backfill", terminal, lat, lon, start, end, status, body])
    return rows


def collect(settings, conn, fetch=common.fetch, now=None):
    """One normal collection run. Returns the number of rows written."""
    rows = current_rows(settings, fetch, now or common.utc_now())
    common.ensure_table(conn, TABLE, CREATE_SQL)
    common.insert_rows(conn, TABLE, COLUMNS, rows)
    return len(rows)


def backfill(settings, conn, start, end, fetch=common.fetch, now=None):
    if end < start:
        raise ValueError("the end date is before the start date")
    rows = backfill_rows(settings, fetch, now or common.utc_now(), start, end)
    common.ensure_table(conn, TABLE, CREATE_SQL)
    common.insert_rows(conn, TABLE, COLUMNS, rows)
    return rows


def gaps(settings, conn, start, end, now=None):
    """Half-hour slots (UTC) in Seattle dates start..end with no successful current snapshot for a
    terminal, merged into ranges: [(terminal, first_slot_start, last_slot_end)]. Read-only."""
    first = datetime.datetime.combine(start, datetime.time(), SEATTLE).astimezone(datetime.timezone.utc).replace(tzinfo=None)
    after = datetime.datetime.combine(end + datetime.timedelta(days=1), datetime.time(), SEATTLE).astimezone(datetime.timezone.utc).replace(tzinfo=None)
    after = min(after, now or common.utc_now())  # don't report the future as missing
    rows = common.select_rows(conn, f"SELECT terminal_id, snapshot_utc FROM `{common.DATABASE}`.`{TABLE}` "
                                    "WHERE source = 'current' AND http_status = 200 AND snapshot_utc >= %s AND snapshot_utc < %s",
                              (first, after))
    seen = {(terminal, int((when - first) / SLOT)) for terminal, when in rows}
    result = []
    for terminal in (settings["departing_terminal_id"], settings["arriving_terminal_id"]):
        open_gap = None
        slot, slots = 0, int((after - first) / SLOT)
        while slot < slots:
            missing = (terminal, slot) not in seen
            if missing and open_gap is None:
                open_gap = slot
            if not missing and open_gap is not None:
                result.append((terminal, first + open_gap * SLOT, first + slot * SLOT))
                open_gap = None
            slot += 1
        if open_gap is not None:
            result.append((terminal, first + open_gap * SLOT, first + slots * SLOT))
    return result


def _date(text):
    return datetime.date.fromisoformat(text)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Weather at the route's terminals (FERRY_COVARIATES.weather_snapshots)")
    sub = parser.add_subparsers(dest="command")
    for name, text in (("backfill", "hourly weather for a range of Seattle dates"),
                       ("gaps", "list half-hours with no current snapshot (read-only)")):
        p = sub.add_parser(name, help=text)
        p.add_argument("start", type=_date, help="first Seattle date, YYYY-MM-DD")
        p.add_argument("end", type=_date, help="last Seattle date, YYYY-MM-DD (included)")
    args = parser.parse_args(argv)

    settings = common.read_settings()
    conn = common.connect(settings)
    try:
        if args.command == "backfill":
            rows = backfill(settings, conn, args.start, args.end)
            for row in rows:
                print(f"weather backfill {args.start}..{args.end}: terminal {row[2]} HTTP {row[7]}")
        elif args.command == "gaps":
            found = gaps(settings, conn, args.start, args.end)
            for terminal, begin, finish in found:
                local = lambda t: t.replace(tzinfo=datetime.timezone.utc).astimezone(SEATTLE).strftime("%Y-%m-%d %H:%M")
                print(f"terminal {terminal}: no snapshot {local(begin)} to {local(finish)} (Seattle time)")
            if not found:
                print("no gaps")
        else:
            print(f"weather: {collect(settings, conn)} row(s) written to {common.DATABASE}.{TABLE}")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
