const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// The light bar patterns (js/actor-models.js lightbarHalf / LIGHTBAR_PATTERN) drive both the lens shader and the
// player's point lights: their flashes must be ones a human eye resolves (the first version stuttered at 31 Hz).
const source = readFileSync(join(__dirname, '../js/actor-models.js'), 'utf8');
const fn = source.match(/function lightbarHalf\(mode, t, side\) \{[\s\S]*?\n\}\n/)?.[0];
assert.ok(fn, 'lightbarHalf is present');
const { lightbarHalf } = vm.runInNewContext(`${fn}; ({ lightbarHalf })`);

// on/off runs of a half over `seconds`, sampled every ms
function runs(mode, side, seconds = 2) {
  const out = [];
  let prev = null, start = 0;
  for (let ms = 0; ms <= seconds * 1000; ms++) {
    const v = lightbarHalf(mode, ms / 1000, side) > 0;
    if (prev === null) { prev = v; start = 0; continue; }
    if (v !== prev) { out.push({ on: prev, ms: ms - start }); prev = v; start = ms; }
  }
  return out;
}

test('mode 0 is dark and mode 1 is a steady dim glow', () => {
  for (let t = 0; t < 3; t += 0.013) {
    assert.equal(lightbarHalf(0, t, 0), 0);
    assert.equal(lightbarHalf(0, t, 1), 0);
    assert.ok(lightbarHalf(1, t, 0) > 0.3 && lightbarHalf(1, t, 0) < 0.6);
  }
});

test('prioritari: the halves alternate once a second with double flashes no shorter than 80 ms', () => {
  const left = runs(2, 0), right = runs(2, 1);
  for (const r of [...left, ...right]) if (r.on) assert.ok(r.ms >= 80 && r.ms <= 120, `flash ${r.ms} ms`);
  assert.equal(left.filter((r) => r.on).length, 4, 'two flashes per cycle, two cycles');
  for (let t = 0; t < 2; t += 0.01) assert.ok(!(lightbarHalf(2, t, 0) && lightbarHalf(2, t, 1)), 'never both halves at once');
});

test('emergència: triple flashes of about 60 ms with 60 ms gaps, 1.25 cycles a second', () => {
  const left = runs(3, 0, 3);
  const flashes = left.filter((r) => r.on);
  for (const r of flashes) assert.ok(r.ms >= 50 && r.ms <= 70, `flash ${r.ms} ms`);
  const gaps = left.filter((r) => !r.on);
  assert.ok(gaps.some((g) => g.ms >= 50 && g.ms <= 70), 'short gaps inside a triple');
  assert.ok(gaps.some((g) => g.ms >= 90), 'a rest between bursts');
  assert.ok(flashes.length >= 20 && flashes.length <= 24, `${flashes.length} flashes in 3 s (3 per 400 ms half, 1.25 Hz)`);
});

test('escombrat: one lit spot crosses the bar and comes back in 1.2 s, never both halves together', () => {
  let swaps = 0, prev = null;
  for (let t = 0; t <= 2.4; t += 0.005) {
    const l = lightbarHalf(4, t, 0) > 0, r = lightbarHalf(4, t, 1) > 0;
    assert.ok(l !== r, 'exactly one half carries the spot');
    if (prev !== null && l !== prev) swaps++;
    prev = l;
  }
  assert.equal(swaps, 4, 'two crossings per 1.2 s cycle');
});
