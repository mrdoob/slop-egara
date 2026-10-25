// js/vehicle-physics.js
// Driving model for the player's car (FEATURES.carPhysics, city-config.js): a rigid body on four independently
// sprung wheels, each with its own tyre, instead of the arcade "speed along the heading" of the original.
//
// Pure arithmetic, no three.js: the controller (controllers.js) feeds it the input and a ground sampler and reads the
// pose back; tests/vehicle-physics.test.cjs runs it headless. Everything is SI (m, kg, N, s, rad); the world frame is
// the city's (x east, z south, y up; heading 0 faces +z, turning left increases it, as in controllers.js). In the
// car's own frame "forward" is (sin heading, cos heading) and "left" is (cos heading, -sin heading): the body's local
// +x is its left-hand side (the traffic's "left (+x) turn signal"). Lateral quantities below are positive to the LEFT,
// yaw & roll follow three.js' rotation.y / rotation.z (positive = turning left / left side up) and pitch is positive
// nose UP (the controller negates it for rotation.x).
//
// What is modelled, per step (sub-stepped at 240 Hz for the stiff tyre forces):
//  - Engine: a torque curve over rpm, an automatic gearbox (ratios, final drive, shift logic with a torque cut while
//    shifting), engine braking, the drive split between the axles (fwd / rwd / awd). Reverse is a gear of its own.
//  - Suspension: one spring-damper per wheel acting on the deviation from its static ride height, so the body heaves,
//    pitches and rolls about the four contact points and the wheel loads follow (load transfer under braking,
//    acceleration and cornering, kerbs and bumps felt one wheel at a time). An anti-roll term couples each axle.
//  - Tyres: slip angle and slip ratio per wheel, a Pacejka-style magic formula for the lateral force whose peak is the
//    wheel load times the friction coefficient, a friction circle so a spinning or locked wheel loses side grip, ABS
//    and traction control switchable per vehicle, a handbrake that locks the rear axle (for turning in the old town).
//  - Resistances: aerodynamic drag, rolling resistance, and gravity along and across the slope under the car (the
//    relief: it costs to climb the Carretera de Rubí and the car runs away down the Rambla if left in neutral).
//  - Steering: a rate-limited wheel angle with speed-sensitive lock (full lock parking, a few degrees at 100 km/h),
//    Ackermann-free (both front wheels turn the same angle: the difference is invisible at this scale).
//
// The vehicle catalogue (VEHICLE_CATALOGUE) describes each selectable car: identity (body loft from actor-models.js,
// livery, paint) and dynamics. No real make or model is named: each one is a plausible archetype of what drives in
// Terrassa (a white hybrid saloon taxi, a compact hatchback, a family SUV, the two police forces' patrol cars, a hot
// hatch), with masses, powers and gear ratios in the range of the real vehicles of that class.

const G = 9.81;
const AIR_DENSITY = 1.2;
const SUBSTEP = 1 / 240;

// Wheel indices
const FL = 0, FR = 1, RL = 2, RR = 3;

// Shape of the torque curve over the rev range, as a fraction of peak torque: a hump that peaks at 55 % of the
// redline and keeps 70 % at the redline (a modern turbo petrol / hybrid family car in broad strokes)
function torqueFraction(r) {
  // r: rpm / redline, 0..1
  const x = Math.max(0, Math.min(1.05, r));
  const hump = 1 - Math.pow((x - 0.55) / 0.55, 2);
  return Math.max(0.45, Math.min(1, 0.45 + 0.55 * hump));
}

// Magic-formula lateral force shape: sin(C atan(B a - E (B a - atan(B a)))), peaking at 1 near a ~ 8-10 degrees
function magicFormula(slip, B = 9.5, C = 1.4, E = -0.6) {
  const Ba = B * slip;
  return Math.sin(C * Math.atan(Ba - E * (Ba - Math.atan(Ba))));
}

/**
 * The selectable vehicles. `body` names the loft in actor-models.js BODY_SPECS ('sedan', 'suv', 'taxi'); `livery` is
 * the carState.w value the car material paints (0 plain, 1 Policia Municipal de Terrassa, 2 Mossos d'Esquadra);
 * `paint` is the body colour. The dynamics:
 *   mass (kg, with driver), cgHeight (m), inertiaYaw (kg m²), wheelbase & track from the loft, wheelRadius (m),
 *   powerKW (for the HUD), torqueNm (peak), redline (rpm), idle (rpm), gears (ratios, forward), reverse (ratio),
 *   finalDrive, drive ('fwd' | 'rwd' | 'awd'), driveEfficiency,
 *   cdA (m², drag coefficient x frontal area), rollingResistance (fraction of weight),
 *   mu (peak tyre friction on dry asphalt), corneringStiffness (per newton of load, 1/rad; the slope of the lateral
 *   force at zero slip is stiffness x load), brakeForce (N, total at full pedal), brakeBias (front share), abs, tcs,
 *   handbrake (rear lock available),
 *   suspension { k (N/m per wheel), c (N s/m per wheel), travel (m), antiRoll (N/m of left-right difference) },
 *   steerLock (rad at the wheel), steerRate (rad/s), topSpeedKmh (HUD scale).
 */
const VEHICLE_CATALOGUE = [
  {
    id: 'taxi', label: 'Taxi de Terrassa', short: 'Taxi', body: 'taxi', livery: 0, paint: 0xf4f4f1, taxiDecal: true,
    description: 'Berlina híbrida blanca amb la franja vermella i blava del taxi de Terrassa i el llum de taxi al sostre.',
    mass: 1480, cgHeight: 0.54, inertiaYaw: 2500, wheelRadius: 0.33,
    powerKW: 90, torqueNm: 190, redline: 5600, idle: 850, gears: [3.6, 2.1, 1.4, 1.0, 0.78, 0.64], reverse: 3.4, finalDrive: 3.9,
    drive: 'fwd', driveEfficiency: 0.9, cdA: 0.66, rollingResistance: 0.012,
    mu: 0.98, corneringStiffness: 14, brakeForce: 15500, brakeBias: 0.64, abs: true, tcs: true, handbrake: true,
    suspension: { k: 26000, c: 2600, travel: 0.11, antiRoll: 12000 },
    steerLock: 0.60, steerRate: 2.6, topSpeedKmh: 175
  },
  {
    id: 'compact', label: 'Compacte', short: 'Compacte', body: 'sedan', livery: 0, paint: 0x9aa3ad,
    description: 'Compacte de gasolina de 1,3 t, el cotxe més corrent de les rondes i de l\'Eixample.',
    mass: 1320, cgHeight: 0.52, inertiaYaw: 2100, wheelRadius: 0.32,
    powerKW: 110, torqueNm: 250, redline: 6200, idle: 800, gears: [3.77, 2.09, 1.32, 0.98, 0.78, 0.64], reverse: 3.6, finalDrive: 3.65,
    drive: 'fwd', driveEfficiency: 0.9, cdA: 0.64, rollingResistance: 0.011,
    mu: 1.02, corneringStiffness: 15, brakeForce: 15000, brakeBias: 0.66, abs: true, tcs: true, handbrake: true,
    suspension: { k: 28000, c: 2800, travel: 0.1, antiRoll: 15000 },
    steerLock: 0.62, steerRate: 2.8, topSpeedKmh: 210
  },
  {
    id: 'suv', label: 'SUV familiar', short: 'SUV', body: 'suv', livery: 0, paint: 0x3a434d,
    description: 'SUV compacte de tracció total: més alt, més pesant, balanceja més i frena pitjor.',
    mass: 1620, cgHeight: 0.64, inertiaYaw: 2900, wheelRadius: 0.36,
    powerKW: 110, torqueNm: 250, redline: 6000, idle: 800, gears: [3.9, 2.2, 1.4, 1.0, 0.8, 0.65], reverse: 3.7, finalDrive: 3.8,
    drive: 'awd', driveEfficiency: 0.86, cdA: 0.82, rollingResistance: 0.013,
    mu: 0.95, corneringStiffness: 12.5, brakeForce: 16500, brakeBias: 0.62, abs: true, tcs: true, handbrake: true,
    suspension: { k: 30000, c: 3100, travel: 0.14, antiRoll: 11000 },
    steerLock: 0.58, steerRate: 2.4, topSpeedKmh: 195
  },
  {
    id: 'municipal', label: 'Policia Municipal de Terrassa', short: 'P. Municipal', body: 'sedan', livery: 1, paint: 0xf6f9fc, lightbar: true,
    description: 'Patrulla blanca de la Policia Municipal amb la banda d\'escacs blaus i grocs i el pont de llums blau (llibrea aproximada).',
    mass: 1420, cgHeight: 0.53, inertiaYaw: 2300, wheelRadius: 0.32,
    powerKW: 110, torqueNm: 250, redline: 6200, idle: 800, gears: [3.77, 2.09, 1.32, 0.98, 0.78, 0.64], reverse: 3.6, finalDrive: 3.65,
    drive: 'fwd', driveEfficiency: 0.9, cdA: 0.66, rollingResistance: 0.011,
    mu: 1.0, corneringStiffness: 15, brakeForce: 15500, brakeBias: 0.66, abs: true, tcs: true, handbrake: true,
    suspension: { k: 28000, c: 2800, travel: 0.1, antiRoll: 15000 },
    steerLock: 0.62, steerRate: 2.8, topSpeedKmh: 205
  },
  {
    id: 'mossos', label: 'Mossos d\'Esquadra', short: 'Mossos', body: 'suv', livery: 2, paint: 0xf6f9fc, lightbar: true,
    description: 'Patrulla dels Mossos: SUV blanc amb la banda blava fosca i la línia vermella, pont de llums blau (llibrea aproximada).',
    mass: 1680, cgHeight: 0.62, inertiaYaw: 3000, wheelRadius: 0.36,
    powerKW: 140, torqueNm: 320, redline: 6000, idle: 800, gears: [3.9, 2.2, 1.4, 1.0, 0.8, 0.65], reverse: 3.7, finalDrive: 3.8,
    drive: 'awd', driveEfficiency: 0.86, cdA: 0.84, rollingResistance: 0.013,
    mu: 1.0, corneringStiffness: 13.5, brakeForce: 17500, brakeBias: 0.62, abs: true, tcs: true, handbrake: true,
    suspension: { k: 32000, c: 3300, travel: 0.13, antiRoll: 14000 },
    steerLock: 0.58, steerRate: 2.5, topSpeedKmh: 210
  },
  {
    id: 'hot', label: 'Esportiu', short: 'Esportiu', body: 'sedan', livery: 0, paint: 0xb0151f,
    description: 'Compacte esportiu de 220 kW i tracció total: suspensió dura, pneumàtics amples, sense pietat als revolts.',
    mass: 1450, cgHeight: 0.48, inertiaYaw: 2300, wheelRadius: 0.33,
    powerKW: 221, torqueNm: 400, redline: 6800, idle: 900, gears: [3.56, 2.53, 1.68, 1.02, 0.79, 0.68], reverse: 3.4, finalDrive: 3.9,
    drive: 'awd', driveEfficiency: 0.88, cdA: 0.68, rollingResistance: 0.011,
    mu: 1.18, corneringStiffness: 18, brakeForce: 19500, brakeBias: 0.66, abs: true, tcs: false, handbrake: true,
    suspension: { k: 38000, c: 3800, travel: 0.08, antiRoll: 22000 },
    steerLock: 0.58, steerRate: 3.2, topSpeedKmh: 250
  }
];

const vehicleById = (id) => VEHICLE_CATALOGUE.find((v) => v.id === id) || VEHICLE_CATALOGUE[0];

/**
 * A fresh dynamic state for a vehicle spec. `wheelbase` and `track` come from the body loft (actor-models.js
 * BODY_SPECS: 2 x wheelZ, 2 x wheelX); the model keeps its own copies so it runs without the loft in tests.
 */
function createVehicleState(spec, { wheelbase = 2.76, track = 1.66 } = {}) {
  const half = wheelbase / 2, ht = track / 2;
  const staticLoad = spec.mass * G / 4;
  // lx is positive on the car's LEFT (its local +x), lz positive ahead
  const wheels = [
    { lx: ht, lz: half, front: true, left: true },
    { lx: -ht, lz: half, front: true, left: false },
    { lx: ht, lz: -half, front: false, left: true },
    { lx: -ht, lz: -half, front: false, left: false }
  ].map((w) => ({
    ...w,
    comp: 0, // suspension deflection from the static ride height (m, + compressed)
    compVel: 0,
    load: staticLoad, // normal force (N)
    groundY: 0,
    spin: 0, // wheel angle for the visuals (rad)
    omega: 0, // wheel angular speed (rad/s)
    slipAngle: 0,
    slipRatio: 0,
    skid: 0, // 0..1, how far past the grip peak the tyre is working
    locked: false,
    spinning: false,
    fx: 0, fy: 0
  }));
  return {
    spec, wheelbase, track,
    x: 0, z: 0, y: 0, heading: 0,
    vx: 0, vz: 0, // world velocity of the body
    yawRate: 0,
    speed: 0, // forward speed (signed)
    lateralSpeed: 0,
    steer: 0, // wheel angle (rad)
    throttle: 0, brake: 0, handbrake: false,
    gear: 1, // 1..n forward, 0 neutral, -1 reverse
    shiftTimer: 0,
    rpm: spec.idle,
    engineTorque: 0,
    heave: 0, heaveVel: 0, // body motion about the static ride height: m up, rad nose up, rad left side up
    pitch: 0, pitchVel: 0,
    roll: 0, rollVel: 0,
    slopePitch: 0, slopeRoll: 0, // the ground plane under the car (same signs)
    accelFwd: 0, accelLat: 0, // body-frame accelerations, lateral positive to the left
    skid: 0, // 0..1 worst tyre (audio, tyre marks)
    wheels
  };
}

// Plane through the four contact heights: pitch (+ nose up) and roll (+ left side up) of the ground under the car
function groundPlane(s) {
  const w = s.wheels;
  const front = (w[FL].groundY + w[FR].groundY) * 0.5;
  const rear = (w[RL].groundY + w[RR].groundY) * 0.5;
  const left = (w[FL].groundY + w[RL].groundY) * 0.5;
  const right = (w[FR].groundY + w[RR].groundY) * 0.5;
  s.slopePitch = Math.atan((front - rear) / s.wheelbase);
  s.slopeRoll = Math.atan((left - right) / s.track);
  s.y = (front + rear) * 0.5;
}

/**
 * Advance the vehicle by dt seconds.
 *   input: { throttle 0..1, brake 0..1, steer -1..1 (+ left), handbrake bool, reverse bool (the driver asks for R) }
 *   env:   { groundAt(x, z, hint) -> y, grip(x, z) -> multiplier (optional, 1 = dry asphalt) }
 * External impulses (collisions) are applied by the caller between steps on vx, vz, yawRate.
 */
function stepVehicle(s, input, dt, env) {
  const steps = Math.max(1, Math.ceil(dt / SUBSTEP));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) substep(s, input, h, env);
  // Pose summary for the caller
  const sinH = Math.sin(s.heading), cosH = Math.cos(s.heading);
  s.speed = s.vx * sinH + s.vz * cosH;
  s.lateralSpeed = s.vx * cosH - s.vz * sinH; // + to the left
  let worst = 0;
  for (const w of s.wheels) worst = Math.max(worst, w.skid);
  s.skid = worst;
  return s;
}

function substep(s, input, h, env) {
  const spec = s.spec;
  const m = spec.mass;
  const sinH = Math.sin(s.heading), cosH = Math.cos(s.heading);
  // body-frame velocity: u forward, v to the left
  const u = s.vx * sinH + s.vz * cosH;
  const v = s.vx * cosH - s.vz * sinH;
  const speedAbs = Math.hypot(u, v);

  // ---- Steering: rate limited, lock shrinking with speed (full at rest, ~1/3 at 30 m/s) --------------------------
  const lockScale = 1 / (1 + Math.pow(Math.abs(u) / 13, 2) * 0.9);
  const steerTarget = input.steer * spec.steerLock * lockScale;
  const steerMax = spec.steerRate * h * (1 + Math.min(1.5, speedAbs / 10)); // quicker to return at speed
  s.steer += Math.max(-steerMax, Math.min(steerMax, steerTarget - s.steer));

  // ---- Ground under each wheel: heights, the ground plane, suspension deflections --------------------------------
  for (const w of s.wheels) {
    const wx = s.x + w.lx * cosH + w.lz * sinH;
    const wz = s.z - w.lx * sinH + w.lz * cosH;
    w.groundY = env.groundAt(wx, wz, s.y);
  }
  groundPlane(s);
  const k = spec.suspension.k, c = spec.suspension.c, travel = spec.suspension.travel;
  const staticLoad = m * G / 4;
  let sumF = 0, sumPitch = 0, sumRoll = 0;
  const loads = [0, 0, 0, 0];
  const tanP = Math.tan(s.slopePitch), tanR = Math.tan(s.slopeRoll);
  for (let i = 0; i < 4; i++) {
    const w = s.wheels[i];
    // how far that corner of the body sits below its static height: heave lifts the body, pitch (+ nose up) lifts the
    // front corners, roll (+ left up) lifts the left corners
    const bodyDrop = -(s.heave + s.pitch * w.lz + s.roll * w.lx);
    // the wheel's ground relative to the plane under the car (a wheel on a kerb sits higher than the plane)
    const bump = w.groundY - (s.y + tanP * w.lz + tanR * w.lx);
    const comp = Math.max(-travel, Math.min(travel, bodyDrop + bump)); // + compressed
    w.compVel = (comp - w.comp) / h;
    w.comp = comp;
    const antiRoll = spec.suspension.antiRoll * (comp - s.wheels[i ^ 1].comp); // the other wheel of the axle
    let f = k * comp + c * w.compVel + antiRoll; // force on the body over the static preload, + up
    if (f < -staticLoad) f = -staticLoad; // a wheel in the air carries nothing (it cannot pull the body down)
    loads[i] = staticLoad + f;
    sumF += f;
    sumPitch += f * w.lz; // an upward force at the front pitches the nose up
    sumRoll += f * w.lx; // an upward force on the left rolls the left side up
  }
  // Body motion about the static ride height, driven by the spring deviations and by the inertial loads: accelerating
  // squats the rear (nose up), braking dives (nose down), cornering to the left throws the body to the right
  // (right springs compressed, left side up: roll > 0)
  const Ipitch = m * 0.9, Iroll = m * 0.42; // kg m²: a 4.5 x 1.8 m box with its mass low
  const inertialPitch = m * s.accelFwd * spec.cgHeight;
  const inertialRoll = m * s.accelLat * spec.cgHeight;
  s.heaveVel += (sumF / m) * h;
  s.heave += s.heaveVel * h;
  s.pitchVel += ((sumPitch + inertialPitch) / Ipitch) * h;
  s.pitch += s.pitchVel * h;
  s.rollVel += ((sumRoll + inertialRoll) / Iroll) * h;
  s.roll += s.rollVel * h;
  // bump stops
  s.heave = Math.max(-travel, Math.min(travel, s.heave));
  s.pitch = Math.max(-0.2, Math.min(0.2, s.pitch));
  s.roll = Math.max(-0.2, Math.min(0.2, s.roll));

  // ---- Powertrain -----------------------------------------------------------------------------------------------
  const wheelR = spec.wheelRadius;
  const wheelOmega = u / wheelR; // the driven wheels roll with the car (no wheel inertia; the spin is a visual)
  const rpmOf = (ratio) => Math.abs(wheelOmega) * ratio * 60 / (2 * Math.PI);
  // Gear selection: the driver asks for R by braking to a stop and holding reverse, and goes back to D with the throttle
  if (input.reverse && s.gear !== -1 && Math.abs(u) < 0.6) { s.gear = -1; s.shiftTimer = 0.25; }
  else if (!input.reverse && s.gear === -1 && Math.abs(u) < 0.6 && input.throttle > 0) { s.gear = 1; s.shiftTimer = 0.25; }
  if (s.gear > 0 && s.shiftTimer <= 0) {
    // automatic: up near the redline (sooner on a light throttle), down when the revs fall or on a kick-down
    const rpmNow = rpmOf(spec.gears[s.gear - 1] * spec.finalDrive);
    const upAt = spec.redline * (0.55 + 0.4 * input.throttle);
    if (rpmNow > upAt && s.gear < spec.gears.length) { s.gear++; s.shiftTimer = 0.3; }
    else if (s.gear > 1) {
      const rpmLower = rpmOf(spec.gears[s.gear - 2] * spec.finalDrive);
      if (rpmNow < spec.redline * 0.3 || (input.throttle > 0.9 && rpmLower < spec.redline * 0.82 && rpmNow < spec.redline * 0.6)) { s.gear--; s.shiftTimer = 0.3; }
    }
  }
  s.shiftTimer = Math.max(0, s.shiftTimer - h);
  const ratio = s.gear > 0 ? spec.gears[s.gear - 1] * spec.finalDrive : s.gear < 0 ? spec.reverse * spec.finalDrive : 0;
  const rpmFromWheels = rpmOf(ratio);
  // the converter slips at low speed: the engine idles (and revs with the throttle) until the wheels catch up
  const slipping = rpmFromWheels < spec.idle;
  const rpmTarget = Math.max(spec.idle + (slipping ? input.throttle * (s.shiftTimer > 0 ? 400 : 1800) : 0), Math.min(spec.redline, rpmFromWheels));
  s.rpm += (rpmTarget - s.rpm) * Math.min(1, h * 12);
  let engineTorque = 0;
  if (ratio > 0 && s.shiftTimer <= 0) {
    const tq = spec.torqueNm * torqueFraction(s.rpm / spec.redline);
    engineTorque = rpmFromWheels >= spec.redline ? 0 : tq * input.throttle;
    if (input.throttle < 0.05) engineTorque = -spec.torqueNm * 0.08 * Math.min(1, Math.abs(u) / 3); // engine braking
  }
  s.engineTorque = engineTorque;
  const driveForce = (engineTorque * ratio * spec.driveEfficiency / wheelR) * (s.gear < 0 ? -1 : 1); // at the wheels, + forward

  // ---- Brakes --------------------------------------------------------------------------------------------------
  const brakeTotal = input.brake * spec.brakeForce;
  const brakeFront = brakeTotal * spec.brakeBias * 0.5, brakeRear = brakeTotal * (1 - spec.brakeBias) * 0.5;
  const handbrake = !!input.handbrake && spec.handbrake;

  // ---- Tyres ----------------------------------------------------------------------------------------------------
  const mu = spec.mu * (env.grip ? env.grip(s.x, s.z) : 1);
  const frontShare = spec.drive === 'fwd' ? 1 : spec.drive === 'rwd' ? 0 : 0.5;
  let FLat = 0, FFwd = 0, Mz = 0; // body-frame sums: lateral (+ left), longitudinal (+ forward), yaw (+ left)
  for (let i = 0; i < 4; i++) {
    const w = s.wheels[i];
    const load = loads[i];
    w.load = load;
    const steer = w.front ? s.steer : 0;
    const cs = Math.cos(steer), sn = Math.sin(steer);
    // the contact point's velocity in the body frame: turning left (+ yawRate) carries a point ahead to the left and
    // a point on the left backwards
    const pointLat = v + s.yawRate * w.lz;
    const pointFwd = u - s.yawRate * w.lx;
    // ... in the wheel's frame, turned left by the steer angle
    const wFwd = pointFwd * cs + pointLat * sn;
    const wLat = pointLat * cs - pointFwd * sn;
    // slip angle: positive when the contact patch slides to the wheel's left (the tyre then pushes right)
    const slipAngle = Math.atan2(wLat, Math.max(0.6, Math.abs(wFwd)));
    w.slipAngle = slipAngle;
    const Fmax = Math.max(0, mu * load);
    // longitudinal demand: the drive at the driven wheels, the brakes against the wheel's motion (holding it at rest)
    let demand = driveForce * (w.front ? frontShare : 1 - frontShare) * 0.5;
    const moving = Math.abs(wFwd) > 0.05;
    const brakeHere = w.front ? brakeFront : brakeRear;
    demand += brakeHere * (moving ? -Math.sign(wFwd) : -Math.sign(demand || u || 0));
    w.locked = false;
    w.spinning = false;
    let fx;
    if (handbrake && !w.front) {
      // the rear axle locked: kinetic friction against its motion and hardly any cornering grip
      fx = moving ? -Math.sign(wFwd) * Fmax * 0.7 : 0;
      w.locked = true;
    } else if (Math.abs(demand) <= Fmax * 0.98) {
      fx = demand;
    } else if (demand < 0 ? spec.abs : spec.tcs) {
      fx = Math.sign(demand) * Fmax * 0.95; // ABS / traction control hold the tyre at the limit
    } else {
      fx = Math.sign(demand) * Fmax * 0.72; // over the limit: the wheel locks (braking) or spins (driving)
      if (demand < 0 && moving) w.locked = true; else if (demand > 0) w.spinning = true;
    }
    // lateral: linear in the slip angle at first, saturating on the magic formula at what the friction circle leaves
    const stiffness = spec.corneringStiffness * load; // N/rad at zero slip
    const lateralCap = Math.sqrt(Math.max(0, Fmax * Fmax - fx * fx)) * (w.locked ? 0.35 : w.spinning ? 0.55 : 1);
    let fy = -stiffness * slipAngle;
    const mf = -lateralCap * magicFormula(slipAngle * (stiffness / Math.max(1, lateralCap)) / 9.5);
    if (Math.abs(fy) > Math.abs(mf)) fy = mf;
    if (speedAbs < 0.15 && Math.abs(demand) < 50 && input.throttle < 0.02) fy = -pointLat * load * 2; // parked: no creep
    w.fx = fx;
    w.fy = fy;
    w.skid = Math.max(0, Math.min(1, (Math.hypot(fx, fy) - Fmax * 0.82) / Math.max(1, Fmax * 0.2)));
    if (w.locked || w.spinning) w.skid = Math.max(w.skid, 0.7);
    // back to the body frame (the wheel's forward axis is (sn, cs) in (left, forward), its left axis (cs, -sn))
    const bodyFwd = fx * cs - fy * sn;
    const bodyLat = fx * sn + fy * cs;
    FFwd += bodyFwd;
    FLat += bodyLat;
    // yaw moment (+ left): a leftward force ahead of the axle turns the car left, a forward force on the left turns it right
    Mz += bodyLat * w.lz - bodyFwd * w.lx;
    // wheel spin for the visuals: rolling with its contact speed, held when locked, over-spinning when spinning
    w.omega = w.locked ? 0 : w.spinning ? wFwd / wheelR + 18 * Math.sign(driveForce || 1) : wFwd / wheelR;
    w.spin = (w.spin + w.omega * h) % (Math.PI * 2);
  }

  // ---- Resistances & gravity along the slope --------------------------------------------------------------------
  const drag = 0.5 * AIR_DENSITY * spec.cdA * speedAbs;
  FFwd -= drag * u;
  FLat -= drag * v * 2.5; // the car is a bad shape sideways
  if (Math.abs(u) > 0.2) FFwd -= Math.sign(u) * spec.rollingResistance * m * G;
  // nose up (climbing) pulls the car back; left side up pulls it to the right
  FFwd -= m * G * Math.sin(s.slopePitch);
  FLat -= m * G * Math.sin(s.slopeRoll);

  // ---- Integrate ------------------------------------------------------------------------------------------------
  let aLat = FLat / m, aFwd = FFwd / m;
  // At rest with no throttle the tyres' static friction holds the car (an automatic creeps against a gentle slope)
  if (speedAbs < 0.12 && input.throttle < 0.02 && Math.abs(Math.sin(s.slopePitch)) * G < 1.5) {
    aLat = -v / h * 0.5;
    aFwd = -u / h * 0.5;
    s.yawRate *= 0.5;
  }
  s.accelFwd = aFwd;
  s.accelLat = aLat;
  s.yawRate += (Mz / spec.inertiaYaw) * h;
  s.yawRate *= Math.exp(-h * 0.4);
  // body frame → world: forward = (sinH, cosH), left = (cosH, -sinH)
  s.vx += (aFwd * sinH + aLat * cosH) * h;
  s.vz += (aFwd * cosH - aLat * sinH) * h;
  s.heading += s.yawRate * h;
  s.x += s.vx * h;
  s.z += s.vz * h;
}

// Suggested gear label for the HUD
function gearLabel(s) {
  if (s.gear < 0) return 'R';
  if (s.gear === 0) return 'N';
  return String(s.gear);
}

export { VEHICLE_CATALOGUE, vehicleById, createVehicleState, stepVehicle, torqueFraction, magicFormula, gearLabel, G };
