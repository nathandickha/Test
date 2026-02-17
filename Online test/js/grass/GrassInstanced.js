// frontend/js/grass/GrassInstanced.js
import * as THREE from "https://esm.sh/three@0.158.0";

/**
 * Instanced grass "cards" (two crossed planes) with:
 *  - camera distance fade (so far grass disappears)
 *  - radial edge feather (so you don't see a hard patch boundary)
 *  - pool footprint exclusion (no instances inside pool void)
 *
 * World is Z-up (blades grow along +Z).
 */
export class GrassInstanced {
  constructor(renderer, {
    radius = 18,
    innerRadius = 0,
    count = 16000,
    bladeHeight = 0.14,
    bladeWidth = 0.055,
    seed = 1337,
    fadeNear = 8,
    fadeFar = 22,
    edgeFeather = 5      // meters of soft blend at the patch edge
  } = {}) {
    this.renderer = renderer;
    this.radius = radius;
    this.innerRadius = innerRadius;
    this.count = count;
    this.bladeHeight = bladeHeight;
    this.bladeWidth = bladeWidth;
    this.seed = seed;
    this.fadeNear = fadeNear;
    this.fadeFar = fadeFar;
    this.edgeFeather = edgeFeather;

    this._rng = mulberry32(seed);
    this._poolPoly = null;

    const { map, alphaMap } = this._makeBladeTextures();

    // Vertical plane in XZ, base at z=0
    const geo = new THREE.PlaneGeometry(bladeWidth, bladeHeight, 1, 1);
    geo.rotateX(Math.PI / 2);
    geo.translate(0, 0, bladeHeight / 2);

    const mat = new THREE.MeshStandardMaterial({
      map,
      alphaMap,
      transparent: true,
      alphaTest: 0.35,
      depthWrite: true,
      side: THREE.DoubleSide,
      roughness: 1.0,
      metalness: 0.0
    });

    this._installFades(mat);

    this.meshA = new THREE.InstancedMesh(geo, mat, count);
    this.meshB = new THREE.InstancedMesh(geo, mat, count);

    this.meshA.castShadow = this.meshB.castShadow = false;
    this.meshA.receiveShadow = this.meshB.receiveShadow = false;

    // Never frustum-cull based on a wrong static bound
    this.meshA.frustumCulled = false;
    this.meshB.frustumCulled = false;

    this._tmpObj = new THREE.Object3D();
    this._lastCenter = new THREE.Vector3(0, 0, 0);
    this._instancesBuilt = false;
  }

  addTo(scene) {
    scene.add(this.meshA);
    scene.add(this.meshB);
  }

  setPoolPolygon(outerPts) {
    if (!outerPts || outerPts.length < 3) {
      this._poolPoly = null;
    } else {
      this._poolPoly = outerPts.map(p => new THREE.Vector2(p.x, p.y));
    }
    this._instancesBuilt = false;
  }

  setCenter(center) {
    if (!center) return;
    this._lastCenter.copy(center);
    this._instancesBuilt = false;
    // Update shader uniform immediately so edge feather is centered correctly
    if (this._fadeUniforms?.uPatchCenter) {
      this._fadeUniforms.uPatchCenter.value.set(center.x, center.y);
    }
  }

  update(camera) {
    if (this._fadeUniforms?.uCameraPos) {
      this._fadeUniforms.uCameraPos.value.copy(camera.position);
    }
  }

  ensureBuilt() {
    if (this._instancesBuilt) return;
    this._buildInstances();
    this._instancesBuilt = true;
  }

  _buildInstances() {
    this._rng = mulberry32(this.seed);

    const cx = this._lastCenter.x;
    const cy = this._lastCenter.y;

    let placed = 0;
    const maxTries = this.count * 12;

    for (let i = 0; placed < this.count && i < maxTries; i++) {
      const a = this._rng() * Math.PI * 2;

      // Uniform area distribution (circle)
      const r = Math.sqrt(this._rng()) * this.radius;
      if (r < this.innerRadius) continue;

      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;

      // Exclude inside pool
      if (this._poolPoly && pointInPoly(x, y, this._poolPoly)) continue;

      const yaw = this._rng() * Math.PI * 2;
      const hScale = 0.75 + this._rng() * 0.5;

      this._tmpObj.position.set(x, y, 0);
      this._tmpObj.rotation.set(0, 0, yaw);
      this._tmpObj.scale.set(1, 1, hScale);
      this._tmpObj.updateMatrix();
      this.meshA.setMatrixAt(placed, this._tmpObj.matrix);

      this._tmpObj.rotation.z = yaw + Math.PI / 2;
      this._tmpObj.updateMatrix();
      this.meshB.setMatrixAt(placed, this._tmpObj.matrix);

      placed++;
    }

    this.meshA.count = this.meshB.count = placed;
    this.meshA.instanceMatrix.needsUpdate = true;
    this.meshB.instanceMatrix.needsUpdate = true;

    // Keep shader patch uniforms in sync
    if (this._fadeUniforms?.uPatchCenter) {
      this._fadeUniforms.uPatchCenter.value.set(cx, cy);
    }
    if (this._fadeUniforms?.uPatchRadius) {
      this._fadeUniforms.uPatchRadius.value = this.radius;
    }
    if (this._fadeUniforms?.uEdgeFeather) {
      this._fadeUniforms.uEdgeFeather.value = this.edgeFeather;
    }
  }

  _makeBladeTextures() {
    // Small procedural texture so you don't need extra assets.
    const size = 128;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d");

    ctx.clearRect(0, 0, size, size);
    for (let i = 0; i < 2300; i++) {
      const x = (Math.random() * size) | 0;
      const y = (Math.random() * size) | 0;
      const len = 12 + Math.random() * 62;
      const g = 120 + Math.random() * 80;
      ctx.strokeStyle = `rgba(${g*0.35}, ${g}, ${g*0.35}, 0.14)`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (Math.random() * 2 - 1), y + len);
      ctx.stroke();
    }

    const map = new THREE.CanvasTexture(canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = this.renderer?.capabilities?.getMaxAnisotropy?.() || 1;

    // Use same canvas for alphaMap (alphaTest does the cutout)
    const alphaMap = new THREE.CanvasTexture(canvas);
    alphaMap.colorSpace = THREE.NoColorSpace;
    alphaMap.anisotropy = map.anisotropy;

    return { map, alphaMap };
  }

  _installFades(material) {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uCameraPos = { value: new THREE.Vector3() };
      shader.uniforms.uFadeNear = { value: this.fadeNear };
      shader.uniforms.uFadeFar  = { value: this.fadeFar };

      shader.uniforms.uPatchCenter = { value: new THREE.Vector2(this._lastCenter.x, this._lastCenter.y) };
      shader.uniforms.uPatchRadius = { value: this.radius };
      shader.uniforms.uEdgeFeather = { value: this.edgeFeather };

      this._fadeUniforms = shader.uniforms;

      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vWorldPos;")
        .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvWorldPos = worldPosition.xyz;");

      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>
          varying vec3 vWorldPos;
          uniform vec3 uCameraPos;
          uniform float uFadeNear;
          uniform float uFadeFar;
          uniform vec2 uPatchCenter;
          uniform float uPatchRadius;
          uniform float uEdgeFeather;
        `)
        .replace("#include <dithering_fragment>", `
          // Camera distance fade
          float d = distance(vWorldPos, uCameraPos);
          float camFade = 1.0 - smoothstep(uFadeNear, uFadeFar, d);

          // Patch edge feather fade (2D distance in XY)
          float r2d = distance(vWorldPos.xy, uPatchCenter);
          float edge0 = max(0.0, uPatchRadius - uEdgeFeather);
          float edgeFade = 1.0 - smoothstep(edge0, uPatchRadius, r2d);

          gl_FragColor.a *= (camFade * edgeFade);
          #include <dithering_fragment>
        `);
    };

    material.needsUpdate = true;
  }
}

function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect = ((yi > y) !== (yj > y)) &&
      (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-9) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function mulberry32(a) {
  return function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}
