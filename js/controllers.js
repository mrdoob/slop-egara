import * as THREE from 'three/webgpu';
import {
  ISLAND_BOUNDS,
  getIslandBoundsAtZ,
  isTypingInField,
  blockAt,
  parkAt,
  SPAWN,
  FEATURES
} from './city-config.js';
import { cityUniforms, createCarPaintMaterial, createContactShadowMaterial } from './tsl-materials.js';
import {
  BODY_SPECS,
  buildCarGeometry,
  buildCarSidePatch,
  buildSteerableWheelGeo,
  createLoftedCarMaterial,
  buildHelicopterBodyGeometry,
  buildHelicopterMainRotorGeometry,
  buildHelicopterTailRotorGeometry,
  createLoftedHelicopterMaterial,
  createLightbarMesh,
  LIGHTBAR_PATTERN
} from './actor-models.js';
import { PersonCrowd, PersonRig } from './pedestrians.js';
import { groundHeightAt, roadHeightAt } from './city-grid.js';
import { terrainY } from './terrain.js';
import { HEADLIGHTS, createVehicleHeadlight, placeVehicleHeadlight } from './vehicle-lights.js';
import { VEHICLE_CATALOGUE, vehicleById, createVehicleState, stepVehicle } from './vehicle-physics.js';

// js/controllers.js
// Sculpted, non-blocky GTA 6-style 3D models, animations, and physics controllers
// for Third-Person Navigation:
// 1. Person (Skinned Pedestrian: planted-footstep IK walk/run/jump, see pedestrians.js)
// 2. Car (Aerodynamic Sculpted Terrassa White Taxi with Sloped Windshield & Clearcoat; with FEATURES.vehicleGarage any
//    car of the catalogue in vehicle-physics.js, and with FEATURES.carPhysics driven by its four-wheel model)
// 3. Cyclist (Sculpted Road Cyclist with Drop-Bar Frame & Aero Helmet)
// 4. Helicopter (Twin-Turbine Chopper)
// With FEATURES.enterExit the player is one person who gets in and out of the car and on and off the bike (F in
// main.js): the pedestrian is hidden while driving, the rider while walking, and parked bicycles can be taken.

// Spawn by the Plaça Vella (city-config.js SPAWN: on the nearest street, facing along it). The other modes start a
// few metres away: the pedestrian on the sidewalk beside the car, the cyclist ahead, the helicopter above & behind.
const spawnDir = { x: Math.sin(SPAWN.heading), z: Math.cos(SPAWN.heading) }; // heading 0 faces +z
const spawnRight = { x: spawnDir.z, z: -spawnDir.x };
// y is over the ground (the relief: city-grid.js groundHeightAt), so a parked mode never floats or sinks at the spawn
const spawnAt = (ahead, right, y = 0) => {
  const x = SPAWN.x + spawnDir.x * ahead + spawnRight.x * right;
  const z = SPAWN.z + spawnDir.z * ahead + spawnRight.z * right;
  return new THREE.Vector3(x, y + groundHeightAt(x, z), z);
};
function sidewalkSpawn() {
  // the first point to the right of the car (then the left) that lies on a curb island
  for (const side of [1, -1]) for (let d = 2; d <= 9; d += 0.5) {
    const p = spawnAt(3, side * d);
    if (blockAt(p.x, p.z)) return p;
  }
  return spawnAt(3, 4);
}
const groundCollider = { type: 'ground' };

const CAR_DRIVE = {
  speed: 23.5, boostSpeed: 36, reverseSpeed: 10.5, acceleration: 14, boostAcceleration: 21,
  rolling: 0.18, drag: 0.0012, coast: 0.6, brake: 9
};
const BICYCLE_DRIVE = {
  speed: 12.8, boostSpeed: 19, reverseSpeed: 4.5, acceleration: 9, boostAcceleration: 13.5,
  rolling: 0.08, drag: 0.004, coast: 0.2, brake: 7.5 // Backward input is scaled to 0.6, giving 4.5 m/s² braking.
};

function driveSpeed(speed, throttle, boost, dt, drive) {
  const braking = speed * throttle < 0;
  const magnitude = Math.abs(speed);
  // Extra resistance on release gives a stronger slowdown while coasting.
  const deceleration = drive.rolling + (!throttle ? drive.coast : braking ? Math.abs(throttle) * drive.brake : 0);
  // Constant rolling resistance and quadratic air drag, without crossing zero or large-dt instability.
  const coasting = Math.max(0, magnitude - deceleration * dt) / (1 + drive.drag * magnitude * dt);
  if (!throttle || braking) return Math.sign(speed) * coasting;

  const limit = throttle < 0 ? drive.reverseSpeed : boost ? drive.boostSpeed : drive.speed;
  const acceleration = boost ? drive.boostAcceleration : drive.acceleration;
  // Releasing boost removes the extra power; existing momentum decays naturally instead of being clamped.
  return Math.sign(throttle) * Math.min(Math.max(limit, coasting), coasting + Math.abs(throttle) * acceleration * dt);
}

// Walking surface for the player's pedestrian (its rig samples it around its feet)
const personGround = (controllers, x, z) => controllers.getGroundHeight(x, z, 'person');

// The car's half extents (m): the taxi's unless a catalogue vehicle says otherwise (entity.halfW / halfL)
const CAR_HALF_W = 0.86, CAR_HALF_L = 2.18;

function collisionBody(mode, radius, heading, margin = 0, halfW = CAR_HALF_W, halfL = CAR_HALF_L) {
  const car = mode === 'car';
  const sin = Math.sin(heading), cos = Math.cos(heading);
  const hx = halfW + margin, hz = halfL + margin;
  return {
    car, sin, cos, hx, hz, radius: radius + margin,
    extX: car ? Math.abs(cos) * hx + Math.abs(sin) * hz : radius + margin,
    extZ: car ? Math.abs(sin) * hx + Math.abs(cos) * hz : radius + margin,
    bottom: mode === 'helicopter' ? -0.25 : 0,
    top: mode === 'helicopter' ? 3.2 : car ? 1.8 : 1.9
  };
}

// Shared by movement and teleport clearance. World bounds reject distant boxes cheaply; the narrow phase
// uses a circle for walking/cycling/flying and all four separating axes for an oriented car rectangle.
function buildingContact(c, x, y, z, body, contact) {
  if (y + body.bottom >= c.maxY || y + body.top <= (c.minY ?? 0)) return false;
  if (x + body.extX <= c.minX || x - body.extX >= c.maxX || z + body.extZ <= c.minZ || z - body.extZ >= c.maxZ) return false;
  const o = c.obb;
  const cs = o ? o.cs : 1, sn = o ? o.sn : 0;
  const hx = o ? o.hx : (c.maxX - c.minX) * 0.5;
  const hz = o ? o.hz : (c.maxZ - c.minZ) * 0.5;
  const dx = x - (o ? o.cx : (c.minX + c.maxX) * 0.5);
  const dz = z - (o ? o.cz : (c.minZ + c.maxZ) * 0.5);
  const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
  let nx = 0, nz = 0, depth = Infinity;
  if (body.car) {
    const ls = body.sin * cs - body.cos * sn, lc = body.sin * sn + body.cos * cs;
    for (let axis = 0; axis < 4; axis++) {
      const ax = axis === 0 ? 1 : axis === 1 ? 0 : axis === 2 ? lc : ls;
      const az = axis === 0 ? 0 : axis === 1 ? 1 : axis === 2 ? -ls : lc;
      const distance = lx * ax + lz * az;
      const overlap = hx * Math.abs(ax) + hz * Math.abs(az)
        + body.hx * Math.abs(ax * lc - az * ls) + body.hz * Math.abs(ax * ls + az * lc) - Math.abs(distance);
      if (overlap <= 0) return false;
      if (overlap < depth) {
        depth = overlap;
        const sign = distance <= 0 ? -1 : 1;
        nx = ax * sign; nz = az * sign;
      }
    }
  } else {
    const qx = lx - Math.max(-hx, Math.min(hx, lx));
    const qz = lz - Math.max(-hz, Math.min(hz, lz));
    const distance = Math.hypot(qx, qz);
    if (distance >= body.radius) return false;
    if (distance > 0) {
      nx = qx / distance; nz = qz / distance;
      depth = body.radius - distance;
    } else if (hx - Math.abs(lx) <= hz - Math.abs(lz)) {
      nx = lx <= 0 ? -1 : 1;
      depth = hx - Math.abs(lx) + body.radius;
    } else {
      nz = lz <= 0 ? -1 : 1;
      depth = hz - Math.abs(lz) + body.radius;
    }
  }
  if (contact) {
    contact.nx = nx * cs + nz * sn;
    contact.nz = -nx * sn + nz * cs;
    contact.depth = depth;
  }
  return true;
}

function createTaxiDoorDecalTexture() {
  // Terrassa's taxi door marking (fleet photos 2019-2022, HOW_TO_IMPROVE.md §5.1): a plain white door with the city's
  // crest (a lozenge with the castle, a mural crown over it) and "Terrassa / TAXI nn" in black under it. The licence
  // number is invented. The red pixel stair motifs are painted by the car material (actor-models.js) on every taxi
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f4f4f1';
  ctx.fillRect(0, 0, 256, 128);
  ctx.strokeStyle = '#111317';
  ctx.fillStyle = '#111317';
  ctx.lineWidth = 2.2;
  const cx = 128, cy = 52, r = 22;
  // lozenge
  ctx.beginPath();
  ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy); ctx.closePath();
  ctx.stroke();
  // the castle: a keep with two towers, and the stripes of the right half
  ctx.fillRect(cx - 9, cy - 4, 6, 12);
  ctx.fillRect(cx - 3, cy - 1, 5, 9);
  ctx.fillRect(cx - 9, cy - 7, 2, 3); ctx.fillRect(cx - 6, cy - 7, 2, 3);
  for (let i = 0; i < 3; i++) ctx.fillRect(cx + 5 + i * 4, cy - 8 + i * 2, 1.5, 16 - i * 4);
  // mural crown
  ctx.fillRect(cx - 12, cy - r - 9, 24, 3);
  for (const dx of [-11, -4, 3, 9]) ctx.fillRect(cx + dx, cy - r - 15, 3, 6);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '600 14px Inter, Arial, sans-serif';
  ctx.fillText('Terrassa', cx, 90);
  ctx.font = '700 15px Inter, Arial, sans-serif';
  ctx.fillText('TAXI 47', cx, 108);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createSpanishPlateTexture() {
  // Spanish plate: white, black "1234 BCD", blue EU band with the ring of stars and "E" on the left
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f7f7f4';
  ctx.fillRect(0, 0, 256, 128);
  ctx.fillStyle = '#003399';
  ctx.fillRect(0, 0, 36, 128);
  ctx.fillStyle = '#ffcc00';
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(18 + Math.cos(a) * 11, 40 + Math.sin(a) * 11, 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 26px Inter, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('E', 18, 92);
  ctx.fillStyle = '#111317';
  ctx.font = '900 54px JetBrains Mono, monospace';
  ctx.fillText('4821 KTR', 148, 66);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

class ThirdPersonControllerManager {
  constructor(scene, colliders = []) {
    this.scene = scene;
    this.colliders = colliders;
    this._colliderCells = null; // built on first use, see nearColliders()
    this._propCells = null; // low props (posts, bollards, trunks...) bucketed by setPropColliders()
    this.parkedBikes = null; // parked-bikes.js field the pedestrian can take a bicycle from (enterNearby)
    this.activeMode = 'car'; // 'person' | 'car' | 'cyclist' | 'helicopter'

    this.keys = {
      forward: false,
      backward: false,
      left: false,
      right: false,
      up: false,
      down: false,
      boost: false
    };

    this.entities = {
      person: this.createPersonEntity(),
      car: this.createCarEntity(),
      cyclist: this.createCyclistEntity(),
      helicopter: this.createHelicopterEntity()
    };

    Object.values(this.entities).forEach((ent) => {
      if (ent.mesh) {
        ent.mesh.traverse((child) => {
          if (
            child.isMesh &&
            !child.material?.isMeshBasicNodeMaterial &&
            child.material?.type !== 'MeshBasicNodeMaterial' &&
            !child.material?.transparent
          ) {
            child.castShadow = true;
            child.receiveShadow = true;
          }
        });
      }
    });

    this.bindKeyboard();
  }

  setCollisionListener(listener) {
    this._collisionListener = typeof listener === 'function' ? listener : null;
    this._collisionEvent ??= { a: null, b: null, kind: '', x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, speed: 0 };
  }

  // Reuse one synchronous event; consumers must copy retained fields. Normal points from b toward a.
  reportCollision(a, b, kind, x, y, z, nx, ny, nz, speed) {
    if (!this._collisionListener || speed <= 0.5) return;
    const event = this._collisionEvent;
    event.a = a; event.b = b; event.kind = kind;
    event.x = x; event.y = y; event.z = z;
    event.nx = nx; event.ny = ny; event.nz = nz; event.speed = speed;
    this._collisionListener(event);
  }

  bindKeyboard() {
    const bindings = {
      forward: ['KeyW', 'ArrowUp'],
      backward: ['KeyS', 'ArrowDown'],
      left: ['KeyA', 'ArrowLeft'],
      right: ['KeyD', 'ArrowRight'],
      up: ['Space', 'KeyE'],
      down: ['KeyQ', 'KeyC'],
      boost: ['ShiftLeft', 'ShiftRight']
    };
    const actionsByCode = new Map(Object.entries(bindings).flatMap(([action, codes]) => codes.map((code) => [code, action])));
    this._pressedCodes = new Set();
    this._keyboardKeys = {};
    this._touchKeys = {};
    this._gamepadKeys = {};

    const onKey = (e, isDown) => {
      const action = actionsByCode.get(e.code);
      if (!action || (isDown && isTypingInField(e))) return;
      if (isDown) this._pressedCodes.add(e.code);
      else this._pressedCodes.delete(e.code);
      // Releasing one binding must not cancel another key held for the same action.
      this._keyboardKeys[action] = bindings[action].some((code) => this._pressedCodes.has(code));
      this._blendInput(action);
    };

    window.addEventListener('keydown', (e) => onKey(e, true));
    window.addEventListener('keyup', (e) => onKey(e, false));
    window.addEventListener('blur', () => this.resetInput());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.resetInput();
    });
  }

  _blendInput(action) {
    const keyboard = this._keyboardKeys[action] || false;
    const touch = this._touchKeys[action] || false;
    const gamepad = this._gamepadKeys[action] || false;
    const strength = Math.max(keyboard, touch, gamepad);
    // Preserve digital button values while allowing either analog source to be strongest.
    this.keys[action] = keyboard === true || touch === true || gamepad === true ? true : strength || false;
  }

  _setAnalogInput(source, action, value) {
    if (!Object.hasOwn(this.keys, action)) return;
    const strength = Number(value);
    source[action] = typeof value === 'boolean' ? value : Number.isFinite(strength) ? Math.max(0, Math.min(1, strength)) : 0;
    this._blendInput(action);
  }

  setTouchInput(action, value) {
    this._setAnalogInput(this._touchKeys, action, value);
  }

  setGamepadInput(action, value) {
    this._setAnalogInput(this._gamepadKeys, action, value);
  }

  clearTouchInput() {
    this._touchKeys = {};
    for (const action of Object.keys(this.keys)) this._blendInput(action);
  }

  clearGamepadInput() {
    this._gamepadKeys = {};
    for (const action of Object.keys(this.keys)) this._blendInput(action);
  }

  resetInput() {
    this._pressedCodes.clear();
    this._keyboardKeys = {};
    this._touchKeys = {};
    this._gamepadKeys = {};
    for (const action of Object.keys(this.keys)) this.keys[action] = false;
  }

  setMode(mode) {
    if (!this.entities[mode]) return;
    this.activeMode = mode;
  }

  getActiveEntity() {
    return this.entities[this.activeMode];
  }

  teleportActiveTo(x, z, heading = Math.PI, savedAltitude = null, opts = {}) {
    const ent = this.getActiveEntity();
    this.resetInput();
    if (!Number.isFinite(heading)) heading = ent.heading;
    const heli = this.activeMode === 'helicopter';
    const altitude = heli ? Math.max(0.25, Math.min(380, savedAltitude ?? Math.max(92, ent.position.y))) : 0;
    const destination = this.findTeleportPosition(x, z, heading, altitude, opts);
    if (destination) {
      ent.position.x = destination.x;
      ent.position.z = destination.z;
      ent.heading = heading;
      ent.position.y = heli ? altitude : this.getGroundHeight(destination.x, destination.z, this.activeMode);
    }
    ent.speed = 0;
    if (this.activeMode === 'person') {
      ent.verticalVel = 0;
      ent.rig.reset(ent.position.x, ent.position.z, ent.heading, personGround, this);
      ent.crowd.begin();
      ent.crowd.add(ent.rig, 0);
      ent.crowd.end();
    } else if (this.activeMode === 'car') {
      ent.vx = ent.vz = ent.angularVel = ent.steerAngle = 0;
      ent.pitchVel = ent.rollVel = ent.heaveY = ent.heaveVel = 0;
      ent.chassisPivot.rotation.x = ent.chassisPivot.rotation.z = 0;
      ent.chassisPivot.position.y = 0;
      ent.lastCollisionSpark = null;
      for (const wheel of ent.wheels) if (wheel.isFront) wheel.steerPivot.rotation.y = 0;
      if (ent.carState) ent.carState.value.x = 1;
      if (ent.phys) {
        // the driving model restarts at rest where the car now stands, in D, on a level body
        const s = ent.phys;
        Object.assign(s, { x: ent.position.x, z: ent.position.z, heading: ent.heading, vx: 0, vz: 0, yawRate: 0, steer: 0, speed: 0, lateralSpeed: 0,
          heave: 0, heaveVel: 0, pitch: 0, pitchVel: 0, roll: 0, rollVel: 0, gear: 1, shiftTimer: 0, rpm: s.spec.idle, skid: 0 });
        for (const w of s.wheels) { w.comp = 0; w.compVel = 0; w.bump = 0; w.skid = 0; w.locked = w.spinning = false; }
        ent.mesh.rotation.x = ent.mesh.rotation.z = 0;
      }
    } else if (this.activeMode === 'cyclist') {
      ent.leanAngle = ent.leanPivot.rotation.z = 0;
    } else if (heli) {
      ent.verticalSpeed = ent.pitchAngle = ent.rollAngle = 0;
      ent.tiltPivot.rotation.x = ent.tiltPivot.rotation.z = 0;
      ent.tiltPivot.position.y = 0;
    }
    ent.mesh.position.copy(ent.position);
    ent.mesh.rotation.y = ent.heading;
    return { x: ent.position.x, z: ent.position.z };
  }

  // Find a fully clear arrival before moving the player. Sequential collision pushes can leave a player trapped
  // between overlapping buildings, so test whole candidate footprints instead; retain the old position if none fits.
  findTeleportPosition(x, z, heading, altitude, { ignoreOthers = false } = {}) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const heli = this.activeMode === 'helicopter';
    const radius = heli ? 4.5 : this.activeMode === 'person' ? 0.48 : 0.65;
    const sinH = Math.sin(heading), cosH = Math.cos(heading);
    const entity = this.getActiveEntity();
    const shape = collisionBody(this.activeMode, radius, heading, 0.1, entity.halfW ?? CAR_HALF_W, entity.halfL ?? CAR_HALF_L);
    const reach = Math.max(shape.extX, shape.extZ);
    const margin = heli ? 6000 : 0;
    // Conservative body cylinders, including the car's corners, bicycle wheels and helicopter tail/rotor.
    const body = { person: [0.48, 1.9], car: [2.4, 1.9], cyclist: [1.0, 1.9], helicopter: [6.2, 3.2] };
    const others = ignoreOthers ? [] : Object.values(this.entities).filter(e => e !== entity).map(e => ({
      x: e.position.x, z: e.position.z, radius: e.type === 'car' && e.halfL ? Math.hypot(e.halfW, e.halfL) : body[e.type][0],
      bottom: e.position.y - (e.type === 'helicopter' ? 0.7 : 0), top: e.position.y + body[e.type][1]
    }));
    const cameraBack = Math.cos(0.09) * entity.chaseDistance;
    const cameraUp = entity.chaseHeight + Math.sin(0.09) * entity.chaseDistance * 0.85;
    const clampPoint = (px, pz) => {
      pz = Math.max(ISLAND_BOUNDS.minZ + (heli ? -6000 : 30), Math.min(ISLAND_BOUNDS.maxZ + margin, pz));
      px = Math.max(ISLAND_BOUNDS.minX - margin, Math.min(ISLAND_BOUNDS.maxX + margin, px));
      if (!heli && getIslandBoundsAtZ) {
        const shore = getIslandBoundsAtZ(pz);
        const west = shore.westX + 8, east = shore.eastX - 8;
        if (west > east) return null;
        px = Math.max(west, Math.min(east, px));
      }
      return { x: px, z: pz };
    };
    const clear = (p) => {
      if (!p) return false;
      const baseY = heli ? altitude : this.getGroundHeight(p.x, p.z, this.activeMode);
      // Keep other player models out of both the arrival and its default chase view. A corridor also prevents a
      // parked car between camera and character from hiding the character even when the camera itself is outside it.
      const viewTop = baseY + Math.max(body[entity.type][1], cameraUp);
      for (const other of others) {
        if (other.bottom > viewTop + 0.3 || other.top < baseY - (heli ? 0.7 : 0) - 0.3) continue;
        const dx = other.x - p.x, dz = other.z - p.z;
        const back = Math.max(0, Math.min(cameraBack, -dx * sinH - dz * cosH));
        if (Math.hypot(dx + sinH * back, dz + cosH * back) < other.radius + Math.max(body[entity.type][0], 0.5) + 0.1) return false;
      }
      for (const c of this.nearColliders(p.x, p.z, reach)) {
        if (buildingContact(c, p.x, baseY, p.z, shape)) return false;
      }
      if (this._propCells && !heli && this.propContact(p.x, p.z, shape)) return false;
      return true;
    };
    const origin = clampPoint(x, z);
    if (clear(origin)) return origin;
    // Four-metre rings cover nearby streets and courtyards, with bounded work even for a click inside a large block.
    const cx = origin ? origin.x : Math.max(ISLAND_BOUNDS.minX, Math.min(ISLAND_BOUNDS.maxX, x));
    const cz = origin ? origin.z : Math.max(ISLAND_BOUNDS.minZ + 30, Math.min(ISLAND_BOUNDS.maxZ, z));
    for (let distance = 4; distance <= 256; distance += 4) {
      for (let i = 0; i < 32; i++) {
        const angle = i * Math.PI / 16;
        const p = clampPoint(cx + Math.cos(angle) * distance, cz + Math.sin(angle) * distance);
        if (clear(p)) return p;
      }
    }
    return null;
  }

  // =========================================================================
  // 1. PERSON (SKINNED PEDESTRIAN WITH PLANTED-FOOTSTEP IK GAIT, see pedestrians.js)
  // =========================================================================
  createPersonEntity() {
    const root = new THREE.Group();
    root.name = 'PlayerPerson';

    // One skinned person, posed in world space every frame by its rig (walk, run, turn, jump)
    const crowd = new PersonCrowd(1, { farDistance: Infinity });
    crowd.meshes.forEach((m) => this.scene.add(m));
    const rig = new PersonRig({ seed: 4.2, scale: 1.0, girth: 1.02, hair: 0.18, armSwing: 1.0 });

    // Soft Under-Foot Contact Shadow (AO)
    const shadowGeo = new THREE.PlaneGeometry(0.95, 0.95);
    shadowGeo.rotateX(-Math.PI * 0.5);
    const pedShadow = new THREE.Mesh(shadowGeo, createContactShadowMaterial());
    pedShadow.position.y = 0.02;
    pedShadow.renderOrder = 998;
    root.add(pedShadow);

    this.scene.add(root);

    return {
      type: 'person',
      label: 'Pedestrian',
      mesh: root,
      crowd,
      rig,
      position: sidewalkSpawn(), // on the kerb island's slab: groundHeightAt gives its height over the relief
      heading: SPAWN.heading,
      speed: 0,
      verticalVel: 0,
      cameraTargetOffset: new THREE.Vector3(0, 1.55, 0),
      chaseDistance: 4.3,
      chaseHeight: 1.95
    };
  }

  // =========================================================================
  // 2. CAR (3D LOFTED SCULPTED SEDAN / SUV: THE TERRASSA WHITE TAXI BY DEFAULT, ANY CATALOGUE VEHICLE WITH THE GARAGE)
  // =========================================================================
  createCarEntity() {
    const root = new THREE.Group();
    root.name = 'PlayerCar';
    root.rotation.order = 'YXZ'; // the heading, then the slope's pitch & roll (updateCarPhysics)
    this.scene.add(root);
    const entity = {
      type: 'car',
      label: 'Terrassa Taxi',
      mesh: root,
      visual: null,
      chassisPivot: null,
      carState: null,
      headLights: [],
      wheels: [],
      lightbar: null,
      vehicle: null, // the catalogue entry (vehicle-physics.js)
      spec: null, // its body loft (actor-models.js BODY_SPECS)
      phys: null, // its driving model state (FEATURES.carPhysics)
      halfW: CAR_HALF_W,
      halfL: CAR_HALF_L,
      position: spawnAt(0, 0),
      heading: SPAWN.heading,
      speed: 0,
      vx: 0,
      vz: 0,
      angularVel: 0,
      pitchVel: 0,
      rollVel: 0,
      heaveY: 0,
      heaveVel: 0,
      lastCollisionSpark: null,
      steerAngle: 0,
      wheelSpin: 0,
      cameraTargetOffset: new THREE.Vector3(0, 0.96, 0),
      chaseDistance: 6.9,
      chaseHeight: 2.12
    };
    this.applyVehicle(entity, vehicleById('taxi'));
    return entity;
  }

  // Dress the car entity as a catalogue vehicle: body loft & livery, plates, lamps, wheels, the police light bar, its
  // collision extents and its driving model. Called once at creation and by setVehicle(); the car keeps its place
  applyVehicle(entity, vehicle) {
    const root = entity.mesh;
    if (entity.visual) {
      root.remove(entity.visual);
      entity.visual.traverse((o) => { if (o.isMesh && o.geometry && !o.userData.sharedGeometry) o.geometry.dispose(); });
      for (const g of entity.visual.userData.wheelGeometries || []) g.dispose();
    }
    const spec = BODY_SPECS[vehicle.body] || BODY_SPECS.taxi;
    const visual = new THREE.Group();
    visual.name = `PlayerCar:${vehicle.id}`;
    const chassisPivot = new THREE.Group();
    visual.add(chassisPivot);

    // 1. Lofted body + curved glass + crowned roof + mirrors (+ the taxi's roof sign), painted by the car material
    const bodyMat = createLoftedCarMaterial(spec, vehicle.paint);
    const bodyMesh = new THREE.Mesh(buildCarGeometry(spec, false), bodyMat);
    bodyMesh.castShadow = true;
    bodyMesh.receiveShadow = true;
    chassisPivot.add(bodyMesh);

    // 2. Terrassa taxi door livery: the diagonal red & blue stripe with the municipal licence number on the front doors
    if (vehicle.taxiDecal) {
      this._doorDecalMat ??= new THREE.MeshStandardNodeMaterial({
        map: createTaxiDoorDecalTexture(), roughness: 0.24, metalness: 0.34, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
      });
      const doorMid = (spec.doors[0] + spec.doors[1]) / 2;
      for (const side of [-1, 1]) {
        chassisPivot.add(new THREE.Mesh(buildCarSidePatch(spec, side, doorMid - 0.36, doorMid + 0.36, 0.53, 0.81, 0.003), this._doorDecalMat));
      }
    }

    // 3. Spanish number plates on the bumpers (white, blue EU band)
    this._plateMat ??= new THREE.MeshStandardNodeMaterial({ map: createSpanishPlateTexture(), roughness: 0.28 });
    const rearPlate = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.14, 0.02), this._plateMat);
    rearPlate.position.set(0, spec.plates[1], spec.zRear - 0.006);
    const frontPlate = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.14, 0.02), this._plateMat);
    frontPlate.position.set(0, spec.plates[0], spec.zFront + 0.006);
    chassisPivot.add(rearPlate, frontPlate);

    // 3b. Brake lights, CHMSL, turn signals & livery are painted by the material from its carState uniform
    const carState = bodyMat.userData.carState;
    if (carState) carState.value.set(0, 0, 0, vehicle.livery || 0);

    // 3c. The police light bar (dark until the driver selects a mode: barLit, see setLightbar) and two blue point
    // lights under its halves that follow the pattern (updateCarLights)
    let lightbar = null;
    const barLights = [];
    if (vehicle.lightbar) {
      lightbar = createLightbarMesh(spec, 1);
      lightbar.setMatrixAt(0, new THREE.Matrix4());
      lightbar.instanceMatrix.needsUpdate = true;
      lightbar.castShadow = true;
      chassisPivot.add(lightbar);
      const barY = lightbar.geometry.boundingBox ? lightbar.geometry.boundingBox.max.y : spec.cabin.roofY[0][1] + 0.12;
      for (const side of [-1, 1]) {
        const pt = new THREE.PointLight(0x3d82ff, 0, 11, 1.3);
        pt.position.set(side * 0.3, barY + 0.05, (spec.cabin.roofFront + spec.cabin.roofRear) * 0.5 + 0.3);
        chassisPivot.add(pt);
        barLights.push(pt);
      }
    }

    // 4. Steerable & spinning lathe tyres with recessed alloys: each wheel on its own pivot in the root (not on the
    // sprung body), so with the driving model each one rides its own ground while the body moves on its springs
    const leftWheelGeo = buildSteerableWheelGeo(spec, -1);
    const rightWheelGeo = buildSteerableWheelGeo(spec, 1);
    const wheels = [];
    // local +x is the car's left: physics wheel order FL, FR, RL, RR (vehicle-physics.js)
    for (const wc of [
      { side: 1, z: spec.wheelZ, isFront: true, physIndex: 0 },
      { side: -1, z: spec.wheelZ, isFront: true, physIndex: 1 },
      { side: 1, z: -spec.wheelZ, isFront: false, physIndex: 2 },
      { side: -1, z: -spec.wheelZ, isFront: false, physIndex: 3 }
    ]) {
      const steerPivot = new THREE.Group();
      steerPivot.position.set(wc.side * spec.wheelX, spec.wheelRadius, wc.z);
      const tire = new THREE.Mesh(wc.side < 0 ? leftWheelGeo : rightWheelGeo, bodyMat);
      tire.userData.sharedGeometry = true; // the two geometries are shared by two wheels each: disposed below
      tire.castShadow = true;
      tire.receiveShadow = true;
      steerPivot.add(tire);
      visual.add(steerPivot);
      wheels.push({ steerPivot, tire, isFront: wc.isFront, physIndex: wc.physIndex });
    }
    visual.userData.wheelGeometries = [leftWheelGeo, rightWheelGeo];

    // 5. Soft under-car contact shadow + clustered LED headlight spots
    const carShadow = new THREE.Mesh(new THREE.PlaneGeometry(spec.wheelX * 2 + 0.56, spec.zFront - spec.zRear + 0.55).rotateX(-Math.PI * 0.5), createContactShadowMaterial());
    carShadow.position.set(0, 0.02, 0.0);
    carShadow.renderOrder = 998;
    visual.add(carShadow);
    const headLights = [];
    for (const side of [-1, 1]) {
      const spot = createVehicleHeadlight();
      placeVehicleHeadlight(spot, spec, side);
      chassisPivot.add(spot, spot.target);
      headLights.push(spot);
    }

    visual.traverse((child) => {
      if (child.isMesh && !child.material?.isMeshBasicNodeMaterial && child.material?.type !== 'MeshBasicNodeMaterial' && !child.material?.transparent) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    root.add(visual);

    const suv = spec.name === 'suv';
    Object.assign(entity, {
      visual, chassisPivot, carState, headLights, wheels, lightbar, barLights, vehicle, spec,
      lightMode: 0, sirenKind: 'off', sirenOn: false, turnSignal: 0, turnStartHeading: 0,
      label: FEATURES.vehicleGarage ? vehicle.label : 'Terrassa Taxi',
      halfW: suv ? 0.92 : CAR_HALF_W,
      halfL: Math.max(2.0, spec.zFront - 0.07),
      speed: 0, vx: 0, vz: 0, angularVel: 0, pitchVel: 0, rollVel: 0, heaveY: 0, heaveVel: 0, steerAngle: 0, wheelSpin: 0,
      chaseHeight: suv ? 2.3 : 2.12
    });
    entity.cameraTargetOffset.y = suv ? 1.1 : 0.96;
    entity.phys = FEATURES.carPhysics ? createVehicleState(vehicle, { wheelbase: spec.wheelZ * 2, track: spec.wheelX * 2 }) : null;
    if (entity.phys) Object.assign(entity.phys, { x: entity.position.x, z: entity.position.z, heading: entity.heading });
    root.rotation.x = root.rotation.z = 0;
    return entity;
  }

  // Swap the player's car for another catalogue vehicle (FEATURES.vehicleGarage), where it stands
  setVehicle(id) {
    const vehicle = vehicleById(id);
    const c = this.entities.car;
    if (c.vehicle && c.vehicle.id === vehicle.id) return vehicle;
    this.applyVehicle(c, vehicle);
    return vehicle;
  }

  // The police bar of the player's car: mode 0 off, 1 posició (steady), 2 prioritari (alternating halves),
  // 3 emergència (triple bursts), 4 escombrat (sweep); see actor-models.js createLightbarMaterial. L cycles it (main.js)
  setLightbar(mode) {
    const c = this.entities.car;
    if (!c.lightbar) { c.lightMode = 0; return false; }
    const m = Math.max(0, Math.min(4, mode === true ? 3 : mode === false ? 0 : Math.round(mode) || 0));
    c.lightMode = m;
    const attr = c.lightbar.geometry.getAttribute('barLit');
    if (attr.array[0] !== m) {
      attr.array[0] = m;
      attr.needsUpdate = true;
    }
    return true;
  }

  cycleLightbar(step = 1) {
    const c = this.entities.car;
    if (!c.lightbar) return 0;
    this.setLightbar(((c.lightMode || 0) + step + 5) % 5);
    return c.lightMode;
  }

  // The siren of the player's patrol car (audio-sources.js reads sirenOn & sirenKind): 'off' or one of the Spanish
  // tones of audio-synthesis.js SIREN_KINDS. K cycles them (main.js)
  static get SIREN_KINDS() { return ['off', 'siren', 'siren-wail', 'siren-yelp', 'siren-phaser']; }

  setSiren(kind) {
    const c = this.entities.car;
    const kinds = ThirdPersonControllerManager.SIREN_KINDS;
    c.sirenKind = c.lightbar && kinds.includes(kind) ? kind : 'off';
    c.sirenOn = c.sirenKind !== 'off';
    return c.sirenKind;
  }

  cycleSiren(step = 1) {
    const c = this.entities.car;
    if (!c.lightbar) return 'off';
    const kinds = ThirdPersonControllerManager.SIREN_KINDS;
    const current = Math.max(0, kinds.indexOf(c.sirenKind || 'off'));
    return this.setSiren(kinds[(current + step + kinds.length) % kinds.length]);
  }

  // Turn signals of the player's car: 1 left, -1 right, 2 hazards, 0 off. Asking for the one already on cancels it;
  // a signal cancels itself once the car has turned through ~50 degrees and the wheel is back near straight
  setTurnSignal(signal) {
    const c = this.entities.car;
    c.turnSignal = c.turnSignal === signal ? 0 : signal;
    c.turnStartHeading = c.heading;
    c.turnPeak = 0;
    return c.turnSignal;
  }

  // Blinkers (carState.y left, .z right) and the bar's point lights, every frame
  updateCarLights(c, elapsed) {
    if (c.turnSignal === 1 || c.turnSignal === -1) {
      let turned = c.heading - c.turnStartHeading;
      turned = Math.atan2(Math.sin(turned), Math.cos(turned)) * c.turnSignal; // + when turning the signalled way
      c.turnPeak = Math.max(c.turnPeak || 0, turned);
      if (c.turnPeak > 0.85 && Math.abs(c.steerAngle) < 0.05) c.turnSignal = 0;
    }
    const blinkOn = c.turnSignal !== 0 && (elapsed % 0.8) < 0.4 ? 1 : 0;
    if (c.carState) {
      c.carState.value.y = c.turnSignal === 1 || c.turnSignal === 2 ? blinkOn : 0;
      c.carState.value.z = c.turnSignal === -1 || c.turnSignal === 2 ? blinkOn : 0;
    }
    if (c.barLights && c.barLights.length) {
      // the same cadences as the lens shader (actor-models.js LIGHTBAR_PATTERN), one light per half
      const [left, right] = LIGHTBAR_PATTERN(c.lightMode || 0, elapsed);
      c.barLights[0].intensity = 40 * right; // index 0 is -x: the car's right
      c.barLights[1].intensity = 40 * left;
    }
  }

  // =========================================================================
  // 3. CYCLIST (3D LOFTED RIDER + ROAD/CITI BICYCLE)
  // =========================================================================
  createCyclistEntity() {
    const root = new THREE.Group();
    root.name = 'PlayerCyclist';

    const leanPivot = new THREE.Group();
    root.add(leanPivot);

    const frameMat = createCarPaintMaterial(0x0078e8);
    const tireMat = new THREE.MeshStandardNodeMaterial({
      color: 0x181a1e,
      roughness: 0.60
    });
    const chromeMat = new THREE.MeshStandardNodeMaterial({
      color: 0xe0e8f0,
      roughness: 0.16,
      metalness: 0.78
    });
    const shortsMat = new THREE.MeshStandardNodeMaterial({
      color: 0x1c2028,
      roughness: 0.55
    });
    const helmetMat = new THREE.MeshStandardNodeMaterial({
      color: 0xf4f7fb,
      emissive: 0x181c22,
      roughness: 0.22,
      metalness: 0.25
    });

    const wheelTorusGeo = new THREE.TorusGeometry(0.35, 0.038, 12, 24);
    wheelTorusGeo.rotateY(Math.PI * 0.5);
    const rimTorusGeo = new THREE.TorusGeometry(0.31, 0.018, 8, 24);
    rimTorusGeo.rotateY(Math.PI * 0.5);

    const frontWheel = new THREE.Mesh(wheelTorusGeo, tireMat);
    frontWheel.add(new THREE.Mesh(rimTorusGeo, chromeMat));
    frontWheel.position.set(0, 0.38, 0.58);
    leanPivot.add(frontWheel);

    const rearWheel = new THREE.Mesh(wheelTorusGeo, tireMat);
    rearWheel.add(new THREE.Mesh(rimTorusGeo, chromeMat));
    rearWheel.position.set(0, 0.38, -0.58);
    leanPivot.add(rearWheel);

    // Rear red LED safety strobe on seatpost
    const tailLed = new THREE.Mesh(
      new THREE.SphereGeometry(0.032, 8, 8),
      new THREE.MeshBasicNodeMaterial({ color: 0xff1e26 })
    );
    tailLed.position.set(0, 0.86, -0.32);
    leanPivot.add(tailLed);

    const topTube = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.72, 10), frameMat);
    topTube.rotation.x = Math.PI * 0.46;
    topTube.position.set(0, 0.78, 0.04);
    leanPivot.add(topTube);

    const downTube = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.78, 10), frameMat);
    downTube.rotation.x = Math.PI * 0.28;
    downTube.position.set(0, 0.58, 0.16);
    leanPivot.add(downTube);

    const seatTube = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.64, 10), frameMat);
    seatTube.rotation.x = -0.22;
    seatTube.position.set(0, 0.66, -0.22);
    leanPivot.add(seatTube);

    const saddle = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.16, 8, 10), shortsMat);
    saddle.rotation.x = Math.PI * 0.5;
    saddle.scale.set(1.15, 1.0, 0.55);
    saddle.position.set(0, 0.96, -0.28);
    leanPivot.add(saddle);

    const fork = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.016, 0.68, 10), chromeMat);
    fork.rotation.x = -0.24;
    fork.position.set(0, 0.68, 0.48);
    leanPivot.add(fork);

    const handlebar = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.48, 10), chromeMat);
    handlebar.rotation.z = Math.PI * 0.5;
    handlebar.position.set(0, 0.98, 0.40);
    leanPivot.add(handlebar);

    // Pedal cranks at the bottom bracket (they turn with the pedal phase, the pedals stay level)
    const bikeFrame = {
      seat: new THREE.Vector3(0, 0.98, -0.28),
      bars: new THREE.Vector3(0, 0.98, 0.4),
      gripHalf: 0.22,
      bracket: new THREE.Vector3(0, 0.34, -0.145),
      crankLength: 0.17
    };
    const crankPivot = new THREE.Group();
    crankPivot.position.copy(bikeFrame.bracket);
    const crankGeo = new THREE.BoxGeometry(0.016, bikeFrame.crankLength, 0.03).translate(0, -bikeFrame.crankLength / 2, 0);
    const pedalGeo = new THREE.BoxGeometry(0.09, 0.018, 0.07);
    const pedals = [];
    for (const side of [1, -1]) {
      const arm = new THREE.Group();
      arm.rotation.x = side > 0 ? 0 : Math.PI;
      const crank = new THREE.Mesh(crankGeo, chromeMat);
      crank.position.x = side * 0.065;
      const pedal = new THREE.Mesh(pedalGeo, tireMat);
      pedal.position.set(side * 0.1, -bikeFrame.crankLength, 0);
      arm.add(crank, pedal);
      crankPivot.add(arm);
      pedals.push(pedal);
    }
    leanPivot.add(crankPivot);

    // Skinned rider (see pedestrians.js), posed every frame with its hands on the grips and feet on the pedals; the
    // helmet rides on its head
    const riderCrowd = new PersonCrowd(1, { farDistance: Infinity });
    riderCrowd.meshes.forEach((m) => this.scene.add(m));
    const riderRig = new PersonRig({ seed: 12.8, scale: 1.0, girth: 0.97, hair: 0.1 });
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.125, 14, 12), helmetMat);
    helmet.scale.set(0.95, 0.68, 1.28);
    this.scene.add(helmet);

    const bikeShadowGeo = new THREE.PlaneGeometry(0.85, 2.25);
    bikeShadowGeo.rotateX(-Math.PI * 0.5);
    const bikeShadow = new THREE.Mesh(bikeShadowGeo, createContactShadowMaterial());
    bikeShadow.position.set(0, 0.02, 0.0);
    bikeShadow.renderOrder = 998;
    root.add(bikeShadow);

    const headLight = new THREE.SpotLight(0xf2f7ff, 0, 20, 0.34, 0.76, 1.25);
    headLight.position.set(0, 1.32, 0.62);
    headLight.target.position.set(0, 0.0, 7.6);
    leanPivot.add(headLight, headLight.target);

    this.scene.add(root);

    return {
      type: 'cyclist',
      label: 'Cyclist',
      mesh: root,
      leanPivot,
      frontWheel,
      rearWheel,
      crankPivot,
      pedals,
      bikeFrame,
      riderCrowd,
      riderRig,
      helmet,
      headLight,
      position: spawnAt(12, 0.6),
      heading: SPAWN.heading,
      speed: 0,
      leanAngle: 0,
      pedalPhase: 0,
      cameraTargetOffset: new THREE.Vector3(0, 1.35, 0),
      chaseDistance: 4.8,
      chaseHeight: 2.05
    };
  }

  // =========================================================================
  // 4. HELICOPTER (3D LOFTED MANHATTAN SIGHTSEEING TWIN-TURBINE CHOPPER)
  // =========================================================================
  createHelicopterEntity() {
    const root = new THREE.Group();
    root.name = 'PlayerHelicopter';

    const tiltPivot = new THREE.Group();
    root.add(tiltPivot);

    const heliLoftMat = createLoftedHelicopterMaterial();
    const blurDiscMat = new THREE.MeshBasicNodeMaterial({
      color: 0xc8d8e8,
      transparent: true,
      opacity: 0.13,
      side: THREE.DoubleSide,
      depthWrite: false
    });

    // 1. 3D Lofted Monocoque Fuselage + Tailboom + Twin-Turbine Cowling + Swept Fin + Stabilizers + Tubular Skids
    const heliBodyGeo = buildHelicopterBodyGeometry();
    const heliBodyMesh = new THREE.Mesh(heliBodyGeo, heliLoftMat);
    heliBodyMesh.castShadow = true;
    heliBodyMesh.receiveShadow = true;
    tiltPivot.add(heliBodyMesh);

    // 2. 4-Blade Main Rotor Assembly with Swashplate, Hub Dome & Yellow Safety Blade Tips
    const mainRotorPivot = new THREE.Group();
    mainRotorPivot.position.set(0, 2.66, -0.35);
    const mainRotorGeo = buildHelicopterMainRotorGeometry();
    const mainRotorMesh = new THREE.Mesh(mainRotorGeo, heliLoftMat);
    mainRotorMesh.castShadow = true;
    mainRotorPivot.add(mainRotorMesh);

    const blurDisc = new THREE.Mesh(new THREE.CylinderGeometry(4.85, 4.85, 0.015, 32), blurDiscMat);
    mainRotorPivot.add(blurDisc);
    tiltPivot.add(mainRotorPivot);

    // 3. 4-Blade Tail Rotor Assembly on Swept Vertical Fin
    const tailRotorPivot = new THREE.Group();
    tailRotorPivot.position.set(0.18, 2.02, -5.62);
    const tailRotorGeo = buildHelicopterTailRotorGeometry();
    const tailRotorMesh = new THREE.Mesh(tailRotorGeo, heliLoftMat);
    tailRotorPivot.add(tailRotorMesh);
    tiltPivot.add(tailRotorPivot);

    // 4. FAA Port (Red), Starboard (Green) & Anti-Collision Fin Beacon (Red) Navigation Strobes
    const navRed = new THREE.Mesh(
      new THREE.SphereGeometry(0.036, 8, 8),
      new THREE.MeshBasicNodeMaterial({ color: 0xff2b2b })
    );
    navRed.position.set(-1.09, 1.54, -4.35);
    const navGreen = new THREE.Mesh(
      new THREE.SphereGeometry(0.036, 8, 8),
      new THREE.MeshBasicNodeMaterial({ color: 0x22ff66 })
    );
    navGreen.position.set(1.09, 1.54, -4.35);
    const navTail = new THREE.Mesh(
      new THREE.SphereGeometry(0.042, 8, 8),
      new THREE.MeshBasicNodeMaterial({ color: 0xff3b2b })
    );
    navTail.position.set(0, 2.84, -6.04);
    tiltPivot.add(navRed, navGreen, navTail);

    this.scene.add(root);

    return {
      type: 'helicopter',
      label: 'Rescue Helicopter',
      mesh: root,
      tiltPivot,
      mainRotorPivot,
      tailRotorPivot,
      position: spawnAt(-90, -40, 96),
      heading: SPAWN.heading,
      speed: 0,
      verticalSpeed: 0,
      pitchAngle: 0,
      rollAngle: 0,
      cameraTargetOffset: new THREE.Vector3(0, 1.55, 0),
      chaseDistance: 11.4,
      chaseHeight: 3.3
    };
  }

  // On a raised curb island (city-config.js BLOCKS: the real blocks, medians & squares), not on open land (parks,
  // woods, fields: at ground level)
  isPointOnSidewalk(x, z) {
    const b = blockAt(x, z);
    return !!b && !(b.open && !b.median) && !(b.park > 0.6 && !b.median);
  }

  getGroundHeight(x, z, mode = 'person', hint = null) {
    // The ground city-grid.js built: the relief, 0 on the roadway, the kerb height on sidewalks, the sunken lawns of
    // the Parc de Vallparadís and the riera channels below street level, the bridge decks (hint: the asker's current
    // height, to stay under a bridge when passing under it). Vehicles never climb the kerbs (the colliders keep them
    // off the islands) but do follow the relief and the decks
    if (mode === 'person') return groundHeightAt(x, z, hint);
    return roadHeightAt(x, z, hint);
  }

  // The colliders whose bounds come within `r` of (x, z), in their original order. They never move, so they are
  // bucketed once into 48 m cells (tens of thousands of buildings: testing them all every frame cost ~0.5 ms)
  nearColliders(x, z, r) {
    const CELL = 48;
    const key = (ix, iz) => (ix + 4096) * 8192 + (iz + 4096);
    if (!this._colliderCells) {
      this._colliderCells = new Map();
      this.colliders.forEach((c, i) => {
        c._order = i;
        for (let ix = Math.floor(c.minX / CELL); ix <= Math.floor(c.maxX / CELL); ix++) {
          for (let iz = Math.floor(c.minZ / CELL); iz <= Math.floor(c.maxZ / CELL); iz++) {
            const k = key(ix, iz);
            let list = this._colliderCells.get(k);
            if (!list) this._colliderCells.set(k, (list = []));
            list.push(c);
          }
        }
      });
      this._nearList = [];
      this._nearStamp = 0;
    }
    const out = this._nearList;
    out.length = 0;
    const stamp = ++this._nearStamp;
    for (let ix = Math.floor((x - r) / CELL); ix <= Math.floor((x + r) / CELL); ix++) {
      for (let iz = Math.floor((z - r) / CELL); iz <= Math.floor((z + r) / CELL); iz++) {
        const list = this._colliderCells.get(key(ix, iz));
        if (!list) continue;
        for (const c of list) {
          if (c._seen === stamp) continue;
          c._seen = stamp;
          out.push(c);
        }
      }
    }
    if (out.length > 1) out.sort((a, b) => a._order - b._order);
    return out;
  }

  // The low solid props the player collides with (FEATURES.propCollisions): cylinders { x, z, r, kind } from
  // street-details.js & city-grid.js (lamp posts, signal poles, bollards, bins, tree trunks), bucketed in 48 m cells
  setPropColliders(props) {
    const CELL = 48;
    const key = (ix, iz) => (ix + 4096) * 8192 + (iz + 4096);
    const cells = new Map();
    for (const p of props) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
      for (let ix = Math.floor((p.x - p.r) / CELL); ix <= Math.floor((p.x + p.r) / CELL); ix++) {
        for (let iz = Math.floor((p.z - p.r) / CELL); iz <= Math.floor((p.z + p.r) / CELL); iz++) {
          const k = key(ix, iz);
          let list = cells.get(k);
          if (!list) cells.set(k, (list = []));
          list.push(p);
        }
      }
    }
    this._propCells = cells;
    this._propCount = props.length;
    this._nearProps = [];
    this._propStamp = 0;
  }

  nearProps(x, z, r) {
    const CELL = 48;
    const key = (ix, iz) => (ix + 4096) * 8192 + (iz + 4096);
    if (!this._propCells) return [];
    const out = this._nearProps;
    out.length = 0;
    const stamp = ++this._propStamp;
    for (let ix = Math.floor((x - r) / CELL); ix <= Math.floor((x + r) / CELL); ix++) {
      for (let iz = Math.floor((z - r) / CELL); iz <= Math.floor((z + r) / CELL); iz++) {
        const list = this._propCells.get(key(ix, iz));
        if (!list) continue;
        for (const p of list) {
          if (p._seen === stamp) continue;
          p._seen = stamp;
          if (Math.abs(p.x - x) <= r + p.r && Math.abs(p.z - z) <= r + p.r) out.push(p);
        }
      }
    }
    return out;
  }

  // Does a body (collisionBody) at (x, z) overlap a prop cylinder? Fills `contact` with the push normal (from the prop
  // towards the body), its depth and the contact point in the car's frame (qx left, qz forward)
  propOverlap(p, x, z, body, contact) {
    const dx = p.x - x, dz = p.z - z;
    if (body.car) {
      const lx = dx * body.cos - dz * body.sin; // left
      const lz = dx * body.sin + dz * body.cos; // forward
      const qx = Math.max(-body.hx, Math.min(body.hx, lx));
      const qz = Math.max(-body.hz, Math.min(body.hz, lz));
      const ex = lx - qx, ez = lz - qz;
      const d = Math.hypot(ex, ez);
      if (d >= p.r) return false;
      let nlx, nlz, depth;
      if (d > 1e-6) {
        nlx = -ex / d; nlz = -ez / d; depth = p.r - d;
      } else {
        const px = body.hx - Math.abs(lx), pz = body.hz - Math.abs(lz);
        if (px < pz) { nlx = lx <= 0 ? 1 : -1; nlz = 0; depth = px + p.r; } else { nlx = 0; nlz = lz <= 0 ? 1 : -1; depth = pz + p.r; }
      }
      if (contact) {
        contact.nx = nlx * body.cos + nlz * body.sin;
        contact.nz = -nlx * body.sin + nlz * body.cos;
        contact.nlx = nlx; contact.nlz = nlz; contact.qx = qx; contact.qz = qz; contact.depth = depth;
      }
      return true;
    }
    const d = Math.hypot(dx, dz);
    const rr = p.r + body.radius;
    if (d >= rr) return false;
    if (contact) {
      if (d > 1e-6) { contact.nx = -dx / d; contact.nz = -dz / d; } else { contact.nx = 1; contact.nz = 0; }
      contact.nlx = contact.nlz = contact.qx = contact.qz = 0;
      contact.depth = rr - d;
    }
    return true;
  }

  propContact(x, z, body) {
    for (const p of this.nearProps(x, z, Math.max(body.extX, body.extZ) + 0.5)) {
      if (this.propOverlap(p, x, z, body, null)) return true;
    }
    return false;
  }

  // Push the player out of the props it overlaps and knock its motion: a post, bollard or trunk stops the car dead on
  // its side and spins it about the contact, a bin gives way; the pedestrian and the cyclist slide round them
  resolvePropCollisions(pos, body, carEntity, entity) {
    const contact = this._propContactInfo ??= { nx: 0, nz: 0, nlx: 0, nlz: 0, qx: 0, qz: 0, depth: 0 };
    const props = this.nearProps(pos.x, pos.z, Math.max(body.extX, body.extZ) + 0.5);
    for (let i = 0; i < props.length; i++) {
      const p = props[i];
      if (!this.propOverlap(p, pos.x, pos.z, body, contact)) continue;
      const { nx, nz, nlx, nlz, qx, qz, depth } = contact;
      pos.x += nx * depth;
      pos.z += nz * depth;
      if (!entity) continue;
      const sin = Math.sin(entity.heading), cos = Math.cos(entity.heading);
      const tvx = sin * (entity.speed || 0) + (entity.vx || 0);
      const tvz = cos * (entity.speed || 0) + (entity.vz || 0);
      const vn = -(tvx * nx + tvz * nz); // approach speed
      if (vn <= 0.3) continue;
      const soft = p.kind === 'bin' ? 0.45 : 1;
      if (carEntity) {
        const j = vn * (1 + 0.15) * soft;
        const jf = j * (nx * sin + nz * cos); // along the heading: comes off the speed; the rest is slip
        carEntity.speed += jf;
        carEntity.vx = (carEntity.vx || 0) + nx * j - jf * sin;
        carEntity.vz = (carEntity.vz || 0) + nz * j - jf * cos;
        carEntity.angularVel = (carEntity.angularVel || 0) + (nlx * qz - nlz * qx) * Math.min(6, vn) * 0.14 * soft;
        carEntity.pitchVel = (carEntity.pitchVel || 0) + nlz * Math.min(10, vn) * 0.12;
        carEntity.rollVel = (carEntity.rollVel || 0) - nlx * Math.min(10, vn) * 0.15;
        carEntity.heaveVel = (carEntity.heaveVel || 0) + Math.min(1.0, vn * 0.08);
        if (vn > 2.2) carEntity.lastCollisionSpark = { x: p.x + nx * p.r, y: pos.y + 0.5, z: p.z + nz * p.r, nx, nz, speed: vn };
      } else if (typeof entity.speed === 'number') {
        entity.speed *= Math.max(0, 1 - Math.abs(nx * sin + nz * cos) * 0.85);
      }
      if (entity.type !== 'person') this.reportCollision(entity, p, 'prop', p.x + nx * p.r, pos.y + 0.5, p.z + nz * p.r, nx, 0, nz, vn);
    }
  }

  // Room for a pedestrian-sized body at (x, z), clear of buildings and props (parked-bikes.js uses it to place racks)
  isClearAt(x, z, radius = 0.6) {
    const body = collisionBody('person', radius, 0, 0);
    const y = this.getGroundHeight(x, z, 'person');
    for (const c of this.nearColliders(x, z, radius + 0.5)) if (buildingContact(c, x, y, z, body)) return false;
    if (this._propCells && this.propContact(x, z, body)) return false;
    return true;
  }

  resolveHorizontalCollision(pos, radius, carEntity = null, entity = carEntity) {
    // The detailed area (the helicopter may roam out over the Vallès & the surrounding towns)
    const heli = this.activeMode === 'helicopter';
    const m = heli ? 6000 : 0;
    pos.x = Math.max(ISLAND_BOUNDS.minX - m, Math.min(ISLAND_BOUNDS.maxX + m, pos.x));
    pos.z = Math.max(ISLAND_BOUNDS.minZ + (heli ? -6000 : 30), Math.min(ISLAND_BOUNDS.maxZ + m, pos.z));
    if (this.activeMode !== 'helicopter' && getIslandBoundsAtZ) {
      const shore = getIslandBoundsAtZ(pos.z);
      const minShoreX = shore.westX + 8.0;
      const maxShoreX = shore.eastX - 8.0;
      if (pos.x < minShoreX) {
        pos.x = minShoreX;
        if (carEntity && carEntity.speed) carEntity.speed *= 0.4;
      } else if (pos.x > maxShoreX) {
        pos.x = maxShoreX;
        if (carEntity && carEntity.speed) carEntity.speed *= 0.4;
      }
    }

    const body = collisionBody(this.activeMode, radius, carEntity ? carEntity.heading : 0, 0,
      carEntity ? carEntity.halfW ?? CAR_HALF_W : CAR_HALF_W, carEntity ? carEntity.halfL ?? CAR_HALF_L : CAR_HALF_L);
    const { sin: sinH, cos: cosH, extX, extZ } = body;
    const contact = this._buildingContact ??= { nx: 0, nz: 0, depth: 0 };

    const reach = Math.max(extX, extZ) + 6;
    let gx = pos.x;
    let gz = pos.z;
    let near = this.nearColliders(gx, gz, reach);
    for (let i = 0; i < near.length; i++) {
      const c = near[i];
      if (buildingContact(c, pos.x, pos.y, pos.z, body, contact)) {
        const { nx, nz, depth } = contact;
        pos.x += nx * depth;
        pos.z += nz * depth;

        if (this._collisionListener && entity && entity.type !== 'person') {
          const sin = carEntity ? sinH : Math.sin(entity.heading);
          const cos = carEntity ? cosH : Math.cos(entity.heading);
          const approachSpeed = -((sin * entity.speed + (entity.vx || 0)) * nx + (cos * entity.speed + (entity.vz || 0)) * nz);
          const support = carEntity ? Math.abs(nx * cos - nz * sin) * body.hx + Math.abs(nx * sin + nz * cos) * body.hz : radius;
          this.reportCollision(entity, c, 'building', pos.x - nx * support, pos.y + (heli ? 1.1 : 0.56), pos.z - nz * support,
            nx, 0, nz, approachSpeed);
        }

        if (carEntity) {
          const totalVx = sinH * carEntity.speed + (carEntity.vx || 0);
          const totalVz = cosH * carEntity.speed + (carEntity.vz || 0);
          const vn = -(totalVx * nx + totalVz * nz);
          if (vn > 0.5) {
            const headOn = Math.abs(sinH * nx + cosH * nz);
            const sideDot = cosH * nx - sinH * nz;
            if (carEntity.phys) {
              // The driving model keeps whatever velocity it is handed, so the wall takes the approach velocity away
              // (a small bounce), scrubs the sliding component and spins the car about the contact
              const j = vn * 1.12;
              const vx2 = totalVx + nx * j, vz2 = totalVz + nz * j;
              const along = vx2 * nx + vz2 * nz;
              const tx = (vx2 - nx * along) * (1 - 0.3 * headOn), tz = (vz2 - nz * along) * (1 - 0.3 * headOn);
              const fwd = (nx * along + tx) * sinH + (nz * along + tz) * cosH;
              carEntity.speed = fwd;
              carEntity.vx = nx * along + tx - fwd * sinH;
              carEntity.vz = nz * along + tz - fwd * cosH;
              // lever: the car corner nearest the wall, in its frame (left, forward)
              const nlx = nx * cosH - nz * sinH, nlz = nx * sinH + nz * cosH;
              const qx = Math.abs(nlx) > 0.2 ? -Math.sign(nlx) * body.hx : 0;
              const qz = Math.abs(nlz) > 0.2 ? -Math.sign(nlz) * body.hz : 0;
              carEntity.angularVel = (carEntity.angularVel || 0) + (nlx * qz - nlz * qx) * Math.min(6, vn) * 0.08;
            } else {
              carEntity.vx = (carEntity.vx || 0) + nx * vn * 0.42;
              carEntity.vz = (carEntity.vz || 0) + nz * vn * 0.42;
              if (headOn > 0.72) {
                carEntity.speed = -carEntity.speed * 0.25;
              } else {
                carEntity.speed *= (1.0 - 0.62 * headOn);
                carEntity.angularVel = (carEntity.angularVel || 0) + sideDot * (sinH * nx + cosH * nz >= 0 ? -1 : 1) * Math.min(3.2, vn * 0.22);
              }
            }
            carEntity.pitchVel = (carEntity.pitchVel || 0) + (sinH * nx + cosH * nz) * Math.min(14.0, vn) * 0.16;
            carEntity.rollVel = (carEntity.rollVel || 0) - sideDot * Math.min(14.0, vn) * 0.22;
            carEntity.heaveVel = (carEntity.heaveVel || 0) + Math.min(1.4, vn * 0.11);
            if (vn > 2.2) {
              carEntity.lastCollisionSpark = {
                x: pos.x - nx * extX * 0.92,
                y: pos.y + 0.56, // over the relief, not the absolute 0.56 of the flat city
                z: pos.z - nz * extZ * 0.92,
                nx,
                nz,
                speed: vn
              };
            }
          }
        }

        // A push that carried it far from where the candidates were gathered (dropped inside a building): gather
        // them again around where it is now, carrying on in the same order
        if (Math.abs(pos.x - gx) > 5 || Math.abs(pos.z - gz) > 5) {
          gx = pos.x;
          gz = pos.z;
          const order = c._order;
          near = this.nearColliders(gx, gz, reach);
          i = -1;
          while (i + 1 < near.length && near[i + 1]._order <= order) i++;
        }
      }
    }

    // The street furniture & the trees (FEATURES.propCollisions): not for the helicopter
    if (this._propCells && !heli) this.resolvePropCollisions(pos, body, carEntity, entity);
  }

  // Pose the skinned characters once every entity has moved: the pedestrian's rig walks (or runs, turns, jumps) it to
  // where it now is, planting its feet on the ground; the cyclist sits on the bike, hands on the grips, feet on the
  // pedals, helmet on its head
  poseCharacters(dt) {
    const p = this.entities.person;
    const air = p.position.y - this.getGroundHeight(p.position.x, p.position.z, 'person', p.position.y);
    p.rig.update(dt, p.position.x, p.position.z, p.heading, personGround, this, air > 0.02 ? air : 0);
    p.crowd.begin();
    p.crowd.add(p.rig, 0);
    p.crowd.end();

    const b = this.entities.cyclist;
    b.riderRig.ride(b.leanPivot, b.pedalPhase, b.bikeFrame);
    b.riderCrowd.begin();
    b.riderCrowd.add(b.riderRig, 0);
    b.riderCrowd.end();
    b.helmet.quaternion.copy(b.riderRig.headQuaternion);
    b.helmet.position.set(0, 0.175, -0.012).applyQuaternion(b.helmet.quaternion).add(b.riderRig.headPosition);
  }

  update(dt, elapsed) {
    this._clock = elapsed;
    const heli = this.entities.helicopter;
    heli.mainRotorPivot.rotation.y += dt * 24.0;
    heli.tailRotorPivot.rotation.x += dt * 32.0;

    if (this.activeMode === 'person') {
      this.updatePerson(dt, elapsed);
    } else if (!FEATURES.enterExit) {
      // Keep the sidewalk pedestrian walking naturally when not actively controlled (the sandbox of the original)
      const p = this.entities.person;
      const walkSpeed = 1.48;
      p.speed = walkSpeed;
      p.position.x += Math.sin(p.heading) * walkSpeed * dt;
      p.position.z += Math.cos(p.heading) * walkSpeed * dt;
      if (p.position.z < -340) p.heading = 0;
      else if (p.position.z > 340) p.heading = Math.PI;
    }

    if (this.activeMode === 'car') {
      this.updateCar(dt, elapsed);
    } else {
      this.updateCarLights(this.entities.car, elapsed); // a parked patrol car keeps its bar & hazards running
    }
    if (this.activeMode === 'cyclist') {
      this.updateCyclist(dt, elapsed);
    } else if (this.activeMode === 'helicopter') {
      this.updateHelicopter(dt, elapsed);
    }

    for (const key of Object.keys(this.entities)) {
      const e = this.entities[key];
      e.mesh.position.copy(e.position);
      e.mesh.rotation.y = e.heading;
    }

    // One person: inside the car or on the bike while driving (hidden there), beside them when walking; the bike
    // stands alone without its rider
    if (FEATURES.enterExit) {
      const p = this.entities.person, b = this.entities.cyclist;
      const walking = this.activeMode === 'person', riding = this.activeMode === 'cyclist';
      if (p.mesh.visible !== walking) {
        p.mesh.visible = walking;
        for (const m of p.crowd.meshes) m.visible = walking;
      }
      if (b.helmet.visible !== riding) {
        b.helmet.visible = riding;
        for (const m of b.riderCrowd.meshes) m.visible = riding;
      }
    }

    // Modulate clustered vehicle & bike lights by time of day (off during Midday & Golden Hour; fade in at Dusk & Night)
    const glow = cityUniforms && cityUniforms.uInteriorGlow ? cityUniforms.uInteriorGlow.value : 0.48;
    const beamScale = Math.min(1.28, Math.max(0.0, (glow - 0.60) * 1.45));
    const car = this.entities.car;
    if (car.headLights) {
      for (const spot of car.headLights) {
        // Accelerating does not change the headlamp output or range.
        spot.intensity = HEADLIGHTS.intensity * beamScale;
      }
    }
    const bike = this.entities.cyclist;
    if (bike.headLight) {
      const bikeActive = this.activeMode === 'cyclist';
      bike.headLight.intensity = bikeActive ? 115 * beamScale : 0;
    }

    this.poseCharacters(dt);
  }

  updatePerson(dt) {
    const p = this.entities.person;
    const maxWalk = this.keys.boost ? 8.2 : 4.4;
    const turnRate = 2.6;

    let targetSpeed = 0;
    if (this.keys.forward) targetSpeed = maxWalk * this.keys.forward;
    else if (this.keys.backward) targetSpeed = -maxWalk * 0.65 * this.keys.backward;

    if (this.keys.left) p.heading += turnRate * dt * this.keys.left;
    if (this.keys.right) p.heading -= turnRate * dt * this.keys.right;

    p.speed += (targetSpeed - p.speed) * Math.min(1, dt * 10);

    p.position.x += Math.sin(p.heading) * p.speed * dt;
    p.position.z += Math.cos(p.heading) * p.speed * dt;
    this.resolveHorizontalCollision(p.position, 0.48);

    const groundY = this.getGroundHeight(p.position.x, p.position.z, 'person', p.position.y);
    if (this.keys.up && p.position.y <= groundY + 0.02) {
      p.verticalVel = 5.2;
    }
    p.verticalVel -= 14.5 * dt;
    p.position.y += p.verticalVel * dt;
    if (p.position.y < groundY) {
      p.position.y = groundY;
      p.verticalVel = 0;
    }
  }

  updateCar(dt) {
    const c = this.entities.car;
    if (c.phys) return this.updateCarPhysics(dt);
    const maxSpeed = this.keys.boost ? CAR_DRIVE.boostSpeed : CAR_DRIVE.speed;

    let throttle = 0;
    if (this.keys.forward) throttle = this.keys.forward;
    else if (this.keys.backward) throttle = -this.keys.backward;

    const braking = c.speed * throttle < 0;
    const previousSpeed = c.speed;
    c.speed = driveSpeed(c.speed, throttle, this.keys.boost, dt, CAR_DRIVE);
    const acceleration = dt > 0 ? (c.speed - previousSpeed) / dt : 0;

    let steerInput = 0;
    if (this.keys.left) steerInput = this.keys.left;
    if (this.keys.right) steerInput = -this.keys.right;

    c.steerAngle += (steerInput * 0.52 - c.steerAngle) * Math.min(1, dt * 10);

    if (Math.abs(c.speed) > 0.2) {
      const dirSign = c.speed >= 0 ? 1 : -1;
      const speedFactor = Math.min(1.0, Math.abs(c.speed) / 8.0);
      c.heading += c.steerAngle * 2.4 * speedFactor * dirSign * dt;
    }

    // Integrate collision yaw spin & lateral tire slip velocity with asphalt grip damping
    const tireGripDamp = Math.exp(-dt * 6.8);
    c.heading += c.angularVel * dt;
    c.angularVel *= Math.exp(-dt * 7.8);

    const prevX = c.position.x;
    const prevZ = c.position.z;
    c.position.x += (Math.sin(c.heading) * c.speed + c.vx) * dt;
    c.position.z += (Math.cos(c.heading) * c.speed + c.vz) * dt;
    c.vx *= tireGripDamp;
    c.vz *= tireGripDamp;

    this.resolveHorizontalCollision(c.position, 1.35, c);
    c.position.y = this.getGroundHeight(c.position.x, c.position.z, 'car', c.position.y);

    // 3-DOF Spring-Damper Chassis Suspension (Pitch, Roll & Vertical Heave), plus the slope of the surface the car
    // is on (the roadway, or a bridge deck: sampled through getGroundHeight with the car's own height as the hint,
    // so on a bridge the deck's slope is used, not the valley's under it): nose up when it rises ahead, leaning into
    // a side slope
    const sinH = Math.sin(c.heading), cosH = Math.cos(c.heading);
    const sx = 1.4, sy = c.position.y;
    const hF = this.getGroundHeight(c.position.x + sinH * sx, c.position.z + cosH * sx, 'car', sy);
    const hB = this.getGroundHeight(c.position.x - sinH * sx, c.position.z - cosH * sx, 'car', sy);
    const hR = this.getGroundHeight(c.position.x + cosH * sx, c.position.z - sinH * sx, 'car', sy);
    const hL = this.getGroundHeight(c.position.x - cosH * sx, c.position.z + sinH * sx, 'car', sy);
    const slopePitch = -Math.atan((hF - hB) / (2 * sx));
    const slopeRoll = Math.atan((hR - hL) / (2 * sx));
    const targetPitch = -Math.max(-1, Math.min(1, acceleration / CAR_DRIVE.acceleration)) * 0.026 + slopePitch;
    const targetRoll = -c.steerAngle * (c.speed / maxSpeed) * 0.092 + slopeRoll;
    const springK = 68.0;
    const dampC = 11.2;
    c.pitchVel += ((targetPitch - c.chassisPivot.rotation.x) * springK - c.pitchVel * dampC) * dt;
    c.rollVel += ((targetRoll - c.chassisPivot.rotation.z) * springK - c.rollVel * dampC) * dt;
    c.chassisPivot.rotation.x = Math.max(-0.22, Math.min(0.22, c.chassisPivot.rotation.x + c.pitchVel * dt));
    c.chassisPivot.rotation.z = Math.max(-0.26, Math.min(0.26, c.chassisPivot.rotation.z + c.rollVel * dt));

    c.heaveVel += (-c.heaveY * 85.0 - c.heaveVel * 12.0) * dt;
    c.heaveY = Math.max(-0.08, Math.min(0.14, c.heaveY + c.heaveVel * dt));
    c.chassisPivot.position.y = c.heaveY;

    if (c.carState) {
      c.carState.value.x = braking || (c.speed === 0 && !throttle) ? 1 : 0;
    }
    this.updateCarLights(c, this._clock || 0);

    const forwardDist = (c.position.x - prevX) * Math.sin(c.heading) + (c.position.z - prevZ) * Math.cos(c.heading);
    const rawWheelStep = forwardDist / 0.35;
    const wheelStep = Math.sign(rawWheelStep) * Math.min(Math.abs(rawWheelStep), 0.48);
    c.wheelSpin = (c.wheelSpin + wheelStep) % (Math.PI * 2);
    for (const w of c.wheels) {
      w.tire.rotation.x = c.wheelSpin + (w.isFront ? 0.0 : 0.55);
      if (w.isFront) {
        w.steerPivot.rotation.y = c.steerAngle;
      }
    }
  }

  // The four-wheel driving model (vehicle-physics.js, FEATURES.carPhysics). W accelerates, S brakes and, held at a
  // standstill, engages reverse (then S accelerates backwards and W brakes), A/D steer, Shift is the handbrake
  updateCarPhysics(dt) {
    const c = this.entities.car;
    const s = c.phys;
    const k = this.keys;
    const fwd = +k.forward || 0, back = +k.backward || 0;
    // In R the pedals swap (S accelerates backwards, W brakes) until the car has stopped and only W is held: then W
    // asks for D again and pulls away forward
    const backToDrive = s.gear < 0 && Math.abs(s.speed) < 0.6 && fwd > 0 && back === 0;
    const reversing = s.gear < 0 && !backToDrive;
    const input = this._carInput ??= { throttle: 0, brake: 0, steer: 0, handbrake: false, reverse: false };
    input.throttle = reversing ? back : fwd;
    input.brake = reversing ? fwd : back;
    input.reverse = back > 0 && fwd === 0 && (reversing || Math.abs(s.speed) < 0.6);
    input.steer = (+k.left || 0) - (+k.right || 0);
    input.handbrake = !!k.boost;

    // Carry in what the collisions changed on the entity since the last step (this manager's and the traffic's:
    // position, forward speed, slip velocity, spin & suspension kicks)
    let sinH = Math.sin(c.heading), cosH = Math.cos(c.heading);
    s.x = c.position.x;
    s.z = c.position.z;
    s.heading = c.heading;
    s.vx = sinH * c.speed + c.vx;
    s.vz = cosH * c.speed + c.vz;
    s.yawRate += c.angularVel;
    s.pitchVel += c.pitchVel * 0.5;
    s.rollVel += c.rollVel * 0.5;
    s.heaveVel += c.heaveVel * 0.5;
    c.angularVel = c.pitchVel = c.rollVel = c.heaveVel = 0;

    const env = this._carEnv ??= { groundAt: (x, z, hint) => this.getGroundHeight(x, z, 'car', hint) };
    stepVehicle(s, input, dt, env);

    // Back to the entity, which is what the camera, HUD, audio & traffic read: the forward speed along the heading
    // plus the slip velocity, and the collisions against buildings, props & traffic on top
    c.position.x = s.x;
    c.position.z = s.z;
    c.heading = s.heading;
    sinH = Math.sin(s.heading);
    cosH = Math.cos(s.heading);
    c.speed = s.speed;
    c.vx = s.vx - sinH * s.speed;
    c.vz = s.vz - cosH * s.speed;
    c.steerAngle = s.steer;
    this.resolveHorizontalCollision(c.position, 1.35, c);
    c.position.y = s.y;

    // Pose: the root follows the ground plane under the four wheels (the slope), the body rides its springs over it,
    // each wheel sits on its own ground (a kerb lifts one side, a stone one wheel)
    c.mesh.rotation.x = -s.slopePitch;
    c.mesh.rotation.z = s.slopeRoll;
    c.chassisPivot.position.y = s.heave;
    c.chassisPivot.rotation.x = -s.pitch;
    c.chassisPivot.rotation.z = s.roll;
    const wheelR = c.spec ? c.spec.wheelRadius : 0.35;
    for (const w of c.wheels) {
      const pw = s.wheels[w.physIndex];
      w.steerPivot.position.y = wheelR + (pw.bump || 0);
      w.tire.rotation.x = pw.spin;
      if (w.isFront) w.steerPivot.rotation.y = s.steer;
    }
    if (c.carState) c.carState.value.x = input.brake > 0.05 || (Math.abs(s.speed) < 0.05 && input.throttle < 0.02) ? 1 : 0;
    this.updateCarLights(c, this._clock || 0);
  }

  // F (main.js): out of the car or off the bike onto the street beside it. The vehicle stays where it is, at rest
  exitVehicle() {
    const mode = this.activeMode;
    if (mode !== 'car' && mode !== 'cyclist') return null;
    const v = this.entities[mode];
    // the driver's door is on the car's left (+x local); the rider steps off to the left too
    const leftX = Math.cos(v.heading), leftZ = -Math.sin(v.heading);
    const side = mode === 'car' ? (v.halfW || CAR_HALF_W) + 0.8 : 0.9;
    const back = mode === 'car' ? -0.2 : 0;
    v.speed = 0;
    v.vx = v.vz = v.angularVel = 0;
    if (v.phys) { v.phys.vx = v.phys.vz = v.phys.yawRate = 0; v.phys.speed = 0; }
    if (v.carState) v.carState.value.x = 0;
    this.setMode('person');
    this.teleportActiveTo(
      v.position.x + leftX * side + Math.sin(v.heading) * back,
      v.position.z + leftZ * side + Math.cos(v.heading) * back,
      v.heading, null, { ignoreOthers: true }
    );
    return 'person';
  }

  // F (main.js): into the car or onto the bike when standing beside them, or onto a parked bicycle (parked-bikes.js)
  enterNearby(maxDistance = 3.4) {
    if (this.activeMode !== 'person') return null;
    const p = this.entities.person;
    const car = this.entities.car, bike = this.entities.cyclist;
    const dCar = Math.hypot(car.position.x - p.position.x, car.position.z - p.position.z) - Math.max(0, (car.halfL || CAR_HALF_L) - 1.3);
    const dBike = Math.hypot(bike.position.x - p.position.x, bike.position.z - p.position.z);
    if (dCar <= maxDistance && dCar <= dBike) {
      this.resetInput();
      this.setMode('car');
      return 'car';
    }
    if (dBike <= maxDistance * 0.8) {
      this.resetInput();
      this.setMode('cyclist');
      return 'cyclist';
    }
    if (this.parkedBikes) {
      const taken = this.parkedBikes.take(p.position.x, p.position.z, 2.8);
      if (taken) {
        this.setMode('cyclist');
        this.teleportActiveTo(taken.x, taken.z, taken.heading, null, { ignoreOthers: true });
        return 'parked';
      }
    }
    return null;
  }

  updateCyclist(dt) {
    const b = this.entities.cyclist;

    let throttle = 0;
    if (this.keys.forward) throttle = this.keys.forward;
    else if (this.keys.backward) throttle = -0.6 * this.keys.backward;

    b.speed = driveSpeed(b.speed, throttle, this.keys.boost, dt, BICYCLE_DRIVE);

    let turnInput = 0;
    if (this.keys.left) turnInput = this.keys.left;
    if (this.keys.right) turnInput = -this.keys.right;

    if (Math.abs(b.speed) > 0.15) {
      const dirSign = b.speed >= 0 ? 1 : -1;
      b.heading += turnInput * 2.15 * dirSign * dt;
    }

    b.position.x += Math.sin(b.heading) * b.speed * dt;
    b.position.z += Math.cos(b.heading) * b.speed * dt;
    this.resolveHorizontalCollision(b.position, 0.65, null, b);
    b.position.y = this.getGroundHeight(b.position.x, b.position.z, 'cyclist', b.position.y);

    const targetLean = -turnInput * Math.min(1.0, Math.abs(b.speed) / 9.0) * 0.34;
    b.leanAngle += (targetLean - b.leanAngle) * Math.min(1, dt * 9);
    b.leanPivot.rotation.z = b.leanAngle;

    const wheelDelta = (b.speed / 0.35) * dt;
    b.frontWheel.rotation.x += wheelDelta;
    b.rearWheel.rotation.x += wheelDelta;

    // The cranks turn with the rear wheel through the gears while pedalling (~110 rpm at cruising speed) and
    // freewheel otherwise; the rider's feet follow the pedals (see poseCharacters)
    if (throttle > 0 && wheelDelta > 0) b.pedalPhase += wheelDelta / 3.2;
    b.crankPivot.rotation.x = b.pedalPhase;
    for (const pedal of b.pedals) pedal.rotation.x = -b.pedalPhase;
  }

  updateHelicopter(dt, elapsed) {
    const h = this.entities.helicopter;
    const maxHorizSpeed = this.keys.boost ? 52.0 : 32.0;
    const maxVertSpeed = 16.0;

    let fwdInput = 0;
    if (this.keys.forward) fwdInput = this.keys.forward;
    else if (this.keys.backward) fwdInput = -this.keys.backward;

    let yawInput = 0;
    if (this.keys.left) yawInput = this.keys.left;
    if (this.keys.right) yawInput = -this.keys.right;

    let vertInput = 0;
    if (this.keys.up) vertInput = this.keys.up;
    else if (this.keys.down) vertInput = -this.keys.down;

    if (fwdInput !== 0) {
      h.speed += fwdInput * 24.0 * dt;
      h.speed = Math.max(-maxHorizSpeed * 0.6, Math.min(maxHorizSpeed, h.speed));
    } else {
      h.speed *= Math.max(0, 1 - dt * 1.8);
    }

    if (vertInput !== 0) {
      h.verticalSpeed += vertInput * 22.0 * dt;
      h.verticalSpeed = Math.max(-maxVertSpeed, Math.min(maxVertSpeed, h.verticalSpeed));
    } else {
      h.verticalSpeed *= Math.max(0, 1 - dt * 3.5);
    }

    h.heading += yawInput * 1.45 * dt;

    h.position.x += Math.sin(h.heading) * h.speed * dt;
    h.position.z += Math.cos(h.heading) * h.speed * dt;
    h.position.y += h.verticalSpeed * dt;

    if (h.position.y < 0.25) {
      this.reportCollision(h, groundCollider, 'ground', h.position.x, 0.25, h.position.z, 0, 1, 0, -h.verticalSpeed);
    }
    h.position.y = Math.max(0.25 + terrainY(h.position.x, h.position.z), Math.min(380 + terrainY(h.position.x, h.position.z), h.position.y));
    this.resolveHorizontalCollision(h.position, 4.5, null, h);

    const targetPitch = (h.speed / maxHorizSpeed) * 0.24;
    const targetRoll = -yawInput * 0.28;
    h.pitchAngle += (targetPitch - h.pitchAngle) * Math.min(1, dt * 5);
    h.rollAngle += (targetRoll - h.rollAngle) * Math.min(1, dt * 5);

    h.tiltPivot.rotation.x = h.pitchAngle;
    h.tiltPivot.rotation.z = h.rollAngle;
    h.tiltPivot.position.y = Math.sin(elapsed * 2.6) * 0.18;
  }
}

export { ThirdPersonControllerManager };
