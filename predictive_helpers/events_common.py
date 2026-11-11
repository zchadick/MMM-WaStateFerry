"""Shared code for the covariate collectors (events_*.py): settings, HTTP, and the database.

Built for this one setup (see CLAUDE.md "Prediction data"). Settings come from MagicMirror's
config.js, read as plain text: only the few values the collectors need, from the
MMM-WaStateFerry sailings entry. Data goes to the FERRY_COVARIATES database, insert-only:
nothing here updates or deletes rows.

Needs PyMySQL (pip install PyMySQL). Written for Python 3.9+.
"""

import datetime
import os
import re
import urllib.error
import urllib.request

DATABASE = "FERRY_COVARIATES"
WSDOT_API = "https://www.wsdot.wa.gov/ferries/api"
HTTP_TIMEOUT_S = 30
CONNECT_TIMEOUT_S = 10

# config.js next to this module in a MagicMirror install (modules/MMM-WaStateFerry/predictive_helpers/..)
DEFAULT_CONFIG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "config", "config.js")


class SettingsError(Exception):
    """A value the collectors need wasn't found in config.js."""


def _find(pattern, text, name):
    match = re.search(pattern, text, re.S)
    if not match:
        raise SettingsError(f"{name} not found in config.js (MMM-WaStateFerry sailings entry)")
    return match.group(1)


def read_settings(path=None):
    """The collectors' settings from config.js: WSDOT key, route terminal IDs, and DB settings."""
    path = path or os.environ.get("FERRY_CONFIG", DEFAULT_CONFIG)
    with open(path, encoding="utf-8") as f:
        text = f.read()
    db = _find(r"predictionDb\s*:\s*\{(.*?)\}", text, "predictionDb")
    port = re.search(r"\bport\s*:\s*(\d+)", db)
    return {
        "wsdot_key": _find(r"\bwsdot\s*:\s*\"([^\"]*)\"", text, "apiKeys.wsdot"),
        "departing_terminal_id": int(_find(r"\bdepartingTerminalID\s*:\s*(\d+)", text, "route.departingTerminalID")),
        "arriving_terminal_id": int(_find(r"\barrivingTerminalID\s*:\s*(\d+)", text, "route.arrivingTerminalID")),
        "db_host": _find(r"\bhost\s*:\s*\"([^\"]*)\"", db, "predictionDb.host"),
        "db_port": int(port.group(1)) if port else 3306,
        "db_user": _find(r"\buser\s*:\s*\"([^\"]*)\"", db, "predictionDb.user"),
        "db_password": _find(r"\bpassword\s*:\s*\"([^\"]*)\"", db, "predictionDb.password"),
    }


def fetch(url):
    """GET a URL. Returns (http_status, body_text); (None, None) if no response arrived."""
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_S) as response:
            return response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:  # an HTTP error still has a status and a body worth keeping
        return error.code, error.read().decode("utf-8", "replace")
    except (urllib.error.URLError, OSError):
        return None, None


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)


def connect(settings):
    """A connection to the DB server (no default database; tables are named DATABASE.table)."""
    import pymysql  # loaded here so the tests and config reading work without it
    return pymysql.connect(host=settings["db_host"], port=settings["db_port"], user=settings["db_user"],
                           password=settings["db_password"], connect_timeout=CONNECT_TIMEOUT_S,
                           charset="utf8mb4", autocommit=True)


def ensure_table(conn, table, create_sql):
    """Create the database and the table if they don't exist yet (never alters or drops)."""
    with conn.cursor() as cursor:
        cursor.execute(f"CREATE DATABASE IF NOT EXISTS `{DATABASE}`")
        cursor.execute(create_sql.format(table=f"`{DATABASE}`.`{table}`"))


def select_rows(conn, sql, params=()):
    """Run a read-only query and return all rows."""
    with conn.cursor() as cursor:
        cursor.execute(sql, params)
        return list(cursor.fetchall())


def insert_rows(conn, table, columns, rows):
    """Insert rows (lists of values in column order). Insert-only."""
    if not rows:
        return
    names = ", ".join(columns)
    marks = ", ".join(["%s"] * len(columns))
    with conn.cursor() as cursor:
        cursor.executemany(f"INSERT INTO `{DATABASE}`.`{table}` ({names}) VALUES ({marks})", rows)
