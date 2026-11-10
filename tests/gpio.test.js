// GPIO LEDs and buttons: settings, the supervisor (gpio/gpioController.js) with a stand-in helper process,
// the Python helper itself (gpio/gpio_helper.py) against a stand-in gpiozero, and node_helper's use of it.
// No Pi needed. The Python tests are skipped if python3 isn't installed.

const { test, mock } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { spawn, spawnSync } = require("node:child_process");
const Module = require("node:module");
const {
  createGpio, validateGpioConfig, MIN_BLINK_MS, RESTART_DELAYS_MS, MAX_RESTARTS_PER_HOUR, MEMORY_LIMIT_KB, MEMORY_CHECK_MS, SETUP_FAILED
} = require("../gpio/gpioController");

const SCRIPT = path.resolve(__dirname, "../gpio/gpio_helper.py");
const tick = () => new Promise(resolve => setImmediate(resolve));
const quietLog = () => {
  const log = { info: [], warn: [], error: [], debug: [] };
  return { log, Log: { info: m => log.info.push(m), warn: m => log.warn.push(m), error: m => log.error.push(m), debug: m => log.debug.push(m), log() {} } };
};

// Stand-in for spawn(): records each helper process and what it was told
function fakeSpawn() {
  const fn = (command, args) => {
    const child = new EventEmitter();
    Object.assign(child, { command, args, pid: 4000 + fn.spawned.length, exitCode: null, commands: [], signals: [] });
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin.on("data", data => child.commands.push(...String(data).split("\n").filter(Boolean)));
    child.kill = signal => child.signals.push(signal);
    child.ready = async () => { child.stdout.write("ready\n"); await tick(); };
    child.exit = async code => { child.exitCode = code; child.emit("exit", code, null); await tick(); };
    fn.spawned.push(child);
    return child;
  };
  fn.spawned = [];
  return fn;
}
const PINS = { status: 12, refresh: 7, buttons: [24, 23] };
const newGpio = (extra = {}) => {
  const spawnFn = fakeSpawn();
  const { log, Log } = quietLog();
  const presses = [];
  const gpio = createGpio({ Log, pins: PINS, onPress: pin => presses.push(pin), spawnFn, memoryKb: () => 20 * 1024, ...extra });
  return { gpio, spawnFn, log, presses };
};

// ---- Settings ----

test("settings: GPIO numbers for each part; nothing configured means no GPIO at all", () => {
  assert.deepStrictEqual(validateGpioConfig({}), { pins: null, errors: [] });
  assert.deepStrictEqual(validateGpioConfig({ gpioStatusLed: 12, gpioRefreshLed: 7, gpioButtons: [24, 23] }).pins, PINS);
  assert.deepStrictEqual(validateGpioConfig({ gpioButtons: [24] }).pins, { status: null, refresh: null, buttons: [24] }, "each part on its own");
});

test("settings: invalid or repeated numbers turn GPIO off with a reason", () => {
  for (const [settings, message] of [
    [{ gpioStatusLed: 40 }, /gpioStatusLed must be a GPIO number/],
    [{ gpioRefreshLed: "7" }, /gpioRefreshLed must be a GPIO number/],
    [{ gpioButtons: 24 }, /gpioButtons must be a list/],
    [{ gpioButtons: [24, 1.5] }, /gpioButtons must be a list/],
    [{ gpioStatusLed: 12, gpioButtons: [12] }, /only once/]
  ]) {
    const { pins, errors } = validateGpioConfig(settings);
    assert.strictEqual(pins, null);
    assert.match(errors.join("; "), message);
  }
});

// ---- Supervisor (gpioController.js) with a stand-in helper ----

test("starts one python3 helper with the configured pins", () => {
  const { gpio, spawnFn } = newGpio();
  gpio.start();
  gpio.start();
  assert.strictEqual(spawnFn.spawned.length, 1);
  assert.strictEqual(spawnFn.spawned[0].command, "python3");
  assert.deepStrictEqual(spawnFn.spawned[0].args, [SCRIPT, "--status", "12", "--refresh", "7", "--buttons", "24,23"]);
  gpio.stop();
});

test("LED commands go out once the helper is ready, and only when a mode changes", async () => {
  const { gpio, spawnFn } = newGpio();
  gpio.start();
  const child = spawnFn.spawned[0];
  gpio.setStatus("ok");
  await tick();
  assert.deepStrictEqual(child.commands, [], "nothing before ready");
  await child.ready();
  assert.deepStrictEqual(child.commands, ["status ok"]);
  gpio.setStatus("ok");
  gpio.setStatus("error");
  gpio.setStatus("off");
  await tick();
  assert.deepStrictEqual(child.commands, ["status ok", "status error", "status off"]);
  gpio.stop();
});

test("REFRESH blinks for at least 5 blinks, and a longer refresh until it ends (on a blink boundary)", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
  try {
    const { gpio, spawnFn } = newGpio();
    gpio.start();
    const child = spawnFn.spawned[0];
    await child.ready();

    // Quick refresh (1 s): still 5 blinks = 2.5 s
    gpio.refreshStarted();
    mock.timers.tick(1000);
    gpio.refreshFinished();
    mock.timers.tick(MIN_BLINK_MS - 1000 - 1);
    await tick();
    assert.deepStrictEqual(child.commands, ["refresh on"], "still blinking just before 2.5 s");
    mock.timers.tick(1);
    await tick();
    assert.deepStrictEqual(child.commands, ["refresh on", "refresh off"]);

    // Slow refresh (3.2 s): blinks until the end of the blink it ends in (3.5 s)
    child.commands.length = 0;
    gpio.refreshStarted();
    mock.timers.tick(3200);
    gpio.refreshFinished();
    mock.timers.tick(299);
    await tick();
    assert.deepStrictEqual(child.commands, ["refresh on"]);
    mock.timers.tick(1);
    await tick();
    assert.deepStrictEqual(child.commands, ["refresh on", "refresh off"]);

    // A new refresh during the last blinks just keeps blinking
    child.commands.length = 0;
    gpio.refreshStarted();
    mock.timers.tick(500);
    gpio.refreshFinished();
    mock.timers.tick(1000);
    gpio.refreshStarted();
    mock.timers.tick(5000);
    await tick();
    assert.deepStrictEqual(child.commands, ["refresh on"], "no off while the second refresh runs");
    gpio.refreshFinished();
    mock.timers.tick(MIN_BLINK_MS);
    await tick();
    assert.deepStrictEqual(child.commands, ["refresh on", "refresh off"]);
    gpio.stop();
  } finally {
    mock.timers.reset();
  }
});

test("button presses reach node_helper only for configured buttons", async () => {
  const { gpio, spawnFn, presses } = newGpio();
  gpio.start();
  const child = spawnFn.spawned[0];
  await child.ready();
  child.stdout.write("press 24\npress 5\npress 23\nnonsense\n" + "x".repeat(5000) + "\n");
  await tick();
  assert.deepStrictEqual(presses, [24, 23]);
  gpio.stop();
});

test("a crashed helper restarts after 10 s, then 60 s, re-sends the LED modes, and gives up after 5 in an hour", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
  try {
    const { gpio, spawnFn, log } = newGpio();
    gpio.start();
    await spawnFn.spawned[0].ready();
    gpio.setStatus("error");

    await spawnFn.spawned[0].exit(1);
    mock.timers.tick(RESTART_DELAYS_MS[0] - 1);
    assert.strictEqual(spawnFn.spawned.length, 1);
    mock.timers.tick(1);
    assert.strictEqual(spawnFn.spawned.length, 2, "restarted after 10 s");
    await spawnFn.spawned[1].ready();
    assert.deepStrictEqual(spawnFn.spawned[1].commands, ["status error"], "current mode re-sent");

    await spawnFn.spawned[1].exit(1);
    mock.timers.tick(RESTART_DELAYS_MS[1]);
    assert.strictEqual(spawnFn.spawned.length, 3, "then after 60 s");

    for (let i = 3; i <= MAX_RESTARTS_PER_HOUR; i++) {
      await spawnFn.spawned.at(-1).exit(1);
      mock.timers.tick(RESTART_DELAYS_MS[1]);
    }
    assert.strictEqual(spawnFn.spawned.length, MAX_RESTARTS_PER_HOUR + 1);
    await spawnFn.spawned.at(-1).exit(1);
    mock.timers.tick(10 * RESTART_DELAYS_MS[1]);
    assert.strictEqual(spawnFn.spawned.length, MAX_RESTARTS_PER_HOUR + 1, "no restart after 5 within an hour");
    assert.strictEqual(gpio.getState().gaveUp, true);
    assert.match(log.error.join(), /stopped 5 times within an hour/);
    gpio.stop();
  } finally {
    mock.timers.reset();
  }
});

test("setup failures and a missing python3 are not retried", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
  try {
    const setupFailed = newGpio();
    setupFailed.gpio.start();
    setupFailed.spawnFn.spawned[0].stdout.write("error could not set up GPIO: GPIO7 is busy\n");
    await tick();
    await setupFailed.spawnFn.spawned[0].exit(SETUP_FAILED);
    mock.timers.tick(10 * RESTART_DELAYS_MS[1]);
    assert.strictEqual(setupFailed.spawnFn.spawned.length, 1);
    assert.match(setupFailed.log.error.join(), /GPIO7 is busy/);

    const noPython = newGpio();
    noPython.gpio.start();
    noPython.spawnFn.spawned[0].emit("error", Object.assign(new Error("spawn python3 ENOENT"), { code: "ENOENT" }));
    mock.timers.tick(10 * RESTART_DELAYS_MS[1]);
    assert.strictEqual(noPython.spawnFn.spawned.length, 1);
    assert.match(noPython.log.error.join(), /could not start python3/);
  } finally {
    mock.timers.reset();
  }
});

test("memory backstop: a helper over the limit is restarted", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
  try {
    let kb = 20 * 1024;
    const { gpio, spawnFn, log } = newGpio({ memoryKb: () => kb });
    gpio.start();
    await spawnFn.spawned[0].ready();
    mock.timers.tick(MEMORY_CHECK_MS);
    assert.deepStrictEqual(spawnFn.spawned[0].signals, [], "normal memory: left alone");
    kb = MEMORY_LIMIT_KB + 1;
    mock.timers.tick(MEMORY_CHECK_MS);
    assert.deepStrictEqual(spawnFn.spawned[0].signals, ["SIGTERM"]);
    assert.match(log.warn.join(), /restarting it/);
    await spawnFn.spawned[0].exit(0);
    mock.timers.tick(RESTART_DELAYS_MS[0]);
    assert.strictEqual(spawnFn.spawned.length, 2);
    gpio.stop();
  } finally {
    mock.timers.reset();
  }
});

test("stop closes the helper's input (it turns the LEDs off and exits) and never restarts it", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
  try {
    const { gpio, spawnFn } = newGpio();
    gpio.start();
    const child = spawnFn.spawned[0];
    await child.ready();
    gpio.stop();
    assert.strictEqual(child.stdin.writableEnded, true);
    await child.exit(0);
    mock.timers.tick(10 * RESTART_DELAYS_MS[1]);
    assert.strictEqual(spawnFn.spawned.length, 1);
  } finally {
    mock.timers.reset();
  }
});

test("stop: a helper that doesn't exit within 3 s is terminated", () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
  try {
    const { gpio, spawnFn } = newGpio();
    gpio.start();
    gpio.stop();
    mock.timers.tick(3000);
    assert.deepStrictEqual(spawnFn.spawned[0].signals, ["SIGTERM"]);
  } finally {
    mock.timers.reset();
  }
});

// ---- The Python helper against a stand-in gpiozero ----

const hasPython = spawnSync("python3", ["--version"]).status === 0;
const STUB = path.resolve(__dirname, "gpio_stub");

// Run gpio_helper.py; resolves with its stdout/stderr lines and exit code once it exits
function runHelper(args, { env = {}, input = null, afterReady = null, stub = true } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", [SCRIPT, ...args], { env: { ...process.env, PYTHONPATH: stub ? STUB : "", PYTHONDONTWRITEBYTECODE: "1", ...env } });
    const out = [];
    let err = "";
    let buffer = "";
    const timer = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error(`helper timed out; stdout: ${out}; stderr: ${err}`)); }, 8000);
    proc.stdout.on("data", data => {
      buffer += data;
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        out.push(line);
        if (line === "ready" && afterReady) afterReady(proc);
      }
    });
    proc.stderr.on("data", data => { err += data; });
    if (input !== null) proc.stdin.end(input);
    proc.on("exit", code => { clearTimeout(timer); resolve({ out, err: err.split("\n").filter(Boolean), code }); });
  });
}

test("python helper: LEDs start off, change only on new modes, report presses, and end off when input closes", { skip: !hasPython }, async () => {
  const result = await runHelper(["--status", "12", "--refresh", "7", "--buttons", "24,23"], {
    env: { FAKE_PRESS: "24" },
    afterReady: proc => {
      proc.stdin.write("status ok\nstatus ok\nrefresh on\nbogus line\nstatus purple\n" + "x".repeat(500) + "\nstatus error\nrefresh off\n");
      setTimeout(() => proc.stdin.end(), 600); // after the stand-in press
    }
  });
  assert.strictEqual(result.code, 0);
  assert.deepStrictEqual(result.out, ["ready", "press 24"]);
  assert.deepStrictEqual(result.err, [
    "PWMLED(12).off", "LED(7).off",
    "Button(24) pull_up=True bounce_time=0.05", "Button(23) pull_up=True bounce_time=0.05",
    "PWMLED(12).pulse 5.0 5.0", "LED(7).blink 0.25 0.25", "PWMLED(12).pulse 0.25 0.25", "LED(7).off",
    "PWMLED(12).off", "PWMLED(12).close", "LED(7).off", "LED(7).close", "Button(24).close", "Button(23).close"
  ]);
});

test("python helper: SIGTERM turns the LEDs off and exits cleanly", { skip: !hasPython }, async () => {
  const result = await runHelper(["--status", "12"], {
    afterReady: proc => { proc.stdin.write("status ok\n"); setTimeout(() => proc.kill("SIGTERM"), 300); }
  });
  assert.strictEqual(result.code, 0);
  assert.deepStrictEqual(result.err.slice(-3), ["PWMLED(12).pulse 5.0 5.0", "PWMLED(12).off", "PWMLED(12).close"]);
});

test("python helper: a busy pin is a setup failure (exit 2), with pins already claimed released", { skip: !hasPython }, async () => {
  const result = await runHelper(["--status", "12", "--refresh", "7"], { env: { FAKE_BUSY: "7" }, input: "" });
  assert.strictEqual(result.code, SETUP_FAILED);
  assert.match(result.out.join(), /error could not set up GPIO: GPIO7 is busy/);
  assert.deepStrictEqual(result.err, ["PWMLED(12).off", "PWMLED(12).close"], "the LED already claimed is turned off and released");
});

const hasRealGpiozero = hasPython && spawnSync("python3", ["-c", "import gpiozero"]).status === 0;
test("python helper: without gpiozero it explains how to install it (exit 2)", { skip: !hasPython || hasRealGpiozero }, async () => {
  const result = await runHelper(["--status", "12"], { stub: false, input: "" });
  assert.strictEqual(result.code, SETUP_FAILED);
  assert.match(result.out.join(), /gpiozero not available.*sudo apt install python3-gpiozero/);
});

// ---- node_helper: STATUS from active problems, REFRESH around each refresh, buttons, stop ----

const HELPER_PATH = path.resolve(__dirname, "../node_helper.js");
const MIN = 60 * 1000;
const at = (h, m) => Date.UTC(2026, 9, 23, h + 7, m);
const wsdot = ms => `/Date(${ms}-0700)/`;

// Fake GPIO controller recording what node_helper asks of it
let fakeGpio = null;
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "node_helper") return { create: def => def };
  if (request === "logger") return { log() {}, info() {}, warn() {}, error() {}, debug() {} };
  if (request === "./gpio/gpioController") {
    const real = originalLoad.call(this, request, ...rest);
    return {
      ...real,
      createGpio: options => {
        fakeGpio = { options, calls: [], start() { this.calls.push("start"); }, stop() { this.calls.push("stop"); },
          setStatus(mode) { this.calls.push(`status ${mode}`); }, refreshStarted() { this.calls.push("refresh on"); },
          refreshFinished() { this.calls.push("refresh done"); } };
        return fakeGpio;
      }
    };
  }
  return originalLoad.call(this, request, ...rest);
};

let api = null;
// The helper under test, stopped after each test even if it fails, so its real timers never keep the run alive
let currentHelper = null;
test.afterEach(() => { if (currentHelper) { currentHelper.stop(); currentHelper = null; } });
function setupHelper() {
  delete require.cache[HELPER_PATH];
  const helper = require(HELPER_PATH);
  currentHelper = helper;
  helper.sent = [];
  helper.sendSocketNotification = (notification, payload) => helper.sent.push({ notification, payload });
  helper.dbWriter = { write() {} };
  helper.start();
  fakeGpio = null;
  api = { calls: 0, failSchedule: false, failSpace: false };
  global.fetch = async url => {
    if (url.includes("scheduletoday")) {
      api.calls++;
      if (api.failSchedule) return new Response("down", { status: 500 });
      return Response.json({ TerminalCombos: [{ DepartingTerminalName: "Bainbridge Island", ArrivingTerminalName: "Seattle",
        Times: [{ DepartingTime: wsdot(at(11, 0)), VesselID: 25, VesselName: "Puyallup" }] }] });
    }
    if (url.includes("vessellocations")) return Response.json([]);
    if (url.includes("terminalsailingspace")) return api.failSpace ? new Response("bad", { status: 400 }) : Response.json({ DepartingSpaces: [] });
    if (url.includes("activeseasons")) return Response.json([]);
    return Response.json([]);
  };
  return helper;
}
const helperSettings = (extra = {}) => ({ departingTerminalID: 3, arrivingTerminalID: 7, apiKey: "test", maxSailings: 5,
  updateInterval: 5 * MIN, manualRefreshCooldown: 30 * 1000, ...extra });
const GPIO_SETTINGS = { gpioStatusLed: 12, gpioRefreshLed: 7, gpioButtons: [24, 23] };
const settle = async helper => { for (let i = 0; i < 6; i++) { if (helper.inFlight) await helper.inFlight; await tick(); } };

test("node_helper: no GPIO settings, no GPIO", async () => {
  const helper = setupHelper();
  helper.register(helperSettings());
  await settle(helper);
  assert.strictEqual(fakeGpio, null);
  helper.stop();
});

test("node_helper: STATUS is off until the first result, then slow pulse; REFRESH wraps each refresh", async () => {
  const helper = setupHelper();
  helper.register(helperSettings(GPIO_SETTINGS));
  assert.deepStrictEqual(fakeGpio.options.pins, PINS);
  await settle(helper);
  assert.deepStrictEqual(fakeGpio.calls, ["start", "status off", "refresh on", "status ok", "refresh done"]);
  helper.stop();
  assert.strictEqual(fakeGpio.calls.at(-1), "stop", "LEDs off when the module stops");
});

test("node_helper: any active problem means fast pulse; it clears when resolved", async () => {
  const helper = setupHelper();
  helper.register(helperSettings(GPIO_SETTINGS));
  await settle(helper);
  const status = () => fakeGpio.calls.filter(c => c.startsWith("status")).at(-1);
  const refresh = async () => { helper.lastManualAt = -Infinity; await helper.refresh("manual"); await settle(helper); };

  api.failSchedule = true;
  await refresh();
  assert.strictEqual(status(), "status error", "failed refresh");
  api.failSchedule = false;
  await refresh();
  assert.strictEqual(status(), "status ok", "resolved by the next successful refresh");

  api.failSpace = true;
  await refresh();
  assert.strictEqual(status(), "status error", "sailing-space feed failed");
  api.failSpace = false;
  await refresh();
  assert.strictEqual(status(), "status ok");

  helper.setDbProblem(true);
  assert.strictEqual(status(), "status error", "DB problem");
  helper.setDbProblem(false);
  assert.strictEqual(status(), "status ok", "DB write recovered");

  helper.setMapProblem("module_9", true);
  assert.strictEqual(status(), "status error", "map failed");
  helper.setMapProblem("module_9", false);
  assert.strictEqual(status(), "status ok");

  helper.getTimetable().isFailing = () => true;
  await refresh();
  assert.strictEqual(status(), "status error", "timetable failed to load");
  helper.stop();
});

test("node_helper: a button press triggers a refresh (cooldown applies)", async () => {
  const helper = setupHelper();
  helper.register(helperSettings(GPIO_SETTINGS));
  await settle(helper);
  fakeGpio.options.onPress(24);
  await settle(helper);
  assert.strictEqual(api.calls, 2, "press refreshed");
  fakeGpio.options.onPress(23);
  await settle(helper);
  assert.strictEqual(api.calls, 2, "second press within 30 s ignored");
  helper.stop();
});

test("node_helper: GPIO settings don't reach the fetch or DB settings", async () => {
  const helper = setupHelper();
  let fetchSettings = null;
  const original = helper.fetchSchedule;
  helper.fetchSchedule = function (s) { fetchSettings = s; return original.call(this, s); };
  helper.register(helperSettings(GPIO_SETTINGS));
  await settle(helper);
  assert.ok(!("gpioButtons" in fetchSettings) && !("gpioStatusLed" in fetchSettings) && !("gpioRefreshLed" in fetchSettings));
  helper.stop();
});
