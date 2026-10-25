const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

// The driving model (js/vehicle-physics.js) is pure arithmetic: these are the numeric acceptance tests NEXT_STEPS.md
// §2.1.2 asked for (braking 50→0 km/h in under 20 m, lateral grip about 1 g, no creeping at rest, gravity on a slope),
// plus the sign conventions the controller relies on (turning left = heading up, body leaning out of the bend, nose
// down under braking).
const source = readFileSync(join(__dirname, '../js/vehicle-physics.js'), 'utf8');
const physics = loadModule(source, { filename: 'vehicle-physics.js' });
const { VEHICLE_CATALOGUE, vehicleById, createVehicleState, stepVehicle, torqueFraction, gearLabel } = physics;

const flat = { groundAt: () => 0 };
const DT = 1 / 60;
const drive = (s, input, seconds, env = flat) => {
  for (let t = 0; t < seconds - 1e-9; t += DT) stepVehicle(s, input, DT, env);
  return s;
};
const rolling = (spec, kmh) => {
  const s = createVehicleState(spec);
  s.vz = kmh / 3.6;
  s.speed = s.vz;
  return s;
};

test('the catalogue has distinct, complete vehicles and a fallback', () => {
  assert.ok(VEHICLE_CATALOGUE.length >= 5);
  assert.equal(new Set(VEHICLE_CATALOGUE.map((v) => v.id)).size, VEHICLE_CATALOGUE.length);
  for (const v of VEHICLE_CATALOGUE) {
    for (const key of ['label', 'body', 'mass', 'torqueNm', 'redline', 'gears', 'finalDrive', 'mu', 'brakeForce', 'suspension', 'steerLock']) {
      assert.ok(v[key] !== undefined, `${v.id} lacks ${key}`);
    }
    assert.ok(['sedan', 'suv', 'taxi'].includes(v.body), `${v.id} body loft`);
    assert.ok([0, 1, 2].includes(v.livery), `${v.id} livery`);
    assert.ok(v.gears.every((g, i) => i === 0 || g < v.gears[i - 1]), `${v.id} gear ratios fall`);
  }
  assert.equal(vehicleById('nothing-like-this').id, VEHICLE_CATALOGUE[0].id);
  assert.ok(VEHICLE_CATALOGUE.some((v) => v.livery === 2 && /Mossos/.test(v.label)), 'a Mossos patrol car');
  assert.ok(VEHICLE_CATALOGUE.some((v) => v.livery === 1 && /Municipal/.test(v.label)), 'a Policia Municipal patrol car');
});

test('the torque curve is a hump that never drops out', () => {
  assert.ok(torqueFraction(0.55) > torqueFraction(0.2));
  assert.ok(torqueFraction(0.55) > torqueFraction(1.0));
  for (let r = 0; r <= 1; r += 0.05) assert.ok(torqueFraction(r) >= 0.45 && torqueFraction(r) <= 1);
});

test('a parked car stays parked, on the flat and on a city slope', () => {
  const s = drive(createVehicleState(vehicleById('taxi')), { throttle: 0, brake: 0, steer: 0 }, 3);
  assert.ok(Math.hypot(s.x, s.z) < 0.01, 'no creep on the flat');
  const hill = { groundAt: (x, z) => 0.08 * z }; // 8 % climbing ahead
  const held = drive(createVehicleState(vehicleById('taxi')), { throttle: 0, brake: 1, steer: 0 }, 3, hill);
  assert.ok(Math.abs(held.z) < 0.02, 'the brakes hold it on the hill');
  const idle = drive(createVehicleState(vehicleById('taxi')), { throttle: 0, brake: 0, steer: 0 }, 3, hill);
  assert.ok(Math.abs(idle.z) < 0.05, 'an automatic creeping in D holds a gentle slope');
  assert.ok(Math.abs(idle.slopePitch - Math.atan(0.08)) < 1e-3, 'the slope under the car is measured');
});

test('gravity pulls a free-rolling car down a steep street', () => {
  const steep = { groundAt: (x, z) => 0.2 * z }; // 20 %, beyond what the creep holds
  const s = drive(createVehicleState(vehicleById('taxi')), { throttle: 0, brake: 0, steer: 0 }, 4, steep);
  assert.ok(s.speed < -1, `rolls backwards: ${s.speed}`);
  assert.ok(s.z < -2);
});

test('full throttle from rest reaches 100 km/h in a plausible time and shifts up through the gears', () => {
  for (const [id, min, max] of [['taxi', 9, 14], ['hot', 4, 7], ['suv', 8, 12]]) {
    const s = createVehicleState(vehicleById(id));
    let t = 0;
    while (t < 30 && s.speed * 3.6 < 100) { stepVehicle(s, { throttle: 1, brake: 0, steer: 0 }, DT, flat); t += DT; }
    assert.ok(t >= min && t <= max, `${id} 0-100 km/h in ${t.toFixed(1)} s`);
    assert.ok(s.gear >= 3, `${id} is in gear ${s.gear} at 100 km/h`);
    assert.ok(s.rpm > s.spec.idle && s.rpm <= s.spec.redline);
    assert.ok(Math.abs(s.x) < 0.5 && Math.abs(s.heading) < 1e-3, 'drives straight');
  }
});

test('top speed is bounded by drag and the gearing', () => {
  const s = drive(createVehicleState(vehicleById('taxi')), { throttle: 1, brake: 0, steer: 0 }, 90);
  const kmh = s.speed * 3.6;
  assert.ok(kmh > 150 && kmh < 215, `taxi top speed ${kmh.toFixed(0)} km/h`);
});

test('braking from 50 km/h stops in under 20 m with the nose down, with and without ABS', () => {
  for (const abs of [true, false]) {
    const spec = { ...vehicleById('compact'), abs };
    const s = rolling(spec, 50);
    let dist = 0, t = 0, minPitch = 0, locked = false;
    while (t < 10 && s.speed > 0.05) {
      const z0 = s.z;
      stepVehicle(s, { throttle: 0, brake: 1, steer: 0 }, DT, flat);
      dist += s.z - z0;
      t += DT;
      minPitch = Math.min(minPitch, s.pitch);
      locked = locked || s.wheels.some((w) => w.locked);
    }
    assert.ok(dist < 20 && dist > 6, `stops in ${dist.toFixed(1)} m (abs ${abs})`);
    assert.ok(minPitch < -0.015, 'the nose dives under braking');
    assert.equal(locked, !abs, 'without ABS the wheels lock');
  }
});

test('steering left turns left, with the body leaning out of the bend and about 0.7 g of lateral grip', () => {
  const s = rolling(vehicleById('compact'), 54);
  drive(s, { throttle: 0.35, brake: 0, steer: 0.22 }, 4);
  assert.ok(s.heading > 0.5, `heading ${s.heading}`);
  assert.ok(s.yawRate > 0.15);
  assert.ok(s.x > 5, 'moved to its left (+x when facing +z)');
  assert.ok(s.roll > 0.01, `leans out: roll ${s.roll}`);
  assert.ok(s.accelLat > 3 && s.accelLat < 9, `lateral acceleration ${s.accelLat}`);
  assert.ok(s.skid < 0.5, `within the tyres (skid ${s.skid})`);
});

test('the tyres saturate: full lock at speed produces about 1 g, not more', () => {
  const s = rolling(vehicleById('compact'), 80);
  let peak = 0;
  for (let t = 0; t < 3; t += DT) {
    stepVehicle(s, { throttle: 0.4, brake: 0, steer: 1 }, DT, flat);
    peak = Math.max(peak, Math.abs(s.accelLat));
  }
  assert.ok(peak < 12.5, `peak lateral ${peak.toFixed(1)} m/s² stays near the friction limit`);
  assert.ok(peak > 6);
});

test('the handbrake locks the rear axle and lets the car rotate', () => {
  const s = rolling(vehicleById('compact'), 40);
  drive(s, { throttle: 0, brake: 0, steer: 0.6, handbrake: true }, 1.5);
  assert.ok(s.wheels[2].locked && s.wheels[3].locked, 'rear wheels locked');
  assert.ok(!s.wheels[0].locked && !s.wheels[1].locked, 'front wheels roll');
  const plain = drive(rolling(vehicleById('compact'), 40), { throttle: 0, brake: 0, steer: 0.6 }, 1.5);
  assert.ok(s.heading > plain.heading * 1.3, `rotates more than without it (${s.heading.toFixed(2)} vs ${plain.heading.toFixed(2)})`);
  assert.ok(s.skid > 0.5, 'audible skid');
});

test('reverse engages only from a standstill and drives backwards', () => {
  const s = rolling(vehicleById('taxi'), 30);
  drive(s, { throttle: 0, brake: 1, steer: 0, reverse: true }, 0.2);
  assert.ok(s.gear > 0, 'still rolling forward: no R yet');
  drive(s, { throttle: 0, brake: 1, steer: 0, reverse: true }, 3);
  assert.equal(s.gear, -1);
  drive(s, { throttle: 0.5, brake: 0, steer: 0, reverse: true }, 3);
  assert.ok(s.speed < -2, `reversing at ${s.speed}`);
  assert.equal(gearLabel(s), 'R');
  drive(s, { throttle: 0, brake: 1, steer: 0 }, 3);
  drive(s, { throttle: 0.5, brake: 0, steer: 0 }, 2);
  assert.equal(s.gear, 1);
  assert.ok(s.speed > 1);
});

test('independent wheels: a kerb under one side tilts the car and loads that side', () => {
  const kerb = { groundAt: (x) => (x > 0.2 ? 0.15 : 0) }; // the car's left wheels (+x when facing +z) on the kerb
  const s = drive(createVehicleState(vehicleById('taxi')), { throttle: 0, brake: 1, steer: 0 }, 2, kerb);
  assert.ok(Math.abs(s.slopeRoll - Math.atan(0.15 / s.track)) < 0.01, 'the ground plane tilts left side up');
  assert.ok(s.wheels[0].groundY > s.wheels[1].groundY, 'FL higher than FR');
  // a bump under one wheel only (a stone): that wheel compresses and carries more
  const stone = { groundAt: (x, z) => (x > 0.2 && z > 0.5 ? 0.06 : 0) };
  const b = drive(createVehicleState(vehicleById('taxi')), { throttle: 0, brake: 1, steer: 0 }, 2, stone);
  assert.ok(b.wheels[0].comp > b.wheels[1].comp + 0.01, 'the front-left spring is compressed');
  assert.ok(b.wheels[0].load > b.wheels[1].load + 200, 'and carries more load');
});

test('speed-sensitive steering: less lock at speed, and the wheel angle is rate limited', () => {
  const slow = drive(rolling(vehicleById('taxi'), 5), { throttle: 0.2, brake: 0, steer: 1 }, 1);
  const fast = drive(rolling(vehicleById('taxi'), 100), { throttle: 0.2, brake: 0, steer: 1 }, 1);
  assert.ok(slow.steer > fast.steer * 2, `${slow.steer} vs ${fast.steer}`);
  const s = createVehicleState(vehicleById('taxi'));
  stepVehicle(s, { throttle: 0, brake: 0, steer: 1 }, DT, flat);
  assert.ok(s.steer < s.spec.steerLock * 0.2, 'one frame does not reach full lock');
});

test('the model is stable through a long drive with a frame-rate hitch', () => {
  const s = createVehicleState(vehicleById('hot'));
  for (let i = 0; i < 1200; i++) {
    const dt = i % 97 === 0 ? 0.05 : DT;
    stepVehicle(s, { throttle: 0.8, brake: i % 300 > 250 ? 1 : 0, steer: Math.sin(i / 40) * 0.5 }, dt, { groundAt: (x, z) => Math.sin(x * 0.05) * 1.5 + Math.cos(z * 0.03) });
    for (const key of ['x', 'z', 'vx', 'vz', 'heading', 'yawRate', 'heave', 'pitch', 'roll', 'rpm']) assert.ok(Number.isFinite(s[key]), key);
    for (const w of s.wheels) assert.ok(Number.isFinite(w.comp) && Number.isFinite(w.load) && w.load >= 0);
  }
  assert.ok(Math.hypot(s.vx, s.vz) < 90);
});
