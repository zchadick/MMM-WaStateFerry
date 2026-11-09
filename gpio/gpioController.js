// STATUS and REFRESH LEDs and the refresh buttons on the Pi's GPIO pins, through gpio/gpio_helper.py
// (gpiozero). Optional: nothing runs unless gpioStatusLed, gpioRefreshLed or gpioButtons is set.
// Supervises one copy of the helper: restarts it after a crash (with limits), restarts it if its memory
// passes a limit, and never lets a GPIO problem affect the rest of the module.

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");

const SCRIPT = path.join(__dirname, "gpio_helper.py");
// REFRESH blinks at 2 Hz for at least 5 blinks, and stops at the end of a blink
const BLINK_PERIOD_MS = 500;
const MIN_BLINK_MS = 5 * BLINK_PERIOD_MS;
// After a crash: wait 10 s, then 60 s for each later restart; give up after 5 restarts in an hour
const RESTART_DELAYS_MS = [10 * 1000, 60 * 1000];
const MAX_RESTARTS_PER_HOUR = 5;
// Memory backstop: the helper normally uses about 20-25 MB
const MEMORY_CHECK_MS = 10 * 60 * 1000;
const MEMORY_LIMIT_KB = 60 * 1024;
// Exit code the helper uses when setup failed (pin busy, gpiozero missing): not worth restarting
const SETUP_FAILED = 2;
const MAX_STDERR_CHARS = 1000;

const isPin = value => Number.isInteger(value) && value >= 0 && value <= 27;

// Settings → { pins: { status, refresh, buttons } | null, errors }. Pins are GPIO (BCM) numbers.
function validateGpioConfig(settings) {
  const errors = [];
  const pins = { status: null, refresh: null, buttons: [] };
  for (const [key, name] of [["gpioStatusLed", "status"], ["gpioRefreshLed", "refresh"]]) {
    if (settings[key] === undefined || settings[key] === null) continue;
    if (isPin(settings[key])) pins[name] = settings[key];
    else errors.push(`${key} must be a GPIO number from 0 to 27`);
  }
  if (settings.gpioButtons !== undefined && settings.gpioButtons !== null) {
    if (Array.isArray(settings.gpioButtons) && settings.gpioButtons.every(isPin)) pins.buttons = [...settings.gpioButtons];
    else errors.push("gpioButtons must be a list of GPIO numbers from 0 to 27, e.g. [24, 23]");
  }
  const used = [pins.status, pins.refresh, ...pins.buttons].filter(p => p !== null);
  if (new Set(used).size !== used.length) errors.push("each GPIO number can be used only once");
  if (errors.length > 0 || used.length === 0) return { pins: null, errors };
  return { pins, errors };
}

// Resident memory of a process in KB (Linux /proc), or null if unknown
function readMemoryKb(pid) {
  try {
    const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"));
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function createGpio({ Log, pins, onPress, spawnFn = spawn, memoryKb = readMemoryKb }) {
  const wanted = { status: "off", refresh: "off" }; // what node_helper asked for
  let sent = {};                                     // what the running helper has been told
  let child = null;
  let ready = false;
  let stopped = false;
  let gaveUp = false;
  let restarts = [];
  let restartTimer = null;
  let memoryTimer = null;
  let blinkStartedAt = null;
  let blinkStopTimer = null;

  const unref = timer => { if (timer && timer.unref) timer.unref(); return timer; };
  const tag = "[MMM-WaStateFerry] GPIO";

  function flush() {
    if (!child || !ready) return;
    for (const name of ["status", "refresh"]) {
      if (sent[name] === wanted[name]) continue;
      child.stdin.write(`${name} ${wanted[name]}\n`);
      sent[name] = wanted[name];
    }
  }

  function set(name, mode) {
    wanted[name] = mode;
    flush();
  }

  function handleLine(line) {
    if (line.length > 200) return;
    if (line === "ready") {
      ready = true;
      sent = { status: "off", refresh: "off" }; // the helper starts with both LEDs off
      Log.info(`${tag} ready (STATUS ${pins.status ?? "-"}, REFRESH ${pins.refresh ?? "-"}, buttons ${pins.buttons.join(", ") || "-"})`);
      flush();
    } else if (line.startsWith("press ")) {
      const pin = Number(line.slice(6));
      if (pins.buttons.includes(pin)) onPress(pin);
    } else if (line.startsWith("error ")) {
      Log.error(`${tag}: ${line.slice(6)}`);
    }
  }

  function giveUp(reason) {
    gaveUp = true;
    Log.error(`${tag} turned off: ${reason}. The ferry display keeps working without the LEDs and buttons.`);
  }

  function scheduleRestart() {
    const now = Date.now();
    restarts = restarts.filter(at => now - at < 60 * 60 * 1000);
    if (restarts.length >= MAX_RESTARTS_PER_HOUR) {
      giveUp(`the GPIO helper stopped ${MAX_RESTARTS_PER_HOUR} times within an hour`);
      return;
    }
    const delay = RESTART_DELAYS_MS[Math.min(restarts.length, RESTART_DELAYS_MS.length - 1)];
    restarts.push(now);
    Log.warn(`${tag} helper stopped unexpectedly; restarting in ${delay / 1000} s.`);
    restartTimer = unref(setTimeout(launch, delay));
  }

  function launch() {
    if (stopped || gaveUp) return;
    const args = [SCRIPT];
    if (pins.status !== null) args.push("--status", String(pins.status));
    if (pins.refresh !== null) args.push("--refresh", String(pins.refresh));
    if (pins.buttons.length > 0) args.push("--buttons", pins.buttons.join(","));

    const proc = spawnFn("python3", args, { stdio: ["pipe", "pipe", "pipe"] });
    child = proc;
    ready = false;
    let stderr = "";

    proc.stdin.on("error", () => {}); // the helper exited mid-write: handled by "exit"
    readline.createInterface({ input: proc.stdout }).on("line", handleLine);
    proc.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS); });

    proc.on("error", error => {
      // Python missing or not runnable: no point retrying
      if (child === proc) child = null;
      giveUp(`could not start python3 (${error.message})`);
    });
    proc.on("exit", (code, signal) => {
      if (child === proc) { child = null; ready = false; }
      if (stopped || gaveUp) return;
      if (stderr.trim()) Log.debug(`${tag} helper output: ${stderr.trim()}`);
      if (code === SETUP_FAILED) giveUp("GPIO setup failed (see the error above)");
      else scheduleRestart();
    });
  }

  // Restart the helper if its memory passes the limit (it should stay flat)
  function checkMemory() {
    if (!child || !child.pid) return;
    const kb = memoryKb(child.pid);
    if (kb === null) return;
    Log.debug(`${tag} helper memory: ${Math.round(kb / 1024)} MB`);
    if (kb > MEMORY_LIMIT_KB) {
      Log.warn(`${tag} helper is using ${Math.round(kb / 1024)} MB (limit ${MEMORY_LIMIT_KB / 1024} MB); restarting it.`);
      child.kill("SIGTERM");
    }
  }

  return {
    start() {
      if (child || stopped) return;
      launch();
      memoryTimer = unref(setInterval(checkMemory, MEMORY_CHECK_MS));
    },

    // "off" (no data yet), "ok" (slow pulse), or "error" (fast pulse)
    setStatus(mode) {
      set("status", mode);
    },

    // REFRESH blinks while a refresh runs, for at least 5 blinks
    refreshStarted() {
      clearTimeout(blinkStopTimer);
      if (wanted.refresh !== "on") {
        blinkStartedAt = Date.now();
        set("refresh", "on");
      }
    },

    refreshFinished() {
      if (wanted.refresh !== "on") return;
      const elapsed = Date.now() - blinkStartedAt;
      const total = Math.max(MIN_BLINK_MS, Math.ceil(elapsed / BLINK_PERIOD_MS) * BLINK_PERIOD_MS);
      clearTimeout(blinkStopTimer);
      blinkStopTimer = unref(setTimeout(() => set("refresh", "off"), total - elapsed));
    },

    // Both LEDs off and the helper stopped (closing its input makes it turn the LEDs off and exit)
    stop() {
      stopped = true;
      clearTimeout(restartTimer);
      clearTimeout(blinkStopTimer);
      clearInterval(memoryTimer);
      if (child) {
        const proc = child;
        proc.stdin.end();
        unref(setTimeout(() => { if (proc.exitCode === null) proc.kill("SIGTERM"); }, 3000));
      }
    },

    getState: () => ({ running: Boolean(child), ready, gaveUp, wanted: { ...wanted }, restarts: restarts.length })
  };
}

module.exports = { createGpio, validateGpioConfig, readMemoryKb, MIN_BLINK_MS, BLINK_PERIOD_MS, RESTART_DELAYS_MS, MAX_RESTARTS_PER_HOUR, MEMORY_LIMIT_KB, MEMORY_CHECK_MS, SETUP_FAILED };
