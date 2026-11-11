"""Runner for the covariate collectors: the one task scheduled on the NAS, every ~30 minutes.

Runs each collector in turn with one shared DB connection. A collector that fails is logged
and the others still run; the exit code is 1 if any failed (so the scheduler can flag it).
Collectors are added to COLLECTORS as they're built (see CLAUDE.md "Prediction data").

Run:  python3 events_collect.py   (settings from config.js; FERRY_CONFIG overrides its path)
"""

import sys
import traceback

import events_bulletins
import events_common as common

COLLECTORS = [("bulletins", events_bulletins)]


def run(settings, conn, collectors=COLLECTORS, log=print):
    """Run every collector; returns the names of those that failed."""
    failed = []
    for name, module in collectors:
        try:
            written = module.collect(settings, conn)
            log(f"{name}: {written} row(s) written")
        except Exception as error:  # one failing source must not stop the others
            failed.append(name)
            log(f"{name}: FAILED: {error}")
            log(traceback.format_exc().rstrip())
    return failed


def main():
    stamp = common.utc_now().isoformat(timespec="seconds")
    try:
        settings = common.read_settings()
        conn = common.connect(settings)
    except Exception as error:
        print(f"{stamp} UTC collection not started: {error}")
        return 1
    try:
        failed = run(settings, conn, log=lambda line: print(f"{stamp} UTC {line}"))
    finally:
        conn.close()
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
