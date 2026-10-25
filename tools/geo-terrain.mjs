// tools/geo-terrain.mjs — builds js/terrassa-terrain.bin, the real relief of Terrassa in the simulation's world frame,
// from one or more digital elevation models (GeoTIFF or Arc/Info ASCII grid; see tools/lib/geotiff.mjs). The first
// raster that has a valid value at a point wins, so pass the best model first (ICGC MET 2 m, then 5 m, then the
// Copernicus 30 m fallback). Fidelity notes & data sources: HOW_TO_IMPROVE.md §2.8.
//
// usage: node tools/geo-terrain.mjs [options] dem1.tif [dem2.asc ...]
//   --cell <m>      grid spacing in the world frame (default 10: the asphalt deck is drawn on this very lattice)
//   --margin <m>    extra terrain beyond the detailed area, for the regional ground to blend into (default 400)
//   --smooth <m>    gaussian sigma applied to the resampled grid; 0 to keep the raw model (default 4)
//   --out <file>    output (default js/terrassa-terrain.bin)
//   --epsg <code>   CRS of ASCII grids (they carry none) or of a GeoTIFF without geokeys
//   --synthetic     no input: an invented, clearly flagged relief for development (plane + torrents), never to ship
//   --raw           keep the bare-earth model: no streets written in, no blocks flattened, no bridge table
//
// Output: 64-byte header + Int16 little-endian centimetres above the Plaça Vella, row-major, rows along +z
//   0  'TRN1'   4 u32 w   8 u32 h   12 f32 cell   16 f32 x0   20 f32 z0   24 f32 ref (m a.s.l. of the origin)
//   28 f32 min  32 f32 max (m, relative)   36 u32 flags (1 = synthetic)   40 f32 smooth   44.. reserved
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readRaster } from './lib/geotiff.mjs';
import { projectorFor } from './lib/utm.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const log = (...a) => console.log('[terrain]', ...a);

export const HEADER_BYTES = 64;
export const MAGIC = 'TRN1';

// ---- arguments -------------------------------------------------------------------------------------------------------
export function parseArgs(argv) {
  const o = { cell: 10, margin: 400, smooth: 4, raw: false, out: path.join(ROOT, 'js/terrassa-terrain.bin'), epsg: null, synthetic: false, files: [], geodata: path.join(ROOT, 'js/terrassa-geodata.js') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cell') o.cell = Number(argv[++i]);
    else if (a === '--margin') o.margin = Number(argv[++i]);
    else if (a === '--smooth') o.smooth = Number(argv[++i]);
    else if (a === '--out') o.out = path.resolve(argv[++i]);
    else if (a === '--epsg') o.epsg = Number(argv[++i]);
    else if (a === '--geodata') o.geodata = path.resolve(argv[++i]);
    else if (a === '--synthetic') o.synthetic = true;
  else if (a === '--raw') o.raw = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else o.files.push(path.resolve(a));
  }
  return o;
}

// ---- the world frame (the same maths as tools/geo-base.mjs, from the generated GEO.frame) ---------------------------
export function frameOf(geoFrame) {
  const A = 6378137.0, E2 = 6.69437999014e-3;
  const lat0 = geoFrame.lat0, lon0 = geoFrame.lon0;
  const theta = (geoFrame.bearingDeg * Math.PI) / 180;
  const phi0 = (lat0 * Math.PI) / 180;
  const s0 = Math.sin(phi0);
  const nrad = A / Math.sqrt(1 - E2 * s0 * s0);
  const mrad = (A * (1 - E2)) / Math.pow(1 - E2 * s0 * s0, 1.5);
  const kx = (Math.PI / 180) * nrad * Math.cos(phi0);
  const ky = (Math.PI / 180) * mrad;
  const c = Math.cos(theta), s = Math.sin(theta);
  return {
    toLonLat(x, z) {
      const e = x * c - z * s;
      const n = -(x * s + z * c);
      return [lon0 + e / kx, lat0 + n / ky];
    },
    toWorld(lon, lat) {
      const e = (lon - lon0) * kx, n = (lat - lat0) * ky;
      return [e * c - n * s, -(e * s + n * c)];
    }
  };
}

// ---- the grid ----------------------------------------------------------------------------------------------------------
export function gridFor(bounds, cell, margin) {
  const x0 = Math.floor((bounds.minX - margin) / cell) * cell;
  const z0 = Math.floor((bounds.minZ - margin) / cell) * cell;
  const w = Math.ceil((bounds.maxX + margin - x0) / cell) + 1;
  const h = Math.ceil((bounds.maxZ + margin - z0) / cell) + 1;
  return { x0, z0, cell, w, h };
}

/** Samples the rasters (in order of preference) onto the world grid. Returns Float32Array of metres a.s.l. (NaN = hole) */
export function resample(grid, rasters, frame) {
  const { x0, z0, cell, w, h } = grid;
  const out = new Float32Array(w * h).fill(NaN);
  const sources = rasters.map((r) => ({ r, project: r.project }));
  let holes = 0;
  for (let j = 0; j < h; j++) {
    const z = z0 + j * cell;
    for (let i = 0; i < w; i++) {
      const x = x0 + i * cell;
      const [lon, lat] = frame.toLonLat(x, z);
      let v = NaN;
      for (const s of sources) {
        const [px, py] = s.project(lon, lat);
        v = s.r.sample(px, py);
        if (Number.isFinite(v)) break;
      }
      if (!Number.isFinite(v)) holes++;
      out[j * w + i] = v;
    }
  }
  return { heights: out, holes };
}

/** Fills NaN cells from their valid neighbours (iterative dilation), so the grid is complete */
export function fillHoles(heights, w, h) {
  let remaining = 0;
  for (let k = 0; k < heights.length; k++) if (!Number.isFinite(heights[k])) remaining++;
  if (!remaining) return 0;
  const filled = remaining;
  let guard = 0;
  while (remaining && guard++ < 4096) {
    const next = Float32Array.from(heights);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        if (Number.isFinite(heights[k])) continue;
        let s = 0, n = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue;
          const v = heights[jj * w + ii];
          if (Number.isFinite(v)) { s += v; n++; }
        }
        if (n) { next[k] = s / n; remaining--; }
      }
    }
    heights.set(next);
  }
  if (remaining) heights.forEach((v, k) => { if (!Number.isFinite(v)) heights[k] = 0; });
  return filled;
}

/** Separable gaussian blur of sigma `sigmaCells` (in cells) */
export function gaussianBlur(heights, w, h, sigmaCells) {
  if (!(sigmaCells > 0.05)) return heights;
  const r = Math.ceil(sigmaCells * 3);
  const k = new Float32Array(2 * r + 1);
  let ks = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigmaCells * sigmaCells)); ks += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= ks;
  const tmp = new Float32Array(heights.length);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let s = 0;
      for (let t = -r; t <= r; t++) s += heights[j * w + Math.min(w - 1, Math.max(0, i + t))] * k[t + r];
      tmp[j * w + i] = s;
    }
  }
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let s = 0;
      for (let t = -r; t <= r; t++) s += tmp[Math.min(h - 1, Math.max(0, j + t)) * w + i] * k[t + r];
      heights[j * w + i] = s;
    }
  }
  return heights;
}

/** Bilinear read of the grid at world (x, z) */
export function gridSample(grid, heights, x, z) {
  const fx = Math.min(grid.w - 1.001, Math.max(0, (x - grid.x0) / grid.cell));
  const fz = Math.min(grid.h - 1.001, Math.max(0, (z - grid.z0) / grid.cell));
  const i = Math.floor(fx), j = Math.floor(fz);
  const u = fx - i, v = fz - j;
  const a = heights[j * grid.w + i], b = heights[j * grid.w + i + 1], d = heights[(j + 1) * grid.w + i], e = heights[(j + 1) * grid.w + i + 1];
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + d * (1 - u) * v + e * u * v;
}

/**
 * Keeps the ground at least `gap` m under every bridge deck (away from its first & last `end` m, where it meets the
 * road), so the deck never coincides with the relief and flickers; the ground under a viaduct is the valley anyway
 */
// `end`: no cell within this many metres of a deck's end is lowered: the 10 m cells touching the abutment feed the
// bilinear sample the street (and the deck end, bridgeDecks) read there; at 4 m the cell 5-10 m along the deck was
// lowered and the abutment sampled 1.1 m under the street (the Pont del Passeig)
export function clearUnderBridges(grid, heights, roads, nodeH, { gap = 0.6, end = 12 } = {}) {
  const { x0, z0, cell, w, h } = grid;
  const mask = grid.roadMask;
  const abut = grid.abutmentMask;
  let lowered = 0;
  for (const road of roads) {
    if (!road.bridge || !Number.isFinite(nodeH[road.a]) || !Number.isFinite(nodeH[road.b])) continue;
    const s = arcLength(road.pts);
    const L = s[s.length - 1];
    if (L <= end * 2) continue;
    const half = road.width * 0.5 + 2.4 + 0.5;
    for (let k = 1; k < road.pts.length; k++) {
      const [ax, az] = road.pts[k - 1], [bx, bz] = road.pts[k];
      const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-9;
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - half - x0) / cell)), i1 = Math.min(w - 1, Math.ceil((Math.max(ax, bx) + half - x0) / cell));
      const j0 = Math.max(0, Math.floor((Math.min(az, bz) - half - z0) / cell)), j1 = Math.min(h - 1, Math.ceil((Math.max(az, bz) + half - z0) / cell));
      for (let j = j0; j <= j1; j++) {
        const z = z0 + j * cell;
        for (let i = i0; i <= i1; i++) {
          const x = x0 + i * cell;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
          const dist = Math.hypot(x - ax - t * dx, z - az - t * dz);
          if (dist > half) continue;
          const d = s[k - 1] + Math.sqrt(l2) * t;
          if (d < end || d > L - end) continue;
          const deck = nodeH[road.a] + (nodeH[road.b] - nodeH[road.a]) * (d / L);
          const q = j * w + i;
          if (mask && mask[q]) continue; // a street under the deck keeps its profile: the deck was raised for it
          if (abut && abut[q]) continue; // an abutment cell (its own or a parallel deck's: the Carretera de Terrassa pair)
          if (heights[q] > deck - gap) { heights[q] = deck - gap; lowered++; }
        }
      }
    }
  }
  return lowered;
}

/**
 * Where a street passes under a deck with less than `clearance` m to spare, the deck is lifted: both abutment
 * junctions rise by what is missing (the connecting streets then climb to them as ramps, limited by their grade),
 * never the other way round (a street is never dug under a bridge). Needs grid.roadMask (after a carve pass).
 */
export function raiseBridgeAbutments(grid, heights, roads, nodeH, { clearance = 4.6, end = 6, minDrop = 1.5, maxLift = 5 } = {}) {
  const { x0, z0, cell, w, h } = grid;
  const mask = grid.carriagewayMask;
  if (!mask) return 0;
  let raised = 0;
  for (const road of roads) {
    if (!road.bridge || !Number.isFinite(nodeH[road.a]) || !Number.isFinite(nodeH[road.b])) continue;
    const s = arcLength(road.pts);
    const L = s[s.length - 1];
    if (L <= end * 2) continue;
    const half = road.width * 0.5 + 2.4;
    let need = 0;
    for (let k = 1; k < road.pts.length; k++) {
      const [ax, az] = road.pts[k - 1], [bx, bz] = road.pts[k];
      const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-9;
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - half - x0) / cell)), i1 = Math.min(w - 1, Math.ceil((Math.max(ax, bx) + half - x0) / cell));
      const j0 = Math.max(0, Math.floor((Math.min(az, bz) - half - z0) / cell)), j1 = Math.min(h - 1, Math.ceil((Math.max(az, bz) + half - z0) / cell));
      for (let j = j0; j <= j1; j++) {
        const z = z0 + j * cell;
        for (let i = i0; i <= i1; i++) {
          const x = x0 + i * cell;
          const q = j * w + i;
          if (!mask[q]) continue;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
          if (Math.hypot(x - ax - t * dx, z - az - t * dz) > half) continue;
          const d = s[k - 1] + Math.sqrt(l2) * t;
          if (d < end || d > L - end) continue; // the abutments: the deck meets its own street there
          const deck = nodeH[road.a] + (nodeH[road.b] - nodeH[road.a]) * (d / L);
          // only a genuine underpass (the carriageway already well below the deck); a street at deck level next to
          // the abutment is the bridge's own approach or a crossing at grade
          if (deck - heights[q] < minDrop) continue;
          need = Math.max(need, heights[q] + clearance - deck);
        }
      }
    }
    if (need > 0.3) { const lift = Math.min(maxLift, need); nodeH[road.a] += lift; nodeH[road.b] += lift; raised++; }
  }
  return raised;
}

/**
 * The abutments stamped at their junction height: within `plateau` m of a bridge node that carries streets the ground
 * IS nodeH (blending back over `blend` m). The junction blending of carveRoads averages the profiles of every street
 * meeting there by closeness, so a ramp leaving the junction downhill (the car-park exit beside the Pont del Passeig,
 * 2.8 m lower 4 m away) pulled the abutment 1.1 m under the deck's street and left a dip at the bridge's end. A deck
 * end reads this ground (bridgeDecks), so deck and street meet at the junction height
 */
export function stampAbutments(grid, heights, roads, nodeH, { back = 8, ahead = 12, margin = 3, blend = 10 } = {}) {
  const { x0, z0, cell, w, h } = grid;
  const streetNode = new Set();
  const ends = []; // { node, x, z, ux, uz (into the deck), half }
  for (const r of roads) {
    if (!r.bridge) { streetNode.add(r.a); streetNode.add(r.b); continue; }
    const n = r.pts.length;
    const dir = (p, q) => { const L = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1; return [(q[0] - p[0]) / L, (q[1] - p[1]) / L]; };
    const half = (r.width > 3 ? r.width : 6) * 0.5 + 2.4;
    const [ux0, uz0] = dir(r.pts[0], r.pts[1]);
    const [ux1, uz1] = dir(r.pts[n - 1], r.pts[n - 2]);
    ends.push({ node: r.a, x: r.pts[0][0], z: r.pts[0][1], ux: ux0, uz: uz0, half });
    ends.push({ node: r.b, x: r.pts[n - 1][0], z: r.pts[n - 1][1], ux: ux1, uz: uz1, half });
  }
  // carriageways near an abutment that do not meet it (a street passing under the deck, a car-park ramp beside it)
  // keep their own profile: cells within their band are never stamped (the first version lifted the Avinguda de
  // Joaquim de Sagrera 8 m where it passes 13 m from an N-150 abutment)
  const carriageways = roads.filter((r) => !r.bridge && r.cls !== 3 && r.cls !== 4);
  const distToRoad = (r, x, z) => {
    let best = Infinity;
    for (let k = 1; k < r.pts.length; k++) {
      const [ax, az] = r.pts[k - 1], [bx, bz] = r.pts[k];
      const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
      best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
    }
    return best;
  };
  const abutMask = grid.abutmentMask || (grid.abutmentMask = new Uint8Array(w * h));
  let stamped = 0;
  for (const e of ends) {
    if (!streetNode.has(e.node) || !Number.isFinite(nodeH[e.node])) continue;
    const y = nodeH[e.node];
    // the deck ends within 12 m of this one (the other carriageway of a dual carriageway, a ramp joining) were brought
    // to this height by nodeHeights: their streets are the same roadway, not "other" carriageways to keep out of (the
    // Carretera de Terrassa pair: each stamp spared the other's approach and left a 1.2 m step between the two decks)
    const group = new Set(ends.filter((o) => Math.hypot(o.x - e.x, o.z - e.z) < 12).map((o) => o.node));
    const others = carriageways.filter((r) => !group.has(r.a) && !group.has(r.b) && distToRoad(r, e.x, e.z) < 60);
    const keepOut = (x, z) => others.some((r) => distToRoad(r, x, z) < r.width * 0.5 + 2 + cell * 0.5);
    // a rectangle in the deck's frame: along from -back (into the street) to +ahead (under the deck: more than a cell,
    // or the node's bilinear sample reads the cleared cells beyond it), across the deck's full width plus the margin,
    // blending back into the model over `blend` m beyond it. The old circle of 10 m left the ground falling away
    // beside the corners of a 19 m deck (the Pont del Passeig: "pequeños huecos")
    const halfW = e.half + margin;
    const reach = Math.max(back, ahead, halfW) + blend;
    const i0 = Math.max(0, Math.floor((e.x - reach - x0) / cell)), i1 = Math.min(w - 1, Math.ceil((e.x + reach - x0) / cell));
    const j0 = Math.max(0, Math.floor((e.z - reach - z0) / cell)), j1 = Math.min(h - 1, Math.ceil((e.z + reach - z0) / cell));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const dx = x0 + i * cell - e.x, dz = z0 + j * cell - e.z;
        const along = dx * e.ux + dz * e.uz, across = Math.abs(-dx * e.uz + dz * e.ux);
        // distance outside the rectangle
        const dAlong = along < -back ? -back - along : along > ahead ? along - ahead : 0;
        const dAcross = Math.max(0, across - halfW);
        const d = Math.hypot(dAlong, dAcross);
        if (d >= blend) continue;
        // the junction itself (from `back` m into the street to 2 m under the deck, the deck's width) is always
        // stamped: the deck end reads the cells round the node (bridgeDecks). Further under the deck, in the margin and
        // in the blend, other carriageways keep their profile (an underpass: the Avinguda de Joaquim de Sagrera passes
        // 13 m from an N-150 abutment and was hoisted 8-10 m when the whole footprint was forced)
        const core = along >= -back && along <= 2 && across <= e.half;
        if (!core && keepOut(x0 + i * cell, z0 + j * cell)) continue;
        const wgt = d <= 0 ? 1 : 1 - smooth01(d / blend);
        const q = j * w + i;
        heights[q] += (y - heights[q]) * wgt;
        if (wgt >= 1) abutMask[q] = 1; // clearUnderBridges leaves these alone (a parallel deck's clearing reached them)
        stamped++;
      }
    }
  }
  return stamped;
}

/**
 * The bridge decks: [{ link, y0, y1 }] (link index into GEO.roadGraph.links, deck heights at its ends, m a.s.l.). At an
 * abutment (a node that also carries streets) the deck end is read from the FINISHED grid at the node, so it meets
 * the street exactly as it was finally carved, whatever the passes in between did to it; mid-viaduct nodes keep the
 * junction height
 */
export function bridgeDecks(roads, nodeH, grid = null, heights = null) {
  const out = [];
  const streetNode = new Set();
  for (const r of roads) if (!r.bridge) { streetNode.add(r.a); streetNode.add(r.b); }
  const endY = (r, node, pt) => (grid && heights && streetNode.has(node) ? gridSample(grid, heights, pt[0], pt[1]) : nodeH[node]);
  roads.forEach((r, i) => {
    if (!r.bridge || !Number.isFinite(nodeH[r.a]) || !Number.isFinite(nodeH[r.b])) return;
    out.push({ link: i, y0: endY(r, r.a, r.pts[0]), y1: endY(r, r.b, r.pts[r.pts.length - 1]) });
  });
  return out;
}

/** Serialises the grid (metres above the reference) to the .bin layout, the bridge table ('BRDG', count, link u32 + y0 f32 + y1 f32 each, relative to ref) after it */
export function encodeTerrain(grid, heights, { ref, synthetic = false, smooth = 0, bridges = [] }) {
  const { w, h, cell, x0, z0 } = grid;
  const buf = Buffer.alloc(HEADER_BYTES + w * h * 2 + 8 + bridges.length * 12);
  let min = Infinity, max = -Infinity;
  for (let k = 0; k < heights.length; k++) {
    const v = heights[k];
    if (v < min) min = v;
    if (v > max) max = v;
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 100))), HEADER_BYTES + k * 2);
  }
  buf.write(MAGIC, 0, 'latin1');
  buf.writeUInt32LE(w, 4);
  buf.writeUInt32LE(h, 8);
  buf.writeFloatLE(cell, 12);
  buf.writeFloatLE(x0, 16);
  buf.writeFloatLE(z0, 20);
  buf.writeFloatLE(ref, 24);
  buf.writeFloatLE(min, 28);
  buf.writeFloatLE(max, 32);
  buf.writeUInt32LE(synthetic ? 1 : 0, 36);
  buf.writeFloatLE(smooth, 40);
  let o = HEADER_BYTES + w * h * 2;
  buf.write('BRDG', o, 'latin1'); o += 4;
  buf.writeUInt32LE(bridges.length, o); o += 4;
  for (const b of bridges) { buf.writeUInt32LE(b.link, o); buf.writeFloatLE(b.y0 - ref, o + 4); buf.writeFloatLE(b.y1 - ref, o + 8); o += 12; }
  return buf;
}

// ---- the synthetic stand-in (development only) -----------------------------------------------------------------------
// A plane rising to the north-west like the real Vallès piedmont (~2.8 % northwards, ~0.5 % westwards), the torrents
// (GEO.water) cut 5 m deep and the Parc de Vallparadís blocks 9 m deep, plus a gentle roll. Flagged in the header and
// reported by the runtime: it is NOT Terrassa's relief.
export function syntheticHeights(grid, GEO) {
  const { x0, z0, cell, w, h } = grid;
  const out = new Float32Array(w * h);
  const cut = new Float32Array(w * h); // metres cut away by torrents & the park
  const toPts = (flat) => { const p = []; for (let i = 0; i < flat.length; i += 2) p.push([flat[i], flat[i + 1]]); return p; };
  const smooth01 = (t) => { const c = Math.max(0, Math.min(1, t)); return c * c * (3 - 2 * c); };
  const cellsOf = (minX, maxX, minZ, maxZ) => ({
    i0: Math.max(0, Math.floor((minX - x0) / cell)), i1: Math.min(w - 1, Math.ceil((maxX - x0) / cell)),
    j0: Math.max(0, Math.floor((minZ - z0) / cell)), j1: Math.min(h - 1, Math.ceil((maxZ - z0) / cell))
  });
  // torrents: a smooth trench around every segment (only the cells within reach of the segment are visited)
  for (const wtr of GEO.water || []) {
    const pts = toPts(wtr.pts);
    const half = Math.max(14, (wtr.w || 10) * 1.6);
    const reach = half * 2;
    for (let s = 1; s < pts.length; s++) {
      const [ax, az] = pts[s - 1], [bx, bz] = pts[s];
      const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-9;
      const { i0, i1, j0, j1 } = cellsOf(Math.min(ax, bx) - reach, Math.max(ax, bx) + reach, Math.min(az, bz) - reach, Math.max(az, bz) + reach);
      for (let j = j0; j <= j1; j++) {
        const z = z0 + j * cell;
        for (let i = i0; i <= i1; i++) {
          const x = x0 + i * cell;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
          const d = Math.hypot(x - ax - t * dx, z - az - t * dz);
          if (d >= reach) continue;
          const c = 5 * (1 - smooth01((d - half * 0.4) / (half * 1.6)));
          const k = j * w + i;
          if (c > cut[k]) cut[k] = c;
        }
      }
    }
  }
  // the Parc de Vallparadís blocks: 9 m down
  for (const b of GEO.blocks || []) {
    if (b[3] !== 'Parc de Vallparadís' || !(b[2] > 0.5)) continue;
    const poly = toPts(b[0]);
    const xs = poly.map((p) => p[0]), zs = poly.map((p) => p[1]);
    const { i0, i1, j0, j1 } = cellsOf(Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs));
    for (let j = j0; j <= j1; j++) {
      const z = z0 + j * cell;
      for (let i = i0; i <= i1; i++) {
        const x = x0 + i * cell;
        let inside = false;
        for (let a = 0, c = poly.length - 1; a < poly.length; c = a++) {
          const [xi, zi] = poly[a], [xj, zj] = poly[c];
          if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
        }
        if (inside) cut[j * w + i] = Math.max(cut[j * w + i], 9);
      }
    }
  }
  for (let j = 0; j < h; j++) {
    const z = z0 + j * cell;
    for (let i = 0; i < w; i++) {
      const x = x0 + i * cell;
      const k = j * w + i;
      out[k] = 286 - 0.028 * z - 0.005 * x + 2.5 * Math.sin(x / 530) * Math.cos(z / 710) - cut[k];
    }
  }
  return out;
}

// ---- conditioning: the relief a city is actually built on ------------------------------------------------------------
// A bare-earth elevation model is not the ground the streets run on: it dips into every culvert, keeps the valley under
// a bridge, carries interpolation noise where the buildings were removed. The runtime has one height per (x, z), so the
// streets are written into the grid as they are driven (bridges & viaducts as embankments, for now: NEXT_STEPS.md
// §1.1 step 4 keeps real bridge decks for later), the carriageways are smoothed along their length, and every built
// block becomes a plane fitted to the kerb line round it (its slab is flat, its buildings stand on it).
const BUILDABLE = new Set([0, 6, 9, 11, 13]); // city-config.js BUILDABLE_CLASSES: none, industrial, parking, campus, grass
const smooth01 = (t) => { const c = Math.max(0, Math.min(1, t)); return c * c * (3 - 2 * c); };

/** Streets as polylines with their kerb-to-kerb width, class, bridge flag and end nodes, from GEO.roadGraph */
export function roadPolylines(GEO) {
  const g = GEO.roadGraph;
  if (!g) return [];
  const nodes = g.nodes;
  const out = [];
  for (const l of g.links) {
    const [a, b, , width, , , inner, cls, bridge] = l;
    const pts = [[nodes[a * 2], nodes[a * 2 + 1]]];
    for (let i = 0; i < inner.length; i += 2) pts.push([inner[i], inner[i + 1]]);
    pts.push([nodes[b * 2], nodes[b * 2 + 1]]);
    out.push({ pts, width: width || 6, bridge: !!bridge, cls, a, b });
  }
  return out;
}

// Class 3 is pedestrian / living street (steps & park paths among them): steeper than a carriageway can be
const MAX_GRADE = (cls) => (cls === 3 ? 0.45 : 0.18);

/** Arc length & interpolation helpers for a polyline */
function arcLength(pts) {
  const s = [0];
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return s;
}
function pointAt(pts, s, d) {
  let i = 1;
  while (i < s.length - 1 && s[i] < d) i++;
  const t = s[i] - s[i - 1] > 1e-9 ? (d - s[i - 1]) / (s[i] - s[i - 1]) : 0;
  return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
}

/**
 * One robust height per junction: the median, over the carriageways that meet there, of each one's median height
 * along its first 10 m (paths & service lanes only when no carriageway arrives; bridge links as a last resort, so
 * an abutment reads the bank, not the channel the model keeps under the deck). An abutment where carriageways arrive
 * is a junction like any other (the deck starts where the street ends); one reached only by paths takes the highest
 * ground along them.
 */
export function nodeHeights(grid, heights, roads, nodeCount) {
  // per junction: the median of each arriving street over its first 10 m, by kind
  const streets = Array.from({ length: nodeCount }, () => []); // carriageways
  const minor = Array.from({ length: nodeCount }, () => []); // paths, steps & service lanes: only if nothing else arrives
  const viaBridge = Array.from({ length: nodeCount }, () => []); // bridge links: last resort
  const streetTop = Array.from({ length: nodeCount }, () => []); // highest ground on each street's first 30 m
  const streetNear = Array.from({ length: nodeCount }, () => []); // the ground 7.5-10 m along each carriageway
  const minorTop = Array.from({ length: nodeCount }, () => []);
  const isBridgeNode = new Uint8Array(nodeCount);
  const median = (arr) => { const a = arr.slice().sort((p, q) => p - q); return a.length ? a[a.length >> 1] : NaN; };
  for (const road of roads) {
    const s = arcLength(road.pts);
    const L = s[s.length - 1];
    for (const [node, from] of [[road.a, 0], [road.b, L]]) {
      const ys = [], far = [], fit = [];
      for (let d = 0; d <= Math.min(40, L); d += 2.5) {
        const [x, z] = pointAt(road.pts, s, from === 0 ? d : L - d);
        const y = gridSample(grid, heights, x, z);
        if (d <= 10) ys.push(y);
        if (d <= 30) far.push(y);
        if (d >= 10) fit.push([d, y]);
      }
      // the street's own line through 10-40 m, evaluated at the junction: what the street would be if it carried
      // on through; the first metres of the model at a junction are its noisiest (raised crossings, the pits and
      // bumps left where the buildings were cut out). Short streets fall back to their first-10 m median
      let m = median(ys);
      if (fit.length >= 4) {
        let sd = 0, sy = 0, sdd = 0, sdy = 0;
        for (const [d, y] of fit) { sd += d; sy += y; sdd += d * d; sdy += d * y; }
        const n = fit.length, den = n * sdd - sd * sd;
        if (Math.abs(den) > 1e-9) { const slope = (n * sdy - sd * sy) / den; const icpt = (sy - slope * sd) / n; if (Math.abs(slope) < 0.2) m = icpt; }
      }
      if (road.bridge) { viaBridge[node].push(m); isBridgeNode[node] = 1; }
      else if (road.cls === 3 || road.cls === 4) minor[node].push(m);
      else { streets[node].push(m); streetNear[node].push(Math.max(far[3] ?? m, far[4] ?? m)); }
      // for an abutment: the highest ground along the street's first 30 m (OSM often ends a bridge link a few
      // metres down the bank; the deck is level with the street beyond it)
      (road.cls === 3 || road.cls === 4 ? minorTop : streetTop)[node].push(Math.max(...far));
    }
  }
  // the streets beyond an abutment, walked along the graph up to `REACH` m (a square's ring road is split into
  // links a few metres long: the first link alone says nothing about where the square is)
  const REACH = 45;
  const incident = Array.from({ length: nodeCount }, () => []);
  roads.forEach((road, i) => { if (!road.bridge) { incident[road.a].push(i); incident[road.b].push(i); } });
  const topBeyond = (n0) => {
    let top = -Infinity;
    const seen = new Set([n0]);
    const queue = [[n0, 0]];
    while (queue.length) {
      const [n, d0] = queue.shift();
      for (const i of incident[n]) {
        const road = roads[i];
        if (road.cls === 3 || road.cls === 4) continue;
        const forward = road.a === n;
        const other = forward ? road.b : road.a;
        const s = arcLength(road.pts);
        const L = s[s.length - 1];
        for (let d = 0; d <= Math.min(L, REACH - d0); d += 2.5) {
          const [x, z] = pointAt(road.pts, s, forward ? d : L - d);
          top = Math.max(top, gridSample(grid, heights, x, z));
        }
        if (d0 + L < REACH && !seen.has(other)) { seen.add(other); queue.push([other, d0 + L]); }
      }
    }
    return top;
  };
  const out = new Float32Array(nodeCount);
  const solid = new Uint8Array(nodeCount);
  for (let n = 0; n < nodeCount; n++) {
    const list = streets[n].length ? streets[n] : minor[n];
    // An abutment (a bridge node where streets arrive) takes the streets' own height at the junction, like any
    // other junction: the deck then starts exactly where the street ends. The earlier rule ("the highest ground on
    // the streets within REACH m, so the ramp down into the valley does not pull the deck down") overshot the street
    // by up to 2 m at 100 of the 254 abutments (the Pont del Passeig by 1.4 m: the Plaça del Doctor Robert is higher
    // than the Passeig), leaving decks hanging in the air and a hump carved into the street to meet them
    // (HOW_TO_IMPROVE.md §3 sesión 4). The streets' fitted lines through their 10-40 m already ignore the bank an OSM
    // bridge link sometimes ends on; where no carriageway arrives (a path up the bank), the highest ground along the
    // paths still wins, as before
    let v = list.length ? median(list) : NaN;
    if (isBridgeNode[n] && !streets[n].length) {
      const top = topBeyond(n);
      if (Number.isFinite(top)) v = top; else if (minorTop[n].length) v = Math.max(...minorTop[n]);
    }
    out[n] = v;
    solid[n] = Number.isFinite(out[n]) ? 1 : 0;
  }
  // Abutments with streets, second pass: OSM often ends a bridge link a few metres down the bank, on a 4 m stub of a
  // square's ring road, so the street line there reads the bank (the Pont del Passeig: 285.7 m at the node, the
  // Plaça del Doctor Robert at 290.2 m thirty metres on, the far end of the deck at 290.3 m). The abutment is lifted
  // to the highest ground on the streets within REACH m, but never above the deck's far end (a square well above the
  // bridge's street must not hoist the deck): the deck comes out level and the stub climbs to it
  const farEnd = Array.from({ length: nodeCount }, () => -Infinity);
  for (const road of roads) {
    if (!road.bridge) continue;
    if (solid[road.b]) farEnd[road.a] = Math.max(farEnd[road.a], out[road.b]);
    if (solid[road.a]) farEnd[road.b] = Math.max(farEnd[road.b], out[road.a]);
  }
  for (let n = 0; n < nodeCount; n++) {
    if (!isBridgeNode[n] || !streets[n].length || !solid[n]) continue;
    let v = Math.max(out[n], ...streetNear[n]);
    const top = topBeyond(n);
    if (Number.isFinite(top) && top > v) {
      const lift = Number.isFinite(farEnd[n]) ? Math.min(top, Math.max(v, farEnd[n])) : (top - v <= 3.5 ? top : v);
      v = Math.max(v, lift);
    }
    out[n] = v;
  }
  // junctions in the middle of a bridge (bridge links only) take the mean of their neighbours along the bridge, so a
  // long bridge split into several links stays a straight deck instead of dipping to the channel at each joint
  const adj = Array.from({ length: nodeCount }, () => []);
  for (const road of roads) if (road.bridge) { adj[road.a].push(road.b); adj[road.b].push(road.a); }
  for (let pass = 0; pass < 8; pass++) {
    let changed = 0;
    for (let n = 0; n < nodeCount; n++) {
      if (solid[n]) continue;
      const near = adj[n].filter((m) => solid[m]);
      if (!near.length) continue;
      out[n] = near.reduce((t, m) => t + out[m], 0) / near.length;
      solid[n] = 2; // settled from neighbours
      changed++;
    }
    if (!changed) break;
  }
  for (let n = 0; n < nodeCount; n++) if (!solid[n]) out[n] = median(viaBridge[n]);
  const joined = joinDeckEnds(roads, out, nodeCount);
  if (joined) log(`${joined} pairs of neighbouring deck ends brought to one height`);
  return out;
}

/**
 * Deck continuity: OSM splits a viaduct into links that meet at distinct nodes a few metres apart (a ramp joins, a
 * tag changes, the two carriageways of a dual carriageway end at their own nodes); the ends then came out at different
 * heights (the N-150 over the Rambleta del Pare Alegre: 1.8 m between two decks 6 m apart; the Carretera de Terrassa:
 * 0.9 m between the two carriageways after one was lifted for its underpass), a wall the car stopped against. Deck end
 * nodes within 12 m of each other with less than 3.5 m between them are brought to one height: by default the
 * street-anchored one's if only one carries streets, else the mean; `mode: 'max'` takes the higher (after
 * raiseBridgeAbutments, so the clearance it won is kept). Returns the number of pairs joined
 */
export function joinDeckEnds(roads, out, nodeCount, { mode = 'mean' } = {}) {
  const bridgeEnds = [];
  const hasStreet = new Uint8Array(nodeCount);
  for (const road of roads) {
    if (road.bridge) { bridgeEnds.push([road.a, road.pts[0]]); bridgeEnds.push([road.b, road.pts[road.pts.length - 1]]); }
    else { hasStreet[road.a] = 1; hasStreet[road.b] = 1; }
  }
  let joined = 0;
  for (let i = 0; i < bridgeEnds.length; i++) {
    for (let j = i + 1; j < bridgeEnds.length; j++) {
      const [n1, p1] = bridgeEnds[i], [n2, p2] = bridgeEnds[j];
      if (n1 === n2 || !Number.isFinite(out[n1]) || !Number.isFinite(out[n2])) continue;
      if (Math.hypot(p1[0] - p2[0], p1[1] - p2[1]) > 12 || Math.abs(out[n1] - out[n2]) > 3.5 || out[n1] === out[n2]) continue;
      const y = mode === 'max' ? Math.max(out[n1], out[n2])
        : hasStreet[n1] && !hasStreet[n2] ? out[n1] : hasStreet[n2] && !hasStreet[n1] ? out[n2] : (out[n1] + out[n2]) / 2;
      out[n1] = y; out[n2] = y; joined++;
    }
  }
  return joined;
}

/**
 * Longitudinal profile of a street between its two junction heights: the model sampled every `step` m, smoothed
 * (moving average over `smoothM` m), corrected linearly so both ends meet their junctions, and limited to the grade
 * a street of its class can have (a two-way envelope that cuts the cliffs the model keeps where the street crosses a
 * channel, a wall or a terrace). A bridge is a straight ramp between its junctions.
 */
function roadProfile(grid, heights, road, step, smoothM, nodeH) {
  const s = arcLength(road.pts);
  const L = s[s.length - 1];
  const n = Math.max(2, Math.ceil(L / step) + 1);
  const samples = [];
  for (let k = 0; k < n; k++) {
    const d = (L * k) / (n - 1);
    const [x, z] = pointAt(road.pts, s, d);
    samples.push({ d, x, z, y: gridSample(grid, heights, x, z) });
  }
  const y0 = nodeH && Number.isFinite(nodeH[road.a]) ? nodeH[road.a] : samples[0].y;
  const y1 = nodeH && Number.isFinite(nodeH[road.b]) ? nodeH[road.b] : samples[n - 1].y;
  if (road.bridge) {
    for (const p of samples) p.y = y0 + (y1 - y0) * (L > 0 ? p.d / L : 0);
    return { samples, L };
  }
  // moving average over smoothM metres
  const r = Math.max(0, Math.round(smoothM / step / 2));
  const ys = samples.map((p) => p.y);
  for (let k = 0; k < n; k++) {
    let sum = 0, cnt = 0;
    for (let j = Math.max(0, k - r); j <= Math.min(n - 1, k + r); j++) { sum += ys[j]; cnt++; }
    samples[k].y = sum / cnt;
  }
  // ends onto the junctions, the correction fading linearly along the street
  const c0 = y0 - samples[0].y, c1 = y1 - samples[n - 1].y;
  for (const p of samples) p.y += c0 + (c1 - c0) * (L > 0 ? p.d / L : 0);
  // short crests & dips: a sample more than 0.3 m off the chord between its neighbours 15 m away on either side is
  // not a hill (a street's vertical curves are far longer): it is the model's noise, and it is laid on the chord
  for (let pass = 0; pass < 3; pass++) {
    const m = Math.max(1, Math.round(15 / step));
    let changed = 0;
    for (let k = m; k < n - m; k++) {
      const chord = (samples[k - m].y + samples[k + m].y) * 0.5;
      if (Math.abs(samples[k].y - chord) > 0.3) { samples[k].y = chord; changed++; }
    }
    if (!changed) break;
  }
  // grade limiter: no sample may rise above / fall below what its neighbours allow (the ends stay where they are)
  const g = MAX_GRADE(road.cls);
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 1; k < n; k++) { const lim = samples[k - 1].y + g * (samples[k].d - samples[k - 1].d); if (samples[k].y > lim && k < n - 1) samples[k].y = lim; }
    for (let k = n - 2; k >= 0; k--) { const lim = samples[k + 1].y + g * (samples[k + 1].d - samples[k].d); if (samples[k].y > lim && k > 0) samples[k].y = lim; }
    for (let k = 1; k < n; k++) { const lim = samples[k - 1].y - g * (samples[k].d - samples[k - 1].d); if (samples[k].y < lim && k < n - 1) samples[k].y = lim; }
    for (let k = n - 2; k >= 0; k--) { const lim = samples[k + 1].y - g * (samples[k + 1].d - samples[k].d); if (samples[k].y < lim && k > 0) samples[k].y = lim; }
  }
  return { samples, L };
}

/**
 * Writes the streets into the grid: within half their width (+ `apron` m) of the centreline the ground is the road's
 * profile; over the next `blend` m it fades back into the model. Bridges carve their ramp through whatever lies below.
 */
export function carveRoads(grid, heights, roads, { step = 5, smoothM = 40, apron = 2, blend = 8, nodeH = null, embank = false } = {}) {
  // (A wider apron for carriageways was tried against the ridges under narrow streets: it made neighbouring terraced
  // streets fight over cells, 1185 → 1985 short crests. The lattice cell, not the apron, is the limit.)
  const apronOf = () => apron;
  const { x0, z0, cell, w, h } = grid;
  const target = new Float32Array(w * h).fill(NaN);
  const weight = new Float32Array(w * h);
  const sumY = new Float32Array(w * h), sumW = new Float32Array(w * h); // the streets that fully own a cell, blended
  // bridges are decks over the relief, not part of it (js/terrain.js draws & drives them from the table written
  // after the grid); `embank: true` writes them into the ground as ramps instead
  const ordered = embank ? [...roads.filter((r) => !r.bridge), ...roads.filter((r) => r.bridge)] : roads.filter((r) => !r.bridge);
  for (const road of ordered) {
    const { samples } = roadProfile(grid, heights, road, step, smoothM, nodeH);
    const half = road.width * 0.5 + apronOf(road);
    const reach = half + blend;
    for (let k = 1; k < samples.length; k++) {
      const a = samples[k - 1], b = samples[k];
      const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz || 1e-9;
      const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - reach - x0) / cell)), i1 = Math.min(w - 1, Math.ceil((Math.max(a.x, b.x) + reach - x0) / cell));
      const j0 = Math.max(0, Math.floor((Math.min(a.z, b.z) - reach - z0) / cell)), j1 = Math.min(h - 1, Math.ceil((Math.max(a.z, b.z) + reach - z0) / cell));
      for (let j = j0; j <= j1; j++) {
        const z = z0 + j * cell;
        for (let i = i0; i <= i1; i++) {
          const x = x0 + i * cell;
          const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2));
          const d = Math.hypot(x - a.x - t * dx, z - a.z - t * dz);
          if (d >= reach) continue;
          const y = a.y + (b.y - a.y) * t;
          // a cell any part of which lies on the carriageway or its apron is wholly the street's (the model's noise
          // in a half-weighted cell next to the centreline showed on the street as crests); beyond, a blend
          const dEff = Math.max(0, d - cell * 0.5);
          const wgt = dEff <= half ? 1 : 1 - smooth01((dEff - half) / blend);
          const q = j * w + i;
          if (wgt >= 1) {
            // a cell on the carriageway of two streets (a junction) blends them by closeness to each centreline, so
            // their profiles meet without a step; a bridge (embank mode) simply takes the cell
            if (road.bridge) { weight[q] = 1; target[q] = y; sumW[q] = 0; continue; }
            const wd = 1 / (d + 2);
            sumY[q] += y * wd; sumW[q] += wd;
            weight[q] = 1; target[q] = sumY[q] / sumW[q];
          } else if (wgt > weight[q]) { weight[q] = wgt; target[q] = y; }
        }
      }
    }
  }
  let carved = 0;
  const mask = grid.roadMask || (grid.roadMask = new Uint8Array(w * h));
  for (let q = 0; q < heights.length; q++) {
    if (!(weight[q] > 0) || !Number.isFinite(target[q])) continue;
    heights[q] = heights[q] + (target[q] - heights[q]) * weight[q];
    if (weight[q] >= 0.5) mask[q] = 1; // the carriageway, its apron & the near half of the blend: no later pass may touch it (the 10 m cells here shape the street's own height)
    carved++;
  }
  // which of those cells carry a carriageway (not a path or a service lane): the underpass check reads it
  const carMask = grid.carriagewayMask || (grid.carriagewayMask = new Uint8Array(w * h));
  for (const road of roads) {
    if (road.bridge || road.cls === 3 || road.cls === 4) continue;
    const half = road.width * 0.5 + apron;
    for (let k = 1; k < road.pts.length; k++) {
      const [ax, az] = road.pts[k - 1], [bx, bz] = road.pts[k];
      const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-9;
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - half - x0) / cell)), i1 = Math.min(w - 1, Math.ceil((Math.max(ax, bx) + half - x0) / cell));
      const j0 = Math.max(0, Math.floor((Math.min(az, bz) - half - z0) / cell)), j1 = Math.min(h - 1, Math.ceil((Math.max(az, bz) + half - z0) / cell));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const x = x0 + i * cell, z = z0 + j * cell;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
        if (Math.hypot(x - ax - t * dx, z - az - t * dz) <= half) carMask[j * w + i] = 1;
      }
    }
  }
  return carved;
}

/**
 * A platform under every building of the big blocks that keep the model (hillsides, estates): the inner part of each
 * footprint (GEO.blocks[].buildings rectangles, in the building's own frame) is levelled to the lowest pavement at
 * its street fronts (never above a door's own street), or to the median under it when no street is at hand, blended
 * over `blend` m outside it and never into the street zone. A nave cut into a hillside then stands on its terrace
 * instead of being buried at the back. Urban blocks are membranes already (membraneBlocks) and are left alone.
 */
export function flattenBuildings(grid, heights, GEO, { blend = 3, maxExtent = 260 } = {}) {
  const { x0, z0, cell, w, h } = grid;
  const mask = grid.roadMask;
  let platforms = 0, cells = 0;
  const src = Float32Array.from(heights); // sample the ground as it was, not as neighbours have just set it
  for (const b of GEO.blocks || []) {
    // only where the model was kept (the big blocks): an urban block is already a smooth membrane spanned from its
    // kerbs, and a platform there can only put a step between neighbours or a mound at a door
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < b[0].length; i += 2) { minX = Math.min(minX, b[0][i]); maxX = Math.max(maxX, b[0][i]); minZ = Math.min(minZ, b[0][i + 1]); maxZ = Math.max(maxZ, b[0][i + 1]); }
    if (Math.max(maxX - minX, maxZ - minZ) <= maxExtent) continue;
    for (const bd of b[9] || []) {
      const [th, cx, cz, , , , , rects] = bd;
      if (!rects || !rects.length) continue;
      const c = Math.cos(th), sn = Math.sin(th);
      const toWorld = (u, v) => [cx + u * c + v * sn, cz - u * sn + v * c];
      const toLocal = (x, z) => [(x - cx) * c - (z - cz) * sn, (x - cx) * sn + (z - cz) * c];
      const ys = [];
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const [u0, u1, v0, v1] of rects) {
        for (const [u, v] of [[u0, v0], [u1, v0], [u1, v1], [u0, v1], [(u0 + u1) / 2, (v0 + v1) / 2]]) {
          const [x, z] = toWorld(u, v);
          ys.push(gridSample(grid, src, x, z));
          minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
        }
      }
      if (ys.length < 5) continue;
      // the platform is the pavement in front of the building: the highest ground at the corners that face a
      // street (within 6 m of the carved roadway), so pavement, platform and ground floor (buildings.js seats each
      // volume at its highest street front) are one level and no mound can rise between kerb and facade; a
      // building with no street at hand takes the median under it
      const fronts = [];
      if (mask) {
        for (const [u0, u1, v0, v1] of rects) {
          for (const [u, v] of [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]) {
            const [x, z] = toWorld(u, v);
            let nearRoad = false;
            for (let dz = -6; dz <= 6 && !nearRoad; dz += 6) for (let dx = -6; dx <= 6; dx += 6) {
              const i = Math.round((x + dx - x0) / cell), j = Math.round((z + dz - z0) / cell);
              if (i >= 0 && j >= 0 && i < w && j < h && mask[j * w + i]) { nearRoad = true; break; }
            }
            if (nearRoad) fronts.push(gridSample(grid, src, x, z));
          }
        }
      }
      ys.sort((p, q) => p - q);
      const target = fronts.length ? Math.min(...fronts) : ys[ys.length >> 1]; // never above a door's own street
      if (ys[ys.length - 1] - ys[0] < 0.4 && Math.abs(target - ys[ys.length >> 1]) < 0.2) continue; // flat enough already
      const inside = (x, z) => { const [u, v] = toLocal(x, z); return rects.some(([u0, u1, v0, v1]) => u >= u0 && u <= u1 && v >= v0 && v <= v1); };
      const edgeDist = (x, z) => { const [u, v] = toLocal(x, z); let d = Infinity; for (const [u0, u1, v0, v1] of rects) { const du = Math.max(u0 - u, 0, u - u1), dv = Math.max(v0 - v, 0, v - v1); d = Math.min(d, Math.hypot(du, dv)); } return d; };
      const i0 = Math.max(0, Math.floor((minX - blend - x0) / cell)), i1 = Math.min(w - 1, Math.ceil((maxX + blend - x0) / cell));
      const j0 = Math.max(0, Math.floor((minZ - blend - z0) / cell)), j1 = Math.min(h - 1, Math.ceil((maxZ + blend - z0) / cell));
      // the pavement strip stays with the street (a cell next to the roadway keeps the membrane: level across its
      // width, as pavements are); the platform is cut only under the inner part of the footprint, where the
      // building hides it and a hillside would otherwise bury its back
      const nearRoad = (i, j) => {
        if (!mask) return false;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const ii = i + di, jj = j + dj;
          if (ii >= 0 && jj >= 0 && ii < w && jj < h && mask[jj * w + ii]) return true;
        }
        return false;
      };
      let touched = 0;
      for (let j = j0; j <= j1; j++) {
        const z = z0 + j * cell;
        for (let i = i0; i <= i1; i++) {
          const x = x0 + i * cell;
          const q = j * w + i;
          if (nearRoad(i, j)) continue;
          if (inside(x, z)) { heights[q] = target; touched++; }
          else { const d = edgeDist(x, z); if (d < blend) heights[q] += (target - heights[q]) * (1 - smooth01(d / blend)); }
        }
      }
      if (touched) { platforms++; cells += touched; }
    }
  }
  return { platforms, cells };
}

/**
 * Urban built blocks (up to `maxExtent` m across) become a membrane spanned from their kerb line: every cell inside
 * is the inverse-distance-weighted mean of the carved ground sampled every 4 m along the outline, so the inside can
 * never bulge above or dip below the streets around it (the bare-earth model does, where the buildings were cut
 * out of it). Bigger blocks (estates, hillsides with scattered houses) keep the model; parks & open land keep it too.
 */
export function membraneBlocks(grid, heights, GEO, { blend = 6, maxExtent = 260 } = {}) {
  const { x0, z0, cell, w, h } = grid;
  const src = Float32Array.from(heights);
  let done = 0, cells = 0, skipped = 0;
  for (const b of GEO.blocks || []) {
    const [flat, , , , , , cls, clsShare] = b;
    const open = !BUILDABLE.has(cls) && clsShare >= 0.5;
    if (open || flat.length < 6) continue;
    const poly = [];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < flat.length; i += 2) { poly.push([flat[i], flat[i + 1]]); minX = Math.min(minX, flat[i]); maxX = Math.max(maxX, flat[i]); minZ = Math.min(minZ, flat[i + 1]); maxZ = Math.max(maxZ, flat[i + 1]); }
    // a big block (an estate, a hillside with scattered houses) keeps the model inside, but its frontage band of
    // `band` m behind the kerb is still spanned from the kerb line, so the pavements along it stay level
    const big = Math.max(maxX - minX, maxZ - minZ) > maxExtent;
    const band = 24;
    if (big) skipped++;
    const samp = [];
    for (let i = 0; i < poly.length; i++) {
      const [ax, az] = poly[i], [bx, bz] = poly[(i + 1) % poly.length];
      const L = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.ceil(L / 4));
      for (let k = 0; k < n; k++) { const t = k / n; const x = ax + (bx - ax) * t, z = az + (bz - az) * t; samp.push([x, z, gridSample(grid, src, x, z)]); }
    }
    if (samp.length < 3) continue;
    const idw = (x, z) => {
      let sw = 0, sy = 0;
      for (const [sx, sz, sy_] of samp) {
        const d2 = (sx - x) * (sx - x) + (sz - z) * (sz - z);
        if (d2 < 0.25) return sy_;
        const wgt = 1 / (d2 * d2); // power 4: the nearest kerb dominates, a far corner barely tilts it
        sw += wgt; sy += wgt * sy_;
      }
      return sy / sw;
    };
    const i0 = Math.max(0, Math.floor((minX - blend - x0) / cell)), i1 = Math.min(w - 1, Math.ceil((maxX + blend - x0) / cell));
    const j0 = Math.max(0, Math.floor((minZ - blend - z0) / cell)), j1 = Math.min(h - 1, Math.ceil((maxZ + blend - z0) / cell));
    let touched = 0;
    for (let j = j0; j <= j1; j++) {
      const z = z0 + j * cell;
      for (let i = i0; i <= i1; i++) {
        const x = x0 + i * cell;
        const q = j * w + i;
        if (grid.roadMask && grid.roadMask[q]) continue;
        let inside = false, dmin = Infinity;
        for (let a = 0, c = poly.length - 1; a < poly.length; c = a++) {
          const [xi, zi] = poly[a], [xj, zj] = poly[c];
          if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
          const dx = xj - xi, dz = zj - zi, l2 = dx * dx + dz * dz || 1e-9;
          const t = Math.max(0, Math.min(1, ((x - xi) * dx + (z - zi) * dz) / l2));
          dmin = Math.min(dmin, Math.hypot(x - xi - t * dx, z - zi - t * dz));
        }
        if (inside) {
          if (!big) { heights[q] = idw(x, z); touched++; }
          else if (dmin < band) { heights[q] += (idw(x, z) - heights[q]) * (1 - smooth01(dmin / band)); touched++; }
        } else if (dmin < blend) heights[q] += (idw(x, z) - heights[q]) * (1 - smooth01(dmin / blend)) * 0.5;
      }
    }
    if (touched && !big) { done++; cells += touched; }
  }
  return { blocks: done, cells, skipped };
}

/** Built blocks become planes fitted (least squares) to the ground along their outline; parks & open land keep theirs.
 * Superseded by membraneBlocks (kept for reference) */
export function flattenBlocks(grid, heights, GEO, { blend = 6 } = {}) {
  const { x0, z0, cell, w, h } = grid;
  let flattened = 0, skipped = 0;
  flattenBlocks.skipped = 0;
  for (const b of GEO.blocks || []) {
    const [flat, , , , , , cls, clsShare] = b;
    const open = !BUILDABLE.has(cls) && clsShare >= 0.5;
    if (open || flat.length < 6) continue;
    const poly = [];
    for (let i = 0; i < flat.length; i += 2) poly.push([flat[i], flat[i + 1]]);
    // kerb-line samples every ~4 m
    const samp = [];
    for (let i = 0; i < poly.length; i++) {
      const [ax, az] = poly[i], [bx, bz] = poly[(i + 1) % poly.length];
      const L = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.ceil(L / 4));
      for (let k = 0; k < n; k++) { const t = k / n; const x = ax + (bx - ax) * t, z = az + (bz - az) * t; samp.push([x, z, gridSample(grid, heights, x, z)]); }
    }
    if (samp.length < 3) continue;
    // least-squares plane y = p + gx (x - cx) + gz (z - cz), refitted without the outliers (a culvert, a bank the
    // outline clips, a model artefact: up to 40 % of the samples more than 1 m off), the gradient clamped to 6 %
    let cx = 0, cz = 0, cy = 0, gx = 0, gz = 0;
    let used = samp;
    for (let pass = 0; pass < 3; pass++) {
      cx = 0; cz = 0; cy = 0;
      for (const [x, z, y] of used) { cx += x; cz += z; cy += y; }
      cx /= used.length; cz /= used.length; cy /= used.length;
      let sxx = 0, sxz = 0, szz = 0, sxy = 0, szy = 0;
      for (const [x, z, y] of used) { const dx = x - cx, dz = z - cz, dy = y - cy; sxx += dx * dx; sxz += dx * dz; szz += dz * dz; sxy += dx * dy; szy += dz * dy; }
      const det = sxx * szz - sxz * sxz;
      gx = 0; gz = 0;
      if (Math.abs(det) > 1e-6) { gx = (sxy * szz - szy * sxz) / det; gz = (szy * sxx - sxy * sxz) / det; }
      const grade = Math.hypot(gx, gz);
      if (grade > 0.16) { gx *= 0.16 / grade; gz *= 0.16 / grade; }
      if (pass === 2) break;
      const res = used.map(([x, z, y]) => Math.abs(y - (cy + gx * (x - cx) + gz * (z - cz))));
      const sorted = res.slice().sort((p, q) => p - q);
      const cut = Math.max(1.0, sorted[Math.floor(sorted.length * 0.6)]);
      const kept = used.filter((_, k) => res[k] <= cut);
      if (kept.length === used.length || kept.length < 3) break;
      used = kept;
    }
    const plane = (x, z) => cy + gx * (x - cx) + gz * (z - cz);
    // a block the plane does not fit (a terraced estate, a block over a crest, a hillside) keeps the model: its
    // buildings then stand on the real platforms instead of being buried under a plane that is wrong everywhere
    let rss = 0;
    for (const [x, z, y] of used) { const r = y - plane(x, z); rss += r * r; }
    const rms = Math.sqrt(rss / used.length);
    if (rms > 0.9 || used.length < samp.length * 0.6) { skipped++; continue; }
    // cells inside the outline take the plane; a ring `blend` m wide outside fades into the carved streets
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of poly) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
    const i0 = Math.max(0, Math.floor((minX - blend - x0) / cell)), i1 = Math.min(w - 1, Math.ceil((maxX + blend - x0) / cell));
    const j0 = Math.max(0, Math.floor((minZ - blend - z0) / cell)), j1 = Math.min(h - 1, Math.ceil((maxZ + blend - z0) / cell));
    for (let j = j0; j <= j1; j++) {
      const z = z0 + j * cell;
      for (let i = i0; i <= i1; i++) {
        const x = x0 + i * cell;
        let inside = false;
        let dmin = Infinity;
        for (let a = 0, c = poly.length - 1; a < poly.length; c = a++) {
          const [xi, zi] = poly[a], [xj, zj] = poly[c];
          if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
          const dx = xj - xi, dz = zj - zi, l2 = dx * dx + dz * dz || 1e-9;
          const t = Math.max(0, Math.min(1, ((x - xi) * dx + (z - zi) * dz) / l2));
          dmin = Math.min(dmin, Math.hypot(x - xi - t * dx, z - zi - t * dz));
        }
        const q = j * w + i;
        if (inside) { heights[q] = plane(x, z); flattened++; }
        else if (dmin < blend) heights[q] += (plane(x, z) - heights[q]) * (1 - smooth01(dmin / blend)) * 0.5;
      }
    }
  }
  flattenBlocks.skipped = skipped;
  return flattened;
}

// ---- report: what the city will drive on (procedural check over the whole grid, no screenshots needed) ---------------
export function report(grid, heights, GEO) {
  const roads = roadPolylines(GEO);
  const grades = [];
  let steep = 0, steepest = null, bridges = [], jumps = 0;
  const byClass = { drivable: [], pedestrian: [] };
  let crests = 0, worstCrest = null; // carriageway samples more than 0.3 m off the chord of their neighbours 15 m away
  for (const road of roads) {
    // the final grid along the centreline, as driven (no smoothing, no limiting here)
    const s = arcLength(road.pts);
    const L = s[s.length - 1];
    const n = Math.max(2, Math.ceil(L / 5) + 1);
    const samples = [];
    for (let k = 0; k < n; k++) { const d = (L * k) / (n - 1); const [x, z] = pointAt(road.pts, s, d); samples.push({ d, y: gridSample(grid, heights, x, z) }); }
    const bucket = road.cls === 3 ? byClass.pedestrian : byClass.drivable;
    if (road.bridge) { bridges.push({ L: Math.round(L), g: Math.abs(samples[n - 1].y - samples[0].y) / Math.max(1, L) }); continue; } // decks: end-to-end grade
    let worst = 0;
    for (let k = 1; k < samples.length; k++) {
      const ds = samples[k].d - samples[k - 1].d;
      if (ds < 1) continue;
      const g = Math.abs(samples[k].y - samples[k - 1].y) / ds;
      grades.push(g);
      bucket.push(g);
      if (g > worst) worst = g;
      if (road.cls !== 3 && Math.abs(samples[k].y - samples[k - 1].y) > 1.0) jumps++; // a step of > 1 m within 5 m of carriageway
    }
    if (road.cls !== 3) for (let k = 3; k < n - 3; k++) { const chord = (samples[k - 3].y + samples[k + 3].y) * 0.5; const off = Math.abs(samples[k].y - chord); if (off > 0.3) { crests++; if (!worstCrest || off > worstCrest.off) { const [x, z] = pointAt(road.pts, s, samples[k].d); worstCrest = { off, x: Math.round(x), z: Math.round(z), name: road.name }; } } }
    if (road.cls !== 3 && worst > 0.18) { steep++; if (!steepest || worst > steepest.g) steepest = { g: worst, x: Math.round(road.pts[0][0]), z: Math.round(road.pts[0][1]) }; }
  }
  const q = (arr, p) => { arr.sort((a, b) => a - b); return arr.length ? (arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] * 100).toFixed(1) : '-'; };
  for (const [name, arr] of Object.entries(byClass)) log(`report: ${name} grade p50 ${q(arr, 0.5)} %, p90 ${q(arr, 0.9)} %, p99 ${q(arr, 0.99)} %, max ${q(arr, 1)} %`);
  log(`report: ${steep} carriageway links over 18 % (steepest ${steepest ? `${(steepest.g * 100).toFixed(0)} % near (${steepest.x}, ${steepest.z})` : '-'}); ${jumps} steps over 1 m within 5 m of carriageway; ${crests} short crests or dips (> 0.3 m off a 30 m chord)${worstCrest ? ` (worst ${worstCrest.off.toFixed(1)} m near (${worstCrest.x}, ${worstCrest.z}))` : ''}`);
  const bl = bridges.map((b) => b.L);
  log(`report: ${bridges.length} bridge decks, length ${Math.min(...bl)}..${Math.max(...bl)} m, end-to-end grade max ${(Math.max(...bridges.map((b) => b.g)) * 100).toFixed(1)} %`);
  // blocks: how far the plane sits from the carved streets round it (kerb steps a car would feel)
  let maxStep = 0, bigSteps = 0, worstBlock = null;
  for (const b of GEO.blocks || []) {
    const [flat, , , , , , cls, clsShare] = b;
    const open = !BUILDABLE.has(cls) && clsShare >= 0.5;
    if (open || flat.length < 6) continue;
    let worst = 0;
    for (let i = 0; i < flat.length; i += 2) {
      // 1.5 m inside vs 1.5 m outside the kerb at each vertex (the kerb step the relief leaves)
      const x = flat[i], z = flat[i + 1];
      const cx = flat.reduce((s, v, k) => (k % 2 === 0 ? s + v : s), 0) / (flat.length / 2);
      const cz = flat.reduce((s, v, k) => (k % 2 === 1 ? s + v : s), 0) / (flat.length / 2);
      const L = Math.hypot(cx - x, cz - z) || 1;
      const ux = (cx - x) / L, uz = (cz - z) / L;
      const d = Math.abs(gridSample(grid, heights, x + ux * 1.5, z + uz * 1.5) - gridSample(grid, heights, x - ux * 1.5, z - uz * 1.5));
      if (d > worst) worst = d;
    }
    if (worst > 1.0) { bigSteps++; if (!worstBlock || worst > worstBlock.d) worstBlock = { d: worst, x: Math.round(flat[0]), z: Math.round(flat[1]) }; }
    if (worst > maxStep) maxStep = worst;
  }
  log(`report: kerb step across block outlines max ${maxStep.toFixed(2)} m, ${bigSteps} built blocks with a step over 1 m${worstBlock ? ` (worst ${worstBlock.d.toFixed(1)} m near (${worstBlock.x}, ${worstBlock.z}))` : ''}`);
  // mounds: along the outline of every urban block, the ground 4 m inside (the pavement at the facade) against the
  // kerb line; a pavement is level across its width unless the street itself climbs there
  let mounds = 0, worstMound = null, checked = 0;
  for (const b of GEO.blocks || []) {
    const [flat, , , , , , cls, clsShare] = b;
    const open = !BUILDABLE.has(cls) && clsShare >= 0.5;
    if (open || flat.length < 6) continue;
    const n = flat.length / 2;
    let cx = 0, cz = 0;
    for (let i = 0; i < flat.length; i += 2) { cx += flat[i]; cz += flat[i + 1]; }
    cx /= n; cz /= n;
    for (let i = 0; i < flat.length; i += 2) {
      const ax = flat[i], az = flat[i + 1], bx = flat[(i + 2) % flat.length], bz = flat[(i + 3) % flat.length];
      const L = Math.hypot(bx - ax, bz - az);
      for (let d = 3; d < L - 3; d += 6) {
        const t = d / L, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
        const ux = (cx - x), uz = (cz - z), U = Math.hypot(ux, uz) || 1;
        const kerb = gridSample(grid, heights, x, z);
        const inner = gridSample(grid, heights, x + (ux / U) * 4, z + (uz / U) * 4);
        checked++;
        const rise = inner - kerb;
        if (Math.abs(rise) > 0.5) { mounds++; if (!worstMound || Math.abs(rise) > Math.abs(worstMound.rise)) worstMound = { rise, x: Math.round(x), z: Math.round(z) }; }
      }
    }
  }
  log(`report: pavement across its width: ${mounds} of ${checked} samples differ over 0.5 m between kerb and facade line${worstMound ? ` (worst ${worstMound.rise.toFixed(1)} m near (${worstMound.x}, ${worstMound.z}))` : ''}`);
}

// ---- main ----------------------------------------------------------------------------------------------------------------
export async function build(opts) {
  const { GEO } = await import(pathToFileURL(opts.geodata).href);
  const frame = frameOf(GEO.frame);
  const grid = gridFor(GEO.bounds, opts.cell, opts.margin);
  log(`grid ${grid.w} x ${grid.h} cells of ${grid.cell} m from (${grid.x0}, ${grid.z0}) — ${(grid.w * grid.h * 2 / 1048576).toFixed(1)} MB`);
  let heights;
  if (opts.synthetic) {
    log('SYNTHETIC relief (development stand-in, not Terrassa)');
    heights = syntheticHeights(grid, GEO);
  } else {
    if (!opts.files.length) throw new Error('no elevation model given (or use --synthetic for a development stand-in)');
    const rasters = opts.files.map((f) => {
      const r = readRaster(f, { epsg: opts.epsg });
      const epsg = r.epsg || opts.epsg;
      const project = projectorFor(epsg);
      if (!project) throw new Error(`${path.basename(f)}: CRS EPSG:${epsg} not supported (reproject to EPSG:25831 or 4326 with gdalwarp)`);
      if (epsg >= 23028 && epsg <= 23038) log(`WARNING ${path.basename(f)} is ED50 (EPSG:${epsg}): expect a ~200 m datum shift`);
      log(`${path.basename(f)}: ${r.width} x ${r.height} px, cell ${r.cell.toFixed(2)}, EPSG:${epsg}, nodata ${r.nodata}`);
      return { ...r, project };
    });
    const res = resample(grid, rasters, frame);
    heights = res.heights;
    log(`resampled, ${res.holes} holes (${((100 * res.holes) / heights.length).toFixed(2)} %)`);
    const filled = fillHoles(heights, grid.w, grid.h);
    if (filled) log(`filled ${filled} cells from their neighbours`);
  }
  if (opts.smooth > 0) gaussianBlur(heights, grid.w, grid.h, opts.smooth / grid.cell);
  let bridges = [];
  if (!opts.raw) {
    const roads = roadPolylines(GEO);
    const nodeH = nodeHeights(grid, heights, roads, GEO.roadGraph.nodes.length / 2);
    // twice: the second pass reads the streets already written in, so where two streets cross at different levels
    // (an overpass with no bridge tag, a ramp over a bridge's abutment) the step becomes a limited-grade ramp
    let carved = carveRoads(grid, heights, roads, { nodeH });
    const raised = raiseBridgeAbutments(grid, heights, roads, nodeH);
    const rejoined = joinDeckEnds(roads, nodeH, nodeH.length, { mode: 'max' }); // a lifted end takes its siblings up with it
    if (rejoined) log(`${rejoined} pairs of deck ends re-joined after the lifts`);
    const membrane = membraneBlocks(grid, heights, GEO);
    const platforms = flattenBuildings(grid, heights, GEO);
    // the streets again, last: whatever the blocks' membranes & platforms did at their edges, the carriageways keep
    // their own smooth profiles (crossings at different levels become limited ramps here too)
    carved = carveRoads(grid, heights, roads, { nodeH, smoothM: 20 });
    const stamped = stampAbutments(grid, heights, roads, nodeH);
    log(`${stamped} cells stamped at the bridge abutments`);
    const lowered = clearUnderBridges(grid, heights, roads, nodeH);
    bridges = bridgeDecks(roads, nodeH, grid, heights);
    log(`${lowered} cells lowered under the bridge decks`);
    log(`streets written into the relief: ${roads.length} links between ${nodeH.length} junction heights, ${carved} cells; ${bridges.length} bridge decks kept over it; ${membrane.blocks} urban blocks spanned from their kerb line (${membrane.cells} cells, ${membrane.skipped} big blocks keep the model); ${platforms.platforms} building platforms (${platforms.cells} cells); ${raised} decks lifted for the streets under them, ${lowered} cells lowered under the decks`);
  }
  report(grid, heights, GEO);
  const ref = gridSample(grid, heights, 0, 0);
  for (let k = 0; k < heights.length; k++) heights[k] -= ref;
  const buf = encodeTerrain(grid, heights, { ref, synthetic: opts.synthetic, smooth: opts.smooth, bridges });
  fs.writeFileSync(opts.out, buf);
  const min = buf.readFloatLE(28), max = buf.readFloatLE(32);
  log(`origin (Plaça Vella) at ${ref.toFixed(1)} m a.s.l.; relief ${min.toFixed(1)} .. +${max.toFixed(1)} m; wrote ${opts.out} (${(buf.length / 1048576).toFixed(1)} MB)`);
  return { grid, heights, ref, out: opts.out };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build(parseArgs(process.argv.slice(2))).catch((e) => { console.error('[terrain]', e.message); process.exit(1); });
}
