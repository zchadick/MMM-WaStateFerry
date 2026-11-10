#!/usr/bin/env python3
"""GPIO helper for MMM-WaStateFerry: drives the STATUS and REFRESH LEDs and watches the buttons.

Started and supervised by gpio/gpioController.js (one copy at a time). Uses gpiozero, which comes
with Raspberry Pi OS. Kept deliberately small: no state grows over time, and an LED only changes
when node_helper asks for a different mode.

Arguments:  --status PIN  --refresh PIN  --buttons PIN,PIN,...   (GPIO/BCM numbers; each optional)

Commands, one per line on stdin:
  status off | ok | error    off, slow pulse (0.1 Hz), or fast pulse (2 Hz)
  refresh on | off           blink at 2 Hz, or off
Reports, one per line on stdout:
  ready                      pins claimed, LEDs off
  press PIN                  a button was pressed (press only; release and hold are ignored)
  error MESSAGE              setup failed (then exits with code 2: not worth restarting)

Exits, with both LEDs off, when stdin closes (MagicMirror stopped or crashed), when its parent
process goes away, or on SIGTERM/SIGINT.
"""

import argparse
import os
import signal
import sys
import threading

MAX_LINE = 100           # longer command lines are ignored
BOUNCE_S = 0.05          # button debounce
PARENT_CHECK_S = 2.0     # how often to check that MagicMirror is still running
STATUS_FADES = {"ok": 5.0, "error": 0.25}  # seconds per fade in (and out): 0.1 Hz and 2 Hz
BLINK_S = 0.25           # REFRESH on and off times: 2 Hz

output_lock = threading.Lock()


def report(line):
    with output_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def pins(text):
    return [int(p) for p in text.split(",") if p.strip()] if text else []


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--status", type=int)
    parser.add_argument("--refresh", type=int)
    parser.add_argument("--buttons", type=pins, default=[])
    args = parser.parse_args()

    try:
        from gpiozero import Button, LED, PWMLED
    except ImportError as error:
        report(f"error gpiozero not available ({error}); install it with: sudo apt install python3-gpiozero")
        return 2

    devices = []  # each device is added as soon as it's claimed, so a later failure still releases it
    status = refresh = None
    try:
        if args.status is not None:
            status = PWMLED(args.status)
            devices.append(status)
        if args.refresh is not None:
            refresh = LED(args.refresh)
            devices.append(refresh)
        for led in devices:
            led.off()
        for pin in args.buttons:
            button = Button(pin, pull_up=True, bounce_time=BOUNCE_S)  # switch wired to ground
            button.when_pressed = (lambda p: lambda: report(f"press {p}"))(pin)
            devices.append(button)
    except Exception as error:  # pin busy, bad number, no GPIO on this machine
        report(f"error could not set up GPIO: {error}")
        close(devices)
        return 2

    stopping = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stopping.set())
    signal.signal(signal.SIGINT, lambda *_: stopping.set())

    # Exit if MagicMirror goes away without closing our stdin
    parent = os.getppid()

    def watch_parent():
        while not stopping.wait(PARENT_CHECK_S):
            if os.getppid() != parent:
                stopping.set()

    threading.Thread(target=watch_parent, daemon=True).start()

    # Commands arrive on stdin; EOF means MagicMirror stopped
    def read_commands():
        modes = {"status": None, "refresh": None}
        for line in sys.stdin:
            if stopping.is_set():
                break
            parts = line.split() if len(line) <= MAX_LINE else []
            if len(parts) != 2 or parts[0] not in modes or parts[1] == modes[parts[0]]:
                continue  # unknown, too long, or no change: ignore
            name, mode = parts
            if name == "status" and status and mode in ("off", "ok", "error"):
                if mode == "off":
                    status.off()
                else:
                    status.pulse(fade_in_time=STATUS_FADES[mode], fade_out_time=STATUS_FADES[mode])
                modes[name] = mode
            elif name == "refresh" and refresh and mode in ("on", "off"):
                if mode == "on":
                    refresh.blink(on_time=BLINK_S, off_time=BLINK_S)
                else:
                    refresh.off()
                modes[name] = mode
        stopping.set()

    threading.Thread(target=read_commands, daemon=True).start()
    report("ready")
    try:
        # Short waits keep the main thread responsive to SIGTERM/SIGINT
        while not stopping.wait(1):
            pass
    finally:
        close(devices)
    return 0


def close(devices):
    """Turn the LEDs off and release every pin."""
    for device in devices:
        try:
            if hasattr(device, "off"):
                device.off()
            device.close()
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
