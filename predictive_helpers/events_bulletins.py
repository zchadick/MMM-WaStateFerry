"""Covariate collector: WSF bulletins (see CLAUDE.md "Prediction data").

Each run stores the raw responses, unchanged, in FERRY_COVARIATES.bulletin_snapshots:
  - schedule/rest/alerts: every active WSF alert, all routes
  - terminals/rest/terminalbulletins/{id}: bulletins for each terminal on the route
One row per response (snapshot time, endpoint, terminal ID, HTTP status, raw body), including
HTTP errors; no row content is parsed here. Processing later filters to the route, works out
when each bulletin appeared and disappeared, and deduplicates by bulletin ID. Insert-only.

Run on its own:  python3 events_bulletins.py   (or through events_collect.py)
"""

import sys

import events_common as common

TABLE = "bulletin_snapshots"
COLUMNS = ["snapshot_utc", "endpoint", "terminal_id", "http_status", "body"]
CREATE_SQL = """CREATE TABLE IF NOT EXISTS {table} (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    snapshot_utc  DATETIME(3) NOT NULL,
    endpoint      VARCHAR(64) NOT NULL,
    terminal_id   INT NULL,
    http_status   SMALLINT NULL,
    body          LONGTEXT NULL,
    KEY idx_snapshot (snapshot_utc),
    KEY idx_endpoint_snapshot (endpoint, snapshot_utc)
) DEFAULT CHARSET=utf8mb4"""


def build_rows(settings, fetch, now):
    """Fetch the alerts and both terminals' bulletins; one row per response, same snapshot time."""
    key = settings["wsdot_key"]
    requests = [("alerts", None, f"{common.WSDOT_API}/schedule/rest/alerts?apiaccesscode={key}")]
    for terminal in (settings["departing_terminal_id"], settings["arriving_terminal_id"]):
        requests.append(("terminalbulletins", terminal,
                         f"{common.WSDOT_API}/terminals/rest/terminalbulletins/{terminal}?apiaccesscode={key}"))
    rows = []
    for endpoint, terminal, url in requests:
        status, body = fetch(url)
        rows.append([now, endpoint, terminal, status, body])
    return rows


def collect(settings, conn, fetch=common.fetch, now=None):
    """One collection run: fetch and insert. Returns the number of rows written."""
    rows = build_rows(settings, fetch, now or common.utc_now())
    common.ensure_table(conn, TABLE, CREATE_SQL)
    common.insert_rows(conn, TABLE, COLUMNS, rows)
    return len(rows)


def main():
    settings = common.read_settings()
    conn = common.connect(settings)
    try:
        written = collect(settings, conn)
    finally:
        conn.close()
    print(f"bulletins: {written} row(s) written to {common.DATABASE}.{TABLE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
