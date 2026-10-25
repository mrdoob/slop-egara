const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const source = readFileSync(join(__dirname, '../js/controllers.js'), 'utf8');
// The driving model is pure arithmetic: the real module, so the car path can be exercised end to end
const physics = loadModule(readFileSync(join(__dirname, '../js/vehicle-physics.js'), 'utf8'), { filename: 'vehicle-physics.js' });

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    dispatch(type, event = {}) {
      for (const listener of listeners.get(type) || []) listener(event);
    }
  };
}

function keyboardHarness(nyc = {}) {
  const window = eventTarget();
  const document = { ...eventTarget(), hidden: false };
  const config = {
    SPAWN: { x: 0, z: 0, heading: 0, street: 'Plaça Vella' },
    parkAt: () => null,
    blockAt: () => null,
    isTypingInField: (event) => ['INPUT', 'SELECT'].includes(event.target?.tagName),
    FEATURES: { carPhysics: true, propCollisions: true, vehicleGarage: true, enterExit: true },
    ...nyc
  };
  const { ThirdPersonControllerManager } = loadModule(source, {
    globals: { window, document },
    imports: {
      'three/webgpu': {},
      './city-config.js': config,
      './tsl-materials.js': {},
      './actor-models.js': { LIGHTBAR_PATTERN: (mode, t) => (mode ? [(t % 0.2) < 0.1 ? 1 : 0, (t % 0.2) < 0.1 ? 1 : 0] : [0, 0]) },
      './pedestrians.js': {},
      './vehicle-lights.js': {},
      './vehicle-physics.js': physics,
      './city-grid.js': { groundHeightAt: () => 0, roadHeightAt: () => 0 },
      './terrain.js': { terrainY: () => 0, terrainGradient: (x, z, out = { gx: 0, gz: 0 }) => { out.gx = 0; out.gz = 0; return out; } }
    }
  });
  // Exercise the production event handlers without constructing the scene's 3D models.
  const controller = Object.create(ThirdPersonControllerManager.prototype);
  controller.keys = Object.fromEntries(['forward', 'backward', 'left', 'right', 'up', 'down', 'boost'].map((action) => [action, false]));
  controller.bindKeyboard();
  return {
    controller,
    window,
    document,
    key(type, code, tagName = 'BODY') {
      window.dispatch(type, { code, target: { tagName } });
    }
  };
}

test('releasing a movement key after focusing search stops movement', () => {
  const { controller, key } = keyboardHarness();
  key('keydown', 'KeyW');
  assert.equal(controller.keys.forward, true);
  key('keyup', 'KeyW', 'INPUT');
  assert.equal(controller.keys.forward, false);

  key('keydown', 'KeyW', 'INPUT');
  assert.equal(controller.keys.forward, false, 'typing in search does not move the player');
});

test('releasing one movement binding preserves another held binding', () => {
  const { controller, key } = keyboardHarness();
  key('keydown', 'KeyW');
  key('keydown', 'ArrowUp');
  key('keyup', 'ArrowUp');
  assert.equal(controller.keys.forward, true);
  key('keyup', 'KeyW');
  assert.equal(controller.keys.forward, false);
});

test('either Shift key keeps boost active until both are released', () => {
  const { controller, key } = keyboardHarness();
  key('keydown', 'ShiftLeft');
  key('keydown', 'ShiftRight');
  key('keyup', 'ShiftLeft');
  assert.equal(controller.keys.boost, true);
  key('keyup', 'ShiftRight');
  assert.equal(controller.keys.boost, false);
});

test('keyboard and touch input remain active independently', () => {
  const { controller, key } = keyboardHarness();
  controller.setTouchInput('forward', 0.35);
  assert.equal(controller.keys.forward, 0.35);
  key('keydown', 'KeyW');
  assert.equal(controller.keys.forward, true);
  controller.setTouchInput('forward', 0.6);
  assert.equal(controller.keys.forward, true);
  key('keyup', 'KeyW');
  assert.equal(controller.keys.forward, 0.6);
  controller.setTouchInput('forward', 0);
  assert.equal(controller.keys.forward, false);
});

test('clearing touch input preserves held keyboard controls', () => {
  const { controller, key } = keyboardHarness();
  key('keydown', 'KeyW');
  controller.setTouchInput('forward', 0.4);
  controller.setTouchInput('left', 0.7);
  controller.setTouchInput('boost', true);
  controller.clearTouchInput();
  assert.equal(controller.keys.forward, true);
  assert.equal(controller.keys.left, false);
  assert.equal(controller.keys.boost, false);
  key('keyup', 'KeyW');
  assert.equal(controller.keys.forward, false);
});

test('touch strengths are clamped and unknown actions are ignored', () => {
  const { controller } = keyboardHarness();
  controller.setTouchInput('forward', 2);
  controller.setTouchInput('left', -0.5);
  controller.setTouchInput('up', true);
  controller.setTouchInput('unknown', 1);
  assert.equal(controller.keys.forward, 1);
  assert.equal(controller.keys.left, false);
  assert.equal(controller.keys.up, true);
  assert.equal(Object.hasOwn(controller.keys, 'unknown'), false);
});

for (const interruption of ['blur', 'hidden', 'reset']) {
  test(`${interruption} clears held controls and their physical key state`, () => {
    const { controller, window, document, key } = keyboardHarness();
    key('keydown', 'KeyW');
    key('keydown', 'KeyA');
    key('keydown', 'Space');
    key('keydown', 'ShiftLeft');
    controller.setTouchInput('forward', 0.4);
    controller.setTouchInput('backward', 0.8);
    controller.setTouchInput('down', true);
    if (interruption === 'blur') {
      window.dispatch('blur');
    } else if (interruption === 'hidden') {
      document.hidden = true;
      document.dispatch('visibilitychange');
    } else {
      controller.resetInput();
    }
    assert.equal(Object.values(controller.keys).some(Boolean), false);

    // A fresh use of the alias must not revive the old key whose keyup was lost.
    key('keydown', 'ArrowUp');
    key('keyup', 'ArrowUp');
    assert.equal(controller.keys.forward, false);
  });
}

function advanceWithTouch(mode, strength, reverse) {
  const { controller } = keyboardHarness();
  const entity = { position: { x: 0, y: 0, z: 0 }, heading: 0, speed: 0 };
  if (mode === 'Person') Object.assign(entity, { verticalVel: 0 });
  if (mode === 'Car') Object.assign(entity, {
    vx: 0, vz: 0, angularVel: 0, steerAngle: 0, pitchVel: 0, rollVel: 0, heaveVel: 0, heaveY: 0, wheelSpin: 0,
    chassisPivot: { rotation: { x: 0, z: 0 }, position: { y: 0 } }, wheels: []
  });
  if (mode === 'Cyclist') Object.assign(entity, {
    leanAngle: 0, leanPivot: { rotation: { z: 0 } },
    frontWheel: { rotation: { x: 0 } }, rearWheel: { rotation: { x: 0 } },
    pedalPhase: 0, crankPivot: { rotation: { x: 0 } }, pedals: []
  });
  if (mode === 'Helicopter') Object.assign(entity, {
    verticalSpeed: 0, pitchAngle: 0, rollAngle: 0,
    tiltPivot: { rotation: { x: 0, z: 0 }, position: { y: 0 } }
  });
  controller.entities = { [mode.toLowerCase()]: entity };
  controller.getGroundHeight = () => 0;
  controller.resolveHorizontalCollision = () => {};
  controller.setTouchInput(reverse ? 'backward' : 'forward', strength);
  controller.setTouchInput(reverse ? 'right' : 'left', strength);
  if (mode === 'Helicopter') controller.setTouchInput(reverse ? 'down' : 'up', strength);
  controller[`update${mode}`](0.1, 0);
  return entity;
}

for (const mode of ['Person', 'Car', 'Cyclist', 'Helicopter']) {
  test(`analog ${mode.toLowerCase()} input proportionally scales movement and turning`, () => {
    for (const reverse of [false, true]) {
      const full = advanceWithTouch(mode, 1, reverse);
      const partial = advanceWithTouch(mode, 0.4, reverse);
      assert.ok(Math.abs(partial.speed - full.speed * 0.4) < 1e-10, 'movement should scale with joystick strength');
      const turn = mode === 'Car' ? 'steerAngle' : 'heading';
      assert.ok(Math.abs(partial[turn] - full[turn] * 0.4) < 1e-10, 'turning should scale with joystick strength');
      if (mode === 'Helicopter') {
        assert.ok(Math.abs(partial.verticalSpeed - full.verticalSpeed * 0.4) < 1e-10);
      }
    }
  });
}

function teleportHarness(mode, colliders = [], shore = () => ({ westX: -500, eastX: 500 })) {
  const harness = keyboardHarness({
    ISLAND_BOUNDS: { minX: -500, maxX: 500, minZ: -500, maxZ: 500, sidewalkHeight: 0.15 },
    getIslandBoundsAtZ: shore,
    blockAt: () => null
  });
  const { controller } = harness;
  const position = (x = 0, y = 0, z = 0) => ({ x, y, z, copy(p) { this.x = p.x; this.y = p.y; this.z = p.z; } });
  const pivot = () => ({ position: position(), rotation: { x: 0.1, y: 0, z: -0.2 } });
  const chase = { person: [4.3, 1.95], car: [6.9, 2.12], cyclist: [4.8, 2.05], helicopter: [11.4, 3.3] };
  const ent = {
    type: mode, chaseDistance: chase[mode][0], chaseHeight: chase[mode][1],
    position: position(400, mode === 'helicopter' ? 120 : 0, 400), heading: 1, speed: 20,
    mesh: pivot(),
    verticalVel: 5, vx: 3, vz: -4, angularVel: 2, steerAngle: 0.4,
    pitchVel: 3, rollVel: 4, heaveY: 0.1, heaveVel: 2, chassisPivot: pivot(),
    lastCollisionSpark: { speed: 5 }, carState: { value: { x: 0 } }, wheelSpin: 1,
    wheels: [{ isFront: true, steerPivot: { rotation: { y: 0.4 } }, tire: { rotation: { x: 0 } } }],
    leanAngle: 0.3, leanPivot: pivot(), pedalPhase: 0.7,
    frontWheel: { rotation: { x: 0 } }, rearWheel: { rotation: { x: 0 } },
    crankPivot: { rotation: { x: 0 } }, pedals: [],
    verticalSpeed: -8, pitchAngle: 0.2, rollAngle: -0.2, tiltPivot: pivot(),
    rig: { reset(...args) { this.resetArgs = args; } },
    crowd: { begin() {}, add() {}, end() {} }
  };
  controller.activeMode = mode;
  controller.entities = { [mode]: ent };
  controller.colliders = colliders;
  controller._colliderCells = null;
  controller.getGroundHeight = (x, z, mode) => mode === 'person' ? (x < 0 ? 1.24 : 0.22) : 0;
  return { ...harness, ent };
}

for (const mode of ['person', 'car', 'cyclist', 'helicopter']) {
  test(`${mode} teleport stops carried motion and updates its arrival pose immediately`, () => {
    const { controller, ent, key } = teleportHarness(mode);
    key('keydown', 'KeyW');
    key('keydown', 'Space');
    controller.setTouchInput('left', 0.8);
    const result = controller.teleportActiveTo(30, 20, 0.7);
    assert.deepEqual({ ...result }, { x: 30, z: 20 }, 'an open destination is kept exactly');
    assert.equal(ent.heading, 0.7);
    assert.equal(ent.speed, 0);
    assert.equal(Object.values(controller.keys).some(Boolean), false);
    assert.equal(controller._pressedCodes.size, 0);
    assert.deepEqual([ent.mesh.position.x, ent.mesh.position.y, ent.mesh.position.z], [ent.position.x, ent.position.y, ent.position.z]);
    assert.equal(ent.mesh.rotation.y, 0.7);
    if (mode === 'person') {
      assert.equal(ent.verticalVel, 0);
      assert.equal(ent.position.y, 0.22);
      assert.deepEqual(ent.rig.resetArgs.slice(0, 3), [30, 20, 0.7]);
      assert.equal(ent.rig.resetArgs[3](ent.rig.resetArgs[4], 30, 20), 0.22);
    } else if (mode === 'car') {
      for (const field of ['vx', 'vz', 'angularVel', 'steerAngle', 'pitchVel', 'rollVel', 'heaveY', 'heaveVel']) assert.equal(ent[field], 0, field);
      assert.equal(ent.chassisPivot.rotation.x, 0);
      assert.equal(ent.chassisPivot.rotation.z, 0);
      assert.equal(ent.chassisPivot.position.y, 0);
      assert.equal(ent.wheels[0].steerPivot.rotation.y, 0);
      assert.equal(ent.lastCollisionSpark, null);
    } else if (mode === 'cyclist') {
      assert.equal(ent.leanAngle, 0);
      assert.equal(ent.leanPivot.rotation.z, 0);
    } else {
      for (const field of ['verticalSpeed', 'pitchAngle', 'rollAngle']) assert.equal(ent[field], 0, field);
      assert.equal(ent.tiltPivot.rotation.x, 0);
      assert.equal(ent.tiltPivot.rotation.z, 0);
      assert.equal(ent.tiltPivot.position.y, 0);
      assert.equal(ent.position.y, 120, 'keep the helicopter altitude when already above the minimum');
    }
    const before = [ent.position.x, ent.position.y, ent.position.z, ent.heading];
    controller[`update${mode[0].toUpperCase()}${mode.slice(1)}`](0.1, 0);
    assert.deepEqual([ent.position.x, ent.position.y, ent.position.z, ent.heading], before, 'the first neutral frame stays at the arrival');
  });
}

test('teleport checks all overlapping buildings instead of leaving a sequential push trap', () => {
  const colliders = [
    { minX: 0, maxX: 10, minZ: 0, maxZ: 10, maxY: 200 },
    { minX: 9, maxX: 20, minZ: 0, maxZ: 10, maxY: 200 }
  ];
  for (const mode of ['person', 'car', 'cyclist', 'helicopter']) {
    // Reverse order as well: a valid arrival must not rely on collider traversal order.
    for (const list of [colliders, colliders.slice().reverse()]) {
      const { controller, ent } = teleportHarness(mode, list.map(c => ({ ...c })));
      const result = controller.teleportActiveTo(11, 5, 0);
      assert.notDeepEqual({ ...result }, { x: 11, z: 5 });
      const before = [ent.position.x, ent.position.z];
      const radius = mode === 'helicopter' ? 4.5 : mode === 'person' ? 0.48 : 0.65;
      controller.resolveHorizontalCollision(ent.position, radius, mode === 'car' ? ent : null);
      assert.deepEqual([ent.position.x, ent.position.z], before, `${mode} must already be collision-free`);
      assert.equal(ent.position.y, mode === 'helicopter' ? 120 : controller.getGroundHeight(result.x, result.z, mode));
    }
  }
});

test('teleports use oriented building footprints without rejecting clear corners of their bounds', () => {
  const cs = Math.SQRT1_2;
  const box = { minX: -8, maxX: 8, minZ: -8, maxZ: 8, maxY: 200, obb: { cx: 0, cz: 0, hx: 8, hz: 2, cs, sn: cs } };
  for (const mode of ['person', 'car', 'cyclist', 'helicopter']) {
    const { controller, ent } = teleportHarness(mode, [{ ...box }]);
    assert.deepEqual({ ...controller.teleportActiveTo(7, 7, 0.6) }, { x: 7, z: 7 });
    const actual = controller.teleportActiveTo(0, 0, 0.6);
    const before = [actual.x, actual.z];
    controller.resolveHorizontalCollision(ent.position, mode === 'helicopter' ? 4.5 : mode === 'person' ? 0.48 : 0.65,
      mode === 'car' ? ent : null);
    assert.deepEqual([ent.position.x, ent.position.z], before);
  }
});

test('pedestrians pass clear building corners and resolve real corner hits radially', () => {
  const { controller, ent } = teleportHarness('person', [{ minX: 0, maxX: 10, minZ: 0, maxZ: 10, maxY: 30 }]);
  ent.position.x = ent.position.z = -0.4;
  controller.resolveHorizontalCollision(ent.position, 0.48);
  assert.deepEqual([ent.position.x, ent.position.z], [-0.4, -0.4], 'distance to the corner exceeds the body radius');

  ent.position.x = ent.position.z = -0.2;
  controller.resolveHorizontalCollision(ent.position, 0.48);
  assert.ok(Math.abs(Math.hypot(ent.position.x, ent.position.z) - 0.48) < 1e-6);
  assert.ok(Math.abs(ent.position.x - ent.position.z) < 1e-6, 'a diagonal contact pushes along the corner normal');
});

test('corner collision normals follow an oriented building footprint', () => {
  const cs = Math.SQRT1_2;
  const { controller, ent } = teleportHarness('person', [{
    minX: -10 * cs, maxX: 10 * cs, minZ: -10 * cs, maxZ: 10 * cs, maxY: 30,
    obb: { cx: 0, cz: 0, hx: 5, hz: 5, cs, sn: cs }
  }]);
  // Local (-5.2, -5.2) lies just outside the rotated square's leftmost corner.
  ent.position.x = -10.4 * cs;
  ent.position.z = 0;
  controller.resolveHorizontalCollision(ent.position, 0.48);
  assert.ok(Math.abs(ent.position.x - (-10 * cs - 0.48)) < 1e-6);
  assert.ok(Math.abs(ent.position.z) < 1e-6, 'the correction must not slide sideways along the corner');
});

test('rotated cars use their own separating axes at building corners', () => {
  const { controller, ent } = teleportHarness('car', [{ minX: 0, maxX: 10, minZ: 0, maxZ: 10, maxY: 30 }]);
  ent.heading = -Math.PI / 4;
  ent.speed = 0;
  ent.vx = ent.vz = 0;
  ent.position.x = ent.position.z = -1.8;
  controller.resolveHorizontalCollision(ent.position, 1.35, ent);
  assert.deepEqual([ent.position.x, ent.position.z], [-1.8, -1.8], 'the projected bounds overlap, but the actual car does not');

  ent.position.x = ent.position.z = -0.3;
  controller.resolveHorizontalCollision(ent.position, 1.35, ent);
  assert.ok(Math.abs(ent.position.x + 0.86 * Math.SQRT1_2) < 1e-6);
  assert.ok(Math.abs(ent.position.z + 0.86 * Math.SQRT1_2) < 1e-6, 'the shortest correction is perpendicular to the car side');
});

test('teleports preserve clear rounded corners and separated rotated cars', () => {
  for (const [mode, coordinate, heading] of [['person', -0.45, 0], ['car', -1.8, -Math.PI / 4]]) {
    const { controller, ent } = teleportHarness(mode, [{ minX: 0, maxX: 10, minZ: 0, maxZ: 10, maxY: 30 }]);
    const arrival = controller.teleportActiveTo(coordinate, coordinate, heading);
    assert.deepEqual({ ...arrival }, { x: coordinate, z: coordinate }, `${mode} has room including the arrival margin`);
    controller.resolveHorizontalCollision(ent.position, mode === 'person' ? 0.48 : 1.35, mode === 'car' ? ent : null);
    assert.deepEqual([ent.position.x, ent.position.z], [coordinate, coordinate], 'teleport clearance agrees with movement');

    const blocked = controller.teleportActiveTo(-0.2, -0.2, heading);
    assert.notDeepEqual({ ...blocked }, { x: -0.2, z: -0.2 }, 'a real corner overlap still needs a different arrival');
  }
});

test('movement and teleports pass underneath elevated building sections', () => {
  for (const mode of ['person', 'car', 'cyclist', 'helicopter']) {
    const { controller, ent } = teleportHarness(mode, [{ minX: 0, maxX: 10, minZ: 0, maxZ: 10, minY: 4, maxY: 30 }]);
    controller.getGroundHeight = () => 0;
    const y = mode === 'helicopter' ? 0.25 : 0;
    Object.assign(ent.position, { x: 5, y, z: 5 });
    controller.resolveHorizontalCollision(ent.position, mode === 'helicopter' ? 4.5 : 0.65, mode === 'car' ? ent : null);
    assert.deepEqual([ent.position.x, ent.position.z], [5, 5], `${mode} fits below the overhang`);
    assert.deepEqual({ ...controller.teleportActiveTo(5, 5, 0, y) }, { x: 5, z: 5 });
  }
});

test('building clearance uses the full player height beneath an overhang', () => {
  for (const [mode, height] of [['person', 1.9], ['car', 1.8], ['cyclist', 1.9], ['helicopter', 3.2]]) {
    const y = mode === 'helicopter' ? 0.25 : 0;
    const { controller, ent } = teleportHarness(mode, [{
      minX: 0, maxX: 10, minZ: 0, maxZ: 10, minY: y + height - 0.1, maxY: 30
    }]);
    controller.getGroundHeight = () => 0;
    Object.assign(ent.position, { x: 5, y, z: 5 });
    controller.resolveHorizontalCollision(ent.position, mode === 'helicopter' ? 4.5 : 0.65, mode === 'car' ? ent : null);
    assert.notDeepEqual([ent.position.x, ent.position.z], [5, 5], `${mode} intersects the underside`);
    assert.notDeepEqual({ ...controller.teleportActiveTo(5, 5, 0, y) }, { x: 5, z: 5 });
  }
});

test('players above a roof are clear once their body bottoms clear it', () => {
  for (const mode of ['person', 'car', 'cyclist', 'helicopter']) {
    const { controller, ent } = teleportHarness(mode, [{ minX: 0, maxX: 10, minZ: 0, maxZ: 10, maxY: 10 }]);
    controller.getGroundHeight = () => 10.1;
    const y = mode === 'helicopter' ? 10.35 : 10.1;
    Object.assign(ent.position, { x: 5, y, z: 5 });
    controller.resolveHorizontalCollision(ent.position, mode === 'helicopter' ? 4.5 : 0.65, mode === 'car' ? ent : null);
    assert.deepEqual([ent.position.x, ent.position.z], [5, 5], `${mode} clears the visible roof`);
    assert.deepEqual({ ...controller.teleportActiveTo(5, 5, 0, y) }, { x: 5, z: 5 });
  }
});

test('helicopter skids cannot pass through a roof below the body origin', () => {
  const { controller, ent } = teleportHarness('helicopter', [{ minX: 0, maxX: 10, minZ: 0, maxZ: 10, maxY: 10 }]);
  Object.assign(ent.position, { x: 5, y: 10.2, z: 5 });
  controller.resolveHorizontalCollision(ent.position, 4.5);
  assert.notDeepEqual([ent.position.x, ent.position.z], [5, 5]);
  assert.notDeepEqual({ ...controller.teleportActiveTo(5, 5, 0, 10.2) }, { x: 5, z: 5 });
});

test('ground arrivals share movement shoreline limits while helicopters may remain above lower buildings', () => {
  const shore = z => ({ westX: -40 + z * 0.05, eastX: 40 + z * 0.05 });
  const { controller, ent } = teleportHarness('person', [], shore);
  const result = controller.teleportActiveTo(1000, -1000);
  assert.deepEqual({ ...result }, { x: 8.5, z: -470 });
  controller.resolveHorizontalCollision(ent.position, 0.48);
  assert.deepEqual([ent.position.x, ent.position.z], [result.x, result.z]);

  const heli = teleportHarness('helicopter', [{ minX: -30, maxX: 30, minZ: -30, maxZ: 30, maxY: 50 }]);
  heli.ent.position.y = 10;
  assert.deepEqual({ ...heli.controller.teleportActiveTo(0, 0) }, { x: 0, z: 0 });
  assert.equal(heli.ent.position.y, 92);
});

test('a displaced pedestrian samples ground and resets its feet at the resolved destination', () => {
  const { controller, ent } = teleportHarness('person', [{ minX: -4, maxX: 0, minZ: -10, maxZ: 10, maxY: 30 }]);
  assert.deepEqual({ ...controller.teleportActiveTo(-1, 0) }, { x: 3, z: 0 });
  assert.equal(ent.position.y, 0.22, 'the requested point was on the higher ground, but the clear arrival is lower');
  assert.deepEqual(ent.rig.resetArgs.slice(0, 2), [3, 0]);
});

test('failed or invalid teleports keep the current position and stop the player with bounded search', () => {
  const { controller, ent } = teleportHarness('car', [{ minX: -300, maxX: 300, minZ: -300, maxZ: 300, maxY: 500 }]);
  let checks = 0;
  const near = controller.nearColliders;
  controller.nearColliders = function (...args) { checks++; return near.apply(this, args); };
  assert.deepEqual({ ...controller.teleportActiveTo(0, 0) }, { x: 400, z: 400 });
  assert.ok(checks <= 2049, 'the search must be bounded even inside an enormous obstacle');
  assert.equal(ent.speed, 0);
  assert.equal(ent.vx, 0);
  assert.equal(ent.angularVel, 0);
  assert.deepEqual({ ...controller.teleportActiveTo(NaN, Infinity) }, { x: 400, z: 400 });
});

test('successive mode teleports keep parked players out of the arrival and default chase view', () => {
  const { controller, ent: car } = teleportHarness('car');
  const person = teleportHarness('person').ent;
  const cyclist = teleportHarness('cyclist').ent;
  controller.entities = { car, person, cyclist };
  person.position.x = 300;
  cyclist.position.x = 200;
  const heading = Math.PI / 2; // The first radial candidate is +X: its rear camera would sit on the parked car.
  assert.deepEqual({ ...controller.teleportActiveTo(0, 0, heading) }, { x: 0, z: 0 });
  const arrivals = [car];
  const radii = { car: 2.4, person: 0.48, cyclist: 1.0 };
  for (const mode of ['person', 'cyclist']) {
    controller.activeMode = mode;
    const ent = controller.entities[mode];
    const actual = controller.teleportActiveTo(0, 0, heading);
    assert.notDeepEqual({ ...actual }, { x: 0, z: 0 });
    for (const parked of arrivals) {
      const dx = parked.position.x - actual.x, dz = parked.position.z - actual.z;
      const cameraBack = Math.cos(0.09) * ent.chaseDistance;
      const along = Math.max(0, Math.min(cameraBack, -dx));
      assert.ok(Math.hypot(dx, dz) > radii[parked.type] + radii[mode], 'player bodies must not overlap');
      assert.ok(Math.hypot(dx + along, dz) > radii[parked.type] + 0.5, 'the complete default chase corridor must be clear');
    }
    assert.deepEqual([car.position.x, car.position.z], [0, 0], 'switching modes leaves the parked car in place');
    arrivals.push(ent);
  }
});

test('player clearance respects altitude and permits a ground arrival under an airborne helicopter', () => {
  const { controller, ent } = teleportHarness('person');
  const helicopter = teleportHarness('helicopter').ent;
  helicopter.position.x = helicopter.position.z = 0;
  helicopter.position.y = 120;
  controller.entities.helicopter = helicopter;
  assert.deepEqual({ ...controller.teleportActiveTo(0, 0) }, { x: 0, z: 0 });
  assert.equal(ent.position.y, 0.22);
  helicopter.position.y = 1;
  assert.notDeepEqual({ ...controller.teleportActiveTo(0, 0) }, { x: 0, z: 0 }, 'a helicopter parked at street level must be avoided');
});

// ---------------------------------------------------------------------------------------------------------------------
// Street furniture & trees (FEATURES.propCollisions), the driving model path and getting in and out (FEATURES.enterExit)
// ---------------------------------------------------------------------------------------------------------------------

test('the car cannot drive through a lamp post, and the post knocks it', () => {
  const { controller, ent } = teleportHarness('car');
  controller.setPropColliders([{ x: 0, z: 6, r: 0.12, h: 5, kind: 'post' }]);
  ent.heading = 0; // facing +z
  ent.speed = 14;
  ent.vx = ent.vz = ent.angularVel = 0;
  Object.assign(ent.position, { x: 0.3, y: 0, z: 3.95 }); // the nose (2.18 ahead) just inside the post
  controller.resolveHorizontalCollision(ent.position, 1.35, ent);
  assert.ok(ent.position.z < 3.95, 'pushed back out of the post');
  assert.ok(ent.position.z + 2.18 <= 6 - 0.12 + 1e-6, 'the nose clears the post');
  assert.ok(ent.speed < 14 * 0.2, `a head-on hit at 14 m/s stops it: ${ent.speed}`);
  assert.ok(ent.angularVel !== 0, 'an off-centre hit spins it');
  assert.ok(ent.lastCollisionSpark && ent.lastCollisionSpark.speed > 2, 'sparks');
});

test('a bin gives way where a bollard does not, and far props are ignored', () => {
  for (const [kind, maxSpeedLeft] of [['bollard', 0.2], ['bin', 0.8]]) {
    const { controller, ent } = teleportHarness('car');
    controller.setPropColliders([{ x: 0, z: 6, r: 0.2, h: 1, kind }, { x: 300, z: 300, r: 0.3, h: 6, kind: 'tree' }]);
    ent.heading = 0; ent.speed = 10; ent.vx = ent.vz = ent.angularVel = 0;
    Object.assign(ent.position, { x: 0, y: 0, z: 3.9 });
    controller.resolveHorizontalCollision(ent.position, 1.35, ent);
    assert.ok(ent.speed <= 10 * maxSpeedLeft + 1e-6, `${kind}: ${ent.speed}`);
    assert.ok(Math.abs(ent.angularVel) < 1e-9, 'a centred hit does not spin it');
  }
});

test('pedestrians and cyclists slide round tree trunks instead of walking through them', () => {
  for (const mode of ['person', 'cyclist']) {
    const { controller, ent } = teleportHarness(mode);
    controller.setPropColliders([{ x: 0, z: 0, r: 0.3, h: 6, kind: 'tree' }]);
    Object.assign(ent.position, { x: 0.5, y: 0, z: 0.1 });
    ent.heading = -Math.PI / 2; ent.speed = 3;
    const radius = mode === 'person' ? 0.48 : 0.65;
    controller.resolveHorizontalCollision(ent.position, radius, null, ent);
    const d = Math.hypot(ent.position.x, ent.position.z);
    assert.ok(Math.abs(d - (0.3 + radius)) < 1e-6, `${mode} rests against the trunk (${d})`);
    assert.ok(!controller.isClearAt(0.2, 0, 0.48), 'the trunk is not a clear spot');
    assert.ok(controller.isClearAt(5, 5, 0.48));
    assert.notDeepEqual({ ...controller.teleportActiveTo(0, 0, 0) }, { x: 0, z: 0 }, 'teleports avoid it too');
  }
});

function physicsCarHarness() {
  const harness = teleportHarness('car');
  const { controller, ent } = harness;
  const vehicle = physics.vehicleById('compact');
  ent.vehicle = vehicle;
  ent.spec = { wheelRadius: 0.35, name: 'sedan' };
  ent.halfW = 0.86; ent.halfL = 2.18;
  ent.phys = physics.createVehicleState(vehicle, { wheelbase: 2.76, track: 1.66 });
  ent.wheels = [0, 1, 2, 3].map((i) => ({ isFront: i < 2, physIndex: i, steerPivot: { position: { y: 0.35 }, rotation: { y: 0 } }, tire: { rotation: { x: 0 } } }));
  ent.chassisPivot = { position: { y: 0 }, rotation: { x: 0, z: 0 } };
  ent.mesh.rotation = { x: 0, y: 0, z: 0 };
  Object.assign(ent.position, { x: 0, y: 0, z: 0 });
  ent.heading = 0; ent.speed = 0; ent.vx = ent.vz = ent.angularVel = 0;
  ent.phys.x = ent.phys.z = ent.phys.heading = 0;
  controller.getGroundHeight = () => 0;
  return harness;
}

test('with the driving model, W pulls away, A steers left, S brakes and the pose follows the body', () => {
  const { controller, ent, key } = physicsCarHarness();
  key('keydown', 'KeyW');
  for (let i = 0; i < 180; i++) controller.updateCar(1 / 60);
  assert.ok(ent.speed > 8, `3 s of throttle: ${ent.speed} m/s`);
  assert.ok(ent.position.z > 10, 'moved ahead along +z');
  assert.ok(ent.phys.rpm > ent.phys.spec.idle);
  assert.ok(ent.chassisPivot.rotation.x < 0, 'nose up (rotation.x negative) while accelerating');
  key('keydown', 'KeyA');
  for (let i = 0; i < 90; i++) controller.updateCar(1 / 60);
  assert.ok(ent.heading > 0.1, 'turned left');
  assert.ok(ent.wheels[0].steerPivot.rotation.y > 0, 'front wheels steered left');
  assert.ok(ent.chassisPivot.rotation.z > 0, 'leans out of the left-hand bend');
  key('keyup', 'KeyA');
  key('keyup', 'KeyW');
  key('keydown', 'KeyS');
  const before = ent.speed;
  for (let i = 0; i < 20; i++) controller.updateCar(1 / 60);
  assert.equal(ent.carState.value.x, 1, 'brake lights on');
  for (let i = 0; i < 100; i++) controller.updateCar(1 / 60);
  assert.ok(ent.speed < before * 0.2, `braked from ${before} to ${ent.speed}`);
});

test('with the driving model, holding S at a standstill reverses and the handbrake is Shift', () => {
  const { controller, ent, key } = physicsCarHarness();
  key('keydown', 'KeyS');
  for (let i = 0; i < 180; i++) controller.updateCar(1 / 60);
  assert.equal(ent.phys.gear, -1);
  assert.ok(ent.speed < -1, `reversing at ${ent.speed}`);
  assert.ok(ent.position.z < -1);
  key('keyup', 'KeyS');
  key('keydown', 'ShiftLeft');
  for (let i = 0; i < 60; i++) controller.updateCar(1 / 60);
  assert.ok(ent.phys.wheels[2].locked, 'the handbrake locks the rear wheels');
  key('keyup', 'ShiftLeft');
  // W while reversing brakes; once stopped, W held alone goes back to D and pulls away forward
  key('keydown', 'KeyW');
  for (let i = 0; i < 240; i++) controller.updateCar(1 / 60);
  assert.equal(ent.phys.gear >= 1, true, `back in D (gear ${ent.phys.gear})`);
  assert.ok(ent.speed > 2, `driving forward again at ${ent.speed}`);
});

test('the driving model takes the knocks of the traffic and the buildings into account', () => {
  const { controller, ent } = physicsCarHarness();
  ent.speed = 10;
  ent.angularVel = 1.5; // a side swipe from a bus set it spinning
  controller.updateCar(1 / 60);
  assert.ok(ent.phys.yawRate > 1, 'the spin was carried into the model');
  assert.equal(ent.angularVel, 0, 'and consumed');
  // a wall right ahead
  controller.colliders = [{ minX: -5, maxX: 5, minZ: 3, maxZ: 10, maxY: 30 }];
  controller._colliderCells = null;
  ent.angularVel = 0; ent.phys.yawRate = 0; ent.heading = ent.phys.heading = 0;
  ent.speed = 12; ent.phys.vx = 0; ent.phys.vz = 12;
  for (let i = 0; i < 30; i++) controller.updateCar(1 / 60);
  assert.ok(ent.position.z + 2.18 <= 3 + 1e-6, 'stopped by the wall');
  assert.ok(Math.abs(ent.speed) < 4, `bounced and lost its speed: ${ent.speed}`);
});

test('getting out puts the person by the driver door and getting in needs to be close', () => {
  const harness = keyboardHarness({
    ISLAND_BOUNDS: { minX: -500, maxX: 500, minZ: -500, maxZ: 500, sidewalkHeight: 0.15 },
    getIslandBoundsAtZ: () => ({ westX: -500, eastX: 500 }),
    blockAt: () => null
  });
  const { controller } = harness;
  const position = (x = 0, y = 0, z = 0) => ({ x, y, z, copy(p) { this.x = p.x; this.y = p.y; this.z = p.z; } });
  const pivot = () => ({ position: position(), rotation: { x: 0, y: 0, z: 0 } });
  const car = {
    type: 'car', chaseDistance: 6.9, chaseHeight: 2.12, position: position(10, 0, 20), heading: Math.PI / 2, speed: 9, vx: 1, vz: 0, angularVel: 0.3,
    halfW: 0.86, halfL: 2.18, mesh: pivot(), carState: { value: { x: 1 } }, chassisPivot: pivot(), wheels: [], phys: { vx: 3, vz: 0, yawRate: 1, speed: 9 }
  };
  const person = {
    type: 'person', chaseDistance: 4.3, chaseHeight: 1.95, position: position(100, 0, 100), heading: 0, speed: 2, verticalVel: 0, mesh: pivot(),
    rig: { reset() {} }, crowd: { begin() {}, add() {}, end() {} }
  };
  const bike = { type: 'cyclist', chaseDistance: 4.8, chaseHeight: 2.05, position: position(-50, 0, -50), heading: 0, speed: 0, leanAngle: 0, leanPivot: pivot(), mesh: pivot() };
  controller.entities = { car, person, cyclist: bike };
  controller.colliders = [];
  controller._colliderCells = null;
  controller.getGroundHeight = () => 0;
  controller.activeMode = 'car';
  assert.equal(controller.exitVehicle(), 'person');
  assert.equal(controller.activeMode, 'person');
  assert.equal(car.speed, 0, 'the car is left at rest');
  assert.equal(car.phys.vx, 0);
  // facing +x (heading π/2): the car's left is -z, so the driver stands at z < 20 beside it
  assert.ok(Math.abs(person.position.x - 10) < 0.5, `beside the door along the car: ${person.position.x}`);
  assert.ok(person.position.z < 20 - 1 && person.position.z > 20 - 3, `by the driver's door: ${person.position.z}`);
  assert.equal(person.heading, Math.PI / 2, 'facing the way the car faces');
  assert.equal(controller.enterNearby(), 'car', 'standing by the door gets back in');
  assert.equal(controller.activeMode, 'car');
  controller.activeMode = 'person';
  Object.assign(person.position, { x: 10, z: 30 });
  assert.equal(controller.enterNearby(), null, '10 m away is too far');
  Object.assign(person.position, { x: -50, z: -48 });
  assert.equal(controller.enterNearby(), 'cyclist');
  controller.activeMode = 'person';
  Object.assign(person.position, { x: 200, z: 200 });
  controller.parkedBikes = { take: (x, z, r) => (Math.hypot(x - 201, z - 200) <= r ? { x: 201, z: 200, heading: 1 } : null) };
  assert.equal(controller.enterNearby(), 'parked');
  assert.equal(controller.activeMode, 'cyclist');
  assert.deepEqual([bike.position.x, bike.position.z, bike.heading], [201, 200, 1]);
  assert.equal(controller.exitVehicle(), 'person');
  assert.ok(Math.hypot(person.position.x - 201, person.position.z - 200) < 1.5, 'off the bike beside it');
});

test('indicators toggle, hazards blink both sides and a signal cancels itself after the turn', () => {
  const { controller, ent } = physicsCarHarness();
  ent.lightbar = null;
  assert.equal(controller.setTurnSignal(1), 1);
  controller._clock = 0.1;
  controller.updateCarLights(ent, 0.1);
  assert.deepEqual([ent.carState.value.y, ent.carState.value.z], [1, 0], 'left blinks in the on half of the cycle');
  controller.updateCarLights(ent, 0.6);
  assert.deepEqual([ent.carState.value.y, ent.carState.value.z], [0, 0], 'and is dark in the off half');
  assert.equal(controller.setTurnSignal(1), 0, 'asking again cancels');
  controller.setTurnSignal(2);
  controller.updateCarLights(ent, 0.1);
  assert.deepEqual([ent.carState.value.y, ent.carState.value.z], [1, 1], 'hazards');
  controller.setTurnSignal(-1);
  ent.heading = 0; ent.steerAngle = 0.4;
  controller.setTurnSignal(0); controller.setTurnSignal(-1);
  ent.heading = -1.0; // turned right through ~57 degrees
  controller.updateCarLights(ent, 0.1);
  assert.equal(ent.turnSignal, -1, 'still on while the wheel is turned');
  ent.steerAngle = 0;
  controller.updateCarLights(ent, 0.1);
  assert.equal(ent.turnSignal, 0, 'cancels once the wheel is straight after the turn');
});

test('light bar modes and sirens cycle only on a patrol car', () => {
  const { controller, ent } = physicsCarHarness();
  ent.lightbar = null;
  assert.equal(controller.cycleLightbar(), 0);
  assert.equal(controller.cycleSiren(), 'off');
  const attr = { array: new Float32Array(1), needsUpdate: false };
  ent.lightbar = { geometry: { getAttribute: () => attr } };
  ent.barLights = [{ intensity: 0 }, { intensity: 0 }];
  assert.equal(controller.cycleLightbar(), 1);
  assert.equal(attr.array[0], 1);
  assert.equal(controller.cycleLightbar(), 2);
  assert.equal(controller.cycleLightbar(), 3);
  assert.equal(controller.cycleLightbar(), 4);
  assert.equal(controller.cycleLightbar(), 0, 'wraps to off');
  controller.setLightbar(3);
  let lit = 0, dark = 0;
  for (let t = 0; t < 1; t += 0.02) {
    controller.updateCarLights(ent, t);
    if (ent.barLights[0].intensity > 0 || ent.barLights[1].intensity > 0) lit++; else dark++;
  }
  assert.ok(lit > 0 && dark > 0, `the point lights flash with the pattern (${lit} lit, ${dark} dark samples)`);
  assert.equal(controller.cycleSiren(), 'siren');
  assert.equal(controller.cycleSiren(), 'siren-wail');
  assert.equal(controller.cycleSiren(), 'siren-yelp');
  assert.equal(controller.cycleSiren(), 'siren-phaser');
  assert.equal(controller.cycleSiren(), 'off');
  assert.equal(ent.sirenOn, false);
  controller.setSiren('siren-yelp');
  assert.equal(ent.sirenOn, true);
});
