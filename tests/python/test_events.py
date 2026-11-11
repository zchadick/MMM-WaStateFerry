"""Tests for the covariate collectors (predictive_helpers/events_*.py). No network, no DB.

Run from the module directory:  python3 -m unittest discover -s tests/python -v
"""

import datetime
import glob
import os
import re
import sys
import tempfile
import unittest

HELPERS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "predictive_helpers")
sys.path.insert(0, HELPERS)

import events_bulletins  # noqa: E402
import events_collect  # noqa: E402
import events_common  # noqa: E402
import events_weather  # noqa: E402

# Shaped like the real config.js: other modules, a map entry first, then the sailings entry
SAMPLE_CONFIG = """let config = {
	modules: [
		{ module: "clock", position: "top_left" },
		{
			module: "MMM-WaStateFerry",
			config: {
				type: "map",
				map: { upperLeft: { lat: 47.7, lon: -122.6 }, lowerRight: { lat: 47.5, lon: -122.3 }, width: 410 }
			}
		},
		{
			module: "MMM-WaStateFerry",
			config: {
				apiKeys: { wsdot: "TEST-KEY" },
				route: { departingTerminalID: 3, arrivingTerminalID: 7 }, // Bainbridge → Seattle
				display: { maxSailings: 5, updateInterval: 5 * 60 * 1000 },
				predictionDb: {
					host: "db-host",
					user: "db-user",
					password: "p@ss/word!",
					database: "FERRY"
				}
			}
		}
	]
};
if (typeof module !== "undefined") { module.exports = config; }
"""


def write_config(text):
    f = tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8")
    f.write(text)
    f.close()
    return f.name


class FakeConnection:
    """Records every SQL statement and the rows inserted."""

    def __init__(self, select_result=()):
        self.statements = []
        self.inserted = []
        self.params = []
        self.select_result = list(select_result)

    def cursor(self):
        conn = self

        class Cursor:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def execute(self, sql, params=None):
                conn.statements.append(sql)
                conn.params.append(params)

            def fetchall(self):
                return conn.select_result

            def executemany(self, sql, rows):
                conn.statements.append(sql)
                conn.inserted.extend(rows)

        return Cursor()


NOW = datetime.datetime(2026, 11, 10, 20, 30, 0)
SETTINGS = {"wsdot_key": "TEST-KEY", "departing_terminal_id": 3, "arriving_terminal_id": 7}


class ReadSettingsTest(unittest.TestCase):
    def test_reads_the_values_the_collectors_need_from_the_sailings_entry(self):
        path = write_config(SAMPLE_CONFIG)
        try:
            settings = events_common.read_settings(path)
        finally:
            os.unlink(path)
        self.assertEqual(settings, {
            "wsdot_key": "TEST-KEY", "departing_terminal_id": 3, "arriving_terminal_id": 7,
            "db_host": "db-host", "db_port": 3306, "db_user": "db-user", "db_password": "p@ss/word!"})

    def test_port_is_read_when_set(self):
        path = write_config(SAMPLE_CONFIG.replace('database: "FERRY"', 'database: "FERRY",\n\t\t\t\t\tport: 3307'))
        try:
            self.assertEqual(events_common.read_settings(path)["db_port"], 3307)
        finally:
            os.unlink(path)

    def test_a_missing_value_fails_clearly_naming_the_setting(self):
        path = write_config(SAMPLE_CONFIG.replace('wsdot: "TEST-KEY"', ""))
        try:
            with self.assertRaisesRegex(events_common.SettingsError, r"apiKeys\.wsdot not found"):
                events_common.read_settings(path)
        finally:
            os.unlink(path)

    def test_the_config_path_can_come_from_FERRY_CONFIG(self):
        path = write_config(SAMPLE_CONFIG)
        os.environ["FERRY_CONFIG"] = path
        try:
            self.assertEqual(events_common.read_settings()["wsdot_key"], "TEST-KEY")
        finally:
            del os.environ["FERRY_CONFIG"]
            os.unlink(path)


class BulletinsTest(unittest.TestCase):
    def test_fetches_alerts_and_both_terminals_bulletins_and_keeps_raw_responses(self):
        urls = []

        def fetch(url):
            urls.append(url)
            if "terminalbulletins/7" in url:
                return 500, "server error"   # HTTP errors are kept too
            if "terminalbulletins/3" in url:
                return None, None            # no response at all
            return 200, '[{"BulletinID": 1}]'

        rows = events_bulletins.build_rows(SETTINGS, fetch, NOW)
        self.assertEqual([u.split("?")[0] for u in urls], [
            "https://www.wsdot.wa.gov/ferries/api/schedule/rest/alerts",
            "https://www.wsdot.wa.gov/ferries/api/terminals/rest/terminalbulletins/3",
            "https://www.wsdot.wa.gov/ferries/api/terminals/rest/terminalbulletins/7"])
        self.assertTrue(all(u.endswith("?apiaccesscode=TEST-KEY") for u in urls))
        self.assertEqual(rows, [
            [NOW, "alerts", None, 200, '[{"BulletinID": 1}]'],
            [NOW, "terminalbulletins", 3, None, None],
            [NOW, "terminalbulletins", 7, 500, "server error"]])

    def test_collect_creates_the_table_if_needed_and_inserts_one_row_per_response(self):
        conn = FakeConnection()
        written = events_bulletins.collect(SETTINGS, conn, fetch=lambda url: (200, "[]"), now=NOW)
        self.assertEqual(written, 3)
        self.assertEqual(conn.statements[0], "CREATE DATABASE IF NOT EXISTS `FERRY_COVARIATES`")
        self.assertIn("CREATE TABLE IF NOT EXISTS `FERRY_COVARIATES`.`bulletin_snapshots`", conn.statements[1])
        self.assertTrue(conn.statements[2].startswith(
            "INSERT INTO `FERRY_COVARIATES`.`bulletin_snapshots` (snapshot_utc, endpoint, terminal_id, http_status, body)"))
        self.assertEqual(len(conn.inserted), 3)


LOCATIONS = '[{"TerminalID": 3, "Latitude": 47.622, "Longitude": -122.509}, {"TerminalID": 7, "Latitude": 47.602, "Longitude": -122.338}, {"TerminalID": 1, "Latitude": 48.5, "Longitude": -122.6}]'


def weather_fetch(urls, wsdot=(200, LOCATIONS), weather=(200, '{"current": {}}')):
    def fetch(url):
        urls.append(url)
        return wsdot if "terminallocations" in url else weather
    return fetch


class WeatherTest(unittest.TestCase):
    def test_a_normal_run_gets_coordinates_from_wsdot_then_current_weather_at_both_terminals(self):
        urls = []
        rows = events_weather.current_rows(SETTINGS, weather_fetch(urls), NOW)
        self.assertEqual(urls[0], "https://www.wsdot.wa.gov/ferries/api/terminals/rest/terminallocations?apiaccesscode=TEST-KEY")
        fields = ",".join(events_weather.FIELDS)
        self.assertEqual(urls[1:], [
            f"https://api.open-meteo.com/v1/forecast?latitude=47.622&longitude=-122.509&current={fields}&timezone=GMT",
            f"https://api.open-meteo.com/v1/forecast?latitude=47.602&longitude=-122.338&current={fields}&timezone=GMT"])
        self.assertEqual(rows, [
            [NOW, "current", 3, 47.622, -122.509, None, None, 200, '{"current": {}}'],
            [NOW, "current", 7, 47.602, -122.338, None, None, 200, '{"current": {}}']])

    def test_the_run_fails_clearly_when_wsdot_has_no_coordinates(self):
        with self.assertRaisesRegex(events_weather.WeatherError, r"unavailable from WSDOT \(HTTP 503\)"):
            events_weather.current_rows(SETTINGS, weather_fetch([], wsdot=(503, "down")), NOW)
        with self.assertRaisesRegex(events_weather.WeatherError, r"no coordinates for terminal 7"):
            events_weather.current_rows(SETTINGS, weather_fetch([], wsdot=(200, '[{"TerminalID": 3, "Latitude": 1, "Longitude": 2}]')), NOW)

    def test_an_open_meteo_error_is_stored_like_any_response(self):
        rows = events_weather.current_rows(SETTINGS, weather_fetch([], weather=(None, None)), NOW)
        self.assertEqual([r[7:] for r in rows], [[None, None], [None, None]])

    def test_backfill_requests_the_utc_dates_covering_the_seattle_dates_hourly(self):
        urls = []
        start, end = datetime.date(2026, 10, 31), datetime.date(2026, 11, 1)  # spans the end of daylight time
        rows = events_weather.backfill_rows(SETTINGS, weather_fetch(urls), NOW, start, end)
        fields = ",".join(events_weather.FIELDS)
        # Seattle Oct 31 00:00 PDT = Oct 31 07:00 UTC; Nov 2 00:00 PST = Nov 2 08:00 UTC
        self.assertEqual(urls[1], "https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=47.622&longitude=-122.509"
                                  f"&start_date=2026-10-31&end_date=2026-11-02&hourly={fields}&timezone=GMT")
        self.assertEqual([r[:7] for r in rows], [
            [NOW, "backfill", 3, 47.622, -122.509, start, end],
            [NOW, "backfill", 7, 47.602, -122.338, start, end]])

    def test_collect_and_backfill_write_to_weather_snapshots(self):
        conn = FakeConnection()
        self.assertEqual(events_weather.collect(SETTINGS, conn, fetch=weather_fetch([]), now=NOW), 2)
        events_weather.backfill(SETTINGS, conn, datetime.date(2026, 10, 20), datetime.date(2026, 10, 21), fetch=weather_fetch([]), now=NOW)
        self.assertIn("CREATE TABLE IF NOT EXISTS `FERRY_COVARIATES`.`weather_snapshots`", conn.statements[1])
        self.assertTrue(conn.statements[2].startswith("INSERT INTO `FERRY_COVARIATES`.`weather_snapshots` (snapshot_utc, source, terminal_id"))
        self.assertEqual([r[1] for r in conn.inserted], ["current", "current", "backfill", "backfill"])
        with self.assertRaisesRegex(ValueError, "before the start"):
            events_weather.backfill(SETTINGS, conn, datetime.date(2026, 10, 21), datetime.date(2026, 10, 20), fetch=weather_fetch([]))

    def test_gaps_lists_half_hours_without_a_snapshot_per_terminal_and_only_reads(self):
        # Seattle Nov 10 (PST) = Nov 10 08:00 UTC to Nov 11 08:00 UTC; "now" is 10:00 UTC, so 4 slots so far
        day = datetime.date(2026, 11, 10)
        t = lambda h, m: datetime.datetime(2026, 11, 10, h, m)
        snapshots = [(3, t(8, 1)), (3, t(8, 31)), (3, t(9, 31)),   # terminal 3 misses 09:00-09:30
                     (7, t(8, 1))]                                   # terminal 7 misses 08:30-10:00
        conn = FakeConnection(select_result=snapshots)
        found = events_weather.gaps(SETTINGS, conn, day, day, now=t(10, 0))
        self.assertEqual(found, [(3, t(9, 0), t(9, 30)), (7, t(8, 30), t(10, 0))])
        self.assertTrue(all(sql.lstrip().upper().startswith("SELECT") for sql in conn.statements), conn.statements)
        self.assertEqual(conn.params[0], (t(8, 0), t(10, 0)))


class RunnerTest(unittest.TestCase):
    def test_a_failing_collector_is_logged_and_the_others_still_run(self):
        ran = []

        class Broken:
            @staticmethod
            def collect(settings, conn):
                raise RuntimeError("source down")

        class Working:
            @staticmethod
            def collect(settings, conn):
                ran.append("working")
                return 2

        lines = []
        failed = events_collect.run(SETTINGS, FakeConnection(), [("broken", Broken), ("working", Working)], log=lines.append)
        self.assertEqual(failed, ["broken"])
        self.assertEqual(ran, ["working"])
        self.assertIn("broken: FAILED: source down", lines)
        self.assertIn("working: 2 row(s) written", lines)

    def test_every_collector_is_registered(self):
        self.assertEqual([name for name, _ in events_collect.COLLECTORS], ["bulletins", "weather"])


class InsertOnlyTest(unittest.TestCase):
    def test_no_collector_code_can_delete_or_overwrite_data(self):
        # Owner's rule: Claude never deletes or overwrites data in FERRY or FERRY_COVARIATES
        forbidden = re.compile(r"\b(DELETE\s+FROM|DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\b|UPDATE\s+\S+\s+SET"
                               r"|REPLACE\s+INTO|ALTER\s+TABLE|INSERT\s+.*?ON\s+DUPLICATE)", re.I | re.S)
        paths = glob.glob(os.path.join(HELPERS, "events_*.py"))
        self.assertGreater(len(paths), 0)
        for path in paths:
            with open(path, encoding="utf-8") as f:
                code = f.read()
            match = forbidden.search(code)
            self.assertIsNone(match, f"{os.path.basename(path)}: {match and match.group(0)}")
        # The check itself catches such statements
        self.assertIsNotNone(forbidden.search('cursor.execute("DELETE FROM `FERRY_COVARIATES`.`t`")'))


if __name__ == "__main__":
    unittest.main()
