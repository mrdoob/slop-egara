import * as THREE from 'three/webgpu';
import { CITY_LANDMARKS, LANDMARK_SITES, TELEPORT_LOCATIONS, SPAWN, STREET_INDEX, PARKS, pointInPoly } from './city-config.js';
import { groundHeightAt } from './city-grid.js';

// js/cameras.js
// Multi-camera system supporting Third-Person Chase (with mouse/touch orbit + zoom),
// Low-Angle Action Cam, POV/Cockpit Cam, 7 Scenic Terrassa Cameras, and Auto-Director Drone.

const CAMERA_PRESETS = [
  { id: 'chase',       name: '3rd-Person Chase',                 short: 'Chase',       category: 'follow', fov: 56 },
  { id: 'action',      name: 'Low-Angle Action',                 short: 'Action',      category: 'follow', fov: 60 },
  { id: 'pov',         name: 'First-Person / Cockpit',           short: 'POV / Dash',  category: 'follow', fov: 68 },
  { id: 'placaVella',  name: 'Plaça Vella & Catedral',           short: 'Plaça Vella', category: 'scenic', fov: 58 },
  { id: 'masiaFreixa', name: 'Masia Freixa · Parc de Sant Jordi', short: 'Masia Freixa', category: 'scenic', fov: 50 },
  { id: 'rambla',      name: 'Rambla d\'Ègara & mNACTEC',        short: 'Rambla',      category: 'scenic', fov: 48 },
  { id: 'vallparadis', name: 'Vallparadís & Castell Cartoixa',   short: 'Vallparadís', category: 'scenic', fov: 52 },
  { id: 'mutua',       name: 'Mútua Tower Rooftop · 70 m',       short: 'Mútua',       category: 'scenic', fov: 52 },
  { id: 'estadi',      name: 'Estadi Olímpic',                   short: 'Estadi',      category: 'scenic', fov: 50 },
  { id: 'skyline',     name: 'Skyline & La Mola',                short: 'Skyline',     category: 'scenic', fov: 46 },
  { id: 'drone',       name: 'Auto-Director Aerial',             short: 'Director',    category: 'scenic', fov: 50 }
];

// ---------------------------------------------------------------------------------------------------------------------
// Scenic vantage points, looked up by id / name in the city data at module load (never hard-coded coordinates): the
// landmarks' real OpenStreetMap centres & sizes (CITY_LANDMARKS / LANDMARK_SITES), the parks' outlines, the street
// index and the teleport arrivals. Every spot falls back to the Plaça Vella (the world origin) when its data is absent.
// ---------------------------------------------------------------------------------------------------------------------
const ORIGIN = { x: 0, z: 0 };
const landmarks = Array.isArray(CITY_LANDMARKS) ? CITY_LANDMARKS : [];
const sites = LANDMARK_SITES || {};
const landmark = (id) => landmarks.find((l) => l.id === id) || null;
const site = (name) => sites[name] || null;
const park = (name) => (Array.isArray(PARKS) ? PARKS.find((p) => p.name === name) : null) || null;
const street = (name) => (Array.isArray(STREET_INDEX) ? STREET_INDEX.find((e) => e.name === name) : null) || null;
const teleport = (key) => (TELEPORT_LOCATIONS && TELEPORT_LOCATIONS[key]) || null;
const pointOf = (p, fallback = ORIGIN) => (p && Number.isFinite(p.x) && Number.isFinite(p.z) ? { x: p.x, z: p.z } : { x: fallback.x, z: fallback.z });
function centroidOf(ring) {
  if (!ring || !ring.length) return null;
  let x = 0, z = 0;
  for (const p of ring) { x += p.x; z += p.z; }
  return { x: x / ring.length, z: z / ring.length };
}
// A point `dist` metres from `from` toward `to` (or along +z when both coincide)
function towards(from, to, dist) {
  const dx = to.x - from.x, dz = to.z - from.z;
  const L = Math.hypot(dx, dz) || 1;
  return { x: from.x + (dx / L) * dist, z: from.z + (dz / L) * dist };
}

const spawn = pointOf(SPAWN);
const placaVella = pointOf(landmark('placavella'));
const catedral = pointOf(landmark('catedral'), { x: placaVella.x + 70, z: placaVella.z });
const masia = pointOf(landmark('masiafreixa'));
const santJordiPark = park('Parc de Sant Jordi');
const santJordi = pointOf(santJordiPark ? centroidOf(santJordiPark.rings[0]) : landmark('santjordi'), { x: masia.x - 60, z: masia.z + 20 });
// The Rambla d'Ègara runs north-south past the mNACTEC (the Vapor Aymerich, Amat i Jover) and the Mercat
const mnactec = landmark('mnactec') || teleport('rambla') || landmark('mercat') || street('Rambla d\'Ègara');
const rambla = pointOf(mnactec, { x: placaVella.x - 200, z: placaVella.z - 200 });
const cartoixa = pointOf(landmark('cartoixa'));
// A spot inside the Parc de Vallparadís (the torrent is a narrow valley west of the castle) with the castle in view: the
// first point around the castle that the park's real outline contains, west first
const vallparadisPark = park('Parc de Vallparadís');
const insidePark = (p, pt) => !!(p && p.rings && p.rings[0] && typeof pointInPoly === 'function' && pointInPoly(p.rings[0], pt.x, pt.z));
const vallparadis = (() => {
  for (const d of [110, 80, 150, 200]) {
    for (const a of [1, 1.25, 0.75, 1.5, 0.5]) { // turns of PI: west, south-west, north-west, south, north
      const pt = { x: cartoixa.x + Math.cos(a * Math.PI) * d, z: cartoixa.z + Math.sin(a * Math.PI) * d };
      if (insidePark(vallparadisPark, pt)) return pt;
    }
  }
  return towards(cartoixa, pointOf(landmark('vallparadis'), { x: cartoixa.x - 60, z: cartoixa.z + 300 }), 150);
})();
const mutua = landmark('mutua');
const mutuaTop = { ...pointOf(mutua), y: (mutua && mutua.site && mutua.site.h) || 70 };
const estadiSite = site('Estadi Municipal Olímpic') || (landmark('estadi') || {}).site || null;
const estadi = { ...pointOf(landmark('estadi')), w: (estadiSite && estadiSite.w) || 150, d: (estadiSite && estadiSite.d) || 180 };

const SCENIC = {
  // Low in the square, by its west side, looking east at the Catedral del Sant Esperit over the terraces
  placaVella: { pos: { ...towards(placaVella, catedral, -24), y: 2.2 }, look: { ...catedral, y: 15 } },
  // From the lawn of the Parc de Sant Jordi toward the Masia Freixa (Lluís Muncunill's modernista masia)
  masiaFreixa: { pos: { ...towards(masia, santJordi, 78), y: 1.7 }, look: { ...masia, y: 8 } },
  // On the Rambla d'Ègara south of the mNACTEC, looking north up the Rambla toward the vapor's chimney
  rambla: { pos: { x: rambla.x, y: 4.5, z: rambla.z + 170 }, look: { x: rambla.x, y: 14, z: rambla.z - 120 } },
  // Inside the Parc de Vallparadís (the torrent), looking up at the Castell Cartoixa on its edge
  vallparadis: { pos: { ...vallparadis, y: 1.8 }, look: { ...cartoixa, y: 12 } },
  // The roof of the Hospital Universitari Mútua Terrassa tower (17 floors, 70 m), panning over the centre
  mutua: { pos: { x: mutuaTop.x, y: mutuaTop.y + 4, z: mutuaTop.z }, look: { ...catedral, y: 28 } },
  // Above the south-east stand of the Estadi Olímpic, looking down onto the pitch
  estadi: { pos: { x: estadi.x + estadi.w * 0.7, y: 26, z: estadi.z + estadi.d * 0.7 }, look: { x: estadi.x, y: 2, z: estadi.z } },
  // Aerial from south of the centre looking north (-z) over the rooftops toward La Mola & Sant Llorenç del Munt
  skyline: { pos: { x: spawn.x - 220, y: 150, z: spawn.z + 1300 }, look: { x: spawn.x, y: 60, z: spawn.z - 2600 } },
  // The auto-director orbits the centre, between the Plaça Vella and the Mútua tower
  drone: { center: { x: (placaVella.x + mutuaTop.x) * 0.5, y: 120, z: (placaVella.z + mutuaTop.z) * 0.5 } }
};

class CameraSystem {
  constructor(domElement, controllerManager) {
    this.domElement = domElement;
    this.controllerManager = controllerManager;

    this.camera = new THREE.PerspectiveCamera(
      56,
      window.innerWidth / window.innerHeight,
      0.35,
      60000 // at 1:1 the Vallès and the Serra de l'Obac run out ~20-40 km to the fogged horizon (reversed float depth keeps precision)
    );

    this.activePresetId = 'chase';
    this.orbitYawOffset = 0.0;
    this.orbitPitchOffset = 0.09;
    this.zoomMultiplier = 1.0;
    this.isDragging = false;
    this.userOrbitTimer = 0;

    // Start just behind the spawn (on the street by the Plaça Vella), looking at it
    this.currentPos = new THREE.Vector3(spawn.x, 10, spawn.z + 60);
    this.currentLookAt = new THREE.Vector3(spawn.x, 8, spawn.z);
    this.initialized = false;

    // Follow cameras (chase / action) are smoothed relative to the followed entity, see update()
    this.followEntity = null;
    this.followOffset = new THREE.Vector3();
    this.followLookOffset = new THREE.Vector3();
    this.followBaseY = 0;
    this.smoothedSpeed = 0;
    this._desiredPos = new THREE.Vector3();
    this._desiredLook = new THREE.Vector3();

    this.bindPointerControls();
  }

  bindPointerControls() {
    const canvas = this.domElement;
    const pointers = new Map();
    canvas.style.touchAction = 'none';

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || pointers.size >= 2) return;
      // Only two touch pointers may share a gesture; mouse and pen drags stay independent.
      if (pointers.size && (e.pointerType !== 'touch' || pointers.values().next().value.type !== 'touch')) return;
      e.preventDefault();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
      canvas.setPointerCapture(e.pointerId);
      this.isDragging = true;
      this.userOrbitTimer = 4.0;
    });

    canvas.addEventListener('pointermove', (e) => {
      const pointer = pointers.get(e.pointerId);
      if (!pointer) return;
      e.preventDefault();
      const dx = e.clientX - pointer.x;
      const dy = e.clientY - pointer.y;
      const pair = pointers.size === 2 ? [...pointers.values()] : null;
      const previousDistance = pair ? Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y) : 0;
      pointer.x = e.clientX;
      pointer.y = e.clientY;

      if (pair) {
        const distance = Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
        if (previousDistance > 1 && distance > 1) {
          this.zoomMultiplier = Math.max(0.45, Math.min(2.4, this.zoomMultiplier * previousDistance / distance));
        }
      } else {
        this.orbitYawOffset -= dx * 0.0065;
        this.orbitPitchOffset = Math.max(-0.32, Math.min(0.68, this.orbitPitchOffset + dy * 0.005));
      }
      this.userOrbitTimer = 4.0;
    });

    const releasePointer = (id) => {
      if (!pointers.delete(id)) return;
      this.isDragging = pointers.size > 0;
      if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      canvas.addEventListener(type, (e) => releasePointer(e.pointerId));
    }
    const clearPointers = () => {
      for (const id of pointers.keys()) releasePointer(id);
    };
    this._clearPointers = clearPointers;
    window.addEventListener('blur', clearPointers);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) clearPointers();
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomMultiplier = Math.max(0.45, Math.min(2.4, this.zoomMultiplier + e.deltaY * 0.001));
    }, { passive: false });
  }

  setCameraPreset(presetId, snapImmediately = false) {
    const preset = CAMERA_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    this.activePresetId = preset.id;
    this.camera.fov = preset.fov;
    this.camera.updateProjectionMatrix();
    if (snapImmediately) {
      this.initialized = false;
    }
  }

  applyGamepadInput(lookX, lookY, zoom, dt) {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    if (this.activePresetId !== 'chase' && this.activePresetId !== 'pov') return;
    // POV uses the orbit angles, but only chase renders a zoomed camera distance.
    if (this.activePresetId !== 'chase') zoom = 0;
    if (!lookX && !lookY && !zoom) return;
    this.orbitYawOffset -= lookX * 2.0 * dt;
    this.orbitPitchOffset = Math.max(-0.32, Math.min(0.68, this.orbitPitchOffset + lookY * 1.25 * dt));
    this.zoomMultiplier = Math.max(0.45, Math.min(2.4, this.zoomMultiplier + zoom * 0.9 * dt));
    this.userOrbitTimer = 4.0;
  }

  resetOrbit() {
    this.orbitYawOffset = 0;
    this.orbitPitchOffset = 0.09;
    this.zoomMultiplier = 1;
    this.userOrbitTimer = 0;
  }

  resetForTeleport() {
    // Arrive with a fresh chase view, without carrying a previous drive or gesture into the destination.
    this._clearPointers();
    this.isDragging = false;
    this.resetOrbit();
    this.smoothedSpeed = 0;
    this.followEntity = null;
    this.followOffset.set(0, 0, 0);
    this.followLookOffset.set(0, 0, 0);
    this.followBaseY = 0;
    this.setCameraPreset('chase', true);
  }

  getActivePreset() {
    return CAMERA_PRESETS.find((p) => p.id === this.activePresetId) || CAMERA_PRESETS[0];
  }

  onResize(width, height) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  update(dt, elapsed) {
    const entity = this.controllerManager.getActiveEntity();
    const desiredPos = this._desiredPos;
    const desiredLook = this._desiredLook;

    if (this.userOrbitTimer > 0 && !this.isDragging) {
      this.userOrbitTimer = Math.max(0, this.userOrbitTimer - dt);
    }

    if (!this.isDragging && this.userOrbitTimer <= 0 && Math.abs(entity.speed) > 0.5) {
      this.orbitYawOffset -= Math.round(this.orbitYawOffset / (Math.PI * 2)) * (Math.PI * 2);
      this.orbitYawOffset += (0.0 - this.orbitYawOffset) * (1 - Math.exp(-dt * 2.2));
    }

    // The follow cameras pull back with speed, eased so that they drift back as the entity speeds up (and in as it
    // slows down); speedLag is about how far their former world-space smoothing left them trailing at 60 FPS
    this.smoothedSpeed += (Math.abs(entity.speed) - this.smoothedSpeed) * (1 - Math.exp(-dt * 3.0));
    const speedLag = this.smoothedSpeed * 0.1;

    const totalYaw = entity.heading + this.orbitYawOffset;

    switch (this.activePresetId) {
      case 'chase': {
        const dist = entity.chaseDistance * this.zoomMultiplier * (1 + Math.min(0.25, this.smoothedSpeed * 0.01));
        const height = entity.chaseHeight * this.zoomMultiplier + Math.sin(this.orbitPitchOffset) * dist * 0.85;
        const horizDist = Math.cos(this.orbitPitchOffset) * dist + speedLag;

        // the floor is the ground under the camera (the relief: city-grid.js groundHeightAt), never an absolute height
        const camX = entity.position.x - Math.sin(totalYaw) * horizDist;
        const camZ = entity.position.z - Math.cos(totalYaw) * horizDist;
        desiredPos.set(camX, Math.max(groundHeightAt(camX, camZ) + 0.65, entity.position.y + height), camZ);

        // The look target leads the entity along the CAMERA's yaw, not its heading: orbiting round it (a drag, the
        // right stick) keeps it in the middle of the frame, as a game's third-person camera does. It used to lead
        // 5.2 m along the heading, so at 90 degrees of orbit the pedestrian slid to the edge of the picture ("el
        // personaje pierde el foco"). Vehicles lead further (you want to see the road), the pedestrian barely
        const lookUpBias = entity.type === 'helicopter' ? 0.2 : (entity.type === 'car' ? 0.52 : 1.55);
        const lead = entity.type === 'person' ? 0.9 : entity.type === 'cyclist' ? 2.6 : 5.2;
        desiredLook.set(
          entity.position.x + Math.sin(totalYaw) * lead,
          entity.position.y + entity.cameraTargetOffset.y + lookUpBias,
          entity.position.z + Math.cos(totalYaw) * lead
        );
        break;
      }

      case 'action': {
        const sideOffset = entity.type === 'car' ? 2.65 : (entity.type === 'helicopter' ? 4.2 : 0.95);
        const backDist = (entity.type === 'car' ? 3.6 : (entity.type === 'helicopter' ? 8.5 : 2.8)) + speedLag;
        const lowY = entity.type === 'helicopter' ? entity.position.y + 1.2 : entity.position.y + 0.92;

        const actX = entity.position.x - Math.sin(entity.heading) * backDist + Math.cos(entity.heading) * sideOffset;
        const actZ = entity.position.z - Math.cos(entity.heading) * backDist - Math.sin(entity.heading) * sideOffset;
        desiredPos.set(actX, Math.max(groundHeightAt(actX, actZ) + 0.55, lowY), actZ);
        desiredLook.set(
          entity.position.x + Math.sin(entity.heading) * 3.2,
          entity.position.y + 1.05,
          entity.position.z + Math.cos(entity.heading) * 3.2
        );
        break;
      }

      case 'pov': {
        let fwdOffset = 0.35;
        let eyeY = 1.68;
        if (entity.type === 'car') {
          fwdOffset = 0.55;
          eyeY = 1.52;
        } else if (entity.type === 'cyclist') {
          fwdOffset = 0.35;
          eyeY = 1.55;
        } else if (entity.type === 'helicopter') {
          fwdOffset = 1.65;
          eyeY = 1.65;
        }

        desiredPos.set(
          entity.position.x + Math.sin(entity.heading) * fwdOffset,
          entity.position.y + eyeY,
          entity.position.z + Math.cos(entity.heading) * fwdOffset
        );
        desiredLook.set(
          entity.position.x + Math.sin(totalYaw) * 40.0,
          entity.position.y + eyeY + Math.sin(-this.orbitPitchOffset) * 18.0 + 1.5,
          entity.position.z + Math.cos(totalYaw) * 40.0
        );
        break;
      }

      case 'placaVella': {
        // Low in the Plaça Vella, looking east at the Catedral del Sant Esperit's façade & bell tower
        const { pos, look } = SCENIC.placaVella;
        const sway = Math.sin(elapsed * 0.25) * 1.8;
        desiredPos.set(pos.x, pos.y, pos.z + sway);
        desiredLook.set(look.x, look.y, look.z);
        break;
      }

      case 'masiaFreixa': {
        // On the lawn of the Parc de Sant Jordi, looking at the Masia Freixa's arcades & minaret
        const { pos, look } = SCENIC.masiaFreixa;
        const sway = Math.sin(elapsed * 0.22) * 2.5;
        desiredPos.set(pos.x + sway, pos.y, pos.z);
        desiredLook.set(look.x, look.y, look.z);
        break;
      }

      case 'rambla': {
        // On the Rambla d'Ègara looking north up its planted median toward the mNACTEC (Vapor Aymerich, Amat i Jover)
        const { pos, look } = SCENIC.rambla;
        const sway = Math.sin(elapsed * 0.3) * 2.0;
        desiredPos.set(pos.x + sway, pos.y, pos.z);
        desiredLook.set(look.x, look.y, look.z);
        break;
      }

      case 'vallparadis': {
        // In the Parc de Vallparadís looking up at the Castell Cartoixa on the edge of the torrent
        const { pos, look } = SCENIC.vallparadis;
        const sway = Math.cos(elapsed * 0.22) * 2.5;
        desiredPos.set(pos.x + sway, pos.y, pos.z);
        desiredLook.set(look.x, look.y, look.z);
        break;
      }

      case 'mutua': {
        // The roof of the Hospital Mútua tower (70 m), panning across the old town & the Catedral
        const { pos, look } = SCENIC.mutua;
        const pan = Math.sin(elapsed * 0.18) * 120.0;
        desiredPos.set(pos.x, pos.y, pos.z);
        desiredLook.set(look.x, look.y, look.z + pan);
        break;
      }

      case 'estadi': {
        // Above the stands of the Estadi Olímpic (the 1992 Olympic hockey stadium), drifting along the touchline
        const { pos, look } = SCENIC.estadi;
        const drift = Math.sin(elapsed * 0.15) * 30.0;
        desiredPos.set(pos.x, pos.y, pos.z + drift);
        desiredLook.set(look.x, look.y, look.z);
        break;
      }

      case 'skyline': {
        // High over the south of the centre, looking north across the rooftops to La Mola & Sant Llorenç del Munt
        const { pos, look } = SCENIC.skyline;
        const drift = Math.sin(elapsed * 0.15) * 40.0;
        desiredPos.set(pos.x + drift, pos.y, pos.z);
        desiredLook.set(look.x, look.y, look.z);
        break;
      }

      case 'drone': {
        const { center } = SCENIC.drone;
        const angle = elapsed * 0.07 + 0.65;
        const radius = 620.0 + Math.sin(elapsed * 0.23) * 120.0;
        const alt = 260.0 + Math.cos(elapsed * 0.19) * 70.0;
        desiredPos.set(
          Math.cos(angle) * radius + center.x,
          alt,
          Math.sin(angle) * radius + center.z
        );
        desiredLook.set(center.x, center.y, center.z);
        break;
      }
    }

    if (!this.initialized || this.activePresetId === 'pov') {
      this.currentPos.copy(desiredPos);
      this.currentLookAt.copy(desiredLook);
      this.initialized = true;
      this.followEntity = null; // the follow cameras re-anchor from here
    } else if (this.activePresetId === 'chase' || this.activePresetId === 'action') {
      // Smoothed in the followed entity's frame rather than in world space. A world-space follower trails a moving
      // target by a distance that depends on the frame time (about speed x dt), so with uneven frame times the camera
      // surged back and forth behind an accelerating or fast car. Relative to the entity a steady drive keeps the
      // camera steady, while turns, orbit drags, zoom & the speed pull-back are still eased. The entity's height is
      // eased in world space (curbs, park lawns, jumps, the helicopter climbing).
      if (this.followEntity !== entity) {
        // preset or mode switch: start from where the camera is and glide over to the new framing
        this.followEntity = entity;
        this.followBaseY = entity.position.y;
        this.followOffset.subVectors(this.currentPos, entity.position);
        this.followLookOffset.subVectors(this.currentLookAt, entity.position);
      }
      const k = 1 - Math.exp(-dt * 8.5);
      this.followBaseY += (entity.position.y - this.followBaseY) * k;
      this.followOffset.lerp(desiredPos.sub(entity.position), k);
      this.followLookOffset.lerp(desiredLook.sub(entity.position), k);
      this.currentPos.set(entity.position.x, this.followBaseY, entity.position.z).add(this.followOffset);
      this.currentLookAt.set(entity.position.x, this.followBaseY, entity.position.z).add(this.followLookOffset);
      // never below the ground under the camera (the relief: city-grid.js groundHeightAt), nor the roadway itself
      this.currentPos.y = Math.max(groundHeightAt(this.currentPos.x, this.currentPos.z) + 0.55, this.currentPos.y);
    } else {
      this.followEntity = null;
      const k = 1 - Math.exp(-dt * 8.5);
      this.currentPos.lerp(desiredPos, k);
      this.currentLookAt.lerp(desiredLook, k);
    }

    this.camera.position.copy(this.currentPos);
    this.camera.lookAt(this.currentLookAt);
  }
}

export { CAMERA_PRESETS, CameraSystem };
