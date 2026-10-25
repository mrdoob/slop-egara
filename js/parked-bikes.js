import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SQUARES, SHOPS, TELEPORT_LOCATIONS, blockAt, nearestRoads } from './city-config.js';

// js/parked-bikes.js
// Bicycles parked at inverted-U racks on the sidewalks (FEATURES.enterExit): by the squares, the stations & the
// monuments' streets and outside a share of the bars, where Terrassa actually chains its bikes. The pedestrian takes
// the nearest one with F (controllers.js enterNearby → take()): that instance disappears from the rack and the player's
// bicycle appears in its place. The racks are placed procedurally (there is no inventory of the real ones:
// HOW_TO_IMPROVE.md §5.8), on kerb islands, clear of buildings and props, two bikes a rack.
//
// The bike matches the player's (controllers.js createCyclistEntity: 0.35 m wheels 1.16 m apart) so the swap is seamless.

function buildBicycleGeometry() {
  const parts = [];
  const wheel = new THREE.TorusGeometry(0.35, 0.036, 8, 20).rotateY(Math.PI * 0.5);
  const rim = new THREE.TorusGeometry(0.31, 0.014, 6, 20).rotateY(Math.PI * 0.5);
  for (const z of [0.58, -0.58]) {
    parts.push(wheel.clone().translate(0, 0.38, z), rim.clone().translate(0, 0.38, z));
  }
  const tube = (r, len, rx, x, y, z) => parts.push(new THREE.CylinderGeometry(r, r, len, 8).rotateX(rx).translate(x, y, z));
  tube(0.02, 0.72, Math.PI * 0.46, 0, 0.78, 0.04); // top tube
  tube(0.024, 0.78, Math.PI * 0.28, 0, 0.58, 0.16); // down tube
  tube(0.02, 0.64, -0.22, 0, 0.66, -0.22); // seat tube
  tube(0.018, 0.68, -0.24, 0, 0.68, 0.48); // fork
  parts.push(new THREE.CylinderGeometry(0.016, 0.016, 0.48, 8).rotateZ(Math.PI * 0.5).translate(0, 0.98, 0.4)); // handlebar
  parts.push(new THREE.BoxGeometry(0.1, 0.05, 0.26).translate(0, 0.97, -0.28)); // saddle
  parts.push(new THREE.BoxGeometry(0.16, 0.03, 0.03).translate(0, 0.34, -0.145)); // crank axle
  // chain stays & seat stays, thin
  tube(0.01, 0.46, Math.PI * 0.5, 0.04, 0.36, -0.37);
  tube(0.01, 0.46, Math.PI * 0.5, -0.04, 0.36, -0.37);
  const geo = mergeGeometries(parts.map((g) => g.toNonIndexed()));
  for (const g of parts) g.dispose();
  wheel.dispose();
  rim.dispose();
  return geo;
}

// An inverted-U rack (Terrassa's standard "U invertida"), 0.85 m high, 0.76 m wide, 48 mm tube
function buildRackGeometry() {
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.38, -0.05, 0), new THREE.Vector3(-0.38, 0.6, 0), new THREE.Vector3(-0.3, 0.82, 0),
    new THREE.Vector3(0, 0.86, 0), new THREE.Vector3(0.3, 0.82, 0), new THREE.Vector3(0.38, 0.6, 0), new THREE.Vector3(0.38, -0.05, 0)
  ], false, 'catmullrom', 0.1);
  return new THREE.TubeGeometry(curve, 24, 0.024, 8, false);
}

/**
 * @param scene
 * @param opts.isClear (x, z, r) → true where a body of radius r stands clear of buildings & props (controllers.js isClearAt)
 * @param opts.groundAt (x, z) → the ground height (city-grid.js groundHeightAt: the kerb top on the relief)
 * @param opts.maxBikes
 */
function buildParkedBikes(scene, { isClear, groundAt, maxBikes = 600 } = {}) {
  const group = new THREE.Group();
  group.name = 'ParkedBikes';
  const clear = isClear || (() => true);
  const ground = groundAt || (() => 0);

  // ---- Sites: the squares, the monuments' streets & stations (teleport spots), a share of the bars ----------------
  const seeds = [];
  for (const sq of SQUARES || []) seeds.push({ x: sq.x, z: sq.z, racks: 2 });
  for (const spot of Object.values(TELEPORT_LOCATIONS || {})) seeds.push({ x: spot.x, z: spot.z, racks: 2 });
  (SHOPS || []).forEach((shop, i) => { if (shop.kind === 1 && i % 4 === 0) seeds.push({ x: shop.x, z: shop.z, racks: 1 }); });

  const onKerb = (x, z) => {
    const b = blockAt(x, z);
    return !!b && !b.open && !b.median;
  };
  const racks = []; // { x, z, ux, uz }
  const bikes = []; // { x, z, heading, taken, rack }
  const rackTooClose = (x, z) => racks.some((r) => Math.hypot(r.x - x, r.z - z) < 2.2);

  for (const seed of seeds) {
    if (bikes.length >= maxBikes) break;
    let placed = 0;
    // rings of candidates around the seed: on a kerb island, clear of walls, props & other racks
    for (let radius = 3; radius <= 14 && placed < seed.racks; radius += 2.5) {
      for (let k = 0; k < 12 && placed < seed.racks; k++) {
        const a = (k / 12) * Math.PI * 2 + radius * 0.37;
        const x = seed.x + Math.cos(a) * radius, z = seed.z + Math.sin(a) * radius;
        if (!onKerb(x, z) || rackTooClose(x, z)) continue;
        // the rack bar runs along the nearest street, the bikes stand across it, nose away from the kerb
        const near = nearestRoads(x, z, 25)[0];
        const ux = near ? near.ux : 1, uz = near ? near.uz : 0;
        // a rack with a bike either side needs ~2.2 x 1.9 m of clear sidewalk
        let ok = true;
        for (const [dx, dz] of [[0, 0], [ux * 0.9, uz * 0.9], [-ux * 0.9, -uz * 0.9], [-uz * 0.7, ux * 0.7], [uz * 0.7, -ux * 0.7]]) {
          if (!onKerb(x + dx, z + dz) || !clear(x + dx, z + dz, 0.45)) { ok = false; break; }
        }
        if (!ok) continue;
        // which way is the roadway? the bikes' noses point away from it
        const toRoad = near ? Math.sign((near.px - x) * -uz + (near.pz - z) * ux) || 1 : 1;
        const heading = Math.atan2(-uz * -toRoad, ux * -toRoad);
        racks.push({ x, z, ux, uz });
        for (const side of [-1, 1]) {
          bikes.push({ x: x + ux * side * 0.5, z: z + uz * side * 0.5, heading, taken: false, rack: racks.length - 1 });
        }
        placed++;
      }
    }
  }

  // ---- Instances --------------------------------------------------------------------------------------------------
  const bikeMat = new THREE.MeshStandardNodeMaterial({ color: 0x2a2f36, roughness: 0.55, metalness: 0.45 });
  const rackMat = new THREE.MeshStandardNodeMaterial({ color: 0x8d949c, roughness: 0.35, metalness: 0.8 });
  const bikeGeo = buildBicycleGeometry();
  const rackGeo = buildRackGeometry();
  const bikeInst = new THREE.InstancedMesh(bikeGeo, bikeMat, Math.max(1, bikes.length));
  const rackInst = new THREE.InstancedMesh(rackGeo, rackMat, Math.max(1, racks.length));
  const dummy = new THREE.Object3D();
  const palette = [0x2a2f36, 0x1d3b6c, 0x7a1a22, 0x3f5a2a, 0x5a5f66, 0xb8b0a0];
  const color = new THREE.Color();
  bikes.forEach((b, i) => {
    dummy.position.set(b.x, ground(b.x, b.z), b.z);
    dummy.rotation.set(0, b.heading, 0.1 * (i % 2 ? 1 : -1)); // leant a little onto the rack
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    bikeInst.setMatrixAt(i, dummy.matrix);
    color.setHex(palette[i % palette.length]);
    bikeInst.setColorAt(i, color);
  });
  racks.forEach((r, i) => {
    dummy.position.set(r.x, ground(r.x, r.z), r.z);
    dummy.rotation.set(0, Math.atan2(r.ux, r.uz) + Math.PI * 0.5, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    rackInst.setMatrixAt(i, dummy.matrix);
  });
  if (!bikes.length) bikeInst.count = 0;
  if (!racks.length) rackInst.count = 0;
  bikeInst.instanceMatrix.needsUpdate = true;
  if (bikeInst.instanceColor) bikeInst.instanceColor.needsUpdate = true;
  rackInst.instanceMatrix.needsUpdate = true;
  bikeInst.castShadow = rackInst.castShadow = true;
  bikeInst.receiveShadow = rackInst.receiveShadow = true;
  bikeInst.computeBoundingSphere();
  rackInst.computeBoundingSphere();
  group.add(bikeInst, rackInst);
  scene.add(group);
  console.info(`[parkedBikes] ${bikes.length} bicycles at ${racks.length} racks from ${seeds.length} sites`);

  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  return {
    group,
    bikes,
    racks,
    /** The nearest bicycle still on its rack within r metres of (x, z): removed from the rack, its place returned */
    take(x, z, r = 2.5) {
      let best = -1, bestD = r;
      for (let i = 0; i < bikes.length; i++) {
        const b = bikes[i];
        if (b.taken) continue;
        const d = Math.hypot(b.x - x, b.z - z);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best < 0) return null;
      const b = bikes[best];
      b.taken = true;
      bikeInst.setMatrixAt(best, zero);
      bikeInst.instanceMatrix.needsUpdate = true;
      return { x: b.x, z: b.z, heading: b.heading, index: best };
    },
    /** Put a taken bicycle back on its rack (unused by the game so far: the player's bike stays where it is left) */
    restore(index) {
      const b = bikes[index];
      if (!b || !b.taken) return false;
      b.taken = false;
      dummy.position.set(b.x, ground(b.x, b.z), b.z);
      dummy.rotation.set(0, b.heading, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      bikeInst.setMatrixAt(index, dummy.matrix);
      bikeInst.instanceMatrix.needsUpdate = true;
      return true;
    }
  };
}

export { buildParkedBikes, buildBicycleGeometry, buildRackGeometry };
