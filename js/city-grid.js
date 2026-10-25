import * as THREE from 'three/webgpu';
import { Fn, vec2, color, positionWorld, mix, smoothstep, sin, dot, length, fwidth, mx_noise_float } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  LAND_CLASS,
  LAND_RING,
  WORLD_BOUNDS,
  BLOCKS,
  blockAt,
  PARKS,
  LANDUSE,
  WATERWAYS,
  RAIL_LINES,
  FEATURES
} from './city-config.js';
import { terrainActive, terrainY, terrainLattice, drapeGeometry, latticeCapGeometry, buildTerrainTiles, bridgeAt, bridgeList, deckY } from './terrain.js';
import { TREE_SPECIES } from './trees.js';
import {
  createRoadSurfaceMaterial,
  createSidewalkMaterial,
  createCurbMaterial,
  createWaterMaterial,
  createParkLawnMaterial,
  createParkPavingMaterial,
  createIronFenceMaterial,
  createParkLampGlobeMaterial,
  createParkWallMaterial,
  createParkLampPoolMaterial,
  createTreeGrateMaterial
} from './tsl-materials.js';

// js/city-grid.js
// The ground of Terrassa at true 1:1 scale, from the real geography in city-config.js (OpenStreetMap, see
// HOW_TO_IMPROVE.md): one asphalt deck over the detailed area, raised sidewalks & kerbs on every real curb island, and
// the open land by its land use — parks & squares (lawns, sauló walks, benches, lamps, trees), the woods of the Serra
// de l'Obac, scrub & fields, sports grounds, car parks, the cemetery, the railways and the canalised rieres & torrents
// (the Riera de les Arenes as a wide concrete channel, the Parc de Vallparadís as the sunken valley it is).
//
// Contract with the rest of the runtime (main.js): buildCityGrid(scene) returns { group, sidewalks: [] (the road
// network bounds the roads with city-config blockAt, not with rectangles), footprints (only SMALL ground obstacles:
// benches, lamps, tree grates, fences... as AABBs), colliders (the parapets of the sunken channels), highwayLanes: []
// (no shore highways) }. After it runs, the named exports below hold the sites street-details.js & buildings.js plant
// and light.

// Live construction data consumed by the building and street-detail builders after buildCityGrid().
let parkTreeSites = []; // { x, y, z, scale, species, ... } park, square, wood & bank trees (planted by street-details.js)
let parkLampSites = []; // { x, y, z } park lamp globes (lit by street-details.js' pooled point lights)
let pavedPlazaRects = []; // bounds of the paved squares (street trees & furniture keep off them)
let sidewalkBlocks = []; // { block, poly } every raised sidewalk island (street-details.js walks their kerb edges)
const fdrViaduct = []; // no viaducts in Terrassa: kept (empty) for the modules that still import it

const SW_TOP = WORLD_BOUNDS.sidewalkHeight; // 0.15 m: Catalan granite / concrete kerbs
const BED_Y = SW_TOP + 0.18; // lawn beds behind their copings
const GROUND_Y = 0.05; // unkerbed open land (woods, scrub, fields, ballast) just above the asphalt deck
const OVERLAY_Y = SW_TOP + 0.015; // land use painted over a block's sidewalk slab (gardens inside built blocks)
const sunkBlocks = new Map(); // block id -> { depth, walk, bank }: the parks sunk below street level

// =====================================================================================================================
// 1. GEOMETRY HELPERS (polygons [{x, z}] in the world frame)
// =====================================================================================================================

/**
 * Merges static non-instanced THREE.Mesh objects sharing the same material into a single
 * batched BufferGeometry per material to minimize WebGPU render & shadow pass draw calls.
 */
function batchStaticGroupMeshes(rootGroup, excludeMaterials = null) {
  if (!mergeGeometries) return;
  rootGroup.updateMatrixWorld(true);
  const invRoot = new THREE.Matrix4().copy(rootGroup.matrixWorld).invert();
  const buckets = new Map();

  rootGroup.traverse((obj) => {
    if (!obj.isMesh || obj.isInstancedMesh || !obj.geometry || !obj.material) return;
    if (excludeMaterials && excludeMaterials.has(obj.material)) return;
    const attrs = obj.geometry.attributes;
    if (!attrs.position || !attrs.normal || !attrs.uv) return;
    if (!buckets.has(obj.material)) {
      buckets.set(obj.material, []);
    }
    buckets.get(obj.material).push(obj);
  });

  for (const [mat, meshes] of buckets.entries()) {
    if (meshes.length < 2) continue;
    const geos = [];
    let anyCast = false;
    let anyReceive = false;

    for (const m of meshes) {
      const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      for (const key of Object.keys(g.attributes)) {
        if (key !== 'position' && key !== 'normal' && key !== 'uv') {
          g.deleteAttribute(key);
        }
      }
      const relMat = new THREE.Matrix4().multiplyMatrices(invRoot, m.matrixWorld);
      g.applyMatrix4(relMat);
      geos.push(g);
      if (m.castShadow) anyCast = true;
      if (m.receiveShadow) anyReceive = true;
      if (m.parent) m.parent.remove(m);
    }

    const merged = mergeGeometries(geos, false);
    if (merged) {
      const batchedMesh = new THREE.Mesh(merged, mat);
      batchedMesh.castShadow = anyCast;
      batchedMesh.receiveShadow = anyReceive;
      rootGroup.add(batchedMesh);
    }
  }
}

/**
 * World {x, z} polygon (with optional holes) -> horizontal THREE.Shape in (x, -z) space, so that rotateX(-PI / 2)
 * maps (x, -z, 0) -> (x, 0, z) with an upward (+Y) surface normal.
 */
function createWorldXZShape(pts, holes = []) {
  const shape = new THREE.Shape();
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (i === 0) shape.moveTo(p.x, -p.z);
    else shape.lineTo(p.x, -p.z);
  }
  shape.closePath();
  for (const h of holes) {
    if (!h || h.length < 3) continue;
    const path = new THREE.Path();
    for (let i = 0; i < h.length; i++) {
      const p = h[i];
      if (i === 0) path.moveTo(p.x, -p.z);
      else path.lineTo(p.x, -p.z);
    }
    path.closePath();
    shape.holes.push(path);
  }
  return shape;
}

function createExtrudedPolygonMesh(pts, bottomY, height, material, receiveShadow = true, castShadow = false, holes = []) {
  const shape = createWorldXZShape(pts, holes);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, curveSegments: 1 });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, bottomY, 0);
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = receiveShadow;
  mesh.castShadow = castShadow;
  return mesh;
}

function createFlatPolygonMesh(pts, y, material, receiveShadow = true, holes = []) {
  const shape = createWorldXZShape(pts, holes);
  const geo = new THREE.ShapeGeometry(shape, 1);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, y, 0);
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = receiveShadow;
  return mesh;
}

/** Sutherland-Hodgman clip of polygon [{x, z}] to the half-plane nx * x + nz * z >= c. */
function clipPolygonHalfPlane(pts, nx, nz, c) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const da = nx * a.x + nz * a.z - c;
    const db = nx * b.x + nz * b.z - c;
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  return out;
}

function rectPolygon(minX, maxX, minZ, maxZ) {
  return [{ x: minX, z: minZ }, { x: maxX, z: minZ }, { x: maxX, z: maxZ }, { x: minX, z: maxZ }];
}

/** Signed area (shoelace) of a polygon: positive when its inside lies left of each edge, i.e. along (-dz, dx) */
function polygonArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j].x * pts[i].z - pts[i].x * pts[j].z;
  return a * 0.5;
}

/** Area centroid {x, z} of a simple polygon */
function polygonCentroid(pts) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    const f = p.x * q.z - q.x * p.z;
    a += f;
    cx += (p.x + q.x) * f;
    cz += (p.z + q.z) * f;
  }
  return Math.abs(a) < 1e-9 ? { x: pts[0].x, z: pts[0].z } : { x: cx / (3 * a), z: cz / (3 * a) };
}

function polygonBounds(pts) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  return { minX, maxX, minZ, maxZ, w: maxX - minX, d: maxZ - minZ };
}

function pointInPolygonXZ(pts, x, z) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** Distance from (x, z) to the closest edge of a polygon */
function distToPolygonEdge(pts, x, z) {
  let best = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[j], b = pts[i];
    const dx = b.x - a.x, dz = b.z - a.z;
    const L2 = dx * dx + dz * dz || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / L2));
    const d = Math.hypot(a.x + dx * t - x, a.z + dz * t - z);
    if (d < best) best = d;
  }
  return best;
}

/**
 * A simple polygon ([{x, z}], either winding, convex or not) offset inward by d with mitred corners (miters clamped
 * to 3d), one vertex per input vertex; null if it collapses
 */
function offsetPolygonInward(pts, d) {
  const n = pts.length;
  if (n < 3) return null;
  const area = polygonArea(pts) * 2;
  const s = area > 0 ? 1 : -1;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = pts[(i + n - 1) % n];
    const q = pts[i];
    const r = pts[(i + 1) % n];
    let ax = q.x - p.x, az = q.z - p.z;
    let bx = r.x - q.x, bz = r.z - q.z;
    const la = Math.hypot(ax, az) || 1e-9;
    const lb = Math.hypot(bx, bz) || 1e-9;
    ax /= la; az /= la; bx /= lb; bz /= lb;
    const n1x = -az * s, n1z = ax * s; // inward normals of the two edges
    const n2x = -bz * s, n2z = bx * s;
    let mx = n1x + n2x, mz = n1z + n2z;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-6) { out.push({ x: q.x + n1x * d, z: q.z + n1z * d }); continue; }
    mx /= ml; mz /= ml;
    const cos = mx * n1x + mz * n1z; // miter length = d / cos(half angle)
    const len = Math.min(3 * d, d / Math.max(1e-3, cos));
    out.push({ x: q.x + mx * len, z: q.z + mz * len });
  }
  const a2 = polygonArea(out) * 2;
  return a2 * area > 0 && Math.abs(a2) < Math.abs(area) ? out : null;
}

/** Polygon offset by d (d > 0 inward, d < 0 outward), mitred corners clamped to 3|d|; null if it degenerates */
function offsetPolygon(pts, d) {
  if (d > 0) return offsetPolygonInward(pts, d);
  const n = pts.length;
  if (n < 3) return null;
  const s = polygonArea(pts) > 0 ? -1 : 1; // outward normal side
  const D = -d;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = pts[(i + n - 1) % n], q = pts[i], r = pts[(i + 1) % n];
    let ax = q.x - p.x, az = q.z - p.z, bx = r.x - q.x, bz = r.z - q.z;
    const la = Math.hypot(ax, az) || 1e-9, lb = Math.hypot(bx, bz) || 1e-9;
    ax /= la; az /= la; bx /= lb; bz /= lb;
    const n1x = -az * s, n1z = ax * s, n2x = -bz * s, n2z = bx * s;
    let mx = n1x + n2x, mz = n1z + n2z;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-6) { out.push({ x: q.x + n1x * D, z: q.z + n1z * D }); continue; }
    mx /= ml; mz /= ml;
    const len = Math.min(3 * D, D / Math.max(1e-3, mx * n1x + mz * n1z));
    out.push({ x: q.x + mx * len, z: q.z + mz * len });
  }
  return out;
}

/** Drops vertices closer than `eps` to the previous one (the generator's polygons have a few) */
function cleanPolygon(pts, eps = 0.05) {
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p.x - q.x, p.z - q.z) > eps) out.push(p);
  }
  if (out.length > 1 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].z - out[out.length - 1].z) <= eps) out.pop();
  return out;
}

/**
 * Tags every vertex of a mesh using the shared park paving material with its paving style (uv.x, see
 * createParkPavingMaterial: 0 hex asphalt pavers, 1 light granite plaza pavers, 2 bluestone slabs).
 */
function setPavingStyle(geo, style) {
  const uvAttr = geo.attributes.uv;
  for (let i = 0; i < uvAttr.count; i++) uvAttr.setXY(i, style, 0);
  uvAttr.needsUpdate = true;
  return geo;
}

/**
 * Vertical alpha-tested iron fence strips (createIronFenceMaterial) along segments [[x1, z1, x2, z2], ...]:
 * uv.x = metres along the run, uv.y = 0 (bottom) .. 1 (top). Also used for the solid walls of the channels (with a
 * double-sided material).
 */
function buildFenceStripGeometry(segments, y0, h) {
  const pos = [];
  const nor = [];
  const uvs = [];
  for (const [x1, z1, x2, z2] of segments) {
    const len = Math.hypot(x2 - x1, z2 - z1);
    if (len < 0.4) continue;
    const nx = -(z2 - z1) / len;
    const nz = (x2 - x1) / len;
    const corners = [[x1, z1, 0, 0], [x2, z2, len, 0], [x2, z2, len, 1], [x1, z1, 0, 0], [x2, z2, len, 1], [x1, z1, 0, 1]];
    for (const [x, z, u, v] of corners) {
      pos.push(x, y0 + v * h, z);
      nor.push(nx, 0, nz);
      uvs.push(u, v);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return g;
}

/**
 * A kerb round a closed outline: the outer face from y0 up to y1 and a flat strip `w` wide on top, turned inward, with
 * a wedge at every corner so the strip stays closed. Nothing underneath or inside (hidden by the deck & the slab).
 */
function buildKerbGeometry(pts, y0, y1, w = 0.25) {
  const n = pts.length;
  const s = polygonArea(pts) > 0 ? 1 : -1;
  // inward normal of edge i; checked against the polygon on the longest edge, flipped if it points out
  const normal = (i, flip) => {
    const a = pts[i], b = pts[(i + 1) % n];
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    return [(flip * -s * (b.z - a.z)) / len, (flip * s * (b.x - a.x)) / len, len];
  };
  let longest = 0;
  for (let i = 0; i < n; i++) if (normal(i, 1)[2] > normal(longest, 1)[2]) longest = i;
  const [nx0, nz0] = normal(longest, 1);
  const a0 = pts[longest], b0 = pts[(longest + 1) % n];
  const flip = pointInPolygonXZ(pts, (a0.x + b0.x) * 0.5 + nx0 * 0.4, (a0.z + b0.z) * 0.5 + nz0 * 0.4) ? 1 : -1;
  const pos = [], nor = [], uvs = [];
  const tri = (p, q, r, nrm) => {
    for (const v of [p, q, r]) { pos.push(v[0], v[1], v[2]); nor.push(nrm[0], nrm[1], nrm[2]); uvs.push(v[0] * 0.5, v[2] * 0.5); }
  };
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const [nx, nz, len] = normal(i, flip);
    if (len < 0.05) continue;
    // outer wall, facing out
    const A0 = [a.x, y0, a.z], B0 = [b.x, y0, b.z], A1 = [a.x, y1, a.z], B1 = [b.x, y1, b.z];
    const out = [-nx, 0, -nz];
    // wound so the face points along `out` (seen from outside, counter-clockwise)
    const cross = (B0[0] - A0[0]) * out[2] - (B0[2] - A0[2]) * out[0];
    if (cross < 0) { tri(A0, B0, B1, out); tri(A0, B1, A1, out); } else { tri(A0, B1, B0, out); tri(A0, A1, B1, out); }
    // top strip
    const Ai = [a.x + nx * w, y1, a.z + nz * w], Bi = [b.x + nx * w, y1, b.z + nz * w];
    const up = [0, 1, 0];
    const upCross = (B1[0] - A1[0]) * (Ai[2] - A1[2]) - (B1[2] - A1[2]) * (Ai[0] - A1[0]); // (x, z) orientation: +y faces need (x, -z) ccw
    if (upCross > 0) { tri(A1, Bi, B1, up); tri(A1, Ai, Bi, up); } else { tri(A1, B1, Bi, up); tri(A1, Bi, Ai, up); }
    // corner wedge at b between this strip's inner corner and the next edge's
    const [nnx, nnz] = normal((i + 1) % n, flip);
    const Bn = [b.x + nnx * w, y1, b.z + nnz * w];
    const wedge = (Bi[0] - B1[0]) * (Bn[2] - B1[2]) - (Bi[2] - B1[2]) * (Bn[0] - B1[0]);
    if (Math.abs(wedge) > 1e-6) { if (wedge > 0) tri(B1, Bn, Bi, up); else tri(B1, Bi, Bn, up); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return g;
}

/**
 * A bridge deck along its link: a 0.9 m thick slab the width of the carriageway plus both walks, the walks raised
 * 0.15 m, parapets 1.1 m high & 0.3 m thick on both edges, every vertex at the deck's own height (terrain.js deckY).
 * Returns { road (asphalt top), deck (slab sides & underside), walks, parapets, rails: [[ax, az, bx, bz, y]] } or null.
 */
function buildBridgeGeometry(b) {
  if (b.pts.length < 2 || b.len < 2) return null;
  const halfRoad = b.width * 0.5;
  const halfAll = b.half;
  const THICK = 0.9, WALK = b.cls === 1 ? 0.05 : 0.15, PARAPET = b.cls === 1 ? 0.85 : 1.05, PT = 0.28;
  const ground = (x, z) => terrainY(x, z);
  const EMBANK = 3.0; // a deck less than this over the ground is carried on walls (an embankment), higher ones on piers
  const PIER_SPACING = 22;
  const PIECE = 4; // m: the deck is resampled so walls, abutments and piers can follow the ground under it

  // ---- Resample the centre line every PIECE m: position, mitred normal, deck height, ground at both edges --------
  const pointAt = (d) => {
    const s = b.s, pts = b.pts;
    for (let k = 1; k < pts.length; k++) {
      if (d <= s[k] || k === pts.length - 1) {
        const a = pts[k - 1], c = pts[k];
        const seg = Math.max(1e-6, s[k] - s[k - 1]);
        const t = Math.max(0, Math.min(1, (d - s[k - 1]) / seg));
        const ux = (c.x - a.x) / seg, uz = (c.z - a.z) / seg;
        return { x: a.x + (c.x - a.x) * t, z: a.z + (c.z - a.z) * t, ux, uz };
      }
    }
    return null;
  };
  const count = Math.max(1, Math.ceil(b.len / PIECE));
  const R = []; // rings
  for (let k = 0; k <= count; k++) {
    const d = (b.len * k) / count;
    const pt = pointAt(d);
    const y = deckY(b, d);
    // normal to the right of the direction of travel (as bridgeAt's `t`), mitred at the polyline's own vertices
    const nx = -pt.uz, nz = pt.ux;
    const gl = ground(pt.x - nx * halfAll, pt.z - nz * halfAll);
    const gr = ground(pt.x + nx * halfAll, pt.z + nz * halfAll);
    const gc = ground(pt.x, pt.z);
    const gap = y - THICK - Math.min(gl, gr, gc);
    // another deck alongside (the other carriageway of a dual carriageway: the Carretera de Terrassa, the Pont de les
    // Arts): no walk, parapet or rail on that side, the roadway runs to the edge (the two decks read as one bridge
    // with a median instead of each one's inner parapet standing in the other's lanes)
    const beside = (sgn) => { const o = bridgeAt(pt.x + nx * (halfAll + 1) * sgn, pt.z + nz * (halfAll + 1) * sgn, 0.5); return !!(o && o.bridge !== b); };
    R.push({ x: pt.x, z: pt.z, ux: pt.ux, uz: pt.uz, nx, nz, y, gl, gr, gc, grounded: gap < EMBANK, d, nbL: beside(-1), nbR: beside(1) });
  }
  // the first and last rings are always grounded: a deck ends at a street or at the ground of its ramp
  R[0].grounded = true;
  R[R.length - 1].grounded = true;

  const road = [], roadN = [], deck = [], deckN = [], walks = [], walksN = [], par = [], parN = [], piers = [], piersN = [], rails = [];
  const quad = (pos, nor, p0, p1, p2, p3, nrm) => {
    // p0 p1 p2 p3 wound counter-clockwise seen from the normal side: checked here from the points themselves (the
    // carriageway quads were wound clockwise, so the double-sided asphalt was lit as a back face and read a
    // different colour from the street: the owner's "el color del asfalto sigue siendo distinto")
    const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
    const bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = p2[2] - p0[2];
    const gx = ay * bz - az * by, gy = az * bx - ax * bz, gz = ax * by - ay * bx;
    const order = gx * nrm[0] + gy * nrm[1] + gz * nrm[2] >= 0 ? [p0, p1, p2, p0, p2, p3] : [p0, p3, p2, p0, p2, p1];
    for (const v of order) { pos.push(v[0], v[1], v[2]); nor.push(nrm[0], nrm[1], nrm[2]); }
  };
  const P = (r, o, y) => [r.x + r.nx * o, y, r.z + r.nz * o];
  // the bottom of a side at a ring: into the ground on the grounded stretches, the slab's underside on the spans
  const bottom = (r, side) => (r.grounded ? Math.min(r.y - THICK, (side > 0 ? r.gr : r.gl) - 0.8) : r.y - THICK);

  for (let i = 0; i + 1 < R.length; i++) {
    const r0 = R[i], r1 = R[i + 1];
    const y0 = r0.y, y1 = r1.y;
    // deck top (carriageway between the walks, or to the edge where another deck runs alongside) and underside
    const nbL = r0.nbL && r1.nbL, nbR = r0.nbR && r1.nbR;
    const roadL = nbL ? -halfAll : -halfRoad, roadR = nbR ? halfAll : halfRoad;
    quad(road, roadN, P(r0, roadL, y0), P(r1, roadL, y1), P(r1, roadR, y1), P(r0, roadR, y0), [0, 1, 0]);
    quad(deck, deckN, P(r0, halfAll, y0 - THICK), P(r1, halfAll, y1 - THICK), P(r1, -halfAll, y1 - THICK), P(r0, -halfAll, y0 - THICK), [0, -1, 0]);
    for (const sgn of [-1, 1]) {
      const o = sgn * halfAll;
      // the side: from the walk's top down to the slab's underside, or into the ground where the deck is carried on
      // walls (the wall's bottom follows the ground ring to ring, so an abutment reads as a wing wall)
      const a0 = P(r0, o, bottom(r0, sgn)), a1 = P(r1, o, bottom(r1, sgn)), a2 = P(r1, o, y1 + WALK), a3 = P(r0, o, y0 + WALK);
      if (sgn > 0) quad(deck, deckN, a0, a1, a2, a3, [r0.nx * sgn, 0, r0.nz * sgn]); else quad(deck, deckN, a3, a2, a1, a0, [r0.nx * sgn, 0, r0.nz * sgn]);
      if (sgn > 0 ? nbR : nbL) continue; // the inner side of a dual carriageway: no walk, parapet or rail
      // raised walk (top + kerb face towards the road)
      const w0 = sgn * halfRoad, w1 = sgn * (halfAll - PT);
      if (sgn > 0) {
        quad(walks, walksN, P(r0, w0, y0 + WALK), P(r1, w0, y1 + WALK), P(r1, w1, y1 + WALK), P(r0, w1, y0 + WALK), [0, 1, 0]);
        quad(walks, walksN, P(r0, w0, y0), P(r1, w0, y1), P(r1, w0, y1 + WALK), P(r0, w0, y0 + WALK), [-r0.nx, 0, -r0.nz]);
      } else {
        quad(walks, walksN, P(r0, w1, y0 + WALK), P(r1, w1, y1 + WALK), P(r1, w0, y1 + WALK), P(r0, w0, y0 + WALK), [0, 1, 0]);
        quad(walks, walksN, P(r0, w0, y0 + WALK), P(r1, w0, y1 + WALK), P(r1, w0, y1), P(r0, w0, y0), [r0.nx, 0, r0.nz]);
      }
      // parapet: a box along the edge
      const e0 = sgn * (halfAll - PT), e1 = sgn * halfAll;
      const top0 = y0 + WALK + PARAPET, top1 = y1 + WALK + PARAPET;
      quad(par, parN, P(r0, e0, top0), P(r1, e0, top1), P(r1, e1, top1), P(r0, e1, top0), [0, 1, 0]);
      quad(par, parN, P(r0, e0, y0 + WALK), P(r1, e0, y1 + WALK), P(r1, e0, top1), P(r0, e0, top0), [-r0.nx * sgn, 0, -r0.nz * sgn]);
      quad(par, parN, P(r0, e1, top0), P(r1, e1, top1), P(r1, e1, y1 + WALK), P(r0, e1, y0 + WALK), [r0.nx * sgn, 0, r0.nz * sgn]);
      const rr0 = P(r0, sgn * (halfAll - PT * 0.5), 0), rr1 = P(r1, sgn * (halfAll - PT * 0.5), 0);
      rails.push([rr0[0], rr0[2], rr1[0], rr1[2], Math.min(y0, y1) + WALK]);
    }
    // an abutment front wall across the deck where a grounded stretch meets a span: closes the void under the deck
    if (r0.grounded !== r1.grounded) {
      const r = r0.grounded ? r0 : r1;
      const low = Math.min(r.gl, r.gr, r.gc) - 0.8;
      const facing = r0.grounded ? 1 : -1; // towards the span
      const fx = r.ux * facing, fz = r.uz * facing;
      const q0 = P(r, -halfAll, low), q1 = P(r, halfAll, low), q2 = P(r, halfAll, r.y - THICK + 0.02), q3 = P(r, -halfAll, r.y - THICK + 0.02);
      if (facing > 0) quad(deck, deckN, q0, q1, q2, q3, [fx, 0, fz]); else quad(deck, deckN, q1, q0, q3, q2, [fx, 0, fz]);
    }
  }
  // end caps: the slab's end faces from the ground up to the carriageway (never higher: the street carries on over
  // them, a cap up to the parapet was a wall across the road), the two walks' end faces (kerb height) and the
  // parapets' end faces, so an end never shows a hollow slab, walk or parapet
  for (const [r, facing] of [[R[0], -1], [R[R.length - 1], 1]]) {
    const low = Math.min(r.gl, r.gr, r.gc) - 0.8;
    const fx = r.ux * facing, fz = r.uz * facing;
    const face = (pos, nor, o0, o1, yb, yt) => {
      const q0 = P(r, o0, yb), q1 = P(r, o1, yb), q2 = P(r, o1, yt), q3 = P(r, o0, yt);
      if (facing > 0) quad(pos, nor, q0, q1, q2, q3, [fx, 0, fz]); else quad(pos, nor, q1, q0, q3, q2, [fx, 0, fz]);
    };
    face(deck, deckN, -halfAll, halfAll, low, r.y);
    for (const sgn of [-1, 1]) {
      if (sgn > 0 ? r.nbR : r.nbL) continue;
      face(walks, walksN, sgn * halfRoad, sgn * (halfAll - PT), r.y, r.y + WALK);
      face(par, parN, sgn * (halfAll - PT), sgn * halfAll, r.y, r.y + WALK + PARAPET);
    }
  }

  // ---- Piers under the spans: a rectangular concrete column every PIER_SPACING m (never within 5 m of an end or
  // on a ramp), from below the ground to the slab's underside
  const box = (cx, cz, ux, uz, halfL, halfW, yBottom, yTop) => {
    const rx = -uz, rz = ux;
    const c = (l, w, y) => [cx + ux * l + rx * w, y, cz + uz * l + rz * w];
    quad(piers, piersN, c(halfL, -halfW, yBottom), c(halfL, halfW, yBottom), c(halfL, halfW, yTop), c(halfL, -halfW, yTop), [ux, 0, uz]);
    quad(piers, piersN, c(-halfL, halfW, yBottom), c(-halfL, -halfW, yBottom), c(-halfL, -halfW, yTop), c(-halfL, halfW, yTop), [-ux, 0, -uz]);
    quad(piers, piersN, c(halfL, halfW, yBottom), c(-halfL, halfW, yBottom), c(-halfL, halfW, yTop), c(halfL, halfW, yTop), [rx, 0, rz]);
    quad(piers, piersN, c(-halfL, -halfW, yBottom), c(halfL, -halfW, yBottom), c(halfL, -halfW, yTop), c(-halfL, -halfW, yTop), [-rx, 0, -rz]);
  };
  const from = (b.ramp0 || 0) + 5, to = b.len - (b.ramp1 || 0) - 5;
  if (to - from > 8) {
    const n = Math.max(1, Math.round((to - from) / PIER_SPACING));
    for (let k = 0; k <= n; k++) {
      const d = from + ((to - from) * k) / n;
      const pt = pointAt(d);
      if (!pt) continue;
      const top = deckY(b, d) - THICK + 0.05;
      const g = ground(pt.x, pt.z);
      if (top - g < 1.2) continue; // the walls carry it here
      box(pt.x, pt.z, pt.ux, pt.uz, 0.7, Math.max(1.0, Math.min(halfRoad * 0.7, 3.0)), g - 0.8, top);
    }
  }

  const make = (pos, nor) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    const uv = new Float32Array((pos.length / 3) * 2);
    for (let k = 0; k < pos.length / 3; k++) { uv[k * 2] = pos[k * 3] * 0.5; uv[k * 2 + 1] = pos[k * 3 + 2] * 0.5; }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return g;
  };
  return { road: make(road, roadN), deck: make(deck, deckN), walks: make(walks, walksN), parapets: make(par, parN), piers: make(piers, piersN), rails };
}

/** Closed polygon outline -> fence segments, skipping the stretches within `gapR` of any gate point {x, z}. */
function polygonFenceSegments(pts, gates = [], gapR = 2.0, step = 1.0) {
  const segs = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.round(len / step));
    let runStart = null;
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      const open = gates.some((g) => Math.hypot(g.x - x, g.z - z) < gapR);
      if (!open && runStart === null) runStart = { x, z };
      if ((open || k === n) && runStart !== null) {
        if (Math.hypot(x - runStart.x, z - runStart.z) > 0.4) segs.push([runStart.x, runStart.z, x, z]);
        runStart = null;
      }
    }
  }
  return segs;
}

/**
 * Flat horizontal ribbon of `width` m along a polyline [{x, z}] at height y, mitred at the joints (miter clamped), uv.x
 * = metres along, uv.y = 0..1 across. null for a degenerate line.
 */
function buildRibbonGeometry(pts, width, y) {
  const n = pts.length;
  if (n < 2) return null;
  const pos = [], nor = [], uvs = [], idx = [];
  const hw = width * 0.5;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    let nx, nz, m = 1;
    if (i > 0 && i < n - 1) {
      const l1 = Math.hypot(p.x - a.x, p.z - a.z) || 1, l2 = Math.hypot(b.x - p.x, b.z - p.z) || 1;
      const n1x = -(p.z - a.z) / l1, n1z = (p.x - a.x) / l1, n2x = -(b.z - p.z) / l2, n2z = (b.x - p.x) / l2;
      let mx = n1x + n2x, mz = n1z + n2z;
      const ml = Math.hypot(mx, mz);
      if (ml > 1e-4) {
        mx /= ml; mz /= ml;
        m = 1 / Math.max(0.4, mx * n1x + mz * n1z);
        nx = mx; nz = mz;
      } else { nx = n1x; nz = n1z; }
    } else {
      const L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      nx = -(b.z - a.z) / L; nz = (b.x - a.x) / L;
    }
    if (i > 0) s += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z);
    pos.push(p.x + nx * hw * m, y, p.z + nz * hw * m, p.x - nx * hw * m, y, p.z - nz * hw * m);
    nor.push(0, 1, 0, 0, 1, 0);
    uvs.push(s, 0, s, 1);
    if (i > 0) {
      const k = i * 2;
      idx.push(k - 2, k, k - 1, k - 1, k, k + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

/**
 * Sloped strip between two rings with the same vertex count (an outline and its inward offset): the banks of the
 * sunken parks. Upward-facing, with smooth normals.
 */
function buildBankGeometry(outer, inner, yOuter, yInner) {
  const n = Math.min(outer.length, inner.length);
  const pos = [], uvs = [];
  const ccw = polygonArea(outer) < 0; // front faces (seen from above) need the (x, -z) counter-clockwise order
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const o0 = outer[i], o1 = outer[j], i0 = inner[i], i1 = inner[j];
    const quad = ccw
      ? [o0, o1, i0, i0, o1, i1]
      : [o1, o0, i0, o1, i0, i1];
    const ys = ccw ? [yOuter, yOuter, yInner, yInner, yOuter, yInner] : [yOuter, yOuter, yInner, yOuter, yInner, yInner];
    quad.forEach((p, k) => { pos.push(p.x, ys[k], p.z); uvs.push(p.x * 0.1, p.z * 0.1); });
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.computeVertexNormals();
  return g;
}

// Deterministic hash in [0, 1) of a few numbers (the same ground on every load)
function prand(x, z, k = 0) {
  const s = Math.sin(x * 127.1 + z * 311.7 + k * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Jittered grid of points inside a polygon (kept `margin` m from its edges), with a share `skip` left empty */
function scatterInPolygon(pts, spacing, margin, skip, fn) {
  const inner = margin > 0 ? offsetPolygonInward(pts, margin) : pts;
  if (!inner) return;
  const bb = polygonBounds(inner);
  for (let gx = bb.minX + spacing * 0.5; gx < bb.maxX; gx += spacing) {
    for (let gz = bb.minZ + spacing * 0.5; gz < bb.maxZ; gz += spacing) {
      const x = gx + (prand(gx, gz) - 0.5) * spacing * 0.8;
      const z = gz + (prand(gz, gx, 1) - 0.5) * spacing * 0.8;
      if (prand(x, z, 9) < skip) continue;
      if (!pointInPolygonXZ(inner, x, z)) continue;
      fn(x, z, prand(x, z, 2), prand(x, z, 3));
    }
  }
}

/** Points every `step` m along a polygon's edges (edges shorter than minLen skipped), with the edge's direction */
function alongPolygonEdges(pts, step, minLen, fn, start = step * 0.5) {
  const s = polygonArea(pts) > 0 ? 1 : -1;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < minLen) continue;
    const ux = (b.x - a.x) / len, uz = (b.z - a.z) / len;
    const inx = -uz * s, inz = ux * s; // inward normal
    for (let t = start; t < len - start * 0.5; t += step) fn(a.x + ux * t, a.z + uz * t, ux, uz, inx, inz, len);
  }
}

/** The longest edge's direction of a polygon (the axis of a median strip) */
function principalAxis(pts) {
  let best = 0, ux = 1, uz = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    if (L > best) { best = L; ux = (b.x - a.x) / L; uz = (b.z - a.z) / L; }
  }
  return { ux, uz };
}

// =====================================================================================================================
// 2. GROUND MATERIALS (world-space noise, so merged slabs of any size share one shader)
// =====================================================================================================================

// Two-tone ground with coarse patches & fine grain that fades out when it would shimmer from the air
function createGroundNoiseMaterial(hexA, hexB, scale, roughness = 0.95, stripes = 0) {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness, metalness: 0.0 });
  mat.colorNode = Fn(() => {
    const p = positionWorld.xz;
    const px = length(fwidth(p));
    const fine = smoothstep(1.2, 0.15, px);
    const coarse = mx_noise_float(p.mul(scale)).mul(0.5).add(0.5);
    const grain = mx_noise_float(p.mul(scale * 9.0).add(3.1)).mul(fine).mul(0.5).add(0.5);
    let f = coarse.mul(0.65).add(grain.mul(0.35));
    if (stripes > 0) {
      // ploughed furrows / mowing lines along the grid's x axis, fading with distance
      const furrow = sin(dot(p, vec2(0.0, 1.0)).mul((Math.PI * 2) / stripes)).mul(0.5).add(0.5);
      f = f.add(furrow.mul(smoothstep(3.0, 0.6, px)).mul(0.22));
    }
    return mix(color(hexA), color(hexB), f);
  })();
  return mat;
}

// =====================================================================================================================
// 3. THE CITY GROUND
// =====================================================================================================================

function buildCityGrid(scene) {
  const group = new THREE.Group();
  group.name = 'TerrassaCityGrid';

  const dummy = new THREE.Object3D();

  // Small ground obstacles traffic and pedestrians keep clear of (benches, lamps, tree pits, fences, copings)
  const footprints = [];
  const addFootprint = (x, z, w, d) => footprints.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });
  // Player colliders: the parapets of the canalised rieres (oriented boxes, one per wall edge)
  const colliders = [];
  const addWallCollider = (ax, az, bx, bz, h = 1.2, y0 = 0) => {
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.3) return;
    const ux = (bx - ax) / len, uz = (bz - az) / len;
    const cx = (ax + bx) * 0.5, cz = (az + bz) * 0.5;
    const hx = len * 0.5 + 0.2, hz = 0.35;
    const ex = Math.abs(ux) * hx + Math.abs(uz) * hz;
    const ez = Math.abs(uz) * hx + Math.abs(ux) * hz;
    colliders.push({ minX: cx - ex, maxX: cx + ex, minZ: cz - ez, maxZ: cz + ez, minY: y0, maxY: y0 + h, obb: { cx, cz, hx, hz, cs: ux, sn: -uz } });
  };

  // ---- Shared materials -----------------------------------------------------------------------------------------
  const roadMat = createRoadSurfaceMaterial();
  const sidewalkMat = createSidewalkMaterial();
  const curbMat = createCurbMaterial();
  const lawnMat = createParkLawnMaterial(false);
  const meadowMat = createParkLawnMaterial(true); // pitches & the big meadows
  const pavingMat = createParkPavingMaterial();
  const waterMat = createWaterMaterial();
  const fenceMat = createIronFenceMaterial();
  const wallMat = createParkWallMaterial(); // the cemetery's & the parks' stone walls
  const grateMat = createTreeGrateMaterial();
  const glowMat = createParkLampGlobeMaterial();
  const graniteMat = new THREE.MeshStandardNodeMaterial({ color: 0x86837c, roughness: 0.8 }); // copings, planters
  const hedgeMat = new THREE.MeshStandardNodeMaterial({ color: 0x366e3b, roughness: 0.82 });
  const sauloMat = createGroundNoiseMaterial(0xb6a078, 0xcdbb94, 0.45, 0.96); // compacted sand park walks
  const woodMat = createGroundNoiseMaterial(0x4a5230, 0x6b6a44, 0.035, 0.97); // pine needles, dry grass & rock
  const scrubMat = createGroundNoiseMaterial(0x8a7a55, 0x6d7a45, 0.05, 0.97); // garriga: ochre earth & low shrubs
  const farmMat = createGroundNoiseMaterial(0xa8865a, 0x8f9a5c, 0.02, 0.97, 1.4); // fields with furrows
  const ballastMat = createGroundNoiseMaterial(0x6a665e, 0x8d887e, 0.9, 0.98);
  const earthMat = createGroundNoiseMaterial(0x6e5e48, 0x8b7b62, 0.4, 0.97); // torrent beds
  const mudMat = createGroundNoiseMaterial(0x7e776b, 0x9b9486, 0.3, 0.95); // concrete channel beds, silted
  // Bridge & channel concrete: a mid grey (the old 0x9c9990 read almost white in the sun), parapets a shade lighter
  const concreteMat = new THREE.MeshStandardNodeMaterial({ color: 0x7e7b76, roughness: 0.94, side: THREE.DoubleSide });
  const parapetMat = new THREE.MeshStandardNodeMaterial({ color: 0x8c8983, roughness: 0.9, side: THREE.DoubleSide });
  const railMat = new THREE.MeshStandardNodeMaterial({ color: 0x5a5753, roughness: 0.35, metalness: 0.8 });
  const timberMat = new THREE.MeshStandardNodeMaterial({ color: 0x6e4f33, roughness: 0.8 });
  const ironMat = new THREE.MeshStandardNodeMaterial({ color: 0x23272a, roughness: 0.5, metalness: 0.6 });
  for (const [name, m] of Object.entries({ roadMat, sidewalkMat, curbMat, lawnMat, meadowMat, pavingMat, waterMat, fenceMat, wallMat, grateMat, glowMat, graniteMat, hedgeMat, sauloMat, woodMat, scrubMat, farmMat, ballastMat, earthMat, mudMat, concreteMat, railMat, timberMat, ironMat })) m.name = name;

  // ---- Shared accumulators (merged / instanced at the end) -----------------------------------------------------
  const geos = new Map(); // material -> [geometry] merged in batches of 400
  // With the relief on (terrain.js), every ground geometry is refined & draped over it as it is accumulated: slabs,
  // kerbs, banks, fences, walks... are authored flat (y relative to the roadway) and lifted here, vertex by vertex
  const relief = terrainActive();
  const KERB_BOTTOM = relief ? -0.4 : 0.0; // kerbs reach below the deck on a slope so no slit opens between them
  // cut along the relief's own lattice (the deck below is drawn on it), bottom caps dropped
  const LATTICE = terrainLattice() || { x0: 0, z0: 0, cell: 10 };
  const DRAPE_OPTS = { dropDown: true, x0: LATTICE.x0, z0: LATTICE.z0 };
  const addGeo = (mat, geo, raw = false) => {
    if (!geo) return;
    if (relief && !raw) geo = drapeGeometry(geo, geo.userData.latticeAligned ? 0 : LATTICE.cell, geo.userData.noDiag ? { ...DRAPE_OPTS, noDiag: true } : DRAPE_OPTS);
    let list = geos.get(mat);
    if (!list) geos.set(mat, (list = []));
    list.push(geo);
  };
  const addExtruded = (mat, pts, y0, h, holes = []) => {
    if (!pts || pts.length < 3) return;
    addGeo(mat, createExtrudedPolygonMesh(pts, y0, h, mat, true, false, holes).geometry);
  };
  const addFlat = (mat, pts, y, holes = [], style = -1) => {
    if (!pts || pts.length < 3) return;
    const g = (relief && latticeCapGeometry(pts, holes, y, LATTICE, THREE.ShapeUtils.triangulateShape)) || createFlatPolygonMesh(pts, y, mat, true, holes).geometry;
    if (style >= 0) setPavingStyle(g, style);
    addGeo(mat, g);
  };
  // The raised slabs (sidewalks, walks, paving) and the kerbs round them. Flat, the slabs are thin extrusions and the
  // kerb a full extrusion of the outline; on the relief the slab is a single draped cap (its sides sit behind the
  // kerb) and the kerb an outer wall with a 0.25 m top strip (no hidden inner wall, no bottom), both cut on the deck
  // lattice: a fraction of the triangles for the same picture
  const addSlab = (mat, pts, holes = [], style = -1) => {
    if (!pts || pts.length < 3) return;
    if (relief) addFlat(mat, pts, SW_TOP + 0.005, holes, style);
    else {
      const g = createExtrudedPolygonMesh(pts, 0.03, SW_TOP - 0.03 + 0.005, mat, true, false, holes).geometry;
      if (style >= 0) setPavingStyle(g, style);
      addGeo(mat, g);
    }
  };
  const addKerb = (poly, holes = []) => {
    if (!poly || poly.length < 3) return;
    if (!relief) { addExtruded(curbMat, poly, 0.0, SW_TOP, holes); return; }
    const g = buildKerbGeometry(poly, KERB_BOTTOM, SW_TOP, 0.25);
    g.userData.noDiag = true; // a 0.25 m strip: the deck's diagonals add nothing
    addGeo(curbMat, g);
  };
  const addRibbon = (mat, pts, w, y, style = -1) => {
    const g = buildRibbonGeometry(pts, w, y);
    if (!g) return;
    if (style >= 0) setPavingStyle(g, style);
    addGeo(mat, g);
  };
  const treeSites = [];
  const lampSpots = []; // [x, y, z] park lamps (post + globe + light pool)
  const benchMatrices = [];
  const grateSpots = []; // [x, y, z] tree grates in the squares
  const lift = relief ? (x, z) => terrainY(x, z) : () => 0;
  const addLamp = (x, y, z) => { lampSpots.push([x, y + lift(x, z), z]); addFootprint(x, z, 0.5, 0.5); };
  const addBench = (x, y, z, rotY) => {
    dummy.position.set(x, y + lift(x, z), z);
    dummy.rotation.set(0, rotY, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    benchMatrices.push(dummy.matrix.clone());
    addFootprint(x, z, 1.9, 0.7);
  };
  const addTree = (x, y, z, scale, species, extra) => { y += lift(x, z); treeSites.push(extra ? { x, y, z, scale, species, lifted: relief, ...extra } : { x, y, z, scale, species, lifted: relief }); };

  // Benches (backs to the bed coping, facing the walk) & lampposts along the edges of a lawn bed
  function lineBedEdges(bed, y, benchStep = 9.0) {
    const s = polygonArea(bed) > 0 ? 1 : -1;
    for (let i = 0; i < bed.length; i++) {
      const a = bed[i];
      const b = bed[(i + 1) % bed.length];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 7) continue;
      const nx = (s * (b.z - a.z)) / len; // outward (toward the walk)
      const nz = (-s * (b.x - a.x)) / len;
      const count = Math.floor((len - 3) / benchStep);
      for (let k = 0; k < count; k++) {
        const t = (1.5 + benchStep * (k + 0.5) + (len - 3 - count * benchStep) * 0.5) / len;
        const px = a.x + (b.x - a.x) * t;
        const pz = a.z + (b.z - a.z) * t;
        if (k % 3 === 1) addLamp(px + nx * 0.6, y, pz + nz * 0.6);
        else addBench(px + nx * 0.7, y, pz + nz * 0.7, Math.atan2(nx, nz));
      }
    }
  }

  // The walks of a park: sauló ribbons from the middle of its longest sides to a hub at its centroid (when the centroid
  // is inside the lawn), with lamps every ~24 m along them
  function parkPaths(bed, y, maxPaths = 4) {
    const c = polygonCentroid(bed);
    if (!pointInPolygonXZ(bed, c.x, c.z)) return;
    const edges = [];
    for (let i = 0; i < bed.length; i++) {
      const a = bed[i], b = bed[(i + 1) % bed.length];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len >= 14) edges.push({ len, x: (a.x + b.x) * 0.5, z: (a.z + b.z) * 0.5 });
    }
    edges.sort((p, q) => q.len - p.len);
    for (const e of edges.slice(0, maxPaths)) {
      const L = Math.hypot(e.x - c.x, e.z - c.z);
      if (L < 8) continue;
      const ux = (e.x - c.x) / L, uz = (e.z - c.z) / L;
      // a gentle bend so the walks don't read as spokes
      const bend = (prand(e.x, e.z, 4) - 0.5) * Math.min(6, L * 0.12);
      const mid = { x: (e.x + c.x) * 0.5 - uz * bend, z: (e.z + c.z) * 0.5 + ux * bend };
      addRibbon(sauloMat, [c, mid, { x: e.x + ux * 0.6, z: e.z + uz * 0.6 }], 2.6, y + 0.012);
      for (let t = 12; t < L - 6; t += 24) {
        const f = t / L;
        const px = c.x + (e.x - c.x) * f - uz * bend * 4 * f * (1 - f) + uz * 1.9;
        const pz = c.z + (e.z - c.z) * f + ux * bend * 4 * f * (1 - f) - ux * 1.9;
        addLamp(px, y, pz);
      }
    }
    // the hub itself
    const hub = new THREE.CircleGeometry(4.2, 24).rotateX(-Math.PI / 2).translate(c.x, y + 0.014, c.z);
    addGeo(sauloMat, hub);
  }

  // Park trees: planes along the walks, pines, holm oaks & limes in the lawns (species 0 plane, 1 slim open crown
  // standing in for the Aleppo pine, 2 dense rounded crown standing in for the holm oak & the lime)
  const parkSpecies = (r) => (r < 0.4 ? 0 : r < 0.65 ? 1 : 2);
  const woodSpecies = (r) => (r < 0.6 ? 1 : 2);

  // =========================================================================
  // 3.1 THE ASPHALT DECK: one flat slab over the whole detailed area at y = 0 (the land beyond it is painted by the
  //     surroundings module), with holes where the ground is sunk below street level (the canalised rieres & the
  //     Parc de Vallparadís)
  // =========================================================================
  const deckHoles = [];
  const sunkParkBlocks = [];
  const waterBlocks = [];
  // With the real relief the torrent of Vallparadís and the rieres are already in the elevation model: no synthetic
  // excavation (the sunk parks become ordinary parks on the valley floor, the channels silted beds on the terrain)
  for (const b of relief ? [] : BLOCKS) {
    if (!b.open) continue;
    const bb = polygonBounds(b.poly);
    if (b.cls === LAND_CLASS.WATER && b.area > 300 && Math.min(bb.w, bb.d) > 4) {
      const hole = offsetPolygonInward(b.poly, 0.2);
      if (hole) { waterBlocks.push(b); deckHoles.push(hole); }
    } else if (b.cls === LAND_CLASS.PARK && b.parkName === 'Parc de Vallparadís' && b.area > 3000) {
      const hole = offsetPolygonInward(b.poly, 0.2);
      if (hole) { sunkParkBlocks.push(b); deckHoles.push(hole); }
    }
  }
  if (relief) {
    // The deck as a heightfield: the relief sampled on a grid, in tiles; plus a skirt down its outer edge so no gap
    // shows against the coarser regional ground (surroundings.js) where the two meet
    const tiles = buildTerrainTiles(WORLD_BOUNDS, LATTICE.cell, FEATURES.terrainTile, 0.0);
    for (const t of tiles) {
      const mesh = new THREE.Mesh(t.geometry, roadMat);
      mesh.name = 'AsphaltDeck';
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    const skirtSegs = [];
    const corners = [[WORLD_BOUNDS.minX, WORLD_BOUNDS.minZ], [WORLD_BOUNDS.maxX, WORLD_BOUNDS.minZ], [WORLD_BOUNDS.maxX, WORLD_BOUNDS.maxZ], [WORLD_BOUNDS.minX, WORLD_BOUNDS.maxZ]];
    for (let i = 0; i < 4; i++) {
      const [ax, az] = corners[i], [bx, bz] = corners[(i + 1) % 4];
      const n = Math.ceil(Math.hypot(bx - ax, bz - az) / LATTICE.cell);
      for (let k = 0; k < n; k++) skirtSegs.push([ax + (bx - ax) * k / n, az + (bz - az) * k / n, ax + (bx - ax) * (k + 1) / n, az + (bz - az) * (k + 1) / n]);
    }
    const skirt = new THREE.Mesh(drapeGeometry(buildFenceStripGeometry(skirtSegs, -30, 30), 0), concreteMat);
    skirt.name = 'DeckSkirt';
    group.add(skirt);
    // The bridges: straight decks between their junction heights (terrain.js bridge table) over the relief, with
    // 2.4 m raised walks and 1.1 m parapets (colliders) either side. Not draped: they are the one thing that is not
    // the ground. Traffic, pedestrians and the player read them through groundHeightAt() / bridgeAt()
    let bridgeCount = 0;
    for (const b of bridgeList()) {
      const g = buildBridgeGeometry(b);
      if (!g) continue;
      addGeo(roadMat, g.road, true); // the carriageway: the same asphalt as the streets
      addGeo(concreteMat, g.deck, true);
      addGeo(b.cls === 1 ? concreteMat : sidewalkMat, g.walks, true); // motorway verges are concrete, not paving
      addGeo(parapetMat, g.parapets, true);
      addGeo(concreteMat, g.piers, true);
      for (const [ax, az, bx, bz, y] of g.rails) addWallCollider(ax, az, bx, bz, 1.2, y);
      bridgeCount++;
    }
    console.info(`[cityGrid] relief on: ${tiles.length} deck tiles of ${FEATURES.terrainTile} m, ${LATTICE.cell} m cells, ${bridgeCount} bridge decks`);
  } else {
    const deck = createFlatPolygonMesh(LAND_RING, 0.0, roadMat, true, deckHoles);
    deck.name = 'AsphaltDeck';
    group.add(deck);
  }

  // =========================================================================
  // 3.2 RAISED SIDEWALKS & KERBS on every built curb island (city-config.js BLOCKS: the real islands between the
  //     carriageways), extruded from their outlines: a kerb ring 0 -> 0.15 m and the concrete slab inset 0.25 m.
  //     Car parks keep only a 2.4 m sidewalk ring (their inside is the asphalt deck); the thin medians between two
  //     carriageways get a slab and, when wide enough, a clipped hedge (the planted medians of the avenues and the
  //     Rambla d'Ègara are planted with trees by street-details.js).
  // =========================================================================
  const blockOutlines = [];
  for (const b of BLOCKS) {
    if (b.open) continue;
    const poly = cleanPolygon(b.poly);
    if (poly.length < 3) continue;
    blockOutlines.push({ block: b, poly });
    const inner = offsetPolygonInward(poly, 0.25);
    addKerb(poly);
    if (!inner) continue;
    const parking = b.cls === LAND_CLASS.PARKING && b.clsShare >= 0.5 && !b.median;
    if (parking) {
      // sidewalk ring around the car park, lamps on a grid inside it
      const inside = offsetPolygonInward(poly, 2.6);
      addSlab(sidewalkMat, inner, inside ? [inside] : []);
      if (inside) scatterInPolygon(inside, 26, 3, 0, (x, z) => addLamp(x, 0.0, z));
      continue;
    }
    addSlab(sidewalkMat, inner);
    if (b.median) {
      const bb = polygonBounds(poly);
      const narrow = Math.min(bb.w, bb.d);
      if (narrow > 2.2 && narrow < 3.4) {
        const hedge = offsetPolygonInward(poly, 0.9);
        if (hedge) addExtruded(hedgeMat, hedge, SW_TOP, 0.55);
      }
    }
  }

  // =========================================================================
  // 3.3 OPEN LAND BY LAND USE on the open curb islands
  // =========================================================================
  const woodArea = BLOCKS.reduce((s, b) => s + (b.open && b.cls === LAND_CLASS.WOOD ? b.area : 0), 0);
  // The woods of the Serra de l'Obac / Sant Llorenç del Munt reach into the detail box from the north: tens of km² of
  // pine & holm oak. Their spacing is set by a budget of ~36k trees over the whole wood (HOW_TO_IMPROVE.md)
  const WOOD_SPACING = Math.max(11, Math.min(26, Math.sqrt(woodArea / 36000)));

  // ---- A small park or garden block: sauló walk round the kerb, a granite-coped lawn, walks, benches, lamps, trees
  function buildParkBlock(b, poly) {
    const bb = polygonBounds(poly);
    const narrow = Math.min(bb.w, bb.d);
    addKerb(poly);
    const walk = offsetPolygonInward(poly, 0.25);
    if (!walk) return;
    addSlab(sauloMat, walk);
    if (b.area < 500 || narrow < 9) {
      // a pocket garden: a few trees in the sauló and a bench
      scatterInPolygon(walk, 7, 2.2, 0.35, (x, z, r, r2) => addTree(x, SW_TOP, z, 0.75 + r2 * 0.3, parkSpecies(r)));
      if (b.area > 150) addBench(b.cx, SW_TOP, b.cz, prand(b.cx, b.cz) * Math.PI * 2);
      return;
    }
    const inset = Math.min(4.5, narrow * 0.16);
    const bed = offsetPolygonInward(poly, inset);
    if (!bed) return;
    addExtruded(graniteMat, bed, SW_TOP, BED_Y - 0.02 - SW_TOP); // coping
    const lawnTop = offsetPolygonInward(bed, 0.3) || bed;
    addExtruded(lawnMat, lawnTop, SW_TOP + 0.1, BED_Y - SW_TOP - 0.1);
    if (b.area > 2500) parkPaths(lawnTop, BED_Y);
    lineBedEdges(bed, SW_TOP);
    const spacing = b.area > 20000 ? 13 : 11;
    scatterInPolygon(lawnTop, spacing, 2.0, 0.3, (x, z, r, r2) => addTree(x, BED_Y, z, 0.9 + r2 * 0.45, parkSpecies(r)));
    // lamps along the outer walk every ~34 m
    alongPolygonEdges(walk, 34, 14, (x, z, ux, uz, inx, inz) => addLamp(x + inx * 1.1, SW_TOP, z + inz * 1.1), 17);
  }

  // ---- The Parc de Vallparadís: the old torrent valley sunk below the streets around it. Kerb & a 2 m walk at street
  //      level, grassed banks sloping down to the valley floor, lawns, walks & trees on the floor
  function buildSunkParkBlock(b, poly) {
    const bb = polygonBounds(poly);
    const narrow = Math.min(bb.w, bb.d);
    const depth = b.area > 50000 ? 3.2 : 2.4;
    const walkW = 2.2;
    const bankW = Math.max(walkW + 4, Math.min(12, narrow * 0.16));
    const kerbIn = offsetPolygonInward(poly, 0.25);
    const walkIn = offsetPolygonInward(poly, walkW);
    const floor = offsetPolygonInward(poly, bankW);
    if (!kerbIn || !walkIn || !floor) { buildParkBlock(b, poly); return; }
    sunkBlocks.set(b.id, { depth, walk: walkW, bank: bankW });
    addKerb(poly, [kerbIn]); // kerb ring (its underside covers the deck's hole edge)
    addSlab(sauloMat, kerbIn, [walkIn]); // the top walk
    addGeo(lawnMat, buildBankGeometry(walkIn, floor, SW_TOP, -depth)); // the banks
    addFlat(lawnMat, floor, -depth);
    const floorIn = offsetPolygonInward(floor, 1.5) || floor;
    parkPaths(floorIn, -depth, 5);
    // a walk along the floor's long axis too (the valley path)
    const axis = principalAxis(floor);
    const c = polygonCentroid(floor);
    if (pointInPolygonXZ(floor, c.x, c.z)) {
      const half = Math.max(bb.w, bb.d) * 0.5;
      const line = [];
      for (let t = -half; t <= half; t += 10) {
        const x = c.x + axis.ux * t + axis.uz * Math.sin(t * 0.045) * 4;
        const z = c.z + axis.uz * t - axis.ux * Math.sin(t * 0.045) * 4;
        if (pointInPolygonXZ(floorIn, x, z)) line.push({ x, z });
        else if (line.length > 1) { addRibbon(sauloMat, line.slice(), 3.0, -depth + 0.012); line.length = 0; }
        else line.length = 0;
      }
      if (line.length > 1) addRibbon(sauloMat, line, 3.0, -depth + 0.012);
    }
    // trees: poplars & planes on the floor, pines on the banks, railings & lamps on the top walk
    scatterInPolygon(floor, 12, 2.0, 0.3, (x, z, r, r2) => addTree(x, -depth, z, 1.0 + r2 * 0.5, parkSpecies(r)));
    const bankMid = offsetPolygonInward(poly, (walkW + bankW) * 0.5);
    if (bankMid) alongPolygonEdges(bankMid, 16, 20, (x, z) => {
      addTree(x, SW_TOP - (depth + SW_TOP) * 0.5, z, 0.8 + prand(x, z, 5) * 0.4, woodSpecies(prand(x, z, 6))); // half-way down the bank
    }, 8);
    alongPolygonEdges(kerbIn, 30, 16, (x, z, ux, uz, inx, inz) => addLamp(x + inx * 0.8, SW_TOP, z + inz * 0.8), 15);
    const rail = offsetPolygonInward(poly, walkW - 0.15);
    if (rail) addGeo(fenceMat, buildFenceStripGeometry(polygonFenceSegments(rail, [], 0, 2.0), SW_TOP, 1.0));
    alongPolygonEdges(kerbIn, 42, 30, (x, z, ux, uz, inx, inz) => addBench(x + inx * 1.0, SW_TOP, z + inz * 1.0, Math.atan2(inx, inz)), 28);
  }

  // ---- A square (plaça): granite paving over the whole island, trees in cast-iron grates, benches round the edge,
  //      lamps on the perimeter
  function buildPlazaBlock(b, poly) {
    addKerb(poly);
    const top = offsetPolygonInward(poly, 0.25);
    if (!top) return;
    const g = relief ? (latticeCapGeometry(top, [], SW_TOP + 0.005, LATTICE, THREE.ShapeUtils.triangulateShape) || createFlatPolygonMesh(top, SW_TOP + 0.005, pavingMat).geometry) : createExtrudedPolygonMesh(top, 0.03, SW_TOP - 0.03 + 0.005, pavingMat).geometry;
    setPavingStyle(g, 1);
    addGeo(pavingMat, g);
    const bb = polygonBounds(poly);
    pavedPlazaRects.push({ minX: bb.minX, maxX: bb.maxX, minZ: bb.minZ, maxZ: bb.maxZ });
    const narrow = Math.min(bb.w, bb.d);
    if (narrow < 7) return;
    scatterInPolygon(top, 9, 3.2, 0.3, (x, z, r, r2) => {
      addTree(x, SW_TOP, z, 0.7 + r2 * 0.25, r < 0.7 ? 0 : 2, { tier: 1 });
      grateSpots.push([x, SW_TOP + 0.006 + lift(x, z), z]);
      addFootprint(x, z, 1.4, 1.4);
    });
    alongPolygonEdges(top, 8, 16, (x, z, ux, uz, inx, inz) => {
      if (prand(x, z, 7) < 0.45) addBench(x + inx * 1.6, SW_TOP, z + inz * 1.6, Math.atan2(inx, inz)); // facing the square
    }, 6);
    alongPolygonEdges(top, 22, 12, (x, z, ux, uz, inx, inz) => addLamp(x + inx * 1.1, SW_TOP, z + inz * 1.1), 11);
  }

  // ---- Sports ground: kerb, pitch turf, a 3 m fence
  function buildSportsBlock(b, poly) {
    addKerb(poly);
    const top = offsetPolygonInward(poly, 0.25);
    if (!top) return;
    addSlab(meadowMat, top);
    const fence = offsetPolygonInward(poly, 1.2);
    if (fence && b.area > 1500) {
      // gates in the middle of the two longest sides
      const gates = [];
      for (let i = 0; i < fence.length; i++) {
        const a = fence[i], c = fence[(i + 1) % fence.length];
        const len = Math.hypot(c.x - a.x, c.z - a.z);
        if (len >= 30) gates.push({ len, x: (a.x + c.x) * 0.5, z: (a.z + c.z) * 0.5 });
      }
      gates.sort((p, q) => q.len - p.len);
      addGeo(fenceMat, buildFenceStripGeometry(polygonFenceSegments(fence, gates.slice(0, 2), 3.0, 2.0), SW_TOP, 3.0));
      alongPolygonEdges(fence, 28, 20, (x, z, ux, uz, inx, inz) => addLamp(x + inx * 1.2, SW_TOP, z + inz * 1.2), 14);
    }
  }

  // ---- Woods, scrub & fields: an unkerbed ground slab and the trees
  function buildWildBlock(b, poly) {
    if (b.cls === LAND_CLASS.WOOD) {
      addFlat(woodMat, poly, GROUND_Y);
      scatterInPolygon(poly, WOOD_SPACING, 2.5, 0.08, (x, z, r, r2) => {
        // glades & denser groves from low-frequency noise
        const grove = Math.sin(x * 0.011 + 1.7) * Math.sin(z * 0.009 + 0.4);
        if (grove > 0.55 && prand(x, z, 11) < 0.7) return;
        const sp = woodSpecies(r);
        addTree(x, GROUND_Y, z, sp === 1 ? 1.05 + r2 * 0.4 : 0.7 + r2 * 0.3, sp, sp === 2 ? { sx: 1.12, sz: 1.12 } : undefined);
      });
    } else if (b.cls === LAND_CLASS.SCRUB) {
      addFlat(scrubMat, poly, GROUND_Y);
      scatterInPolygon(poly, 22, 3, 0.55, (x, z, r, r2) => addTree(x, GROUND_Y, z, 0.45 + r2 * 0.3, r < 0.5 ? 2 : 1, { sx: 1.15, sz: 1.15 }));
    } else if (b.cls === LAND_CLASS.FARM) {
      addFlat(farmMat, poly, GROUND_Y);
      // a few trees on the field margins
      alongPolygonEdges(poly, 30, 40, (x, z, ux, uz, inx, inz) => {
        if (prand(x, z, 12) < 0.5) addTree(x + inx * 4, GROUND_Y, z + inz * 4, 0.8 + prand(x, z, 13) * 0.3, 2);
      }, 20);
    } else if (b.cls === LAND_CLASS.RAILWAY) {
      addFlat(ballastMat, poly, GROUND_Y - 0.01);
    }
  }

  // ---- A canalised riera: kerb & a planted walk on the bank, a concrete parapet, vertical concrete walls down to a
  //      silted bed with a trickle of water along the real watercourse. The deck has a hole under it (3.1).
  function buildWaterBlock(b, poly) {
    const bb = polygonBounds(poly);
    const narrow = Math.min(bb.w, bb.d);
    const wide = narrow >= 18; // the Riera de les Arenes
    const depth = wide ? 2.4 : 1.6;
    const walkW = wide ? 2.4 : 0.25;
    const kerbIn = offsetPolygonInward(poly, 0.25);
    const walkIn = offsetPolygonInward(poly, walkW);
    const wallIn = offsetPolygonInward(poly, walkW + 0.4);
    if (!kerbIn || !walkIn || !wallIn) { addFlat(mudMat, poly, GROUND_Y); return; }
    addKerb(poly, [kerbIn]);
    if (wide) {
      addSlab(sidewalkMat, kerbIn, [walkIn]);
      alongPolygonEdges(kerbIn, 10, 24, (x, z, ux, uz, inx, inz) => {
        if (prand(x, z, 14) < 0.2) return;
        addTree(x + inx * 1.0, SW_TOP, z + inz * 1.0, 0.72 + prand(x, z, 15) * 0.2, 0, { tier: 1 });
      }, 6);
      alongPolygonEdges(kerbIn, 30, 24, (x, z, ux, uz, inx, inz) => addLamp(x + inx * 0.6, SW_TOP, z + inz * 0.6), 15);
    }
    // parapet 1 m high on the walk's inner edge; its collider stops where a bridge deck crosses the channel (the car
    // on the Pont de les Arts was stopped dead by the Riera del Palau's parapet running on under the deck)
    addExtruded(concreteMat, walkIn, SW_TOP, 1.0, [wallIn]);
    for (let i = 0; i < walkIn.length; i++) {
      const a = walkIn[i], c = walkIn[(i + 1) % walkIn.length];
      const len = Math.hypot(c.x - a.x, c.z - a.z);
      const n = Math.max(1, Math.ceil(len / 2));
      let run = null;
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        const x = a.x + (c.x - a.x) * t, z = a.z + (c.z - a.z) * t;
        const underDeck = relief && bridgeAt(x, z, 1.5) !== null;
        if (!underDeck && run === null) run = { x, z };
        if ((underDeck || k === n) && run !== null) {
          const ex = underDeck ? a.x + (c.x - a.x) * ((k - 1) / n) : x, ez = underDeck ? a.z + (c.z - a.z) * ((k - 1) / n) : z;
          addWallCollider(run.x, run.z, ex, ez, 1.2, lift((run.x + ex) * 0.5, (run.z + ez) * 0.5));
          run = null;
        }
      }
    }
    // the channel: walls down from the parapet's inner face, the bed
    const segs = [];
    for (let i = 0; i < wallIn.length; i++) {
      const a = wallIn[i], c = wallIn[(i + 1) % wallIn.length];
      segs.push([a.x, a.z, c.x, c.z]);
    }
    addGeo(concreteMat, buildFenceStripGeometry(segs, -depth, depth + SW_TOP));
    addFlat(mudMat, wallIn, -depth);
    // the water along the watercourse inside this channel
    for (const w of WATERWAYS) {
      let run = [];
      const flush = () => {
        if (run.length > 1) addRibbon(waterMat, run, Math.min(w.w * 0.4, narrow * 0.3, 4.0), -depth + 0.03);
        run = [];
      };
      for (const p of w.pts) {
        if (p.x < bb.minX - 2 || p.x > bb.maxX + 2 || p.z < bb.minZ - 2 || p.z > bb.maxZ + 2 || !pointInPolygonXZ(wallIn, p.x, p.z)) flush();
        else run.push(p);
      }
      flush();
    }
  }

  const openBlocks = BLOCKS.filter((b) => b.open);
  const sunkIds = new Set(sunkParkBlocks.map((b) => b.id));
  const waterIds = new Set(waterBlocks.map((b) => b.id));
  for (const b of openBlocks) {
    const poly = cleanPolygon(b.poly);
    if (poly.length < 3) continue;
    if (b.median) {
      // open medians (grass strips between carriageways): kerb & lawn
      addKerb(poly);
      const inner = offsetPolygonInward(poly, 0.25);
      if (inner) addSlab(b.cls === LAND_CLASS.PARK || b.cls === LAND_CLASS.GRASS ? lawnMat : sidewalkMat, inner);
      continue;
    }
    switch (b.cls) {
      case LAND_CLASS.PARK:
      case LAND_CLASS.GRASS:
        if (sunkIds.has(b.id)) buildSunkParkBlock(b, poly);
        else buildParkBlock(b, poly);
        break;
      case LAND_CLASS.PLAZA:
        buildPlazaBlock(b, poly);
        break;
      case LAND_CLASS.SPORTS:
        buildSportsBlock(b, poly);
        break;
      case LAND_CLASS.WATER:
        if (waterIds.has(b.id)) buildWaterBlock(b, poly);
        else addFlat(mudMat, poly, GROUND_Y);
        break;
      case LAND_CLASS.CEMETERY:
        buildPlazaBlock(b, poly);
        break;
      default:
        buildWildBlock(b, poly);
    }
  }

  // =========================================================================
  // 3.4 LAND USE INSIDE THE BUILT BLOCKS: gardens, lawns, pitches & woods that OSM maps inside islands whose dominant
  //     use is something else (a school's pitch, the gardens of an estate, a wood behind the houses), painted on the
  //     sidewalk slab when the polygon lies on built islands (not on the roads)
  // =========================================================================
  const overlayMat = { [LAND_CLASS.PARK]: lawnMat, [LAND_CLASS.GRASS]: lawnMat, [LAND_CLASS.WOOD]: woodMat, [LAND_CLASS.SCRUB]: scrubMat, [LAND_CLASS.FARM]: farmMat, [LAND_CLASS.SPORTS]: meadowMat };
  let overlays = 0;
  for (const l of LANDUSE) {
    const mat = overlayMat[l.cls];
    if (!mat || l.area < 900) continue;
    const ring = cleanPolygon(l.rings[0]);
    if (ring.length < 3) continue;
    let on = 0, openOn = 0;
    for (const p of ring) {
      const b = blockAt(p.x, p.z);
      if (b) { on++; if (b.open) openOn++; }
    }
    if (on / ring.length < 0.85 || openOn / ring.length > 0.5) continue; // on the roads, or already painted as open land
    const holes = l.rings.slice(1).map((h) => cleanPolygon(h)).filter((h) => h.length >= 3);
    addFlat(mat, ring, OVERLAY_Y, holes);
    overlays++;
    if (l.cls === LAND_CLASS.PARK || l.cls === LAND_CLASS.GRASS || l.cls === LAND_CLASS.WOOD) {
      const spacing = l.cls === LAND_CLASS.WOOD ? Math.max(10, WOOD_SPACING * 0.7) : 12;
      scatterInPolygon(ring, spacing, 2.5, l.cls === LAND_CLASS.WOOD ? 0.1 : 0.4, (x, z, r, r2) => {
        const b = blockAt(x, z);
        if (!b || b.open) return;
        if (holes.some((h) => pointInPolygonXZ(h, x, z))) return;
        addTree(x, OVERLAY_Y, z, 0.8 + r2 * 0.4, l.cls === LAND_CLASS.WOOD ? woodSpecies(r) : parkSpecies(r));
      });
    }
  }

  // =========================================================================
  // 3.5 THE CEMETERY (Cementiri de Terrassa, from PARKS): paved lanes, a 2.4 m wall round it & rows of cypresses
  // =========================================================================
  for (const p of PARKS) {
    if (p.cls !== LAND_CLASS.CEMETERY) continue;
    const ring = cleanPolygon(p.rings[0]);
    if (ring.length < 3) continue;
    const y = OVERLAY_Y + 0.004;
    const g = createFlatPolygonMesh(ring, y, pavingMat).geometry;
    setPavingStyle(g, 2);
    addGeo(pavingMat, g);
    const wall = offsetPolygonInward(ring, 0.8);
    if (wall) {
      // the gate in the middle of the longest side
      let best = 0;
      const gate = { x: wall[0].x, z: wall[0].z };
      for (let i = 0; i < wall.length; i++) {
        const a = wall[i], b = wall[(i + 1) % wall.length];
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        if (len > best) { best = len; gate.x = (a.x + b.x) * 0.5; gate.z = (a.z + b.z) * 0.5; }
      }
      addGeo(wallMat, buildFenceStripGeometry(polygonFenceSegments(wall, [gate], 4.0, 2.0), y, 2.4));
      const wallCap = offsetPolygonInward(ring, 0.6);
      const wallIn = offsetPolygonInward(ring, 1.0);
      if (wallCap && wallIn) addExtruded(graniteMat, wallCap, y + 2.4, 0.12, [wallIn]);
    }
    // cypresses (tall, narrow crowns) in rows along the lanes; pencil-thin via sx / sz
    scatterInPolygon(ring, 9, 4, 0.35, (x, z, r, r2) => addTree(x, y, z, 1.1 + r2 * 0.5, 2, { sx: 0.32, sz: 0.32 }));
    alongPolygonEdges(wall || ring, 40, 30, (x, z, ux, uz, inx, inz) => addLamp(x + inx * 2.0, y, z + inz * 2.0), 20);
  }

  // =========================================================================
  // 3.6 RAILWAYS at grade (Rodalies R4 & FGC where they run in the open): ballast strip, two rails & sleepers
  // =========================================================================
  for (const r of RAIL_LINES) {
    if (r.pts.length < 2) continue;
    addRibbon(ballastMat, r.pts, 7.0, GROUND_Y + 0.01);
    // rails 1.435 m apart (ribbons 70 mm wide, 0.16 m above the ballast) and sleepers every 0.6 m as a dark band
    for (const side of [-0.7175, 0.7175]) {
      const off = [];
      for (let i = 0; i < r.pts.length; i++) {
        const p = r.pts[i];
        const a = r.pts[Math.max(0, i - 1)], b = r.pts[Math.min(r.pts.length - 1, i + 1)];
        const L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        off.push({ x: p.x - ((b.z - a.z) / L) * side, z: p.z + ((b.x - a.x) / L) * side });
      }
      addRibbon(railMat, off, 0.07, GROUND_Y + 0.17);
    }
    addRibbon(timberMat, r.pts, 2.5, GROUND_Y + 0.08);
  }

  // =========================================================================
  // 3.7 TORRENTS & RIERES in the open (outside the canalised blocks): a shallow earth bed following the real course;
  //     the wider rieres (Riera del Palau, Riera de Gaià) with a concrete bed & a ribbon of water. Stretches running
  //     under the streets (culverts) are skipped.
  // =========================================================================
  for (const w of WATERWAYS) {
    let run = [];
    const flush = () => {
      if (run.length > 1) {
        const ww = Math.max(2.5, w.w);
        if (w.w >= 8) {
          addRibbon(concreteMat, run, ww, GROUND_Y + 0.02);
          addRibbon(waterMat, run, ww * 0.35, GROUND_Y + 0.03);
        } else {
          addRibbon(earthMat, run, ww + 1.5, GROUND_Y + 0.02);
          addRibbon(mudMat, run, ww * 0.5, GROUND_Y + 0.03);
        }
      }
      run = [];
    };
    for (const p of w.pts) {
      const b = blockAt(p.x, p.z);
      if (!b || waterIds.has(b.id) || (!b.open && b.cls !== LAND_CLASS.SCRUB && b.cls !== LAND_CLASS.FARM && b.cls !== LAND_CLASS.WOOD)) flush();
      else run.push(p);
    }
    flush();
  }

  // =========================================================================
  // 3.8 MESHES: merged slabs per material, instanced furniture (park benches, lamps & their light pools, tree
  //     grates), and the exports for the other builders
  // =========================================================================
  for (const [mat, list] of geos) {
    for (let i = 0; i < list.length; i += 400) {
      const merged = mergeGeometries(list.slice(i, i + 400).map((g) => (g.index ? g.toNonIndexed() : g)), false);
      if (!merged) continue;
      const m = new THREE.Mesh(merged, mat);
      m.receiveShadow = true;
      m.castShadow = mat === curbMat || mat === graniteMat || mat === concreteMat || mat === wallMat || mat === hedgeMat;
      group.add(m);
    }
  }

  const instanced = (geo, mat, spots, cast = true) => {
    if (!spots.length) return;
    const inst = new THREE.InstancedMesh(geo, mat, spots.length);
    const m = new THREE.Matrix4();
    spots.forEach(([x, y, z], i) => inst.setMatrixAt(i, m.makeTranslation(x, y, z)));
    inst.instanceMatrix.needsUpdate = true;
    inst.castShadow = cast;
    inst.receiveShadow = true;
    inst.computeBoundingSphere();
    group.add(inst);
  };
  // Park lamp: a dark cast-iron column with a globe (the city's parks mostly carry globe or lantern luminaires)
  instanced(mergeGeometries([
    new THREE.CylinderGeometry(0.15, 0.2, 0.7, 8).translate(0, 0.35, 0),
    new THREE.CylinderGeometry(0.055, 0.085, 3.1, 8).translate(0, 2.25, 0),
    new THREE.CylinderGeometry(0.13, 0.07, 0.2, 8).translate(0, 3.85, 0)
  ]), ironMat, lampSpots);
  instanced(new THREE.SphereGeometry(0.27, 12, 8).translate(0, 4.17, 0), glowMat, lampSpots, false);
  // ... and the warm pools of their light on the ground (additive decal, black by day)
  instanced(new THREE.PlaneGeometry(10, 10).rotateX(-Math.PI / 2).translate(0, 0.025, 0), createParkLampPoolMaterial(), lampSpots, false);
  // Tree grates in the squares
  instanced(new THREE.RingGeometry(0.24, 0.82, 12, 1).rotateX(-Math.PI / 2), grateMat, grateSpots, false);
  // Park benches: slatted timber seat & back on two cast-iron ends (the "banc Neobarcino" every Catalan park has)
  if (benchMatrices.length) {
    const seat = mergeGeometries([
      new THREE.BoxGeometry(1.8, 0.05, 0.14).translate(0, 0.45, -0.17),
      new THREE.BoxGeometry(1.8, 0.05, 0.14).translate(0, 0.45, 0.0),
      new THREE.BoxGeometry(1.8, 0.05, 0.14).translate(0, 0.45, 0.17),
      new THREE.BoxGeometry(1.8, 0.14, 0.04).translate(0, 0.66, -0.3),
      new THREE.BoxGeometry(1.8, 0.14, 0.04).translate(0, 0.84, -0.34)
    ]);
    const ends = mergeGeometries([
      new THREE.BoxGeometry(0.06, 0.45, 0.5).translate(-0.8, 0.225, 0),
      new THREE.BoxGeometry(0.06, 0.45, 0.5).translate(0.8, 0.225, 0),
      new THREE.BoxGeometry(0.06, 0.5, 0.08).translate(-0.8, 0.7, -0.33),
      new THREE.BoxGeometry(0.06, 0.5, 0.08).translate(0.8, 0.7, -0.33)
    ]);
    for (const [geo, mat] of [[seat, timberMat], [ends, ironMat]]) {
      const inst = new THREE.InstancedMesh(geo, mat, benchMatrices.length);
      benchMatrices.forEach((mx, i) => inst.setMatrixAt(i, mx));
      inst.instanceMatrix.needsUpdate = true;
      inst.castShadow = true;
      inst.receiveShadow = true;
      inst.computeBoundingSphere();
      group.add(inst);
    }
  }

  parkTreeSites = treeSites;
  parkLampSites = lampSpots.map(([x, y, z]) => ({ x, y: y + 4.17, z }));
  sidewalkBlocks = blockOutlines;

  // Batch the remaining static sub-meshes by material to reduce per-frame WebGPU draw calls
  batchStaticGroupMeshes(group, new Set([roadMat, waterMat]));

  scene.add(group);
  console.info(`[cityGrid] ${blockOutlines.length} sidewalk islands, ${openBlocks.length} open islands (${sunkParkBlocks.length} sunk park, ${waterBlocks.length} channel), ${overlays} land-use overlays, ${treeSites.length} park & wood trees, ${lampSpots.length} park lamps, ${benchMatrices.length} benches, wood spacing ${WOOD_SPACING.toFixed(1)} m`);

  // Low solid props for the player's collisions (controllers.js, FEATURES.propCollisions): the park lamps & trees as
  // cylinders, the benches as oriented boxes in the building colliders' format (VDR-0030)
  const obstacles = [];
  for (const [x, , z] of lampSpots) obstacles.push({ x, z, r: 0.1, h: 4.5, kind: 'post' });
  for (const t of treeSites) {
    const trunk = (TREE_SPECIES[t.species] && TREE_SPECIES[t.species].trunk ? TREE_SPECIES[t.species].trunk.r : 0.3) * (t.scale || 1);
    obstacles.push({ x: t.x, z: t.z, r: trunk + 0.04, h: 6, kind: 'tree' });
  }
  const propBoxes = benchMatrices.map((m) => {
    const e = m.elements;
    const cx = e[12], cz = e[14], y0 = e[13];
    const cs = e[0], sn = e[8]; // rotation about y: the local x axis is (cos, 0, -sin), the z axis (sin, 0, cos)
    const hx = 0.95, hz = 0.35;
    const ex = Math.abs(cs) * hx + Math.abs(sn) * hz, ez = Math.abs(sn) * hx + Math.abs(cs) * hz;
    return { minX: cx - ex, maxX: cx + ex, minZ: cz - ez, maxZ: cz + ez, minY: y0, maxY: y0 + 0.9, obb: { cx, cz, hx, hz, cs, sn }, kind: 'bench' };
  });

  // The road network bounds the roads with the real block outlines (city-config.js blockAt): no sidewalk rectangles,
  // and no shore highways
  return { group, sidewalks: [], footprints, obstacles, propBoxes, highwayLanes: [], colliders };
}

/**
 * Height of the ground at (x, z): the relief (terrain.js, 0 when the city is flat) plus the asphalt deck (0), the
 * sidewalks & park walks (WORLD_BOUNDS.sidewalkHeight), the unkerbed open land, and the sunken parks (walk at street
 * level, then the bank down to the valley floor; only without the relief). Valid after buildCityGrid(). The channels of
 * the rieres are fenced off (colliders), so they count as their bank's walk. The one source of truth for the ground.
 */
function groundHeightAt(x, z, hint = null) {
  const ground = localGroundAt(x, z) + terrainY(x, z);
  if (!terrainActive()) return ground;
  const b = bridgeAt(x, z);
  if (!b) return ground;
  // on a bridge: its deck, the walks either side of the carriageway 0.15 m up; with a `hint` (the asker's current
  // height) the level nearer to it, so whoever passes under the bridge stays under it
  const deck = b.y + (Math.abs(b.t) > b.bridge.width * 0.5 ? SW_TOP : 0);
  if (hint === null || hint === undefined) return Math.max(ground, deck);
  return Math.abs(hint - deck) < Math.abs(hint - ground) ? deck : ground;
}

/** The carriageway height for a vehicle at (x, z): the roadway (never the kerbs), or a bridge deck; `hint` as above */
function roadHeightAt(x, z, hint = null) {
  const road = terrainY(x, z) + Math.min(0, localGroundAt(x, z));
  if (!terrainActive()) return road;
  const b = bridgeAt(x, z);
  if (!b) return road;
  if (hint === null || hint === undefined) return Math.max(road, b.y);
  return Math.abs(hint - b.y) < Math.abs(hint - road) ? b.y : road;
}

/** The local part of groundHeightAt(): the kerb / bank / channel height over the roadway, without the relief */
function localGroundAt(x, z) {
  const b = blockAt(x, z);
  if (!b) return 0;
  const s = sunkBlocks.get(b.id);
  if (s) {
    const d = distToPolygonEdge(b.poly, x, z);
    if (d <= s.walk) return SW_TOP;
    if (d >= s.bank) return -s.depth;
    const t = (d - s.walk) / (s.bank - s.walk);
    const k = t * t * (3 - 2 * t);
    return SW_TOP + (-s.depth - SW_TOP) * k;
  }
  if (!b.open || b.median) return SW_TOP;
  switch (b.cls) {
    case LAND_CLASS.WOOD:
    case LAND_CLASS.SCRUB:
    case LAND_CLASS.FARM:
    case LAND_CLASS.RAILWAY:
      return GROUND_Y;
    default:
      return SW_TOP;
  }
}

export {
  buildCityGrid,
  batchStaticGroupMeshes,
  groundHeightAt,
  roadHeightAt,
  localGroundAt,
  parkTreeSites,
  parkLampSites,
  pavedPlazaRects,
  sidewalkBlocks,
  fdrViaduct,
  // polygon helpers shared with the other ground builders
  createWorldXZShape,
  createExtrudedPolygonMesh,
  createFlatPolygonMesh,
  clipPolygonHalfPlane,
  rectPolygon,
  polygonArea,
  polygonCentroid,
  polygonBounds,
  pointInPolygonXZ,
  offsetPolygonInward,
  offsetPolygon,
  buildRibbonGeometry,
  buildFenceStripGeometry,
  polygonFenceSegments,
  setPavingStyle
};
