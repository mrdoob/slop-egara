import * as THREE from 'three/webgpu';
import { Fn, float, color, positionLocal, uniform, mod, fract, step, smoothstep, mix, uv, texture, attribute, vec2, clamp } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SIGNAL_TIMING, blockAt, STREET_TREES, nearestRoads, prettyName, UNNAMED, LAND_CLASS, WORLD_BOUNDS, blockProfile } from './city-config.js';
import { cityUniforms, createTreeGrateMaterial } from './tsl-materials.js';
import { createTreeField, TREE_SPECIES } from './trees.js';
import { pavedPlazaRects, parkTreeSites, sidewalkBlocks, parkLampSites, localGroundAt } from './city-grid.js';
import { terrainActive, terrainY } from './terrain.js';
import { GEO } from './terrassa-geodata.js';

// js/street-details.js
// Populates the streets of Terrassa with their furniture, from the real street graph (GEO.roadGraph) and the real
// curb islands (city-grid.js sidewalkBlocks), all InstancedMesh:
// - Traffic signals on the right-hand kerb of every approach of the 236 signalled junctions (OSM), on the shared signal
//   clock & SIGNAL_TIMING that js/traffic.js obeys: the widest road at each junction runs on the main phase (group 0)
// - Red / green man pedestrian signals at the signalled crossings (OSM), litter bins & bollards
// - Catalan street name plaques (white plaque, blue lettering, the full name: "Carrer de Sant Pere") on the building
//   corner where two named streets meet; where no building stands at the corner (an empty lot, a car park, an open
//   block) the plates hang on a slim dark-blue pole at the kerb corner instead, as the city does at open corners
// - Column luminaires along every kerb (wall-mounted lanterns in the old town's lanes), lamps on the medians
// Everything "on a facade" (plaques, wall lanterns) is only mounted where a facade exists: the building colliders
// (js/buildings.js, js/landmarks.js) passed in through opts.colliders are hashed and probed behind each mount point
// - Street trees: the 834 mapped trees (OSM) plus rows of planes, limes & small ornamentals in tree pits along the
//   wider streets, the planted medians of the avenues & the Rambla d'Ègara, and the park, square & wood trees laid
//   out by city-grid.js

const SW_TOP = WORLD_BOUNDS.sidewalkHeight + 0.005; // top of the sidewalk slabs (city-grid.js)

// ---------------------------------------------------------------------------------------------------------------------
// Street name plaques: all the names go into a few canvas atlases (160 x 64 px cells, 288 per 1920 x 1536 atlas); each
// plaque instance picks its cell through an instanced attribute, so a whole atlas is one draw call
// ---------------------------------------------------------------------------------------------------------------------
const PLAQUE_W = 160;
const PLAQUE_H = 64;
const PLAQUE_COLS = 12;
const PLAQUE_ROWS = 24;
const PLAQUE_PER_ATLAS = PLAQUE_COLS * PLAQUE_ROWS;
const ODONYM = /^(Carrer|Carretera|Avinguda|Passeig|Rambla|Plaça|Placeta|Passatge|Camí|Ronda|Travessera|Via|Raval|Pont|Torrent|Riera|Baixada|Pujada|Portal|Carreró|Autovia|Autopista|Polígon)(\s+(?:de la|de les|dels|del|de l'|de|d'|la|el|les|els))?\s*(.*)$/i;

// "Carrer de la Font Vella" -> ["Carrer de la", "Font Vella"]; names without a generic stay on one line
function splitOdonym(name) {
  const m = name.match(ODONYM);
  if (!m || !m[3]) return [null, name];
  return [(m[1] + (m[2] || '')).replace(/\s+/g, ' ').trim(), m[3].trim()];
}

class PlaqueAtlas {
  constructor() {
    this.cells = new Map(); // name -> { atlas, u0, v0 }
    this.canvases = [];
    this.textures = [];
  }
  _canvas(i) {
    if (this.canvases[i]) return this.canvases[i];
    const c = document.createElement('canvas');
    c.width = PLAQUE_W * PLAQUE_COLS;
    c.height = PLAQUE_H * PLAQUE_ROWS;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#f4f2ec';
    ctx.fillRect(0, 0, c.width, c.height);
    this.canvases[i] = c;
    return c;
  }
  cell(name) {
    let cell = this.cells.get(name);
    if (cell) return cell;
    const index = this.cells.size;
    const atlas = Math.floor(index / PLAQUE_PER_ATLAS);
    const slot = index % PLAQUE_PER_ATLAS;
    const col = slot % PLAQUE_COLS;
    const row = Math.floor(slot / PLAQUE_COLS);
    const ctx = this._canvas(atlas).getContext('2d');
    const x0 = col * PLAQUE_W;
    const y0 = row * PLAQUE_H;
    // cream enamel plaque with a dark blue border & lettering (the city's current model)
    ctx.fillStyle = '#f4f2ec';
    ctx.fillRect(x0, y0, PLAQUE_W, PLAQUE_H);
    ctx.strokeStyle = '#1d3f7a';
    ctx.lineWidth = 2;
    ctx.strokeRect(x0 + 2.5, y0 + 2.5, PLAQUE_W - 5, PLAQUE_H - 5);
    ctx.fillStyle = '#1d3f7a';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const [generic, rest] = splitOdonym(name);
    const maxW = PLAQUE_W - 14;
    const fit = (text, weight, size, minSize) => {
      let s = size;
      ctx.font = `${weight} ${s}px Inter, Arial, sans-serif`;
      while (ctx.measureText(text).width > maxW && s > minSize) {
        s -= 1;
        ctx.font = `${weight} ${s}px Inter, Arial, sans-serif`;
      }
    };
    if (generic) {
      fit(generic, '500', 14, 9);
      ctx.fillText(generic, x0 + PLAQUE_W / 2, y0 + 18);
      fit(rest, '700', 22, 9);
      ctx.fillText(rest, x0 + PLAQUE_W / 2, y0 + 41);
    } else {
      fit(rest, '700', 20, 9);
      ctx.fillText(rest, x0 + PLAQUE_W / 2, y0 + PLAQUE_H / 2);
    }
    cell = { atlas, u0: col / PLAQUE_COLS, v0: 1 - (row + 1) / PLAQUE_ROWS };
    this.cells.set(name, cell);
    return cell;
  }
  finish() {
    this.textures = this.canvases.map((c) => {
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      return tex;
    });
    return this.textures;
  }
}

function createPlaqueMaterial(tex) {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.3, metalness: 0.05 });
  const cell = attribute('aPlaqueCell', 'vec2');
  mat.colorNode = texture(tex, uv().mul(vec2(1 / PLAQUE_COLS, 1 / PLAQUE_ROWS)).add(cell));
  return mat;
}

/**
 * TSL 3-aspect traffic signal lens material: red / amber / green picked from each lens's height in the head (local y
 * +0.36 / 0 / -0.36), lit by the shared signal clock & SIGNAL_TIMING (city-config.js), which js/traffic.js obeys.
 * Main-road heads (group 0 at the junction) run the "avenue" phase, the others the cross-street phase.
 */
function createTrafficSignalLensMaterial(isMainHead, clock) {
  const { cycle, avenueAmber, avenueRed, streetAmber } = SIGNAL_TIMING;
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.colorNode = Fn(() => {
    const t = mod(clock, cycle);
    const ly = positionLocal.y;
    const isTopRed = step(0.18, ly);
    const isBottomGreen = float(1.0).sub(step(-0.18, ly));
    const isMidAmber = float(1.0).sub(isTopRed).mul(float(1.0).sub(isBottomGreen));

    const greenActive = isMainHead
      ? float(1.0).sub(step(avenueAmber, t))
      : step(avenueRed, t).mul(float(1.0).sub(step(streetAmber, t)));
    const amberActive = isMainHead
      ? step(avenueAmber, t).mul(float(1.0).sub(step(avenueRed, t)))
      : step(streetAmber, t);
    const redActive = isMainHead
      ? step(avenueRed, t)
      : float(1.0).sub(step(avenueRed, t));

    const activeMask = isTopRed.mul(redActive)
      .add(isMidAmber.mul(amberActive))
      .add(isBottomGreen.mul(greenActive));

    const lensHue = mix(
      mix(color(0x18ff68), color(0xffaa10), isMidAmber),
      color(0xff2424),
      isTopRed
    );
    return mix(color(0x14181e), lensHue.mul(1.35), activeMask);
  })();
  return mat;
}

/**
 * Pedestrian signal (red man above, green man below): green while the traffic parallel to the crossing has its WALK
 * window (walkSignal in city-config.js), flashing green until that traffic's amber, red otherwise.
 */
function createPedSignalMaterial(isAvenue, clock) {
  const { cycle, avenueAmber, avenueRed, streetAmber, walk } = SIGNAL_TIMING;
  const t0 = isAvenue ? 0 : avenueRed; // when the parallel traffic turns green
  const greenEnd = (isAvenue ? avenueAmber : streetAmber) - t0; // ... and amber
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.colorNode = Fn(() => {
    const t = mod(clock.sub(t0).add(cycle), cycle);
    const walking = float(1.0).sub(step(walk, t));
    const flashing = step(walk, t).mul(float(1.0).sub(step(greenEnd, t)));
    const blink = step(0.5, fract(t.mul(1.4)));
    const greenLit = clamp(walking.add(flashing.mul(blink)), 0.0, 1.0);
    const redLit = float(1.0).sub(clamp(walking.add(flashing), 0.0, 1.0));
    const isTop = step(0.0, positionLocal.y);
    const lit = isTop.mul(redLit).add(float(1.0).sub(isTop).mul(greenLit));
    const hue = mix(color(0x22ff66), color(0xff2a2a), isTop);
    return mix(color(0x14181e), hue.mul(1.3), lit);
  })();
  return mat;
}

/**
 * @param {THREE.Scene} scene
 * @param {{ colliders?: Array<{minX, maxX, minZ, maxZ, minY?, maxY, obb?: {cx, cz, hx, hz, cs, sn}}> }} [opts]
 *   colliders: the building / landmark colliders (world AABB, optionally an oriented box inside it) that stand for
 *   the facades. Plaques and wall lanterns are only hung where one of them is right behind the mount point; without
 *   the option (undefined) every assumed facade is trusted, as before, and an empty array means "no walls anywhere".
 * @returns {{ group, footprints, signalClock, audioSignals, update, stats }}
 */
function buildStreetDetails(scene, opts = {}) {
  const group = new THREE.Group();
  group.name = 'TerrassaStreetDetails';

  const dummy = new THREE.Object3D();
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const unitCyl = new THREE.CylinderGeometry(1, 1, 1, 10);

  // Ground footprints of street furniture that traffic and pedestrians must keep clear of
  const footprints = [];
  const addFootprint = (x, z, w, d) => footprints.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });

  // Signal clock (seconds), set every frame by main.js
  const signalClock = uniform(0);

  // ---- Shared materials --------------------------------------------------------------------------------------------
  const poleMetalMat = new THREE.MeshStandardNodeMaterial({ color: 0x3b4046, roughness: 0.45, metalness: 0.78 });
  const darkGreenMat = new THREE.MeshStandardNodeMaterial({ color: 0x2a3b33, roughness: 0.5, metalness: 0.55 }); // old-town lanterns, bins
  const signalHousingMat = new THREE.MeshStandardNodeMaterial({ color: 0x24272b, roughness: 0.42, metalness: 0.3, side: THREE.DoubleSide });
  const mainSignalLensMat = createTrafficSignalLensMaterial(true, signalClock);
  const crossSignalLensMat = createTrafficSignalLensMaterial(false, signalClock);
  const pedMainMat = createPedSignalMaterial(true, signalClock);
  const pedCrossMat = createPedSignalMaterial(false, signalClock);
  // Luminaire lenses: pale diffuser by day, warm white after dusk
  const lampBulbGlow = new THREE.MeshBasicNodeMaterial();
  lampBulbGlow.colorNode = mix(color(0x8f918c), color(0xfff1d6).mul(2.1), smoothstep(0.4, 1.1, cityUniforms.uInteriorGlow));
  const lanternGlow = new THREE.MeshBasicNodeMaterial();
  lanternGlow.colorNode = mix(color(0xd4d2c8), color(0xffe4b0).mul(1.95), smoothstep(0.4, 1.1, cityUniforms.uInteriorGlow));
  const plaqueFrameMat = new THREE.MeshStandardNodeMaterial({ color: 0x1d3f7a, roughness: 0.4, metalness: 0.2 });
  const bollardMat = new THREE.MeshStandardNodeMaterial({ color: 0x3a3d40, roughness: 0.6, metalness: 0.5 });

  // ---- Geometries ---------------------------------------------------------------------------------------------------
  // 200 mm three-aspect head (origin at its centre): dark housing, a visor over each lens, lenses on the +z face
  const HEAD_W = 0.34;
  const HEAD_H = 1.0;
  const HEAD_D = 0.26;
  const LENS_R = 0.11;
  const LENS_Y = [0.36, 0, -0.36];
  const signalHousingGeo = mergeGeometries([
    new THREE.BoxGeometry(HEAD_W, HEAD_H, HEAD_D),
    new THREE.BoxGeometry(0.06, 0.16, 0.06).translate(0, -HEAD_H / 2 - 0.08, 0),
    ...LENS_Y.map((ly) => new THREE.CylinderGeometry(LENS_R + 0.03, LENS_R + 0.03, 0.2, 14, 1, true, Math.PI / 2, Math.PI)
      .rotateX(Math.PI / 2).translate(0, ly, HEAD_D / 2 + 0.1))
  ].map((g) => g.toNonIndexed()));
  const signalLensGeo = mergeGeometries(LENS_Y.map((ly) => new THREE.CircleGeometry(LENS_R, 18).translate(0, ly, HEAD_D / 2 + 0.004)));
  // Pedestrian signal: two-aspect housing with the men on the +z face
  const pedHousingGeo = mergeGeometries([
    new THREE.BoxGeometry(0.26, 0.56, 0.2),
    new THREE.BoxGeometry(0.05, 0.14, 0.05).translate(0, -0.35, 0)
  ].map((g) => g.toNonIndexed()));
  const pedLensGeo = mergeGeometries([
    new THREE.CircleGeometry(0.085, 14).translate(0, 0.14, 0.104),
    new THREE.CircleGeometry(0.085, 14).translate(0, -0.14, 0.104)
  ]);
  // Column luminaire (8 m column, short arm, flat LED luminaire) & its lens
  const columnGeo = mergeGeometries([
    new THREE.CylinderGeometry(0.07, 0.11, 8.0, 10).translate(0, 4.0, 0),
    new THREE.CylinderGeometry(0.16, 0.18, 0.5, 10).translate(0, 0.25, 0)
  ].map((g) => g.toNonIndexed()));
  const columnArmGeo = mergeGeometries([
    new THREE.CylinderGeometry(0.045, 0.055, 1.5, 8).rotateZ(Math.PI / 2).translate(0.75, 7.85, 0),
    new THREE.BoxGeometry(0.62, 0.1, 0.28).translate(1.4, 7.78, 0)
  ].map((g) => g.toNonIndexed()));
  const columnLensGeo = new THREE.PlaneGeometry(0.5, 0.2).rotateX(Math.PI / 2).translate(1.4, 7.725, 0);
  // Residential post: 4.6 m post with a lantern (box) on top
  const postGeo = mergeGeometries([
    new THREE.CylinderGeometry(0.05, 0.08, 4.4, 8).translate(0, 2.2, 0),
    new THREE.CylinderGeometry(0.12, 0.14, 0.4, 8).translate(0, 0.2, 0),
    new THREE.BoxGeometry(0.34, 0.06, 0.34).translate(0, 4.42, 0),
    new THREE.ConeGeometry(0.26, 0.2, 4).rotateY(Math.PI / 4).translate(0, 4.95, 0)
  ].map((g) => g.toNonIndexed()));
  const postLanternGeo = new THREE.BoxGeometry(0.26, 0.4, 0.26).translate(0, 4.65, 0);
  // Old-town wall lantern: bracket from the facade (origin on the facade, +z out over the lane) & lantern
  const wallBracketGeo = mergeGeometries([
    new THREE.BoxGeometry(0.05, 0.05, 0.8).translate(0, 4.6, 0.4),
    new THREE.BoxGeometry(0.05, 0.6, 0.05).translate(0, 4.3, 0.025),
    new THREE.BoxGeometry(0.3, 0.05, 0.3).translate(0, 4.35, 0.72),
    new THREE.ConeGeometry(0.24, 0.18, 4).rotateY(Math.PI / 4).translate(0, 4.64, 0.72)
  ].map((g) => g.toNonIndexed()));
  const wallLanternGeo = new THREE.BoxGeometry(0.22, 0.34, 0.22).translate(0, 4.4, 0.72);
  // Plaque: enamel face & blue frame; and the slim 2.6 m pole (origin at its foot) the plates hang on at open corners
  const plaqueFaceGeo = new THREE.PlaneGeometry(0.6, 0.3).translate(0, 0, 0.017);
  const plaqueFrameGeo = new THREE.BoxGeometry(0.64, 0.34, 0.03);
  const PLAQUE_POLE_H = 2.6;
  const plaquePoleGeo = mergeGeometries([
    new THREE.CylinderGeometry(0.03, 0.035, PLAQUE_POLE_H, 8).translate(0, PLAQUE_POLE_H / 2, 0),
    new THREE.CylinderGeometry(0.04, 0.04, 0.03, 8).translate(0, PLAQUE_POLE_H + 0.015, 0),
    new THREE.CylinderGeometry(0.07, 0.08, 0.12, 8).translate(0, 0.06, 0)
  ].map((g) => g.toNonIndexed()));
  // Litter bin & bollard
  const binGeo = mergeGeometries([
    new THREE.CylinderGeometry(0.2, 0.18, 0.8, 10).translate(0, 0.4, 0),
    new THREE.TorusGeometry(0.2, 0.02, 6, 12).rotateX(Math.PI / 2).translate(0, 0.8, 0)
  ].map((g) => g.toNonIndexed()));
  const bollardGeo = mergeGeometries([
    new THREE.CylinderGeometry(0.06, 0.07, 0.85, 8).translate(0, 0.425, 0),
    new THREE.SphereGeometry(0.07, 8, 6).translate(0, 0.85, 0)
  ].map((g) => g.toNonIndexed()));

  // ---- Instance accumulators -----------------------------------------------------------------------------------------
  const M = {
    signalPole: [], signalArm: [], head: [], mainLens: [], crossLens: [], pedPole: [], pedHead: [], pedMainLens: [], pedCrossLens: [],
    column: [], columnArm: [], post: [], wall: [], plaque: [], plaquePole: [], bin: [], bollard: []
  };
  const plaqueCells = []; // [u0, v0] per plaque, parallel to M.plaque
  const plaqueAtlasOf = []; // atlas index per plaque
  const audioSignals = [];
  const spotSites = []; // column luminaires: pooled spot lights { x, y, z, tx, tz }
  const pointSites = []; // lanterns, posts & park lamps: pooled point lights { x, y, z, color, intensity, dist }
  // The relief (terrain.js) under every prop authored at kerb height: added as the matrices are written
  const lift = terrainActive() ? terrainY : () => 0;
  const pushMatrix = (list, x, y, z, yaw = 0, sx = 1, sy = 1, sz = 1) => {
    dummy.position.set(x, y + lift(x, z), z);
    dummy.rotation.set(0, yaw, 0);
    dummy.scale.set(sx, sy, sz);
    dummy.updateMatrix();
    list.push(dummy.matrix.clone());
  };

  // ---- Placement helpers ---------------------------------------------------------------------------------------------
  const plazaRects = pavedPlazaRects || [];
  const inPlaza = (x, z, m = 1.0) =>
    plazaRects.some((r) => x > r.minX - m && x < r.maxX + m && z > r.minZ - m && z < r.maxZ + m);

  // True only when (x, z) and its pad-metre surroundings sit on a built curb island (never on a road, median or park)
  const isOnCurbIsland = (x, z, pad = 0.55) => {
    const b = blockAt(x, z);
    if (!b || b.median || b.open) return false;
    if (pad <= 0) return true;
    for (const [dx, dz] of [[-pad, 0], [pad, 0], [0, -pad], [0, pad]]) {
      const o = blockAt(x + dx, z + dz);
      if (!o || o.median || o.open) return false;
    }
    return true;
  };
  // ... and off the paved squares
  const isOnSidewalk = (x, z, pad = 0.55) => isOnCurbIsland(x, z, pad) && !inPlaza(x, z, 1.0);
  // Signal posts may also stand on the kerbed open land (the edge of a park or a square), never on medians or roads
  const KERBED_OPEN = new Set([LAND_CLASS.PARK, LAND_CLASS.GRASS, LAND_CLASS.PLAZA, LAND_CLASS.SPORTS, LAND_CLASS.CEMETERY]);
  const isSignalSpot = (x, z, pad = 0.4) => {
    for (const [dx, dz] of [[0, 0], [-pad, 0], [pad, 0], [0, -pad], [0, pad]]) {
      const b = blockAt(x + dx, z + dz);
      if (!b || b.median || (b.open && !KERBED_OPEN.has(b.cls))) return false;
    }
    return true;
  };

  // Spatial hash of everything standing on the sidewalks, so nothing is planted through anything else
  const POLE_CELL = 16;
  const poleGrid = new Map();
  const poleKey = (ix, iz) => ix * 100003 + iz;
  const placePole = (x, z) => {
    const k = poleKey(Math.floor(x / POLE_CELL), Math.floor(z / POLE_CELL));
    let list = poleGrid.get(k);
    if (!list) poleGrid.set(k, (list = []));
    list.push(x, z);
  };
  const isClearOfPoles = (x, z, minDist = 6.0) => {
    const md2 = minDist * minDist;
    const r = Math.ceil(minDist / POLE_CELL);
    const ix = Math.floor(x / POLE_CELL), iz = Math.floor(z / POLE_CELL);
    for (let i = ix - r; i <= ix + r; i++) {
      for (let j = iz - r; j <= iz + r; j++) {
        const list = poleGrid.get(poleKey(i, j));
        if (!list) continue;
        for (let k = 0; k < list.length; k += 2) {
          const dx = list[k] - x, dz = list[k + 1] - z;
          if (dx * dx + dz * dz < md2) return false;
        }
      }
    }
    return true;
  };
  function hashPos(x, y, z) {
    const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
    return s - Math.floor(s);
  }
  // Where the ground is under a pole, without the relief: the sidewalk top on an island (the walks of the sunken
  // rieres included), 0 on the roadway (city-grid.js). The relief is added once, by pushMatrix / addPlaque
  const groundY = (x, z) => localGroundAt(x, z);

  // ---- The facades: a spatial hash of the building colliders --------------------------------------------------------
  // Everything hung "on a facade" (the street plaques, the old town's wall lanterns) is only mounted where one of the
  // colliders passed in stands right behind the mount point. Plinths & low walls (under 2.5 m) don't count: nothing
  // hangs at 2.8 m on them.
  const WALL_MIN_HEIGHT = 2.5;
  const WALL_CELL = 24;
  const wallColliders = opts.colliders;
  const wallGrid = new Map();
  const wallKey = (ix, iz) => ix * 100003 + iz;
  if (wallColliders) {
    for (const c of wallColliders) {
      if (!(c.maxY >= WALL_MIN_HEIGHT)) continue;
      const ix0 = Math.floor(c.minX / WALL_CELL), ix1 = Math.floor(c.maxX / WALL_CELL);
      const iz0 = Math.floor(c.minZ / WALL_CELL), iz1 = Math.floor(c.maxZ / WALL_CELL);
      for (let i = ix0; i <= ix1; i++) {
        for (let j = iz0; j <= iz1; j++) {
          const k = wallKey(i, j);
          let list = wallGrid.get(k);
          if (!list) wallGrid.set(k, (list = []));
          list.push(c);
        }
      }
    }
  }
  // Distance from (x, z) to a collider's footprint is within r: the AABB first, then the oriented box, with the point
  // in the box's frame (js/buildings.js toWorld: world = centre + R · local, R = [[cs, sn], [-sn, cs]])
  const colliderWithin = (c, x, z, r) => {
    if (x < c.minX - r || x > c.maxX + r || z < c.minZ - r || z > c.maxZ + r) return false;
    let ex, ez;
    if (c.obb) {
      const o = c.obb;
      const dx = x - o.cx, dz = z - o.cz;
      const lx = dx * o.cs - dz * o.sn, lz = dx * o.sn + dz * o.cs;
      ex = Math.abs(lx) - o.hx;
      ez = Math.abs(lz) - o.hz;
    } else {
      ex = Math.max(c.minX - x, x - c.maxX);
      ez = Math.max(c.minZ - z, z - c.maxZ);
    }
    if (ex <= 0 && ez <= 0) return true;
    ex = Math.max(ex, 0);
    ez = Math.max(ez, 0);
    return ex * ex + ez * ez <= r * r;
  };
  // Some building's footprint comes within r metres of (x, z). Without colliders (opts.colliders undefined) every
  // assumed facade is trusted
  const wallNear = (x, z, r) => {
    if (!wallColliders) return true;
    const ix0 = Math.floor((x - r) / WALL_CELL), ix1 = Math.floor((x + r) / WALL_CELL);
    const iz0 = Math.floor((z - r) / WALL_CELL), iz1 = Math.floor((z + r) / WALL_CELL);
    for (let i = ix0; i <= ix1; i++) {
      for (let j = iz0; j <= iz1; j++) {
        const list = wallGrid.get(wallKey(i, j));
        if (!list) continue;
        for (let k = 0; k < list.length; k++) if (colliderWithin(list[k], x, z, r)) return true;
      }
    }
    return false;
  };
  // The facade behind a mount point: (x, z) is meant to sit just outside a wall whose outward normal is (nx, nz).
  // Marches along -n up to maxIn metres looking for the wall (or along +n up to maxOut when the point is already
  // inside the building) and returns the point just outside the wall face, or null when there is no wall there.
  // Without colliders the point is returned as it is.
  const WALL_STEP = 0.1;
  const snapToWall = (x, z, nx, nz, maxIn, maxOut) => {
    if (!wallColliders) return [x, z];
    if (wallNear(x, z, 0)) {
      for (let t = WALL_STEP; t <= maxOut + 1e-6; t += WALL_STEP) {
        const px = x + nx * t, pz = z + nz * t;
        if (!wallNear(px, pz, 0)) return [px, pz];
      }
      return null;
    }
    let ox = x, oz = z;
    for (let t = WALL_STEP; t <= maxIn + 1e-6; t += WALL_STEP) {
      const px = x - nx * t, pz = z - nz * t;
      if (wallNear(px, pz, 0)) return [ox, oz];
      ox = px; oz = pz;
    }
    return null;
  };

  // =========================================================================
  // 1. THE STREET GRAPH: the arms of every junction (direction, width, name, which way traffic runs) and, at each,
  //    the main road: the arms paired into roads (an arm with the one most nearly opposite it), the widest road
  //    first — group 0 in js/road-network.js, the "avenue" phase of SIGNAL_TIMING
  // =========================================================================
  const graph = GEO.roadGraph;
  const nodeCount = graph.nodes.length / 2;
  const nodeX = (i) => graph.nodes[i * 2];
  const nodeZ = (i) => graph.nodes[i * 2 + 1];
  const arms = new Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) arms[i] = [];
  for (const l of graph.links) {
    const [a, b, nameIdx, w, lanes, dir, inner, cls, , roundabout] = l;
    const ax = nodeX(a), az = nodeZ(a), bx = nodeX(b), bz = nodeZ(b);
    const name = prettyName(graph.names[nameIdx]);
    const firstX = inner.length ? inner[0] : bx, firstZ = inner.length ? inner[1] : bz;
    const lastX = inner.length ? inner[inner.length - 2] : ax, lastZ = inner.length ? inner[inner.length - 1] : az;
    const la = Math.hypot(firstX - ax, firstZ - az) || 1;
    const lb = Math.hypot(lastX - bx, lastZ - bz) || 1;
    const width = w || 6;
    arms[a].push({ node: a, ux: (firstX - ax) / la, uz: (firstZ - az) / la, w: width, lanes, name, cls, roundabout, incoming: dir !== 1, outgoing: dir !== -1 });
    arms[b].push({ node: b, ux: (lastX - bx) / lb, uz: (lastZ - bz) / lb, w: width, lanes, name, cls, roundabout, incoming: dir !== -1, outgoing: dir !== 1 });
  }
  // Marks each arm of a node with whether it belongs to the main road (the widest); returns the main road's direction
  function markMainRoad(list) {
    const pairs = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const d = list[i].ux * list[j].ux + list[i].uz * list[j].uz;
        if (d < -0.82) pairs.push([d + 0.02 * Math.abs(list[i].w - list[j].w), list[i], list[j]]);
      }
    }
    pairs.sort((p, q) => p[0] - q[0]);
    const mates = new Map();
    for (const [, a, b] of pairs) {
      if (mates.has(a) || mates.has(b)) continue;
      mates.set(a, b);
      mates.set(b, a);
    }
    const roads = [];
    const done = new Set();
    for (const a of list) {
      if (done.has(a)) continue;
      done.add(a);
      const mate = mates.get(a);
      if (mate) done.add(mate);
      const members = mate ? [a, mate] : [a];
      roads.push({ members, rank: Math.max(...members.map((m) => m.w + m.lanes * 0.5 + (m.cls === 2 || m.cls === 1 ? 4 : 0))) });
    }
    roads.sort((p, q) => q.rank - p.rank);
    for (const r of roads) for (const m of r.members) m.main = r === roads[0];
    const m0 = roads[0].members[0];
    return { ux: m0.ux, uz: m0.uz };
  }
  const mainDir = new Map(); // signalled node -> main road direction
  const signalSet = new Set(graph.signals);
  // Signalled nodes bucketed for the crossings' lookup
  const SIG_CELL = 32;
  const sigGrid = new Map();
  for (const n of graph.signals) {
    if (arms[n].length < 2) continue;
    mainDir.set(n, markMainRoad(arms[n]));
    const k = Math.floor(nodeX(n) / SIG_CELL) * 100003 + Math.floor(nodeZ(n) / SIG_CELL);
    if (!sigGrid.has(k)) sigGrid.set(k, []);
    sigGrid.get(k).push(n);
  }
  const nearestSignalNode = (x, z, r) => {
    let best = -1, bd = r * r;
    const ix = Math.floor(x / SIG_CELL), iz = Math.floor(z / SIG_CELL), c = Math.ceil(r / SIG_CELL);
    for (let i = ix - c; i <= ix + c; i++) {
      for (let j = iz - c; j <= iz + c; j++) {
        const list = sigGrid.get(i * 100003 + j);
        if (!list) continue;
        for (const n of list) {
          const d2 = (nodeX(n) - x) ** 2 + (nodeZ(n) - z) ** 2;
          if (d2 < bd) { bd = d2; best = n; }
        }
      }
    }
    return best;
  };

  // =========================================================================
  // 2. TRAFFIC SIGNALS: one post on the right-hand kerb corner of every approach (Spain drives on the right), its
  //    head facing the arriving traffic; a mast arm with a second head over the wide approaches
  // =========================================================================
  let signalHeads = 0;
  for (const n of graph.signals) {
    const list = arms[n];
    if (list.length < 2 || !mainDir.has(n)) continue;
    const nx = nodeX(n), nz = nodeZ(n);
    for (const arm of list) {
      if (!arm.incoming) continue;
      let crossHalf = 3;
      for (const o of list) if (o !== arm) crossHalf = Math.max(crossHalf, o.w * 0.5);
      // right of the traffic arriving along -u: (uz, -ux)
      const rx = arm.uz, rz = -arm.ux;
      const L = crossHalf + 1.2;
      const R = arm.w * 0.5 + 0.75;
      // the nearest kerb corner on the right: a little further along the approach where the crossing is wide or the
      // corner is rounded, a little further right where a traffic island sits in the mouth
      let px = 0, pz = 0, found = false;
      for (let dl = 0; dl <= 15 && !found; dl += 1.5) {
        for (const dr of [0, 0.8, 1.6, 2.6, 3.8, 5.2]) {
          px = nx + arm.ux * (L + dl) + rx * (R + dr);
          pz = nz + arm.uz * (L + dl) + rz * (R + dr);
          if (isSignalSpot(px, pz, 0.4) && isClearOfPoles(px, pz, 1.5)) { found = true; break; }
        }
      }
      if (!found) continue;
      placePole(px, pz);
      addFootprint(px, pz, 0.45, 0.45);
      const yaw = Math.atan2(arm.ux, arm.uz); // the +z face toward where the traffic comes from
      const tall = arm.w >= 11;
      pushMatrix(M.signalPole, px, tall ? 3.1 : 1.9, pz, 0, 0.07, tall ? 6.2 : 3.8, 0.07);
      // post head, hung out over the kerb toward the roadway
      pushMatrix(M.head, px - rx * 0.3, 3.15, pz - rz * 0.3, yaw);
      pushMatrix(arm.main ? M.mainLens : M.crossLens, px - rx * 0.3, 3.15, pz - rz * 0.3, yaw);
      signalHeads++;
      if (tall) {
        const A = Math.min(arm.w * 0.45, 6.5);
        pushMatrix(M.signalArm, px - rx * A * 0.5, 5.95, pz - rz * A * 0.5, Math.atan2(rz, -rx), A, 0.1, 0.1);
        pushMatrix(M.head, px - rx * (A - 0.4), 5.3, pz - rz * (A - 0.4), yaw);
        pushMatrix(arm.main ? M.mainLens : M.crossLens, px - rx * (A - 0.4), 5.3, pz - rz * (A - 0.4), yaw);
        signalHeads++;
      }
      // a litter bin by most signal posts
      if (hashPos(px, 1, pz) < 0.6) {
        const bx = px + arm.ux * 0.9, bz = pz + arm.uz * 0.9;
        if (isOnSidewalk(bx, bz, 0.3)) { pushMatrix(M.bin, bx, SW_TOP, bz); addFootprint(bx, bz, 0.45, 0.45); placePole(bx, bz); }
      }
    }
  }

  // =========================================================================
  // 3. PEDESTRIAN SIGNALS at the signalled crossings: a post at each end, the men facing across the road. A crossing
  //    over the junction's main road walks with the cross streets' green (isAvenue false), and vice versa
  // =========================================================================
  let pedHeads = 0;
  for (const c of graph.crossings) {
    const [cx, cz, ux, uz, w, kind] = c;
    if (kind !== 1) continue;
    const n = nearestSignalNode(cx, cz, 30);
    const md = n >= 0 ? mainDir.get(n) : null;
    const crossesMain = md ? Math.abs(md.ux * ux + md.uz * uz) > 0.7 : false;
    const isAvenue = !crossesMain;
    const nxv = -uz, nzv = ux; // across the road
    for (const s of [-1, 1]) {
      let ex = 0, ez = 0, ok = false;
      for (const extra of [0, 0.6, 1.2, 1.9]) {
        ex = cx + s * nxv * (w * 0.5 + 0.9 + extra);
        ez = cz + s * nzv * (w * 0.5 + 0.9 + extra);
        if (isSignalSpot(ex, ez, 0.3) && isClearOfPoles(ex, ez, 0.9)) { ok = true; break; }
      }
      if (!ok) continue;
      placePole(ex, ez);
      addFootprint(ex, ez, 0.3, 0.3);
      const fx = -s * nxv, fz = -s * nzv; // facing the far kerb
      const yaw = Math.atan2(fx, fz);
      pushMatrix(M.pedPole, ex, 1.35, ez, 0, 0.05, 2.7, 0.05);
      pushMatrix(M.pedHead, ex + fx * 0.12, 2.35, ez + fz * 0.12, yaw);
      pushMatrix(isAvenue ? M.pedMainLens : M.pedCrossLens, ex + fx * 0.12, 2.35, ez + fz * 0.12, yaw);
      audioSignals.push({ x: ex, y: 2.35, z: ez, isAvenue });
      pedHeads++;
    }
  }

  // =========================================================================
  // 4. STREET NAME PLAQUES on the building corner of every corner where two named streets meet: for each pair of
  //    neighbouring arms, the kerb corner lies along their bisector, the building corner 2.4 m (the sidewalk) behind
  //    it; one plaque per street on the facade facing that street, at 2.8 m. The facade has to be there (a building
  //    collider right behind the plaque): otherwise the plaque slides along the facade line up to 6 m from the corner
  //    to the first wall, and where the corner has no building at all (an empty lot, a car park, a block whose
  //    buildings were skipped) both plates hang on a slim pole at the kerb corner instead
  // =========================================================================
  const atlas = new PlaqueAtlas();
  const plaqueKeys = new Set();
  const SIDEWALK = 2.4;
  const PLAQUE_Y = 2.65; // above the sidewalk
  let plaquesOnWalls = 0, plaquesOnPoles = 0, plaquePoles = 0, plaquesSkipped = 0;
  function addPlaque(name, x, y, z, yaw) {
    // y is the kerb-height mount; pushMatrix lifts it onto the relief (once)
    const key = `${name}|${Math.round(x / 2)}|${Math.round(z / 2)}`;
    if (plaqueKeys.has(key)) return false;
    plaqueKeys.add(key);
    const cell = atlas.cell(name);
    pushMatrix(M.plaque, x, y, z, yaw);
    plaqueCells.push(cell.u0, cell.v0);
    plaqueAtlasOf.push(cell.atlas);
    return true;
  }
  for (let n = 0; n < nodeCount; n++) {
    const list = arms[n];
    if (list.length < 2) continue;
    const names = new Set();
    for (const a of list) if (a.name && a.name !== UNNAMED) names.add(a.name);
    if (names.size < 2) continue;
    const nx = nodeX(n), nz = nodeZ(n);
    const sorted = list.map((a) => ({ a, ang: Math.atan2(a.uz, a.ux) })).sort((p, q) => p.ang - q.ang);
    for (let i = 0; i < sorted.length; i++) {
      const A = sorted[i], B = sorted[(i + 1) % sorted.length];
      if (A.a === B.a) continue;
      const na = A.a.name, nb = B.a.name;
      if (!na || !nb || na === UNNAMED || nb === UNNAMED || na === nb) continue;
      const sector = ((B.ang - A.ang) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) || Math.PI * 2;
      if (sector < 0.45 || sector > 3.4) continue; // no building corner in a sliver or a reflex gap
      const mid = A.ang + sector * 0.5;
      const bx = Math.cos(mid), bz = Math.sin(mid);
      // the kerb corner: the first built island along the bisector
      let blk = null, d = 0;
      for (d = 3; d <= 30; d += 1) {
        const b = blockAt(nx + bx * d, nz + bz * d);
        if (b && !b.open && !b.median) { blk = b; break; }
      }
      if (!blk || !(blk.rects.length || (blk.frames && blk.frames.length))) continue;
      const back = Math.min(7, SIDEWALK / Math.max(0.35, Math.sin(sector * 0.5)));
      let cxp = nx + bx * (d + back), czp = nz + bz * (d + back);
      if (blockAt(cxp, czp) !== blk) { cxp = nx + bx * (d + 1.2); czp = nz + bz * (d + 1.2); }
      const wallY = SW_TOP + PLAQUE_Y;
      const unmounted = []; // the streets whose facade isn't there: { name, fnx, fnz }
      for (const [arm, other] of [[A.a, B.a], [B.a, A.a]]) {
        const px0 = -arm.uz, pz0 = arm.ux;
        const sgn = px0 * other.ux + pz0 * other.uz > 0 ? -1 : 1; // facade normal: away from the block, toward this street
        const fnx = px0 * sgn, fnz = pz0 * sgn;
        const yaw = Math.atan2(fnx, fnz);
        // the assumed building corner first, then along the facade line away from the corner, to the first wall
        let mounted = false;
        for (const along of [1.7, 2.6, 3.6, 4.8, 6.0]) {
          const x = cxp + arm.ux * along + fnx * 0.08;
          const z = czp + arm.uz * along + fnz * 0.08;
          if (blockAt(x - fnx * 0.5, z - fnz * 0.5) !== blk) continue; // the facade would be over the road
          // the wall within 1.6 m behind the point (or, when a building reaches out over the sidewalk, its face in
          // front of it), and that face still on the island
          const face = snapToWall(x, z, fnx, fnz, 1.6, SIDEWALK);
          if (!face || blockAt(face[0], face[1]) !== blk) continue;
          if (addPlaque(arm.name, face[0] + fnx * 0.06, wallY, face[1] + fnz * 0.06, yaw)) plaquesOnWalls++;
          mounted = true;
          break;
        }
        if (!mounted) unmounted.push({ name: arm.name, fnx, fnz });
      }
      if (!unmounted.length) continue;
      // No facade at this corner: the plates hang (stacked) on a slim pole 0.4 m inside the kerb corner
      const kx = nx + bx * (d + 0.4), kz = nz + bz * (d + 0.4);
      if (!isOnCurbIsland(kx, kz, 0.25) || !isClearOfPoles(kx, kz, 1.0)) { plaquesSkipped += unmounted.length; continue; }
      const baseY = groundY(kx, kz);
      let hung = 0;
      for (const u of unmounted) {
        if (addPlaque(u.name, kx + u.fnx * 0.045, baseY + PLAQUE_POLE_H - 0.2 - hung * 0.38, kz + u.fnz * 0.045, Math.atan2(u.fnx, u.fnz))) hung++;
      }
      if (!hung) continue;
      placePole(kx, kz);
      addFootprint(kx, kz, 0.2, 0.2);
      pushMatrix(M.plaquePole, kx, baseY, kz, 0);
      plaquePoles++;
      plaquesOnPoles += hung;
    }
  }

  // =========================================================================
  // 5. STREETLIGHTS, TREES, BINS & BOLLARDS along every kerb edge of every built island: column luminaires along the
  //    wider streets, posts along the residential ones, wall lanterns in the old town's lanes & the pedestrian
  //    streets; rows of plane trees in tree pits along the streets with a roadway of 9 m or more (and a few small
  //    ornamentals on the residential streets of the Eixample & the suburbs); bollards along the pedestrian streets
  // =========================================================================
  const treePositions = []; // { x, y, z, scale, species, ... }
  const sidewalkTreePositions = []; // ... of those, the ones standing in tree pits
  const TREE_Y = SW_TOP + 0.05;
  const mixSpecies = (r, plane, locust) => (r < plane ? 0 : (r < plane + locust ? 1 : 2));
  // Street trees turn in 90° steps with the crown squeezed across the sidewalk, away from the facades
  function addStreetTree(x, z, scale, species, ux, uz, extra = {}) {
    if (!isOnSidewalk(x, z, 0.5) || inPlaza(x, z, 1.5) || !isClearOfPoles(x, z, 2.4)) return false;
    const q = Math.floor(hashPos(x, 8.8, z) * 3.999);
    const alongX = Math.abs(ux) > Math.abs(uz);
    const t = { x, y: TREE_Y, z, scale, species, yaw: q * Math.PI * 0.5, tier: 1, pitRot: Math.atan2(ux, uz), ...extra };
    if (alongX === (q % 2 === 0)) t.sz = extra.squeeze || 0.82;
    else t.sx = extra.squeeze || 0.82;
    treePositions.push(t);
    sidewalkTreePositions.push(t);
    placePole(x, z);
    return true;
  }
  const WIDE_KIND = { oldtown: 1, eixample: 1, blocs: 1, suburban: 1 };
  let columns = 0, posts = 0, lanterns = 0, lanternsToPosts = 0, lanternsSkipped = 0, rowTrees = 0;
  for (const s of sidewalkBlocks || []) {
    const b = s.block;
    const poly = s.poly;
    if (!b || !poly || poly.length < 3 || b.median || b.open) continue;
    const kind = blockProfile(b).kind;
    const parking = b.cls === LAND_CLASS.PARKING && b.clsShare >= 0.5;
    for (let i = 0; i < poly.length; i++) {
      const p0 = poly[i];
      const p1 = poly[(i + 1) % poly.length];
      const dx = p1.x - p0.x;
      const dz = p1.z - p0.z;
      const len = Math.hypot(dx, dz);
      if (len < 11) continue;
      const ux = dx / len;
      const uz = dz / len;
      const mx = (p0.x + p1.x) * 0.5;
      const mz = (p0.z + p1.z) * 0.5;
      // inward normal (into the island) and outward normal (into the roadway)
      let inx = -uz;
      let inz = ux;
      if (blockAt(mx + inx * 1.6, mz + inz * 1.6) !== b) {
        inx = uz;
        inz = -ux;
      }
      if (blockAt(mx + inx * 1.6, mz + inz * 1.6) !== b) continue;
      const outX = -inx;
      const outZ = -inz;
      if (blockAt(mx + outX * 2.5, mz + outZ * 2.5)) continue; // faces another island, not a roadway

      const near = nearestRoads(mx + outX * 3, mz + outZ * 3, 14);
      const road = near.length ? near[0].road : null;
      const w = road ? road.w : 7;
      const pedestrian = road ? road.pedestrian : false;
      const lampType = pedestrian || w < 5.5 || (kind === 'oldtown' && w < 7) ? 'wall' : w >= 8 ? 'column' : 'post';
      const spacing = lampType === 'column' ? 28 : lampType === 'post' ? 24 : 20;
      const start = 6 + hashPos(p0.x, 2.2, p0.z) * 6;

      // lamps
      for (let t = start; t < len - 4; t += spacing) {
        const cx = p0.x + ux * t;
        const cz = p0.z + uz * t;
        let type = lampType;
        if (type === 'wall') {
          // on the facade (the property line, 2.4 m behind the kerb), hanging out over the lane: only where a
          // building stands within a metre behind that point (or reaches out over the sidewalk up to it); where the
          // lane has no facade there (an empty lot, a car park, a yard wall) a post at the kerb takes over
          const lx = cx + inx * SIDEWALK, lz = cz + inz * SIDEWALK;
          const face = blockAt(lx, lz) === b && wallNear(lx, lz, 1.0) ? snapToWall(lx, lz, outX, outZ, 1.0, SIDEWALK - 0.6) : null;
          if (face && blockAt(face[0], face[1]) === b) {
            const [fx, fz] = face;
            if (!isClearOfPoles(fx, fz, 5)) continue;
            placePole(fx, fz);
            pushMatrix(M.wall, fx, SW_TOP, fz, Math.atan2(outX, outZ));
            pointSites.push({ x: fx + outX * 0.72, y: SW_TOP + 4.3, z: fz + outZ * 0.72, color: 0xffd9a0, intensity: 22, dist: 12 });
            lanterns++;
            continue;
          }
          type = 'post';
          lanternsToPosts++;
        }
        {
          const lx = cx + inx * 0.65, lz = cz + inz * 0.65;
          if (!isOnSidewalk(lx, lz, 0.4) || !isClearOfPoles(lx, lz, spacing * 0.35)) {
            if (lampType === 'wall') { lanternsToPosts--; lanternsSkipped++; }
            continue;
          }
          placePole(lx, lz);
          addFootprint(lx, lz, 0.4, 0.4);
          if (type === 'column') {
            const yaw = Math.atan2(outZ, -outX) + Math.PI; // the arm's +x toward the roadway
            pushMatrix(M.column, lx, SW_TOP, lz, 0);
            pushMatrix(M.columnArm, lx, SW_TOP, lz, Math.atan2(-outZ, outX));
            spotSites.push({ x: lx + outX * 1.4, y: SW_TOP + 7.7, z: lz + outZ * 1.4, tx: lx + outX * 3.6, tz: lz + outZ * 3.6, yaw });
            columns++;
          } else {
            pushMatrix(M.post, lx, SW_TOP, lz, 0);
            pointSites.push({ x: lx, y: SW_TOP + 4.65, z: lz, color: 0xffe0aa, intensity: 28, dist: 14 });
            posts++;
          }
          // a litter bin next to the odd lamp
          if (hashPos(cx, 3.3, cz) < 0.3) {
            const bx = lx + ux * 1.0, bz = lz + uz * 1.0;
            if (isOnSidewalk(bx, bz, 0.3)) { pushMatrix(M.bin, bx, SW_TOP, bz); addFootprint(bx, bz, 0.45, 0.45); placePole(bx, bz); }
          }
        }
      }

      // trees: rows of planes along the wide streets & the avenues, small ornamentals on residential streets
      if (parking) continue;
      if (!pedestrian && w >= 9) {
        const sp = w >= 12 ? 7 : 8;
        const thin = w >= 12 ? 0.15 : 0.25;
        for (let t = start + 4; t < len - 5; t += sp) {
          const x = p0.x + ux * t + inx * 1.0;
          const z = p0.z + uz * t + inz * 1.0;
          if (hashPos(x, 3.1, z) < thin) continue;
          const r = hashPos(z, 2.9, x);
          const species = w >= 12 ? mixSpecies(r, 0.7, 0.1) : mixSpecies(r, 0.55, 0.2);
          if (addStreetTree(x, z, 0.64 + hashPos(x, 6.1, z) * 0.2, species, ux, uz)) rowTrees++;
        }
      } else if (!pedestrian && w >= 6.5 && WIDE_KIND[kind] && hashPos(p0.x, 4.2, p1.z) < 0.3) {
        for (let t = start + 3; t < len - 5; t += 9) {
          const x = p0.x + ux * t + inx * 0.9;
          const z = p0.z + uz * t + inz * 0.9;
          if (hashPos(x, 5.1, z) < 0.3) continue;
          if (addStreetTree(x, z, 0.48 + hashPos(x, 6.1, z) * 0.1, 1, ux, uz, { pitS: 0.7, squeeze: 0.7 })) rowTrees++;
        }
      }

      // bollards along the pedestrian streets & the narrowest lanes (where the kerb is the only thing keeping cars off)
      if (pedestrian || w < 4.5) {
        for (let t = 2.5; t < len - 1.5; t += 2.5) {
          const x = p0.x + ux * t + inx * 0.42;
          const z = p0.z + uz * t + inz * 0.42;
          if (blockAt(x, z) !== b || !isClearOfPoles(x, z, 0.8)) continue;
          pushMatrix(M.bollard, x, SW_TOP, z);
        }
      }
    }
  }

  // =========================================================================
  // 6. MEDIANS: lamps (double arm) & the planted medians of the avenues and the Rambla d'Ègara (rows of planes)
  // =========================================================================
  for (const s of sidewalkBlocks || []) {
    const b = s.block;
    if (!b || !b.median) continue;
    const poly = s.poly;
    const narrow = Math.min(b.maxX - b.minX, b.maxZ - b.minZ);
    if (narrow < 1.4) continue;
    // the strip's axis: its longest edge; extent along it from the vertices
    let best = 0, ux = 1, uz = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], c = poly[(i + 1) % poly.length];
      const L = Math.hypot(c.x - a.x, c.z - a.z);
      if (L > best) { best = L; ux = (c.x - a.x) / L; uz = (c.z - a.z) / L; }
    }
    let t0 = Infinity, t1 = -Infinity;
    for (const p of poly) {
      const t = (p.x - b.cx) * ux + (p.z - b.cz) * uz;
      t0 = Math.min(t0, t); t1 = Math.max(t1, t);
    }
    if (t1 - t0 < 16) continue;
    const across = Math.hypot(ux, uz) ? [-uz, ux] : [0, 1];
    for (let t = t0 + 8; t < t1 - 6; t += 30) {
      const x = b.cx + ux * t, z = b.cz + uz * t;
      if (blockAt(x, z) !== b) continue;
      placePole(x, z);
      addFootprint(x, z, 0.4, 0.4);
      pushMatrix(M.column, x, SW_TOP, z, 0);
      for (const sgn of [1, -1]) {
        const ox = across[0] * sgn, oz = across[1] * sgn;
        pushMatrix(M.columnArm, x, SW_TOP, z, Math.atan2(-oz, ox));
        spotSites.push({ x: x + ox * 1.4, y: SW_TOP + 7.7, z: z + oz * 1.4, tx: x + ox * 3.8, tz: z + oz * 3.8 });
      }
    }
    if (narrow >= 3.0) {
      for (let t = t0 + 5; t < t1 - 4; t += 8) {
        const x = b.cx + ux * t, z = b.cz + uz * t;
        if (blockAt(x, z) !== b || !isClearOfPoles(x, z, 2.4)) continue;
        if (hashPos(x, 7.7, z) < 0.12) continue;
        placePole(x, z);
        treePositions.push({ x, y: SW_TOP, z, scale: 0.78 + hashPos(x, 1.1, z) * 0.16, species: 0, tier: 1 });
      }
    }
  }

  // =========================================================================
  // 7. THE MAPPED TREES (OSM natural=tree): on the sidewalks in tree pits, on the open land as they are; the few that
  //    fall on a carriageway (mapping imprecision) are dropped
  // =========================================================================
  let realTrees = 0;
  for (const t of STREET_TREES) {
    const b = blockAt(t.x, t.z);
    if (b) {
      if (b.open) {
        const low = b.cls === LAND_CLASS.WOOD || b.cls === LAND_CLASS.SCRUB || b.cls === LAND_CLASS.FARM;
        treePositions.push({ x: t.x, y: low ? 0.05 : SW_TOP, z: t.z, scale: 0.8 + hashPos(t.x, 2, t.z) * 0.3, species: mixSpecies(hashPos(t.x, 3, t.z), 0.6, 0.15) });
      } else if (b.median) {
        treePositions.push({ x: t.x, y: SW_TOP, z: t.z, scale: 0.78, species: 0, tier: 1 });
      } else {
        if (!isClearOfPoles(t.x, t.z, 1.2)) continue;
        const near = nearestRoads(t.x, t.z, 12)[0];
        const ux = near ? near.ux : 1, uz = near ? near.uz : 0;
        const q = Math.floor(hashPos(t.x, 8.8, t.z) * 3.999);
        const site = { x: t.x, y: TREE_Y, z: t.z, scale: 0.68 + hashPos(t.x, 6.1, t.z) * 0.2, species: 0, yaw: q * Math.PI * 0.5, tier: 1, pitRot: Math.atan2(ux, uz), sx: 0.85 };
        treePositions.push(site);
        sidewalkTreePositions.push(site);
        placePole(t.x, t.z);
      }
      realTrees++;
      continue;
    }
    // on no island: a traffic island too small for the generator, or mis-placed in the roadway
    const near = nearestRoads(t.x, t.z, 12);
    if (near.length && near[0].dist < near[0].road.w * 0.5 + 0.4 && !near[0].road.pedestrian) continue;
    treePositions.push({ x: t.x, y: 0, z: t.z, scale: 0.75, species: 0 });
    addFootprint(t.x, t.z, 1.2, 1.2);
    realTrees++;
  }

  // The parks, squares, woods & banks laid out by city-grid.js
  for (const s of parkTreeSites || []) treePositions.push(s);

  // =========================================================================
  // 8. MESHES
  // =========================================================================
  function addMatrixArrayInstanced(geo, mat, matrices, castShadow = true, extraAttrs = null) {
    if (matrices.length === 0) return null;
    let g = geo;
    if (extraAttrs) {
      g = geo.clone();
      for (const [name, attr] of Object.entries(extraAttrs)) g.setAttribute(name, attr);
    }
    const inst = new THREE.InstancedMesh(g, mat, matrices.length);
    if (castShadow && !mat.isMeshBasicNodeMaterial && mat.type !== 'MeshBasicNodeMaterial' && !mat.transparent) {
      inst.castShadow = true;
      inst.receiveShadow = true;
    }
    for (let i = 0; i < matrices.length; i++) inst.setMatrixAt(i, matrices[i]);
    inst.instanceMatrix.needsUpdate = true;
    inst.computeBoundingSphere();
    group.add(inst);
    return inst;
  }

  addMatrixArrayInstanced(unitCyl, poleMetalMat, M.signalPole);
  addMatrixArrayInstanced(unitBox, poleMetalMat, M.signalArm);
  addMatrixArrayInstanced(signalHousingGeo, signalHousingMat, M.head);
  addMatrixArrayInstanced(signalLensGeo, mainSignalLensMat, M.mainLens, false);
  addMatrixArrayInstanced(signalLensGeo, crossSignalLensMat, M.crossLens, false);
  addMatrixArrayInstanced(unitCyl, poleMetalMat, M.pedPole);
  addMatrixArrayInstanced(pedHousingGeo, signalHousingMat, M.pedHead);
  addMatrixArrayInstanced(pedLensGeo, pedMainMat, M.pedMainLens, false);
  addMatrixArrayInstanced(pedLensGeo, pedCrossMat, M.pedCrossLens, false);
  addMatrixArrayInstanced(columnGeo, poleMetalMat, M.column);
  addMatrixArrayInstanced(columnArmGeo, poleMetalMat, M.columnArm);
  addMatrixArrayInstanced(columnLensGeo, lampBulbGlow, M.columnArm, false);
  addMatrixArrayInstanced(postGeo, poleMetalMat, M.post);
  addMatrixArrayInstanced(postLanternGeo, lanternGlow, M.post, false);
  addMatrixArrayInstanced(wallBracketGeo, darkGreenMat, M.wall);
  addMatrixArrayInstanced(wallLanternGeo, lanternGlow, M.wall, false);
  addMatrixArrayInstanced(binGeo, darkGreenMat, M.bin);
  addMatrixArrayInstanced(bollardGeo, bollardMat, M.bollard);

  // Plaques: one instanced mesh per atlas, the cell of each plaque in an instanced attribute
  const plaqueTextures = atlas.finish();
  plaqueTextures.forEach((tex, ai) => {
    const idx = [];
    for (let i = 0; i < plaqueAtlasOf.length; i++) if (plaqueAtlasOf[i] === ai) idx.push(i);
    if (!idx.length) return;
    const cells = new THREE.InstancedBufferAttribute(new Float32Array(idx.length * 2), 2);
    idx.forEach((i, k) => cells.setXY(k, plaqueCells[i * 2], plaqueCells[i * 2 + 1]));
    addMatrixArrayInstanced(plaqueFaceGeo, createPlaqueMaterial(tex), idx.map((i) => M.plaque[i]), false, { aPlaqueCell: cells });
  });
  addMatrixArrayInstanced(plaqueFrameGeo, plaqueFrameMat, M.plaque);
  addMatrixArrayInstanced(plaquePoleGeo, plaqueFrameMat, M.plaquePole);

  // Tree pits (granite surround & dark soil, cast-iron grates on the avenues), running along the kerb
  const grateMat = createTreeGrateMaterial();
  const pitCurbMat = new THREE.MeshStandardNodeMaterial({ color: 0x5a5753, roughness: 0.88 });
  const pitSoilMat = new THREE.MeshStandardNodeMaterial({ color: 0x241c14, roughness: 0.96 });
  const pitCurbGeo = new THREE.BoxGeometry(1.5, 0.16, 2.2);
  const pitSoilGeo = new THREE.BoxGeometry(1.2, 0.15, 1.9);
  const pitGrateGeo = new THREE.RingGeometry(0.24, 0.72, 12, 1).rotateX(-Math.PI / 2);
  // Onto the relief: the trees, lights & signal sounds authored at kerb height (the park trees of city-grid.js
  // arrive already lifted: `lifted`)
  for (const t of treePositions) if (!t.lifted) t.y += lift(t.x, t.z);
  for (const l of pointSites) l.y += lift(l.x, l.z);
  for (const l of spotSites) l.y += lift(l.x, l.z);
  for (const a of audioSignals) a.y += lift(a.x, a.z);
  const gratedTrees = sidewalkTreePositions.filter((t) => t.grate !== false && (t.pitS || 1) >= 1);
  if (sidewalkTreePositions.length) {
    const pitCurbInst = new THREE.InstancedMesh(pitCurbGeo, pitCurbMat, sidewalkTreePositions.length);
    const pitSoilInst = new THREE.InstancedMesh(pitSoilGeo, pitSoilMat, sidewalkTreePositions.length);
    pitCurbInst.receiveShadow = true;
    pitSoilInst.receiveShadow = true;
    sidewalkTreePositions.forEach((t, i) => {
      dummy.rotation.set(0, t.pitRot || 0, 0);
      dummy.scale.set(t.pitS || 1, 1, t.pitS || 1);
      dummy.position.set(t.x, SW_TOP - 0.02 + lift(t.x, t.z), t.z);
      dummy.updateMatrix();
      pitCurbInst.setMatrixAt(i, dummy.matrix);
      dummy.position.set(t.x, SW_TOP - 0.03 + lift(t.x, t.z), t.z);
      dummy.updateMatrix();
      pitSoilInst.setMatrixAt(i, dummy.matrix);
    });
    pitCurbInst.instanceMatrix.needsUpdate = true;
    pitSoilInst.instanceMatrix.needsUpdate = true;
    pitCurbInst.computeBoundingSphere();
    pitSoilInst.computeBoundingSphere();
    group.add(pitCurbInst, pitSoilInst);
  }
  if (gratedTrees.length) {
    const pitGrateInst = new THREE.InstancedMesh(pitGrateGeo, grateMat, gratedTrees.length);
    pitGrateInst.receiveShadow = true;
    gratedTrees.forEach((t, i) => {
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.position.set(t.x, SW_TOP + 0.052 + lift(t.x, t.z), t.z);
      dummy.updateMatrix();
      pitGrateInst.setMatrixAt(i, dummy.matrix);
    });
    pitGrateInst.instanceMatrix.needsUpdate = true;
    pitGrateInst.computeBoundingSphere();
    group.add(pitGrateInst);
  }

  const stats = {
    signalHeads, pedHeads,
    plaques: M.plaque.length, plaquesOnWalls, plaquesOnPoles, plaquePoles, plaquesSkipped,
    columns, posts, lanterns, lanternsToPosts, lanternsSkipped,
    bollards: M.bollard.length, bins: M.bin.length, trees: treePositions.length, rowTrees, realTrees,
    wallsKnown: !!wallColliders
  };
  console.info(`[streetDetails] ${signalHeads} signal heads, ${pedHeads} pedestrian signals, ${M.plaque.length} street plaques (${plaquesOnWalls} on facades, ${plaquesOnPoles} on ${plaquePoles} poles, ${plaquesSkipped} without a corner to stand on; ${atlas.cells.size} names, ${plaqueTextures.length} atlases), ${columns} columns, ${posts} posts (${lanternsToPosts} in place of lanterns with no facade, ${lanternsSkipped} lanterns dropped), ${lanterns} wall lanterns, ${M.bollard.length} bollards, ${M.bin.length} bins, ${treePositions.length} trees (${rowTrees} in rows, ${realTrees} mapped)${wallColliders ? '' : ' [no colliders given: every assumed facade trusted]'}`);

  // Procedural trees (js/trees.js): species skeletons with leaf-spray cards, one instanced mesh per species, variant &
  // level of detail, each tree's level following the camera
  const treeField = createTreeField(scene, treePositions);
  group.add(treeField.group);

  // =========================================================================
  // 9. POOLED STREETLIGHTS: a few dozen real lights follow the camera among the thousands of luminaires (spot lights
  //    under the columns, point lights at the lanterns, posts & park lamps), looked up in 64 m cells
  // =========================================================================
  for (const s of parkLampSites || []) {
    pointSites.push({ x: s.x, y: s.y, z: s.z, color: 0xffe4b4, intensity: 32, dist: 14.0 });
  }

  const STREETLIGHT_SPOT_POOL = 36;
  const STREET_POINT_POOL = 48;
  const STREETLIGHT_DIST = 115;
  const STREET_POINT_DIST = 110;
  const LIGHT_CELL = 64;
  const bucket = (sites) => {
    const grid = new Map();
    for (const s of sites) {
      const k = Math.floor(s.x / LIGHT_CELL) * 100003 + Math.floor(s.z / LIGHT_CELL);
      let list = grid.get(k);
      if (!list) grid.set(k, (list = []));
      list.push(s);
    }
    return grid;
  };
  const spotGrid = bucket(spotSites);
  const pointGrid = bucket(pointSites);
  const gather = (grid, cx, cz, r, out) => {
    out.length = 0;
    const c = Math.ceil(r / LIGHT_CELL);
    const ix = Math.floor(cx / LIGHT_CELL), iz = Math.floor(cz / LIGHT_CELL);
    for (let i = ix - c; i <= ix + c; i++) {
      for (let j = iz - c; j <= iz + c; j++) {
        const list = grid.get(i * 100003 + j);
        if (list) for (let k = 0; k < list.length; k++) out.push(list[k]);
      }
    }
    return out;
  };

  const streetLightsGroup = new THREE.Group();
  streetLightsGroup.name = 'StreetClusteredLights';
  scene.add(streetLightsGroup);

  const streetlightSpotPool = [];
  for (let i = 0; i < STREETLIGHT_SPOT_POOL; i++) {
    // Flat LED luminaire: wide downward spread lighting both the roadway and the sidewalk
    const spot = new THREE.SpotLight(0xffe8c2, 0, 25, 0.96, 0.82, 1.25);
    spot.position.set(0, -1000, 0);
    spot.target.position.set(0, -1001, 0);
    streetLightsGroup.add(spot, spot.target);
    streetlightSpotPool.push(spot);
  }
  const streetPointPool = [];
  for (let i = 0; i < STREET_POINT_POOL; i++) {
    const pt = new THREE.PointLight(0xffe4b4, 0, 12, 1.35);
    pt.position.set(0, -1000, 0);
    streetLightsGroup.add(pt);
    streetPointPool.push(pt);
  }

  const nearSpots = [];
  const nearPoints = [];
  const activeSpots = [];
  const activePoints = [];

  function smoothFade(d, start, end) {
    const t = Math.min(1, Math.max(0, (end - d) / (end - start)));
    return t * t * (3 - 2 * t);
  }

  function update(camera) {
    if (!camera) return;
    const glow = cityUniforms && cityUniforms.uInteriorGlow ? cityUniforms.uInteriorGlow.value : 0.48;
    // Streetlights fade in smoothly as dusk approaches (matching lampBulbGlow smoothstep(0.4, 1.1, uInteriorGlow))
    const lampScale = Math.min(1.25, Math.max(0.0, (glow - 0.36) * 1.15));
    if (lampScale <= 0.001) {
      for (let i = 0; i < STREETLIGHT_SPOT_POOL; i++) {
        streetlightSpotPool[i].intensity = 0;
        streetlightSpotPool[i].position.set(0, -1000, 0);
      }
      for (let i = 0; i < STREET_POINT_POOL; i++) {
        streetPointPool[i].intensity = 0;
        streetPointPool[i].position.set(0, -1000, 0);
      }
      return;
    }

    const cx = camera.position.x;
    const cy = camera.position.y;
    const cz = camera.position.z;
    const me = camera.matrixWorld.elements;
    const fwdX = -me[8];
    const fwdZ = -me[10];

    const rank = (sites, maxDist, out) => {
      let n = 0;
      const md2 = maxDist * maxDist;
      for (let i = 0; i < sites.length; i++) {
        const s = sites[i];
        const dx = s.x - cx;
        const dz = s.z - cz;
        const d2 = dx * dx + dz * dz + cy * cy;
        if (d2 > md2) continue;
        const d = Math.sqrt(d2);
        const forwardDot = dx * fwdX + dz * fwdZ;
        const effDist = d + Math.max(0, 6.0 - forwardDot) * 2.8;
        if (effDist >= maxDist) continue;
        s._effDist = effDist;
        out[n++] = s;
      }
      out.length = n;
      if (n > 1) out.sort((a, b) => a._effDist - b._effDist);
      return n;
    };

    const spotCount = rank(gather(spotGrid, cx, cz, STREETLIGHT_DIST, nearSpots), STREETLIGHT_DIST, activeSpots);
    const spotCutoff = spotCount > STREETLIGHT_SPOT_POOL
      ? Math.min(STREETLIGHT_DIST, activeSpots[STREETLIGHT_SPOT_POOL]._effDist)
      : STREETLIGHT_DIST;
    const spotUsed = Math.min(spotCount, STREETLIGHT_SPOT_POOL);
    for (let i = 0; i < spotUsed; i++) {
      const s = activeSpots[i];
      const fade = smoothFade(s._effDist, spotCutoff * 0.62, spotCutoff);
      const spot = streetlightSpotPool[i];
      spot.position.set(s.x, s.y, s.z);
      spot.target.position.set(s.tx, 0.0, s.tz);
      spot.target.updateMatrixWorld();
      spot.intensity = 88.0 * lampScale * fade;
    }
    for (let i = spotUsed; i < STREETLIGHT_SPOT_POOL; i++) {
      streetlightSpotPool[i].intensity = 0;
      streetlightSpotPool[i].position.set(0, -1000, 0);
    }

    const ptCount = rank(gather(pointGrid, cx, cz, STREET_POINT_DIST, nearPoints), STREET_POINT_DIST, activePoints);
    const ptCutoff = ptCount > STREET_POINT_POOL
      ? Math.min(STREET_POINT_DIST, activePoints[STREET_POINT_POOL]._effDist)
      : STREET_POINT_DIST;
    const ptUsed = Math.min(ptCount, STREET_POINT_POOL);
    for (let i = 0; i < ptUsed; i++) {
      const s = activePoints[i];
      const fade = smoothFade(s._effDist, ptCutoff * 0.62, ptCutoff);
      const pt = streetPointPool[i];
      pt.color.setHex(s.color);
      pt.position.set(s.x, s.y, s.z);
      pt.distance = s.dist;
      pt.intensity = s.intensity * lampScale * fade;
    }
    for (let i = ptUsed; i < STREET_POINT_POOL; i++) {
      streetPointPool[i].intensity = 0;
      streetPointPool[i].position.set(0, -1000, 0);
    }
  }

  // Low solid props the player collides with (controllers.js, FEATURES.propCollisions): a cylinder per post, bollard,
  // bin and tree trunk, read off the instance matrices once everything is placed, whoever placed it (VDR-0030)
  const obstacles = [];
  const fromMatrices = (list, r, h, kind) => {
    for (const m of list) obstacles.push({ x: m.elements[12], z: m.elements[14], r, h, kind });
  };
  fromMatrices(M.column, 0.14, 8, 'post');
  fromMatrices(M.post, 0.07, 4.5, 'post');
  fromMatrices(M.signalPole, 0.09, 5, 'post');
  fromMatrices(M.pedPole, 0.06, 3, 'post');
  fromMatrices(M.plaquePole, 0.05, 3, 'post');
  fromMatrices(M.bollard, 0.08, 0.9, 'bollard');
  fromMatrices(M.bin, 0.24, 1.0, 'bin');
  for (const t of treePositions) {
    const trunk = (TREE_SPECIES[t.species] && TREE_SPECIES[t.species].trunk ? TREE_SPECIES[t.species].trunk.r : 0.3) * (t.scale || 1);
    obstacles.push({ x: t.x, z: t.z, r: trunk + 0.04, h: 6, kind: 'tree' });
  }

  scene.add(group);
  return { group, footprints, obstacles, signalClock, audioSignals, update, stats };
}

export { buildStreetDetails };
