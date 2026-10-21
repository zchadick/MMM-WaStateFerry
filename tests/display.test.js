// Display rule tests (delay colors, space colors, bottom fade). Run from the module directory: node --test
// Loads MMM-WaStateFerry.js with a stand-in for MagicMirror's global Module.register.

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

// Capture the module definition instead of registering it with MagicMirror
let definition = null;
global.Module = { register: (name, def) => { definition = def; } };
require(path.resolve(__dirname, "../MMM-WaStateFerry.js"));

// Methods run with the module's default config, as they would in MagicMirror
const moduleWithConfig = (config = {}) => Object.assign(Object.create(definition), {
  config: { ...definition.defaults, ...config }
});

test("delay colors: none under 5, yellow 5-30, red over 30 to 60, purple over 60", () => {
  const m = moduleWithConfig();
  const cases = [
    [null, ""], [0, ""], [4, ""],
    [5, "delay-yellow"], [30, "delay-yellow"],
    [31, "delay-red"], [60, "delay-red"],
    [61, "delay-purple"], [120, "delay-purple"]
  ];
  for (const [minutes, expected] of cases) {
    assert.strictEqual(m.delayClass(minutes), expected, `delay ${minutes} min`);
  }
});

test("space colors: purple at 0%, red to 10%, yellow to 50%, none above 50%", () => {
  const m = moduleWithConfig();
  const cases = [
    [0, 200, "space-purple"],
    [1, 200, "space-red"], [20, 200, "space-red"],     // 0.5%, 10%
    [21, 200, "space-yellow"], [100, 200, "space-yellow"], // 10.5%, 50%
    [101, 200, ""], [200, 200, ""],                    // 50.5%, 100%
    [null, 200, ""],                                   // no space data (shown as N/A)
    [5, null, ""], [5, 0, ""]                          // no capacity to compare against
  ];
  for (const [count, max, expected] of cases) {
    assert.strictEqual(m.spaceClass(count, max), expected, `${count} of ${max}`);
  }
});

test("bottom fade matches the calendar/weather formula", () => {
  const m = moduleWithConfig();
  // 5 rows, fadePoint 0.25: fade starts at 1.25, so rows 0-1 are full and the rest fade
  const opacities = [0, 1, 2, 3, 4].map(i => Math.round(m.fadeOpacity(i, 5) * 100) / 100);
  assert.deepStrictEqual(opacities, [1, 1, 0.8, 0.53, 0.27]);
});

test("no fade when fade is off", () => {
  const m = moduleWithConfig({ fade: false });
  assert.deepStrictEqual([0, 1, 2, 3, 4].map(i => m.fadeOpacity(i, 5)), [1, 1, 1, 1, 1]);
});
