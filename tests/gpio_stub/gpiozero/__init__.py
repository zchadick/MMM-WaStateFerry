# Stand-in for gpiozero, used only by tests/gpio.test.js to run gpio/gpio_helper.py without a Pi.
# Every LED call is written to stderr; FAKE_PRESS=24 presses GPIO24 once shortly after setup;
# FAKE_BUSY=7 makes claiming GPIO7 fail (as if another program had it).
import os
import sys
import threading


def log(text):
    sys.stderr.write(text + "\n")
    sys.stderr.flush()


def claim(pin):
    if str(pin) in os.environ.get("FAKE_BUSY", "").split(","):
        raise RuntimeError(f"GPIO{pin} is busy")


class _Output:
    def __init__(self, pin):
        claim(pin)
        self.name = f"{type(self).__name__}({pin})"

    def off(self):
        log(f"{self.name}.off")

    def close(self):
        log(f"{self.name}.close")


class LED(_Output):
    def blink(self, on_time=1, off_time=1):
        log(f"{self.name}.blink {on_time} {off_time}")


class PWMLED(_Output):
    def pulse(self, fade_in_time=1, fade_out_time=1):
        log(f"{self.name}.pulse {fade_in_time} {fade_out_time}")


class Button:
    def __init__(self, pin, pull_up=True, bounce_time=None):
        claim(pin)
        self.pin = pin
        self.when_pressed = None
        log(f"Button({pin}) pull_up={pull_up} bounce_time={bounce_time}")
        if str(pin) in os.environ.get("FAKE_PRESS", "").split(","):
            threading.Timer(0.3, self._press).start()

    def _press(self):
        if self.when_pressed:
            self.when_pressed()

    def close(self):
        log(f"Button({self.pin}).close")
