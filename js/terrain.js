// js/terrain.js — the real relief of Terrassa (js/terrassa-terrain.bin, built by tools/geo-terrain.mjs from the ICGC's
// elevation model): the single source of the ground's height for everything that stands on it. The city is built flat
// (y = 0 is the roadway) and lifted onto this surface: city-grid.js drapes the asphalt, kerbs & slabs over it,
// buildings.js & landmarks.js seat every volume at its street front with a plinth below, street-details.js, traffic.js,
// pedestrians & the player read groundHeightAt() (city-grid.js), which adds terrainY() to the local kerb height.
// Without the data file (or with FEATURES.terrain off) every function here is a no-op and the city stays flat.
import * as THREE from 'three/webgpu';
import { GEO } from './terrassa-geodata.js';

const HEADER_BYTES = 64;
let T = null; // { w, h, cell, x0, z0, ref, min, max, synthetic, data: Int16Array (cm), bridges: [{ link, y0, y1 }] }

/** Parses a terrain .bin (ArrayBuffer). Returns the record or throws */
function parseTerrain(buffer) {
  const dv = new DataView(buffer);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'TRN1') throw new Error(`terrain: bad magic ${JSON.stringify(magic)}`);
  const w = dv.getUint32(4, true), h = dv.getUint32(8, true);
  if (buffer.byteLength < HEADER_BYTES + w * h * 2) throw new Error('terrain: truncated file');
  const data = new Int16Array(w * h);
  // the payload is little-endian Int16: copy through a DataView only on big-endian hosts
  const le = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  if (le && (HEADER_BYTES % 2) === 0) data.set(new Int16Array(buffer, HEADER_BYTES, w * h));
  else for (let k = 0; k < w * h; k++) data[k] = dv.getInt16(HEADER_BYTES + k * 2, true);
  // the bridge table after the grid: 'BRDG', count, then link index + deck heights at both ends (m over the origin)
  const bridges = [];
  let o = HEADER_BYTES + w * h * 2;
  if (buffer.byteLength >= o + 8 && String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3)) === 'BRDG') {
    const n = dv.getUint32(o + 4, true);
    o += 8;
    for (let k = 0; k < n && o + 12 <= buffer.byteLength; k++, o += 12) bridges.push({ link: dv.getUint32(o, true), y0: dv.getFloat32(o + 4, true), y1: dv.getFloat32(o + 8, true) });
  }
  return {
    w, h, data, bridges,
    cell: dv.getFloat32(12, true), x0: dv.getFloat32(16, true), z0: dv.getFloat32(20, true),
    ref: dv.getFloat32(24, true), min: dv.getFloat32(28, true), max: dv.getFloat32(32, true),
    synthetic: (dv.getUint32(36, true) & 1) === 1, smooth: dv.getFloat32(40, true)
  };
}

/** Installs (or clears, with null) the terrain every other module samples */
function setTerrain(bufferOrRecord) {
  if (!bufferOrRecord) { T = null; BRIDGES = null; return null; }
  T = bufferOrRecord.data ? bufferOrRecord : parseTerrain(bufferOrRecord);
  BRIDGES = buildBridges(T.bridges || []);
  return T;
}

// ---------------------------------------------------------------------------------------------------------------------
// Bridges: decks over the relief. Each is a road-graph link (GEO.roadGraph) with the deck height at both ends; the deck
// is straight between them. A spatial grid of 64 m cells finds the deck under a point.
// ---------------------------------------------------------------------------------------------------------------------
const SIDEWALK_W = 2.4; // m of sidewalk either side of the carriageway (city-config GEO.frame.sidewalk)
const B_CELL = 64;
let BRIDGES = null; // { list: [{ link, pts, s, half, y0, y1, len }], grid: Map(cellKey -> [index]) }
function buildBridges(table) {
  const rg = GEO.roadGraph;
  const list = [];
  const grid = new Map();
  if (!rg || !table.length) return { list, grid };
  for (const b of table) {
    const l = rg.links[b.link];
    if (!l) continue;
    const [a, bb, , width, , , inner] = l;
    const pts = [{ x: rg.nodes[a * 2], z: rg.nodes[a * 2 + 1] }];
    for (let k = 0; k < inner.length; k += 2) pts.push({ x: inner[k], z: inner[k + 1] });
    pts.push({ x: rg.nodes[bb * 2], z: rg.nodes[bb * 2 + 1] });
    const s = [0];
    for (let k = 1; k < pts.length; k++) s.push(s[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z));
    const len = s[s.length - 1];
    if (len < 1) continue;
    const cls = l[7] || 0; // 1 motorway: verges instead of sidewalks
    const w = width > 3 ? width : 6;
    const half = w * 0.5 + (cls === 1 ? 0.9 : SIDEWALK_W);
    const id = list.length;
    const ys = s.map((d) => b.y0 + (b.y1 - b.y0) * (d / len));
    list.push({ link: b.link, nodes: [a, bb], pts, s, ys, half, y0: b.y0, y1: b.y1, len, width: w, cls, ramp0: 0, ramp1: 0 });
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
    for (let i = Math.floor((minX - half) / B_CELL); i <= Math.floor((maxX + half) / B_CELL); i++) {
      for (let j = Math.floor((minZ - half) / B_CELL); j <= Math.floor((maxZ + half) / B_CELL); j++) {
        const key = i * 100003 + j;
        let cell = grid.get(key);
        if (!cell) grid.set(key, (cell = []));
        cell.push(id);
      }
    }
  }
  fitAbutments(list, rg);
  addRamps(list);
  // the grid is bucketed after the ramps, which lengthen the decks
  grid.clear();
  list.forEach((b, id) => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of b.pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
    for (let i = Math.floor((minX - b.half) / B_CELL); i <= Math.floor((maxX + b.half) / B_CELL); i++) {
      for (let j = Math.floor((minZ - b.half) / B_CELL); j <= Math.floor((maxZ + b.half) / B_CELL); j++) {
        const key = i * 100003 + j;
        let cell = grid.get(key);
        if (!cell) grid.set(key, (cell = []));
        cell.push(id);
      }
    }
  });
  return { list, grid };
}

// A deck end at a street junction (an abutment: the node also carries ordinary streets) sits at the street's own
// height, which is where the cars arrive from: the tool's abutment cotes (the highest ground along the streets within
// 45 m) overshoot the street by up to 2 m (100 of the 254 abutments by more than 0.3 m; the Pont del Passeig by 1.4 m),
// which left the deck ending in the air and, worse, had addRamps() carry the parapets 36 m into the Passeig looking
// for ground at the table's height. Larger gaps (a street carved under the very end) keep the table and get a ramp.
// The inner vertices are re-interpolated between the two ends
function fitAbutments(list, rg) {
  const streetNode = new Set();
  for (const l of rg.links) if (!l[8]) { streetNode.add(l[0]); streetNode.add(l[1]); }
  for (const b of list) {
    const last = b.pts.length - 1;
    for (const [end, i] of [[0, 0], [1, last]]) {
      if (!streetNode.has(b.nodes[end])) continue;
      const p = b.pts[i];
      const street = terrainY(p.x, p.z);
      if (Math.abs(b.ys[i] - street) <= 2.5) b.ys[i] = street;
    }
    b.y0 = b.ys[0];
    b.y1 = b.ys[last];
    for (let k = 1; k < last; k++) b.ys[k] = b.y0 + (b.y1 - b.y0) * (b.s[k] / b.len);
  }
}

// A deck end that hangs over the terrain with no other deck carrying on from that junction gets an approach: the
// terrain tool's abutment heights, the limited-grade approach streets and the cuttings carved under the decks do not
// always meet (81 of the 280 ends in the ICGC model were off by more than 0.3 m, some by 5 m). The deck is extended back
// along its own line: level, to where the ground comes back up to the deck (the real abutment lies beyond the dip the
// crossing street was carved into), or failing that falling at 9 % until it meets the ground. The cars follow it
// (groundHeightAt → bridgeAt → deckY) and the geometry carries it on walls (city-grid.js buildBridgeGeometry)
function addRamps(list) {
  const endHeights = new Map(); // node → [heights of the deck ends there]
  for (const b of list) {
    for (const [k, node] of b.nodes.entries()) {
      const y = k === 0 ? b.ys[0] : b.ys[b.ys.length - 1];
      if (!endHeights.has(node)) endHeights.set(node, []);
      endHeights.get(node).push(y);
    }
  }
  const GRADE = 0.09, STEP = 2, LEVEL_MAX = 90, RAMP_MAX = 120;
  for (const b of list) {
    for (const end of [0, 1]) {
      const node = b.nodes[end];
      const i = end === 0 ? 0 : b.pts.length - 1;
      const j = end === 0 ? 1 : b.pts.length - 2;
      const p = b.pts[i], q = b.pts[j];
      const y = b.ys[i];
      if (endHeights.get(node).filter((other) => Math.abs(other - y) < 0.8).length > 1) continue; // another deck carries on
      if (y - terrainY(p.x, p.z) < 0.5) continue; // already on the ground
      const dx = p.x - q.x, dz = p.z - q.z;
      const d = Math.hypot(dx, dz) || 1;
      const ux = dx / d, uz = dz / d;
      const groundAt = (t) => terrainY(p.x + ux * t, p.z + uz * t);
      // 1. level: the ground comes back up to the deck within LEVEL_MAX m
      let L = 0, yEnd = y;
      for (let t = STEP; t <= LEVEL_MAX; t += STEP) {
        if (groundAt(t) >= y - 0.4) { L = t; yEnd = y; break; }
      }
      // 2. a 9 % ramp down to wherever it meets the ground
      if (!L) {
        for (let t = STEP; t <= RAMP_MAX; t += STEP) {
          const h = y - GRADE * t;
          if (groundAt(t) >= h - 0.3) { L = t; yEnd = Math.max(h, groundAt(t)); break; }
        }
      }
      // 3. the ground stays far below: a ramp of RAMP_MAX m to it (a long viaduct ramp)
      if (!L) { L = RAMP_MAX; yEnd = groundAt(L); }
      const ex = p.x + ux * L, ez = p.z + uz * L;
      if (end === 0) {
        b.pts.unshift({ x: ex, z: ez });
        b.ys.unshift(yEnd);
        b.ramp0 = L;
      } else {
        b.pts.push({ x: ex, z: ez });
        b.ys.push(yEnd);
        b.ramp1 = L;
      }
    }
    const s = [0];
    for (let k = 1; k < b.pts.length; k++) s.push(s[k - 1] + Math.hypot(b.pts[k].x - b.pts[k - 1].x, b.pts[k].z - b.pts[k - 1].z));
    b.s = s;
    b.len = s[s.length - 1];
  }
}

/** The deck height along bridge `b` at arc length `d` (clamped): piecewise linear through its vertex heights */
function deckY(b, d) {
  const s = b.s, ys = b.ys;
  if (!ys) return b.y0 + (b.y1 - b.y0) * Math.max(0, Math.min(1, d / b.len));
  if (d <= 0) return ys[0];
  for (let k = 1; k < s.length; k++) {
    if (d <= s[k]) {
      const t = (d - s[k - 1]) / Math.max(1e-6, s[k] - s[k - 1]);
      return ys[k - 1] + (ys[k] - ys[k - 1]) * t;
    }
  }
  return ys[ys.length - 1];
}

/**
 * The bridge deck under (x, z), if any: { y, bridge, d (arc length), t (signed offset to the right) }, the nearest
 * when decks overlap. `extra` widens the search (parapets, the deck's edge geometry).
 */
function bridgeAt(x, z, extra = 0) {
  if (!BRIDGES || !BRIDGES.list.length) return null;
  const cell = BRIDGES.grid.get(Math.floor(x / B_CELL) * 100003 + Math.floor(z / B_CELL));
  if (!cell) return null;
  let best = null;
  for (const id of cell) {
    const b = BRIDGES.list[id];
    for (let k = 1; k < b.pts.length; k++) {
      const a = b.pts[k - 1], c = b.pts[k];
      const dx = c.x - a.x, dz = c.z - a.z;
      const l2 = dx * dx + dz * dz || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2));
      const px = a.x + dx * t, pz = a.z + dz * t;
      const dist = Math.hypot(x - px, z - pz);
      if (dist > b.half + extra || (best && dist >= best.dist)) continue;
      const d = b.s[k - 1] + Math.sqrt(l2) * t;
      const side = ((x - a.x) * dz - (z - a.z) * dx) / Math.sqrt(l2); // > 0 right of the direction of travel
      best = { y: deckY(b, d), bridge: b, d, t: side, dist };
    }
  }
  return best;
}

/**
 * The surface to stand on at (x, z): the relief, or a bridge deck over it. With a `hint` (the current height of
 * whatever is asking) the level nearest to it wins, so a car under a viaduct stays under it; without one the deck.
 */
function surfaceY(x, z, hint = null) {
  const t = terrainY(x, z);
  const b = bridgeAt(x, z);
  if (!b) return t;
  if (hint === null || hint === undefined) return Math.max(t, b.y);
  return Math.abs(hint - b.y) < Math.abs(hint - t) ? b.y : t;
}
const bridgeList = () => (BRIDGES ? BRIDGES.list : []);

/** Fetches & installs the terrain file; resolves to the record, or null (flat city) when it is missing or broken */
async function loadTerrain(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rec = setTerrain(await res.arrayBuffer());
    console.info(`[terrain] ${rec.w} x ${rec.h} cells of ${rec.cell} m, origin ${rec.ref.toFixed(1)} m a.s.l., relief ${rec.min.toFixed(1)}..+${rec.max.toFixed(1)} m${rec.synthetic ? ' — SYNTHETIC stand-in, not the real relief' : ''}`);
    return rec;
  } catch (e) {
    console.warn(`[terrain] no relief (${e.message}): the city stays flat`);
    T = null;
    return null;
  }
}

const terrainActive = () => T !== null;
const terrainInfo = () => T;
/** The lattice the deck & every draped geometry are cut on: the data's own cells (x0, z0, cell); null without terrain */
const terrainLattice = () => (T ? { x0: T.x0, z0: T.z0, cell: T.cell } : null);

/**
 * Height of the terrain (m above the Plaça Vella) at world (x, z): the surface of the rendered deck's triangles — each
 * cell split along its b-d diagonal like surroundings.js — clamped to the edge of the data. 0 without terrain.
 */
function terrainY(x, z) {
  if (!T) return 0;
  const { w, h, cell, data } = T;
  let fx = (x - T.x0) / cell;
  let fz = (z - T.z0) / cell;
  if (fx < 0) fx = 0; else if (fx > w - 1) fx = w - 1;
  if (fz < 0) fz = 0; else if (fz > h - 1) fz = h - 1;
  const i = Math.min(w - 2, fx | 0), j = Math.min(h - 2, fz | 0);
  const u = fx - i, v = fz - j;
  const k = j * w + i;
  const a = data[k], b = data[k + 1], d = data[k + w], e = data[k + w + 1];
  if (u + v <= 1) return (a + (b - a) * u + (d - a) * v) * 0.01;
  return (e + (d - e) * (1 - u) + (b - e) * (1 - v)) * 0.01;
}

/** Gradient of the terrain at (x, z) as { gx, gz } (rise per metre); zeros without terrain */
function terrainGradient(x, z, out = { gx: 0, gz: 0 }) {
  if (!T) { out.gx = 0; out.gz = 0; return out; }
  const s = T.cell * 0.5;
  out.gx = (terrainY(x + s, z) - terrainY(x - s, z)) / (2 * s);
  out.gz = (terrainY(x, z + s) - terrainY(x, z - s)) / (2 * s);
  return out;
}

/** Lowest / highest terrain under a list of {x, z} points */
function terrainMin(pts) {
  if (!T) return 0;
  let m = Infinity;
  for (const p of pts) { const y = terrainY(p.x, p.z); if (y < m) m = y; }
  return m === Infinity ? 0 : m;
}
function terrainMax(pts) {
  if (!T) return 0;
  let m = -Infinity;
  for (const p of pts) { const y = terrainY(p.x, p.z); if (y > m) m = y; }
  return m === -Infinity ? 0 : m;
}

/**
 * Cuts every triangle of `geo` along the lattice the asphalt deck is built on (buildTerrainTiles: lines x = x0 + k·cell,
 * z = z0 + k·cell and the cells' b-d diagonals x + z = x0 + z0 + k·cell), so each piece lies inside one deck triangle
 * and, draped vertex by vertex, sits exactly on the deck's surface. Pieces are convex (a triangle clipped by half
 * planes), fan-triangulated; attributes are interpolated linearly. Slivers along a kerb cost one piece per cell they
 * cross, not a cascade of bisections. `opts.dropDown` discards the faces looking down first (the bottom caps of the
 * extrusions, never seen from above the ground); `opts.noDiag` skips the diagonal cuts (narrow strips such as kerb
 * tops, where the deck's twist within a cell is centimetres). Returns an indexed geometry with the lattice vertices shared.
 */
function refineGeometry(geo, cell, { dropDown = false, x0 = 0, z0 = 0, noDiag = false } = {}) {
  const src = geo.index ? geo.toNonIndexed() : geo;
  const names = Object.keys(src.attributes);
  const attrs = names.map((a) => src.attributes[a]);
  const sizes = attrs.map((a) => a.itemSize);
  const pos = src.attributes.position.array;
  const nrm = dropDown ? src.attributes.normal?.array : null;
  const triCount = pos.length / 9;
  const out = names.map(() => []);
  const stride = sizes.reduce((s, n) => s + n, 0);
  const offs = [];
  sizes.reduce((s, n) => { offs.push(s); return s + n; }, 0);
  const pOff = offs[names.indexOf('position')];
  const vert = (t, c) => {
    const v = new Float64Array(stride);
    attrs.forEach((a, ai) => { for (let k = 0; k < sizes[ai]; k++) v[offs[ai] + k] = a.array[(t * 3 + c) * sizes[ai] + k]; });
    return v;
  };
  const lerp = (a, b, t) => { const m = new Float64Array(stride); for (let k = 0; k < stride; k++) m[k] = a[k] + (b[k] - a[k]) * t; return m; };
  const emit = (v) => { for (let ai = 0; ai < attrs.length; ai++) for (let k = 0; k < sizes[ai]; k++) out[ai].push(v[offs[ai] + k]); };
  // the three families of cutting lines, as a coordinate function and the offset of their first line
  const families = [
    { f: (v) => v[pOff], o: x0 },
    { f: (v) => v[pOff + 2], o: z0 },
    { f: (v) => v[pOff] + v[pOff + 2], o: x0 + z0 }
  ];
  // Splits a convex polygon by the line f(v) = p into the two sides (either may be empty)
  const split = (poly, f, p) => {
    const lo = [], hi = [];
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      const fa = f(a) - p, fb = f(b) - p;
      if (fa <= 0) lo.push(a);
      if (fa >= 0) hi.push(a);
      if ((fa < 0 && fb > 0) || (fa > 0 && fb < 0)) {
        const m = lerp(a, b, fa / (fa - fb));
        lo.push(m);
        hi.push(m);
      }
    }
    return [lo, hi];
  };
  const cut = (pieces, fam) => {
    const outPieces = [];
    for (const piece of pieces) {
      let min = Infinity, max = -Infinity;
      for (const v of piece) { const c = fam.f(v); if (c < min) min = c; if (c > max) max = c; }
      const k0 = Math.floor((min - fam.o) / cell) + 1, k1 = Math.ceil((max - fam.o) / cell) - 1;
      if (k1 < k0) { outPieces.push(piece); continue; }
      let rest = piece;
      for (let k = k0; k <= k1; k++) {
        const [lo, hi] = split(rest, fam.f, fam.o + k * cell);
        if (lo.length >= 3) outPieces.push(lo);
        rest = hi;
        if (rest.length < 3) break;
      }
      if (rest.length >= 3) outPieces.push(rest);
    }
    return outPieces;
  };
  for (let t = 0; t < triCount; t++) {
    if (dropDown) {
      let ny;
      if (nrm) ny = nrm[t * 9 + 1] + nrm[t * 9 + 4] + nrm[t * 9 + 7];
      else {
        const o = t * 9;
        const ux = pos[o + 3] - pos[o], uy = pos[o + 4] - pos[o + 1], uz = pos[o + 5] - pos[o + 2];
        const vx = pos[o + 6] - pos[o], vy = pos[o + 7] - pos[o + 1], vz = pos[o + 8] - pos[o + 2];
        const nx = uy * vz - uz * vy, nz = ux * vy - uy * vx;
        ny = uz * vx - ux * vz;
        ny = (ny / (Math.hypot(nx, ny, nz) || 1)) * 3;
      }
      if (ny < -1.5) continue;
    }
    let pieces = [[vert(t, 0), vert(t, 1), vert(t, 2)]];
    // a vertical face (a kerb's wall) only needs the cuts along its length: the diagonals are for the ground
    const o = t * 9;
    const vertical = Math.abs((pos[o + 5] - pos[o + 2]) * (pos[o + 6] - pos[o]) - (pos[o + 3] - pos[o]) * (pos[o + 8] - pos[o + 2])) < 1e-6;
    for (let fi = 0; fi < (vertical || noDiag ? 2 : 3); fi++) pieces = cut(pieces, families[fi]);
    for (const piece of pieces) {
      for (let i = 1; i + 1 < piece.length; i++) {
        const a = piece[0], b = piece[i], c = piece[i + 1];
        // skip the degenerate slivers the cuts leave along the lines
        const ax = b[pOff] - a[pOff], az = b[pOff + 2] - a[pOff + 2], ay = b[pOff + 1] - a[pOff + 1];
        const bx = c[pOff] - a[pOff], bz = c[pOff + 2] - a[pOff + 2], by = c[pOff + 1] - a[pOff + 1];
        const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
        if (cx * cx + cy * cy + cz * cz < 1e-8) continue;
        emit(a); emit(b); emit(c);
      }
    }
  }
  return indexedFromSoup(out, names, sizes, stride, offs);
}

// Shares the vertices the cuts duplicate (every lattice point belongs to up to six pieces): an indexed geometry a
// few times smaller than the triangle soup. Vertices are matched on all their attributes, quantised to 1/2048
function indexedFromSoup(out, names, sizes, stride, offs) {
  const n = out[names.indexOf('position')].length / 3;
  const index = new Uint32Array(n);
  const buckets = new Map(); // hash -> [vertex id, ...]
  const packed = names.map((_, ai) => new Float32Array(out[ai])); // the soup, per attribute
  const unique = names.map(() => []);
  let count = 0;
  const q = 2048;
  for (let v = 0; v < n; v++) {
    let h = 0;
    for (let ai = 0; ai < packed.length; ai++) for (let k = 0; k < sizes[ai]; k++) h = (Math.imul(h, 31) + Math.round(packed[ai][v * sizes[ai] + k] * q)) | 0;
    let list = buckets.get(h);
    let id = -1;
    if (list) {
      for (const cand of list) {
        let same = true;
        for (let ai = 0; ai < packed.length && same; ai++) {
          for (let k = 0; k < sizes[ai]; k++) {
            if (Math.round(packed[ai][v * sizes[ai] + k] * q) !== Math.round(unique[ai][cand * sizes[ai] + k] * q)) { same = false; break; }
          }
        }
        if (same) { id = cand; break; }
      }
    } else buckets.set(h, (list = []));
    if (id < 0) {
      id = count++;
      list.push(id);
      for (let ai = 0; ai < packed.length; ai++) for (let k = 0; k < sizes[ai]; k++) unique[ai].push(packed[ai][v * sizes[ai] + k]);
    }
    index[v] = id;
  }
  const g = new THREE.BufferGeometry();
  names.forEach((nm, ai) => g.setAttribute(nm, new THREE.Float32BufferAttribute(new Float32Array(unique[ai]), sizes[ai])));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  return g;
}

/**
 * A flat polygon cap (outline `pts` [{x, z}] with `holes`) built directly on the deck lattice: every cell wholly
 * inside is the deck's own two triangles, only the cells the outline crosses are triangulated (`triangulate`:
 * THREE.ShapeUtils.triangulateShape) and clipped to their cell & diagonal. For a big sidewalk slab or a wood this is
 * a tenth of the vertices refineGeometry() would cut from a fan of slivers. Not yet draped: addGeo does that
 * (userData.latticeAligned tells it no further cutting is needed). Flat (no terrain): null, use ShapeGeometry.
 */
function latticeCapGeometry(pts, holes, y, lat, triangulate) {
  if (!T || !lat) return null;
  const { cell, x0, z0 } = lat;
  const rings = [pts, ...holes.filter((h) => h && h.length >= 3)];
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of pts) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z; }
  const i0 = Math.floor((minX - x0) / cell), i1 = Math.floor((maxX - x0) / cell);
  const j0 = Math.floor((minZ - z0) / cell), j1 = Math.floor((maxZ - z0) / cell);
  const nI = i1 - i0 + 1, nJ = j1 - j0 + 1;
  if (nI <= 0 || nJ <= 0 || nI * nJ > 4e6) return null;
  // the cells an edge passes through are boundary cells
  const boundary = new Uint8Array(nI * nJ);
  const mark = (x, z) => {
    const i = Math.floor((x - x0) / cell) - i0, j = Math.floor((z - z0) / cell) - j0;
    if (i >= 0 && j >= 0 && i < nI && j < nJ) boundary[j * nI + i] = 1;
  };
  for (const ring of rings) {
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k], b = ring[(k + 1) % ring.length];
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      const n = Math.max(1, Math.ceil(L / (cell * 0.25)));
      for (let t = 0; t <= n; t++) {
        const x = a.x + (b.x - a.x) * (t / n), z = a.z + (b.z - a.z) * (t / n);
        mark(x, z);
        // a point on a lattice line belongs to both cells
        const fx = (x - x0) / cell, fz = (z - z0) / cell;
        if (Math.abs(fx - Math.round(fx)) < 1e-6) mark(x - cell * 0.01, z), mark(x + cell * 0.01, z);
        if (Math.abs(fz - Math.round(fz)) < 1e-6) mark(x, z - cell * 0.01), mark(x, z + cell * 0.01);
      }
    }
  }
  const inRing = (ring, x, z) => {
    let inside = false;
    for (let a = 0, c = ring.length - 1; a < ring.length; c = a++) {
      const pa = ring[a], pc = ring[c];
      if (pa.z > z !== pc.z > z && x < ((pc.x - pa.x) * (z - pa.z)) / (pc.z - pa.z) + pa.x) inside = !inside;
    }
    return inside;
  };
  const inside = (x, z) => { if (!inRing(pts, x, z)) return false; for (let r = 1; r < rings.length; r++) if (inRing(rings[r], x, z)) return false; return true; };
  // the outline's own triangulation, bucketed into the boundary cells it overlaps
  const flat = rings.flat();
  const tri = triangulate(pts.map((p) => new THREE.Vector2(p.x, p.z)), rings.slice(1).map((h) => h.map((p) => new THREE.Vector2(p.x, p.z))));
  const perCell = new Map();
  for (const [a, b, c] of tri) {
    const P = [flat[a], flat[b], flat[c]];
    const tx0 = Math.min(P[0].x, P[1].x, P[2].x), tx1 = Math.max(P[0].x, P[1].x, P[2].x);
    const tz0 = Math.min(P[0].z, P[1].z, P[2].z), tz1 = Math.max(P[0].z, P[1].z, P[2].z);
    const ci0 = Math.max(0, Math.floor((tx0 - x0) / cell) - i0), ci1 = Math.min(nI - 1, Math.floor((tx1 - x0) / cell) - i0);
    const cj0 = Math.max(0, Math.floor((tz0 - z0) / cell) - j0), cj1 = Math.min(nJ - 1, Math.floor((tz1 - z0) / cell) - j0);
    for (let j = cj0; j <= cj1; j++) for (let i = ci0; i <= ci1; i++) {
      const k = j * nI + i;
      if (!boundary[k]) continue;
      let list = perCell.get(k);
      if (!list) perCell.set(k, (list = []));
      list.push(P);
    }
  }
  const pos = [], nor = [], uvs = [];
  const emitTri = (a, b, c) => {
    // front face up: counter-clockwise seen from above, i.e. in (x, -z)
    const cross = (b[0] - a[0]) * (-(c[1]) + a[1]) - (-(b[1]) + a[1]) * (c[0] - a[0]);
    const [p, q, r] = cross >= 0 ? [a, b, c] : [a, c, b];
    for (const v of [p, q, r]) { pos.push(v[0], y, v[1]); nor.push(0, 1, 0); uvs.push(v[0], -v[1]); }
  };
  const clip = (poly, f, p, keepBelow) => {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const fa = f(a) - p, fb = f(b) - p;
      const ina = keepBelow ? fa <= 0 : fa >= 0, inb = keepBelow ? fb <= 0 : fb >= 0;
      if (ina) out.push(a);
      if (ina !== inb) { const t = fa / (fa - fb); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
    }
    return out;
  };
  const fx = (v) => v[0], fz = (v) => v[1], fd = (v) => v[0] + v[1];
  for (let j = 0; j < nJ; j++) {
    const cz0 = z0 + (j0 + j) * cell, cz1 = cz0 + cell;
    for (let i = 0; i < nI; i++) {
      const cx0 = x0 + (i0 + i) * cell, cx1 = cx0 + cell;
      const k = j * nI + i;
      if (!boundary[k]) {
        if (!inside(cx0 + cell * 0.5, cz0 + cell * 0.5)) continue;
        const a = [cx0, cz0], b = [cx1, cz0], d = [cx0, cz1], e = [cx1, cz1];
        emitTri(a, d, b);
        emitTri(b, d, e);
        continue;
      }
      const list = perCell.get(k);
      if (!list) continue;
      for (const P of list) {
        let poly = P.map((v) => [v.x, v.z]);
        poly = clip(poly, fx, cx0, false); if (poly.length < 3) continue;
        poly = clip(poly, fx, cx1, true); if (poly.length < 3) continue;
        poly = clip(poly, fz, cz0, false); if (poly.length < 3) continue;
        poly = clip(poly, fz, cz1, true); if (poly.length < 3) continue;
        const diag = cx0 + cz1; // the b-d diagonal: x + z = x0 + z0 + (i + j + 1) cell
        for (const piece of [clip(poly, fd, diag, true), clip(poly, fd, diag, false)]) {
          for (let m = 1; m + 1 < piece.length; m++) {
            const a = piece[0], b = piece[m], c = piece[m + 1];
            if (Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) < 1e-6) continue;
            emitTri(a, b, c);
          }
        }
      }
    }
  }
  if (!pos.length) return null;
  const names = ['position', 'normal', 'uv'], sizes = [3, 3, 2];
  const g = indexedFromSoup([pos, nor, uvs], names, sizes, 8, [0, 3, 6]);
  g.userData.latticeAligned = true;
  return g;
}

/**
 * Lifts every vertex of `geo` by the terrain under it, after cutting it along the deck lattice of `cell` m (0: no
 * cutting; see refineGeometry for `opts`). Normals are kept: the relief's slopes are a few degrees. Returns the
 * (possibly new) geometry; with no terrain the input is returned untouched.
 */
function drapeGeometry(geo, cell = 10, opts = {}) {
  if (!T || !geo) return geo;
  const g = cell > 0 ? refineGeometry(geo, cell, opts) : geo;
  const p = g.attributes.position;
  const arr = p.array;
  for (let k = 0; k < arr.length; k += 3) arr[k + 1] += terrainY(arr[k], arr[k + 2]);
  p.needsUpdate = true;
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/**
 * The relief as a mesh: a regular grid of `cell` m over the bounds, split into tiles of `tile` m (frustum culling),
 * each cell triangulated on its b-d diagonal like terrainY() so the asphalt deck is exactly the sampled surface.
 * `yOffset` lifts the whole sheet. Returns [{ geometry, minX, minZ }] (empty without terrain).
 */
function buildTerrainTiles(bounds, cell, tile, yOffset = 0) {
  if (!T) return [];
  // the data's own lattice: tiles start on lattice lines, so every deck vertex is a sample and the deck's triangles
  // are exactly the surface terrainY() interpolates (cell = T.cell; a coarser multiple only subsamples it)
  cell = Math.max(T.cell, Math.round(cell / T.cell) * T.cell);
  tile = Math.max(cell, Math.round(tile / cell) * cell);
  const snap = (v, o) => o + Math.floor((v - o) / cell) * cell;
  const minX = snap(bounds.minX, T.x0), minZ = snap(bounds.minZ, T.z0);
  const maxX = snap(bounds.maxX - 1e-6, T.x0) + cell, maxZ = snap(bounds.maxZ - 1e-6, T.z0) + cell;
  const tiles = [];
  const nx = Math.ceil((maxX - minX) / tile);
  const nz = Math.ceil((maxZ - minZ) / tile);
  for (let tz = 0; tz < nz; tz++) {
    for (let tx = 0; tx < nx; tx++) {
      const x0 = minX + tx * tile, z0 = minZ + tz * tile;
      const x1 = Math.min(maxX, x0 + tile), z1 = Math.min(maxZ, z0 + tile);
      const cx = Math.max(1, Math.round((x1 - x0) / cell)), cz = Math.max(1, Math.round((z1 - z0) / cell));
      const n = (cx + 1) * (cz + 1);
      const pos = new Float32Array(n * 3);
      const nor = new Float32Array(n * 3);
      const uv = new Float32Array(n * 2);
      for (let j = 0; j <= cz; j++) {
        const z = j === cz ? z1 : z0 + j * cell;
        for (let i = 0; i <= cx; i++) {
          const x = i === cx ? x1 : x0 + i * cell;
          const k = j * (cx + 1) + i;
          pos[k * 3] = x;
          pos[k * 3 + 1] = terrainY(x, z) + yOffset;
          pos[k * 3 + 2] = z;
          nor[k * 3 + 1] = 1;
          uv[k * 2] = x;
          uv[k * 2 + 1] = z;
        }
      }
      const idx = new Uint32Array(cx * cz * 6);
      let o = 0;
      for (let j = 0; j < cz; j++) {
        for (let i = 0; i < cx; i++) {
          const a = j * (cx + 1) + i, b = a + 1, d = a + cx + 1, e = d + 1;
          // seen from above (+y) the front faces are counter-clockwise in (x, -z): a, d, b and b, d, e
          idx[o++] = a; idx[o++] = d; idx[o++] = b;
          idx[o++] = b; idx[o++] = d; idx[o++] = e;
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.computeBoundingBox();
      g.computeBoundingSphere();
      tiles.push({ geometry: g, minX: x0, minZ: z0, maxX: x1, maxZ: z1 });
    }
  }
  return tiles;
}

export {
  HEADER_BYTES,
  parseTerrain,
  setTerrain,
  loadTerrain,
  terrainActive,
  terrainInfo,
  terrainLattice,
  terrainY,
  terrainGradient,
  terrainMin,
  terrainMax,
  bridgeAt,
  surfaceY,
  bridgeList,
  deckY,
  refineGeometry,
  latticeCapGeometry,
  drapeGeometry,
  buildTerrainTiles
};
