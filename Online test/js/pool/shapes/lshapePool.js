// js/pool/shapes/lshapePool.js
import * as THREE from "https://esm.sh/three@0.158.0";
import { createPoolWater } from "../water.js";

export function createLShapePool(params, tileSize = 0.3) {
  const {
    length,
    width,
    shallow,
    deep,
    shallowFlat,
    deepFlat,
    stepCount,
    stepDepth
  } = params;

  const group = new THREE.Group();
  const loader = new THREE.TextureLoader();

  const clampedShallow = Math.max(0.5, shallow);
  const clampedDeep = Math.max(clampedShallow, deep);

  group.userData.poolParams = {
    length,
    width,
    shallow,
    deep,
    shallowFlat,
    deepFlat,
    stepCount,
    stepDepth
  };

  /* -------------------------------------------------------
     OUTLINE (L-shape)
  ------------------------------------------------------- */
  const halfL = length / 2;
  const halfW = width / 2;

  const notchL = Math.max(0.6, length * 0.35);
  const notchW = Math.max(0.6, width * 0.35);

  const borderPts = [
    new THREE.Vector2(-halfL, -halfW),
    new THREE.Vector2(halfL, -halfW),
    new THREE.Vector2(halfL, halfW),
    new THREE.Vector2(halfL - notchL, halfW),
    new THREE.Vector2(halfL - notchL, halfW - notchW),
    new THREE.Vector2(-halfL, halfW - notchW)
  ];

  const shape = new THREE.Shape(borderPts);

  const STEP_LENGTH = 0.3;
  const STEP_TOP_OFFSET = 0.25;

  /* -------------------------------------------------------
     FLOOR  (BBOX-RECTANGLE PLANE)
  ------------------------------------------------------- */
  const bb2 = new THREE.Box2();
  for (const p of borderPts) bb2.expandByPoint(p);

  const wallMinX = bb2.min.x;
  const wallMaxX = bb2.max.x;
  const wallMinY = bb2.min.y;
  const wallMaxY = bb2.max.y;

  const bbLen = Math.max(0.01, wallMaxX - wallMinX);
  const bbWid = Math.max(0.01, wallMaxY - wallMinY);
  const cx = (wallMinX + wallMaxX) * 0.5;
  const cy = (wallMinY + wallMaxY) * 0.5;

  const segX = Math.max(2, Math.min(200, Math.ceil(bbLen / tileSize)));
  const segY = Math.max(2, Math.min(200, Math.ceil(bbWid / tileSize)));

  const floorGeo = new THREE.PlaneGeometry(bbLen, bbWid, segX, segY);
  const pos = floorGeo.attributes.position;

  let originX = wallMinX;
  if (stepCount > 0) originX = wallMinX + STEP_LENGTH * stepCount;

  const fullLen = wallMaxX - originX;

  let sFlat = shallowFlat || 0;
  let dFlat = deepFlat || 0;

  const maxFlats = Math.max(0, fullLen - 0.1);
  if (sFlat + dFlat > maxFlats) {
    const scale = maxFlats / (sFlat + dFlat);
    sFlat *= scale;
    dFlat *= scale;
  }

  const slopeLen = Math.max(0.01, fullLen - sFlat - dFlat);

  for (let i = 0; i < pos.count; i++) {
    const worldX = pos.getX(i) + cx;

    let dx = worldX - originX;
    if (dx < 0) dx = 0;

    let z;
    if (dx <= sFlat) {
      z = -clampedShallow;
    } else if (dx >= fullLen - dFlat) {
      z = -clampedDeep;
    } else {
      const t = (dx - sFlat) / slopeLen;
      z = -(clampedShallow + t * (clampedDeep - clampedShallow));
    }

    pos.setZ(i, z);
  }

  pos.needsUpdate = true;
  floorGeo.computeVertexNormals();

  const floor = new THREE.Mesh(
    floorGeo,
    new THREE.MeshStandardMaterial({ color: 0xffffff })
  );
  floor.receiveShadow = true;
  floor.userData.isFloor = true;
  floor.userData.type = "floor";
  floor.position.set(cx, cy, 0);
  group.add(floor);

/* -------------------------------------------------------
     STEPS
  ------------------------------------------------------- */
  if (stepCount > 0) {
    const shallowDepth = clampedShallow;

    let stepWidth = wallMaxY - wallMinY;
    if (!isFinite(stepWidth) || stepWidth < 0.05) stepWidth = width * 0.6;

    for (let s = 0; s < stepCount; s++) {
      let h = stepDepth;

      if (s === stepCount - 1) {
        const used = stepDepth * (stepCount - 1);
        h = shallowDepth - STEP_TOP_OFFSET - used;
        if (h < 0.05) h = 0.05;
      }

      const geo = new THREE.BoxGeometry(STEP_LENGTH, stepWidth, h);
      const mat = new THREE.MeshStandardMaterial({ color: 0xaaaaaa });
      const step = new THREE.Mesh(geo, mat);

      const x = wallMinX + STEP_LENGTH * (s + 0.5);
      const z =
        s === stepCount - 1
          ? -(shallowDepth - h / 2)
          : -(STEP_TOP_OFFSET + stepDepth * (s + 0.5));

      step.position.set(x, 0, z);
      step.userData.isStep = true;

      step.castShadow = true;
      step.receiveShadow = true;
      group.add(step);
    }
  }

  /* -------------------------------------------------------
     WATER
  ------------------------------------------------------- */
  const water = createPoolWater(length, width);
  const waterGeo = new THREE.ShapeGeometry(shape, 64);
  if (water.geometry) water.geometry.dispose();
  water.geometry = waterGeo;

  water.position.set(0, 0, -0.15);
  water.receiveShadow = true;
  if (water.material) water.material.depthWrite = false;
  water.renderOrder = 1;
  group.add(water);

  /* -------------------------------------------------------
     WALLS (200mm)
  ------------------------------------------------------- */
  const wallMeshes = [];
  const wallThickness = 0.2;

  for (let i = 0; i < borderPts.length; i++) {
    const p1 = borderPts[i];
    const p2 = borderPts[(i + 1) % borderPts.length];

    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-4) continue;

    const wallGeo = new THREE.BoxGeometry(len, wallThickness, clampedDeep);
    const wall = new THREE.Mesh(
      wallGeo,
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        side: THREE.DoubleSide
      })
    );

    wall.position.set((p1.x + p2.x) / 2, (p1.y + p2.y) / 2, -clampedDeep / 2);
    wall.rotation.z = Math.atan2(dy, dx);
    wall.castShadow = true;
    wall.receiveShadow = true;

    wall.userData.isWall = true;
    wall.userData.baseHeight = clampedDeep;
    wall.userData.extraHeight = 0;

    wallMeshes.push(wall);
    group.add(wall);
  }

  /* -------------------------------------------------------
     COPING RING (Travertine)
     Rules (match rectangle pool):
       - Outer edge sits on the OUTSIDE face of the wall (offset outward by wallThickness)
       - Inner edge overhangs 0.05 m INTO the water (offset inward by 0.05)
       - Bottom sits on wall top (z = 0), with a tiny zOffset to avoid z-fighting
  ------------------------------------------------------- */
  const pts2D = borderPts.map((p) => new THREE.Vector2(p.x, p.y));

  function polygonSignedArea(pts) {
    let a = 0;
    for (let i = 0, n = pts.length; i < n; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % n];
      a += p.x * q.y - q.x * p.y;
    }
    return a * 0.5;
  }

  function computeOutwardVertexNormals(pts) {
    const n = pts.length;
    const area = polygonSignedArea(pts);
    const ccw = area > 0;
    const normals = new Array(n);

    for (let i = 0; i < n; i++) {
      const p0 = pts[(i - 1 + n) % n];
      const p1 = pts[i];
      const p2 = pts[(i + 1) % n];

      const ePrev = new THREE.Vector2(p1.x - p0.x, p1.y - p0.y);
      const eNext = new THREE.Vector2(p2.x - p1.x, p2.y - p1.y);

      const nPrev = ccw
        ? new THREE.Vector2(ePrev.y, -ePrev.x)
        : new THREE.Vector2(-ePrev.y, ePrev.x);
      const nNext = ccw
        ? new THREE.Vector2(eNext.y, -eNext.x)
        : new THREE.Vector2(-eNext.y, eNext.x);

      if (nPrev.lengthSq() > 1e-12) nPrev.normalize();
      if (nNext.lengthSq() > 1e-12) nNext.normalize();

      const nv = nPrev.add(nNext);
      if (nv.lengthSq() < 1e-12) {
        normals[i] =
          nPrev.lengthSq() > 1e-12 ? nPrev.clone() : new THREE.Vector2(1, 0);
      } else {
        normals[i] = nv.normalize();
      }
    }

    return normals;
  }

  const normals = computeOutwardVertexNormals(pts2D);

  const copingOverhang = 0.2;
  const copingDepth = 0.05;
  const zOffset = 0.001;

  const outerPts = pts2D.map((p, i) =>
    p.clone().add(normals[i].clone().multiplyScalar(wallThickness))
  );
  const innerPts = pts2D.map((p, i) =>
    p.clone().add(normals[i].clone().multiplyScalar(-copingOverhang))
  );

  const copingShape = new THREE.Shape(outerPts);
  const innerPath = new THREE.Path(innerPts.slice().reverse());
  copingShape.holes.push(innerPath);

  const copingGeo = new THREE.ExtrudeGeometry(copingShape, {
    depth: copingDepth,
    bevelEnabled: false,
    curveSegments: 48
  });
  copingGeo.computeVertexNormals();

  const copingCol = loader.load("textures/Coping/TilesTravertine001_COL_4K.jpg");
  copingCol.wrapS = copingCol.wrapT = THREE.RepeatWrapping;
  copingCol.repeat.set(1.5, 1.5);

  const copingMat = new THREE.MeshStandardMaterial({
    map: copingCol,
    color: 0xffffff,
    roughness: 0.8,
    metalness: 0.05,
    side: THREE.DoubleSide
  });

  const copingMesh = new THREE.Mesh(copingGeo, copingMat);
  copingMesh.castShadow = true;
  copingMesh.receiveShadow = true;
  copingMesh.position.z = zOffset;
  copingMesh.renderOrder = 3;
  copingMesh.userData.isCoping = true;

  group.add(copingMesh);
  group.userData.copingMesh = copingMesh;

  /* -------------------------------------------------------
     METADATA / ANIMATION
  ------------------------------------------------------- */
  const animatables = [];
  if (water.userData && typeof water.userData.animate === "function") {
    animatables.push(water);
  }

  group.userData.animatables = animatables;
  group.userData.water = water;
  group.userData.waterMesh = water;
  group.userData.floorMesh = floor;
  group.userData.wallMeshes = wallMeshes;
  group.userData.wallThickness = wallThickness;
  group.userData.outerPts = borderPts;

  if (water.userData && typeof water.userData.triggerRipple === "function") {
    group.userData.triggerRipple = water.userData.triggerRipple;
  }

  return group;
}
