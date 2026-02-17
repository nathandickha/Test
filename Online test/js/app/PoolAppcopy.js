// js/app/PoolApp.js
import * as THREE from "https://esm.sh/three@0.158.0";
import { TransformControls } from "https://esm.sh/three@0.158.0/examples/jsm/controls/TransformControls.js";

import {
  initScene,
  updateGroundVoid,
  updatePoolWaterVoid,
  updateGrassForPool
} from "../scene.js";

import { createPoolGroup } from "../pool/pool.js";
import { EditablePolygon } from "../pool/editing/polygon.js";

import {
  createSpa,
  spas,
  setSelectedSpa,
  setSpaTopOffset,
  updateSpa,
  snapToPool
} from "../pool/spa.js";

import { PoolEditor } from "../pool/pool-editor.js";

import { setupSidePanels } from "../ui/UI.js";
import { PBRManager } from "../pbr/PBR.js";
import { CausticsSystem } from "../caustics/Caustics.js";
import { createRectanglePool } from "../pool/shapes/rectanglePool.js";
import { createOvalPool } from "../pool/shapes/ovalPool.js";
import { createKidneyPool } from "../pool/shapes/kidneyPool.js";
import { createLShapePool } from "../pool/shapes/lshapePool.js";

export class PoolApp {
    constructor() {
    this.poolParams = {
      length: 10,
      width: 5,
      shallow: 1.2,
      deep: 2.5,
      shape: "rectangular",
      shallowFlat: 2,
      deepFlat: 2,
      stepCount: 3,
      stepDepth: 0.2,

      notchLengthX: 0.4,
      notchWidthY: 0.45,

      kidneyLeftRadius: 2.0,
      kidneyRightRadius: 3.0,
      kidneyOffset: 1.0
    };

    this.tileSize = 0.3;

    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.ground = null;
    this.controls = null;
    this.clock = null;

    this.editablePolygon = null;
    this.poolGroup = null;

    this.spa = null;
    this.transformControls = null;

    this.poolEditor = null;
    this.pbrManager = null;
    this.caustics = null;

    // Step interaction state
    this.selectedStep = null;
    this.hoveredStep = null;
    this.hoverHighlightMesh = null;
    this.selectedHighlightMesh = null;

    // Wall interaction state
    this.selectedWall = null;
    this.hoveredWall = null;
    this.hoverWallHighlightMesh = null;
    this.selectedWallHighlightMesh = null;
  }

  // -----------------------------
  // Caustics controls (called by UI)
  // -----------------------------
  setCausticsEnabled(enabled) {
    this.caustics?.setEnabled?.(enabled);
    // Re-attach (in case materials were rebuilt while disabled)
    if (enabled) this.caustics?.attachToGroup?.(this.poolGroup, { waterMesh: (this.poolGroup?.userData?.waterMesh || this.poolGroup?.userData?.water || null), light: (this.scene?.userData?.dirLight || null) })
  }

  setCausticsSizeMultiplier(mult) {
    this.caustics?.setSizeMultiplier?.(mult);
  }

  setCausticsSpeedMultiplier(mult) {
    this.caustics?.setSpeedMultiplier?.(mult);
  }

  setCausticsIntensity(intensity) {
    this.caustics?.setIntensity?.(intensity);
  }


  // --------------------------------------------------------------
  // INTERNAL: remove poolGroup safely without disposing PBR-managed textures
  // (dispose geometry only; PBRManager owns texture/material lifecycle)
  // --------------------------------------------------------------
  _removePoolGroupSafely(group) {
    if (!group) return;

    try {
      if (group.parent) group.parent.remove(group);
      else if (this.scene) this.scene.remove(group);
    } catch (_) {}

    // Dispose geometries only (avoid disposing materials/textures that may be re-used)
    group.traverse((o) => {
      if (!o || !o.isMesh) return;
      try { o.geometry?.dispose?.(); } catch (_) {}
    });
  }

  // --------------------------------------------------------------
  // INTERNAL: coalesce expensive PBR re-application so we do not race
  // against rapid polygon edits (prevents tiles disappearing after edits)
  // --------------------------------------------------------------
  _schedulePBRApply() {
    if (!this.pbrManager || !this.poolGroup) return;

    const token = (this._pbrApplyToken = (this._pbrApplyToken || 0) + 1);
    const targetGroup = this.poolGroup;

    requestAnimationFrame(async () => {
      if (token !== this._pbrApplyToken) return;
      if (!this.pbrManager || this.poolGroup !== targetGroup) return;

      this.pbrManager.setPoolGroup(this.poolGroup);
      this.pbrManager.updatePoolParamsRef(this.poolParams);

      try {
        await this.pbrManager.applyCurrentToGroup();
      
        // Ensure caustics are attached after PBR materials are created/updated
        this.caustics?.attachToGroup?.(this.poolGroup, { waterMesh: (this.poolGroup?.userData?.waterMesh || this.poolGroup?.userData?.water || null), light: (this.scene?.userData?.dirLight || null) })
} catch (_) {}

      if (token !== this._pbrApplyToken) return;

      if (this.spa) {
        try {
          snapToPool(this.spa);
          updateSpa(this.spa);
          await this.pbrManager.applyTilesToSpa(this.spa);
      // Attach caustics to spa interior too
      try { this.caustics?.attachToGroup?.(this.spa, { waterMesh: (this.poolGroup?.userData?.waterMesh || this.poolGroup?.userData?.water || null), light: (this.scene?.userData?.dirLight || null) }) } catch (e) {}
          
        // Ensure caustics are attached to spa materials as well
        this.caustics?.attachToGroup?.(this.spa, { waterMesh: (this.poolGroup?.userData?.waterMesh || this.poolGroup?.userData?.water || null), light: (this.scene?.userData?.dirLight || null) })
updatePoolWaterVoid(this.poolGroup, this.spa);
        } catch (_) {}
      }
    });
  }


  
  // --------------------------------------------------------------
  // UV / GROUT ALIGNMENT HELPERS
  //  - Keeps tile density fixed when meshes are scaled (steps/walls)
  //  - Snaps step grout across treads + risers
  //  - Snaps floor grout to a stable origin per-shape rebuild
  // --------------------------------------------------------------
  computeAndStoreUVOrigins() {
    if (!this.poolGroup) return;

    // Ensure matrices are up to date
    this.poolGroup.updateMatrixWorld?.(true);

    // Floor origin: prefer the tagged floor mesh, else use poolGroup bounds
    let floorOrigin = null;

    const floors = [];
    this.poolGroup.traverse((o) => o.userData?.isFloor && floors.push(o));

    const tmpBox = new THREE.Box3();

    if (floors.length) {
      tmpBox.setFromObject(floors[0]);
      floorOrigin = { x: tmpBox.min.x, y: tmpBox.min.y };
    } else {
      tmpBox.setFromObject(this.poolGroup);
      floorOrigin = { x: tmpBox.min.x, y: tmpBox.min.y };
    }

    this.poolGroup.userData.floorUVOrigin = floorOrigin;

    // Step origin: left-most edge across all step meshes (treads/risers)
    const steps = [];
    this.poolGroup.traverse((o) => o.userData?.isStep && steps.push(o));

    if (steps.length) {
      let minEdgeX = Infinity;

      steps.forEach((s) => {
        if (!s.geometry?.boundingBox) s.geometry?.computeBoundingBox?.();
        const bb = s.geometry?.boundingBox;
        if (!bb) return;

        const baseLen = (bb.max.x - bb.min.x) || 0;
        const len = baseLen * (s.scale?.x || 1);
        const left = (s.position?.x || 0) - len * 0.5;
        if (left < minEdgeX) minEdgeX = left;
      });

      if (isFinite(minEdgeX)) {
        this.poolGroup.userData.stepUVOriginX = minEdgeX;
        // z=0 is the pool datum (coping level) in your builders
        this.poolGroup.userData.stepUVOriginZ = 0;
      }
    }
  }

  rebakePoolTilingUVs() {
    if (!this.poolGroup) return;

    // Recompute origins each rebuild (shape changes shift bounds)
    this.computeAndStoreUVOrigins();

    // Update UVs on any mesh that relies on fixed-density tiling
    this.poolGroup.traverse((o) => {
      if (!o?.isMesh) return;

      // Floors, walls, steps (treads + risers) are the main targets
      if (o.userData?.isFloor || o.userData?.isWall || o.userData?.isStep || o.userData?.forceVerticalUV) {
        this.updateScaledBoxTilingUVs(o);
      }
    });
  }

  updateScaledBoxTilingUVs(mesh) {
    if (!mesh?.isMesh || !mesh.geometry?.attributes?.position) return;

    const geo = mesh.geometry;
    const pos = geo.attributes.position;
    const nrm = geo.attributes.normal;
    if (!nrm) return;

    const tile = this.tileSize || 0.3;

    // Per-group origins for grout snapping
    const g = mesh.parent?.userData || this.poolGroup?.userData || {};
    const stepOriginX = (g.stepUVOriginX ?? 0);
    const stepOriginZ = (g.stepUVOriginZ ?? 0);
    const floorOrigin = g.floorUVOrigin ?? { x: 0, y: 0 };

    // Mesh scale (for step extension / wall raise scaling)
    const sx = mesh.scale?.x ?? 1;
    const sy = mesh.scale?.y ?? 1;
    const sz = mesh.scale?.z ?? 1;

    const uvs = new Float32Array(pos.count * 2);

    for (let i = 0; i < pos.count; i++) {
      // Local vertex scaled to match world-space tiling density
      const lx = pos.getX(i) * sx;
      const ly = pos.getY(i) * sy;
      const lz = pos.getZ(i) * sz;

      const ax = Math.abs(nrm.getX(i));
      const ay = Math.abs(nrm.getY(i));
      const az = Math.abs(nrm.getZ(i));

      let u = 0, v = 0;

      // RISERS: vertical faces must use Z for vertical grout density
      // (older mapping used Y, which collapses grout on risers)
      if (mesh.userData?.forceVerticalUV || mesh.userData?.isRiser) {
        if (ax >= ay && ax >= az) {
          // normal ~X => plane is YZ
          u = (ly + (mesh.position?.y || 0) - floorOrigin.y) / tile;
          v = (lz + (mesh.position?.z || 0) - stepOriginZ) / tile;
        } else if (ay >= ax && ay >= az) {
          // normal ~Y => plane is XZ
          u = (lx + (mesh.position?.x || 0) - stepOriginX) / tile;
          v = (lz + (mesh.position?.z || 0) - stepOriginZ) / tile;
        } else {
          // fallback
          u = (lx + (mesh.position?.x || 0) - stepOriginX) / tile;
          v = (ly + (mesh.position?.y || 0) - floorOrigin.y) / tile;
        }

      // STEP TREADS: align along X from step origin, and along Y from floor origin
      } else if (mesh.userData?.isStep && az >= ax && az >= ay) {
        u = (lx + (mesh.position?.x || 0) - stepOriginX) / tile;
        v = (ly + (mesh.position?.y || 0) - floorOrigin.y) / tile;

      // POOL FLOOR: align to floor origin in XY
      } else if (mesh.userData?.isFloor && az >= ax && az >= ay) {
        u = (lx + (mesh.position?.x || 0) - floorOrigin.x) / tile;
        v = (ly + (mesh.position?.y || 0) - floorOrigin.y) / tile;

      // WALLS (vertical): lock grout to floor origin horizontally, and Z vertically
      } else if (mesh.userData?.isWall) {
        if (ax >= ay && ax >= az) {
          // plane YZ
          u = (ly + (mesh.position?.y || 0) - floorOrigin.y) / tile;
          v = (lz + (mesh.position?.z || 0)) / tile;
        } else {
          // plane XZ
          u = (lx + (mesh.position?.x || 0) - floorOrigin.x) / tile;
          v = (lz + (mesh.position?.z || 0)) / tile;
        }

      // Fallback triplanar-ish projection
      } else {
        if (az >= ax && az >= ay) {
          u = (lx + (mesh.position?.x || 0)) / tile;
          v = (ly + (mesh.position?.y || 0)) / tile;
        } else if (ay >= ax && ay >= az) {
          u = (lx + (mesh.position?.x || 0)) / tile;
          v = (lz + (mesh.position?.z || 0)) / tile;
        } else {
          u = (ly + (mesh.position?.y || 0)) / tile;
          v = (lz + (mesh.position?.z || 0)) / tile;
        }
      }

      uvs[i * 2] = u;
      uvs[i * 2 + 1] = v;
    }

    geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));

    // If a material uses uv2 (AO), keep it in sync
    if (geo.attributes.uv2) {
      geo.setAttribute("uv2", geo.attributes.uv.clone());
    }

    geo.attributes.uv.needsUpdate = true;
  }

// --------------------------------------------------------------
  // WATER GHOST MODE

  // --------------------------------------------------------------
  // FLOOR REPROFILE AFTER STEP EXTENSION
  // - Moves slope origin to the runtime end of steps run
  // - Raises (cuts out) the floor under step footprints to meet step bottoms
  // --------------------------------------------------------------
  updateFloorAfterStepExtension(steps, originX) {
    if (!this.poolGroup || !Array.isArray(steps) || steps.length === 0) return;
    if (!isFinite(originX)) return;

    // Find the floor mesh (prefer tagged isFloor)
    let floor = null;
    this.poolGroup.traverse((o) => {
      if (!floor && o?.isMesh && o.userData?.isFloor) floor = o;
    });
    floor = floor || this.poolGroup.userData?.floorMesh;
    if (!floor?.geometry?.attributes?.position) return;

    const params = this.poolGroup.userData?.poolParams || {};
    const clampedShallow = Math.max(0.5, Number(params.shallow) || 0.5);
    const clampedDeep = Math.max(clampedShallow, Number(params.deep) || clampedShallow);

    // Determine pool axis start/end from outerPts bbox if available
    let axisStartX = 0;
    let axisEndX = 1;

    const outerPts = this.poolGroup.userData?.outerPts;
    if (Array.isArray(outerPts) && outerPts.length) {
      let minX = Infinity;
      let maxX = -Infinity;
      for (const p of outerPts) {
        const x = p?.x;
        if (!isFinite(x)) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
      if (isFinite(minX) && isFinite(maxX) && maxX > minX) {
        axisStartX = minX;
        axisEndX = maxX;
      }
    } else {
      // fallback: floor bbox in world
      if (!floor.geometry.boundingBox) floor.geometry.computeBoundingBox();
      const bb = floor.geometry.boundingBox;
      const fx = floor.position?.x || 0;
      axisStartX = bb.min.x + fx;
      axisEndX = bb.max.x + fx;
    }

    // If originX is outside the pool span, clamp defensively
    originX = THREE.MathUtils.clamp(originX, axisStartX, axisEndX);

    const fullLen = axisEndX - originX;

    let sFlat = Number(params.shallowFlat) || 0;
    let dFlat = Number(params.deepFlat) || 0;

    const maxFlats = Math.max(0, fullLen - 0.01);
    if (sFlat + dFlat > maxFlats) {
      const scale = (sFlat + dFlat) > 0 ? (maxFlats / (sFlat + dFlat)) : 0;
      sFlat *= scale;
      dFlat *= scale;
    }

    const slopeLen = Math.max(0.01, fullLen - sFlat - dFlat);

    // Build step footprints (world-space AABBs + bottom z)
    const stepBoxes = [];
    for (const step of steps) {
      const geo = step?.geometry;
      if (!geo?.attributes?.position) continue;
      if (!geo.boundingBox) geo.computeBoundingBox();
      const bb = geo.boundingBox;

      const sx = step.scale?.x ?? 1;
      const sy = step.scale?.y ?? 1;
      const sz = step.scale?.z ?? 1;

      const lenX = (bb.max.x - bb.min.x) * sx;
      const lenY = (bb.max.y - bb.min.y) * sy;
      const lenZ = (bb.max.z - bb.min.z) * sz;

      const cx = step.position?.x ?? 0;
      const cy = step.position?.y ?? 0;
      const cz = step.position?.z ?? 0;

      const minX = cx - lenX * 0.5;
      const maxX = cx + lenX * 0.5;
      const minY = cy - lenY * 0.5;
      const maxY = cy + lenY * 0.5;

      const bottomZ = cz - lenZ * 0.5;

      stepBoxes.push({ minX, maxX, minY, maxY, bottomZ });
    }

    const pos = floor.geometry.attributes.position;
    const fx = floor.position?.x || 0;
    const fy = floor.position?.y || 0;

    for (let i = 0; i < pos.count; i++) {
      const worldX = pos.getX(i) + fx;
      const worldY = pos.getY(i) + fy;

      // Base rectangle-style floor depth at X (with new originX)
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

      // Cutout/raise under steps: raise floor to meet step bottoms
      // (raise = move toward 0 => max() in negative Z space)
      for (const b of stepBoxes) {
        if (worldX >= b.minX && worldX <= b.maxX && worldY >= b.minY && worldY <= b.maxY) {
          z = Math.max(z, b.bottomZ);
        }
      }

      pos.setZ(i, z);
    }

    pos.needsUpdate = true;
    floor.geometry.computeVertexNormals();

    // Persist for debugging / other systems
    this.poolGroup.userData.originX = originX;
    this.poolGroup.userData.stepFootprintLen = Math.max(0, originX - axisStartX);

    // Re-UV floor too (slope moved, and floor changed under steps)
    this.updateScaledBoxTilingUVs(floor);
  }

  // --------------------------------------------------------------
  ghostifyWater() {
    if (!this.poolGroup) return;
    const water = this.poolGroup.userData?.waterMesh;
    if (water) water.visible = false;
  }

  restoreWater() {
    if (!this.poolGroup) return;
    const water = this.poolGroup.userData?.waterMesh;
    if (water) water.visible = true;
  }

  // --------------------------------------------------------------
  // STEP HIGHLIGHT HELPERS
  // --------------------------------------------------------------
  updateHighlightForStep(step, isSelected) {
    if (!this.scene || !step) return;

    const scaleFactor = isSelected ? 1.12 : 1.06;
    const opacity = isSelected ? 0.45 : 0.3;

    let highlightMesh = isSelected
      ? this.selectedHighlightMesh
      : this.hoverHighlightMesh;

    if (!highlightMesh) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffff66,
        transparent: true,
        opacity,
        depthWrite: false
      });

      highlightMesh = new THREE.Mesh(step.geometry.clone(), mat);
      highlightMesh.renderOrder = 999;
      this.scene.add(highlightMesh);

      if (isSelected) this.selectedHighlightMesh = highlightMesh;
      else this.hoverHighlightMesh = highlightMesh;
    } else {
      if (highlightMesh.geometry) highlightMesh.geometry.dispose();
      highlightMesh.geometry = step.geometry.clone();
      highlightMesh.material.opacity = opacity;
    }

    highlightMesh.position.copy(step.position);
    highlightMesh.rotation.copy(step.rotation);
    highlightMesh.scale.copy(step.scale).multiplyScalar(scaleFactor);
    highlightMesh.visible = true;
  }

  clearHoverHighlight() {
    if (this.hoverHighlightMesh) this.hoverHighlightMesh.visible = false;
    this.hoveredStep = null;
  }

  clearSelectedHighlight() {
    if (this.selectedHighlightMesh) this.selectedHighlightMesh.visible = false;
    this.selectedStep = null;
  }

  // --------------------------------------------------------------
  // WALL HIGHLIGHT HELPERS (blue)
  // --------------------------------------------------------------
  updateHighlightForWall(wall, isSelected) {
    if (!this.scene || !wall) return;

    const scaleFactor = isSelected ? 1.08 : 1.04;
    const opacity = isSelected ? 0.5 : 0.3;

    let highlightMesh = isSelected
      ? this.selectedWallHighlightMesh
      : this.hoverWallHighlightMesh;

    if (!highlightMesh) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x66aaff,
        transparent: true,
        opacity,
        depthWrite: false
      });

      highlightMesh = new THREE.Mesh(wall.geometry.clone(), mat);
      highlightMesh.renderOrder = 998;
      this.scene.add(highlightMesh);

      if (isSelected) this.selectedWallHighlightMesh = highlightMesh;
      else this.hoverWallHighlightMesh = highlightMesh;
    } else {
      if (highlightMesh.geometry) highlightMesh.geometry.dispose();
      highlightMesh.geometry = wall.geometry.clone();
      highlightMesh.material.opacity = opacity;
    }

    highlightMesh.position.copy(wall.position);
    highlightMesh.rotation.copy(wall.rotation);
    highlightMesh.scale.copy(wall.scale).multiplyScalar(scaleFactor);
    highlightMesh.visible = true;
  }

  clearWallHoverHighlight() {
    if (this.hoverWallHighlightMesh) {
      this.hoverWallHighlightMesh.visible = false;
    }
    this.hoveredWall = null;
  }

  clearWallSelectedHighlight() {
    if (this.selectedWallHighlightMesh) {
      this.selectedWallHighlightMesh.visible = false;
    }
    this.selectedWall = null;

    // Also reset wall UI slider directly (defensive, in case UI.js
    // is not listening to events)
    const row = document.getElementById("wallRaiseRow");
    const slider = document.getElementById("wallRaise");
    const val = document.getElementById("wallRaise-val");

    if (row) row.style.display = "none";
    if (slider) {
      slider.disabled = true;
      slider.value = "0";
    }
    if (val) val.textContent = "0.00 m";
  }

  // --------------------------------------------------------------
  // STEP SELECTION (hover + click)
  // --------------------------------------------------------------
  setupStepSelection() {
    if (!this.renderer || !this.camera) return;
    const dom = this.renderer.domElement;

    // Hover – highlight only, do not open panel
    dom.addEventListener("pointermove", (event) => {
      if (!this.poolGroup) return;

      if (this.poolEditor?.isDragging) return;

      const rect = dom.getBoundingClientRect();
      const mouse = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
      );

      const ray = new THREE.Raycaster();
      ray.setFromCamera(mouse, this.camera);

      const steps = [];
      this.poolGroup.traverse((o) => o.userData?.isStep && steps.push(o));

      if (!steps.length) {
        this.clearHoverHighlight();
        return;
      }

      const hit = ray.intersectObjects(steps, true);
      if (!hit.length) {
        this.clearHoverHighlight();
        return;
      }

      const step = hit[0].object;

      if (step === this.selectedStep) {
        this.clearHoverHighlight();
        return;
      }

      if (step !== this.hoveredStep) {
        this.hoveredStep = step;
        this.updateHighlightForStep(step, false);
      }
    });

    // Select – pick step, ghost water, open Steps panel
    dom.addEventListener("pointerdown", (event) => {
      if (!this.poolGroup) return;

      const rect = dom.getBoundingClientRect();
      const mouse = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
      );

      const ray = new THREE.Raycaster();
      ray.setFromCamera(mouse, this.camera);

      const steps = [];
      this.poolGroup.traverse((o) => o.userData?.isStep && steps.push(o));

      const hit = steps.length ? ray.intersectObjects(steps, true) : [];

      // If a step is hit, consume this event so wall selection / ripple do not also fire
      if (hit.length) {
        event.stopImmediatePropagation();
      }
      if (!hit.length) {
        const hadSel = !!this.selectedStep;
        this.clearSelectedHighlight();
        if (hadSel) {
          document.dispatchEvent(new CustomEvent("stepSelectionCleared"));
          document.dispatchEvent(new CustomEvent("stepsPanelClosed"));
          this.restoreWater();
        }
        return;
      }

      const step = hit[0].object;
      this.selectedStep = step;

      this.updateHighlightForStep(step, true);
      this.clearHoverHighlight();

      // Open Steps panel via UI helper (if present)
      if (window.openPanelFromCode) {
        window.openPanelFromCode("steps");
      }

      // Fire panel-open event so existing listeners (camera zoom, ghost)
      // continue to work as before
      document.dispatchEvent(new CustomEvent("stepsPanelOpened"));

      // ghost water for clearer view of steps
      this.ghostifyWater();

      document.dispatchEvent(new CustomEvent("stepSelected"));
    });
  }

  // --------------------------------------------------------------
  // STEP EXTENSION SLIDER (CHAIN PUSH, ALL SHAPES)
  // --------------------------------------------------------------
  setupStepExtensionSlider() {
    const slider = document.getElementById("stepExtension");
    const output = document.getElementById("stepExtension-val");
    if (!slider) return;

    if (output) {
      output.textContent = parseFloat(slider.value).toFixed(2) + " m";
    }

    slider.addEventListener("input", () => {
      if (!this.selectedStep || !this.poolGroup) return;

      const val = parseFloat(slider.value);
      if (!isFinite(val)) return;

      if (output) {
        output.textContent = val.toFixed(2) + " m";
      }

      const steps = [];
      this.poolGroup.traverse((o) => {
        if (o.userData && o.userData.isStep) steps.push(o);
      });
      if (!steps.length) return;

      steps.forEach((step) => {
        if (!step.geometry.boundingBox) {
          step.geometry.computeBoundingBox();
        }
      });

      const selGeo = this.selectedStep.geometry;
      if (!selGeo.boundingBox) selGeo.computeBoundingBox();
      const selBBox = selGeo.boundingBox;
      let selBaseLength = selBBox.max.x - selBBox.min.x;
      if (!isFinite(selBaseLength) || selBaseLength <= 0) {
        selBaseLength = 0.3;
      }

      const newScaleX = val / selBaseLength;
      this.selectedStep.scale.x = newScaleX;

      // compute left-most edge among all steps
      let minEdgeX = Infinity;
      steps.forEach((step) => {
        const geo = step.geometry;
        const bbox = geo.boundingBox;
        const baseLen = bbox.max.x - bbox.min.x;
        const length = baseLen * step.scale.x;
        const leftEdge = step.position.x - length * 0.5;
        if (leftEdge < minEdgeX) minEdgeX = leftEdge;
      });
      if (!isFinite(minEdgeX)) return;

      // chain them left to right
      let runX = minEdgeX;
      steps
        .sort((a, b) => a.position.x - b.position.x)
        .forEach((step) => {
          const geo = step.geometry;
          const bbox = geo.boundingBox;
          const baseLen = bbox.max.x - bbox.min.x;
          const length = baseLen * step.scale.x;

          const centerX = runX + length * 0.5;
          step.position.x = centerX;

          runX += length;
        });

            // Rebake UVs so tile density stays fixed after scaling/position changes
      steps.forEach((s) => this.updateScaledBoxTilingUVs(s));

      // Reprofile floor: move slope origin + cut out under steps
      this.updateFloorAfterStepExtension(steps, runX);

      this.updateHighlightForStep(this.selectedStep, true);
      this.ghostifyWater();
    });
  }

  // --------------------------------------------------------------
  // WALL SELECTION (hover + click) – opens Features panel
  // --------------------------------------------------------------
  setupWallSelection() {
    if (!this.renderer || !this.camera) return;
    const dom = this.renderer.domElement;

    // Hover: always allowed, independent of panel state
    dom.addEventListener("pointermove", (event) => {
      if (!this.poolGroup) return;

      if (this.poolEditor?.isDragging) return;

      const rect = dom.getBoundingClientRect();
      const mouse = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
      );

      const ray = new THREE.Raycaster();
      ray.setFromCamera(mouse, this.camera);

      const walls = [];
      this.poolGroup.traverse((o) => o.userData?.isWall && walls.push(o));

      if (!walls.length) {
        this.clearWallHoverHighlight();
        return;
      }

      const hit = ray.intersectObjects(walls, true);
      if (!hit.length) {
        this.clearWallHoverHighlight();
        return;
      }

      const wall = hit[0].object;

      if (wall === this.selectedWall) {
        this.clearWallHoverHighlight();
        return;
      }

      if (wall !== this.hoveredWall) {
        this.hoveredWall = wall;
        this.updateHighlightForWall(wall, false);
      }
    });

    // Select: pick wall, open Features panel, sync slider
    dom.addEventListener("pointerdown", (event) => {
      if (!this.poolGroup) return;

      const rect = dom.getBoundingClientRect();
      const mouse = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
      );

      const ray = new THREE.Raycaster();
      ray.setFromCamera(mouse, this.camera);

      const walls = [];
      this.poolGroup.traverse((o) => o.userData?.isWall && walls.push(o));

      const hit = walls.length ? ray.intersectObjects(walls, true) : [];
      if (!hit.length) {
        const hadSel = !!this.selectedWall;
        this.clearWallSelectedHighlight();
        if (hadSel) {
          document.dispatchEvent(new CustomEvent("wallSelectionCleared"));
        }
        return;
      }

      const wall = hit[0].object;
      this.selectedWall = wall;

      this.updateHighlightForWall(wall, true);
      this.clearWallHoverHighlight();

      // Open Features panel via UI helper, if available
      if (window.openPanelFromCode) {
        window.openPanelFromCode("features");
      }

      // initialise slider UI from wall meta
      const row = document.getElementById("wallRaiseRow");
      const slider = document.getElementById("wallRaise");
      const valSpan = document.getElementById("wallRaise-val");

      if (row) row.style.display = "block";

      if (slider) {
        let baseHeight = wall.userData?.baseHeight;
        if (!isFinite(baseHeight) || baseHeight <= 0) {
          const params = wall.geometry?.parameters;
          baseHeight =
            (params && typeof params.depth === "number" && params.depth > 0)
              ? params.depth
              : 1;
          wall.userData.baseHeight = baseHeight;
        }

        const currentHeight =
          wall.userData?.currentHeight ?? baseHeight * (wall.scale?.z || 1);
        const extra = Math.max(0, currentHeight - baseHeight);

        slider.disabled = false;
        slider.value = extra.toFixed(2);

        if (valSpan) {
          valSpan.textContent = extra.toFixed(2) + " m";
        }
      }

      document.dispatchEvent(new CustomEvent("wallSelected"));
    });
  }

  // --------------------------------------------------------------
  // WALL RAISE SLIDER
  //  - raises selected wall
  //  - raises coping:
  //      * per-wall, if copingSegments + wall.copingIndex exist
  //      * otherwise, global ring coping using max extra
  // --------------------------------------------------------------
  setupWallRaiseSlider() {
    const slider = document.getElementById("wallRaise");
    const output = document.getElementById("wallRaise-val");
    if (!slider) return;

    if (output) {
      output.textContent =
        parseFloat(slider.value || "0").toFixed(2) + " m";
    }

    slider.addEventListener("input", () => {
      if (!this.selectedWall || !this.poolGroup) return;

      const extra = parseFloat(slider.value || "0");
      if (!isFinite(extra)) return;

      if (output) {
        output.textContent = extra.toFixed(2) + " m";
      }

      const wall = this.selectedWall;

      let baseHeight = wall.userData?.baseHeight;
      if (!isFinite(baseHeight) || baseHeight <= 0) {
        const params = wall.geometry?.parameters;
        baseHeight =
          (params && typeof params.depth === "number" && params.depth > 0)
            ? params.depth
            : 1;
        wall.userData.baseHeight = baseHeight;
      }

      const newHeight = baseHeight + extra;
      const scaleZ = newHeight / baseHeight;

      // Scale around center but keep bottom fixed at original depth:
      // original: center at -baseHeight/2 => bottom = -baseHeight, top = 0
      // after raise: bottom still -baseHeight, top = +extra
      wall.scale.z = scaleZ;
      wall.position.z = -(baseHeight / 2) + extra / 2;

      // Rebake UVs so tile density stays fixed after scaling
      this.updateScaledBoxTilingUVs(wall);

      wall.userData.currentHeight = newHeight;
      wall.userData.extraHeight = extra;

      // --- Coping handling ---
      const copingSegments = this.poolGroup.userData?.copingSegments;
      const copingRing = this.poolGroup.userData?.copingMesh;

      // Preferred: per-wall coping segment
      if (
        Array.isArray(copingSegments) &&
        wall.userData &&
        wall.userData.copingIndex != null
      ) {
        const idx = wall.userData.copingIndex;
        const seg = copingSegments[idx];
        if (seg) {
          if (!seg.userData) seg.userData = {};
          if (seg.userData.baseZ == null) {
            seg.userData.baseZ = seg.position.z;
          }
          // top of wall is at +extra => coping bottom should be at +extra
          seg.position.z = seg.userData.baseZ + extra;
        }
      } else if (copingRing) {
        // Fallback: move entire coping ring using highest extra across walls
        if (!copingRing.userData) copingRing.userData = {};
        if (copingRing.userData.baseZ == null) {
          copingRing.userData.baseZ = copingRing.position.z;
        }

        const walls = [];
        this.poolGroup.traverse((o) => o.userData?.isWall && walls.push(o));
        let maxExtra = 0;
        walls.forEach((w) => {
          const e = w.userData?.extraHeight || 0;
          if (e > maxExtra) maxExtra = e;
        });

        copingRing.position.z = copingRing.userData.baseZ + maxExtra;
      }

      this.updateHighlightForWall(wall, true);
    });
  }

  // --------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------
  isPolygonShape() {
    return this.poolParams.shape === "freeform";
  }

  destroyPoolEditor() {
    if (this.poolEditor) {
      this.poolEditor.dispose?.();
      this.poolEditor = null;
    }
  }

  // --------------------------------------------------------------
  // REBUILD POOL
  // --------------------------------------------------------------
  async rebuildPoolForCurrentShape() {
    if (this.poolGroup) {
      this._removePoolGroupSafely(this.poolGroup);
    }

    let group;

    if (this.isPolygonShape()) {
      if (!this.editablePolygon) {
        this.editablePolygon = EditablePolygon.fromRectangle(
          this.poolParams.length,
          this.poolParams.width
        );
        this.editablePolygon.isRectangular = true;
        this.editablePolygon.minVertices = 3;
      }

      group = createPoolGroup(
        this.poolParams,
        this.tileSize,
        this.editablePolygon
      );
    } else {
      this.editablePolygon = null;
      this.destroyPoolEditor();

      const shape = this.poolParams.shape;

      if (shape === "rectangular")
        group = createRectanglePool(this.poolParams, this.tileSize);
      else if (shape === "oval")
        group = createOvalPool(this.poolParams, this.tileSize);
      else if (shape === "kidney")
        group = createKidneyPool(this.poolParams, this.tileSize);
      else if (shape === "L")
        group = createLShapePool(this.poolParams, this.tileSize);
      else group = createRectanglePool(this.poolParams, this.tileSize);
    }

    this.poolGroup = group;

    // Ensure fixed tile density + snapped grout after any rebuild (shape/params)
    this.rebakePoolTilingUVs();

    if (this.scene && this.poolGroup) {
      this.scene.add(this.poolGroup);
updateGroundVoid(this.ground || this.scene.userData.ground, this.poolGroup);
      updateGrassForPool(this.scene, this.poolGroup);
    }

    if (this.pbrManager && this.poolGroup) {
      this.pbrManager.setPoolGroup(this.poolGroup);
      this.pbrManager.updatePoolParamsRef(this.poolParams);
      await this.pbrManager.applyCurrentToGroup();
    }

    if (this.spa && this.poolGroup && this.pbrManager) {
      snapToPool(this.spa);
      updateSpa(this.spa);
      await this.pbrManager.applyTilesToSpa(this.spa);
      updatePoolWaterVoid(this.poolGroup, this.spa);
    }

    if (this.isPolygonShape() && this.editablePolygon) {
      this.setupPoolEditor();
    }

    // Clear step selection and notify UI
    const hadSelection = !!this.selectedStep;
    this.clearHoverHighlight();
    this.clearSelectedHighlight();
    if (hadSelection) {
      document.dispatchEvent(new CustomEvent("stepSelectionCleared"));
      document.dispatchEvent(new CustomEvent("stepsPanelClosed"));
      this.restoreWater();
    }

    // Clear wall selection and notify UI
    const hadWallSel = !!this.selectedWall;
    this.clearWallHoverHighlight();
    this.clearWallSelectedHighlight();
    if (hadWallSel) {
      document.dispatchEvent(new CustomEvent("wallSelectionCleared"));
    }

    // If steps panel currently open (from UI), keep water ghosted
    const stepsPanel = document.getElementById("panel-steps");
    if (stepsPanel?.classList.contains("open")) this.ghostifyWater();
  }

  // --------------------------------------------------------------
  // START
  // --------------------------------------------------------------
  async start() {
    setupSidePanels();

    const { scene, camera, renderer, ground, controls } = await initScene();
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
    // Wire renderer into caustics RT system
    this.caustics?.setRenderer?.(renderer);
    this.ground = ground;
    this.controls = controls;
    this.clock = new THREE.Clock();

    // Water interior prepass render target (used by stylized water refraction)
    const _sz = new THREE.Vector2();
    this.renderer.getSize(_sz);
    this._waterInteriorRT = new THREE.WebGLRenderTarget(_sz.x, _sz.y, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat
    });
    // Water depth prepass (packed RGBA depth) for thickness/absorption in water shader
    this._waterDepthRT = new THREE.WebGLRenderTarget(_sz.x, _sz.y, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat
    });
    this._waterDepthMat = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking
    });
    this._waterDepthMat.blending = THREE.NoBlending;


    // Keep RT in sync with window resize (scene.js also resizes renderer/camera)
    window.addEventListener("resize", () => {
      const s = new THREE.Vector2();
      this.renderer.getSize(s);
      this._waterInteriorRT.setSize(s.x, s.y);
      this._waterDepthRT?.setSize(s.x, s.y);

      const wm = this.poolGroup?.userData?.waterMesh;
      const u = wm?.material?.uniforms;
      if (u?.resolution) u.resolution.value.set(s.x, s.y);
    });


    this.caustics = new CausticsSystem();
    // NOTE: poolGroup is built in rebuildPoolForCurrentShape(); we attach after that.
    console.log('✅ PoolApp created CausticsSystem:', this.caustics);
// PBR / Caustics integration should never hard-crash the app if a module fails
    // to load or throws during initialization. If it fails, we continue without PBR.
    try {
      this.pbrManager = new PBRManager(this.poolParams, this.tileSize, this.caustics);
    } catch (err) {
      console.error("[PoolApp] PBRManager init failed; continuing without PBR.", err);
      this.pbrManager = null;
    }

    await this.rebuildPoolForCurrentShape();

    // Final defensive attach (in case materials changed during rebuild)
    try { this.caustics?.attachToGroup?.(this.poolGroup, { waterMesh: (this.poolGroup?.userData?.waterMesh || this.poolGroup?.userData?.water || null), light: (this.scene?.userData?.dirLight || null) }) } catch (_) {}

    // Guard all calls: if PBR is unavailable (or poolGroup not yet built), keep running.
    if (this.poolGroup && this.pbrManager && typeof this.pbrManager.setPoolGroup === "function") {
      this.pbrManager.setPoolGroup(this.poolGroup);
      if (typeof this.pbrManager.initButtons === "function") {
        await this.pbrManager.initButtons(this.poolGroup);
      }
    }

    this.setupSpaSystem();
    this.setupShapeDropdown();
    this.setupSpaSliders();
    this.setupPoolSliders();
    this.setupRippleClick();

    this.updateShapeUIVisibility();

    // steps
    this.setupStepSelection();
    this.setupStepExtensionSlider();

    // walls
    this.setupWallSelection();
    this.setupWallRaiseSlider();

    // Make sure UI sliders reflect the current poolParams
    this.syncSlidersFromParams();

    // CAMERA ZOOM WHEN STEPS PANEL OPENS
    document.addEventListener("stepsPanelOpened", () => {
      this.ghostifyWater();

      if (!this.poolGroup) return;

      const steps = [];
      this.poolGroup.traverse((o) => o.userData?.isStep && steps.push(o));
      if (!steps.length) return;

      const firstStep = steps[0];
      const target = firstStep.position.clone();
      target.z += 0.3;

      const cam = this.camera;
      const ctrl = this.controls;

      const offset = new THREE.Vector3(3, 2, 2);
      const newPos = target.clone().add(offset);

      const duration = 0.8;
      const startPos = cam.position.clone();
      const startTarget = ctrl.target.clone();
      const startTime = performance.now();

      const animateCam = (now) => {
        const t = Math.min(1, (now - startTime) / (duration * 1000));
        const k = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

        cam.position.lerpVectors(startPos, newPos, k);
        ctrl.target.lerpVectors(startTarget, target, k);
        ctrl.update();

        if (t < 1) requestAnimationFrame(animateCam);
      };

      requestAnimationFrame(animateCam);
    });

    document.addEventListener("stepsPanelClosed", () => {
      this.restoreWater();
      const hadSel = !!this.selectedStep;
      this.clearHoverHighlight();
      this.clearSelectedHighlight();
      if (hadSel)
        document.dispatchEvent(new CustomEvent("stepSelectionCleared"));
    });

    this.animate();
  }

  // --------------------------------------------------------------
  // SPA SYSTEM
  // --------------------------------------------------------------
  setupSpaSystem() {
    const btn = document.getElementById("addRemoveSpa");
    if (!btn) return;

    const initialLabel = btn.textContent;

    this.setSpaSlidersEnabled(false);

    btn.addEventListener("click", () => {
      if (!this.spa) {
        this.addSpa();
        btn.textContent = "Remove Spa";
      } else {
        this.removeSpa();
        btn.textContent = initialLabel;
      }
    });
  }

  async addSpa() {
    this.spa = createSpa(this.poolParams, this.scene);

    snapToPool(this.spa);
    updateSpa(this.spa);

    await this.pbrManager.applyTilesToSpa(this.spa);

    if (this.poolGroup) updatePoolWaterVoid(this.poolGroup, this.spa);

    if (!this.transformControls) {
      this.transformControls = new TransformControls(
        this.camera,
        this.renderer.domElement
      );
      this.transformControls.setMode("translate");

      this.transformControls.addEventListener("change", () => {
        if (this.spa && this.poolGroup)
          updatePoolWaterVoid(this.poolGroup, this.spa);
      });

      this.transformControls.addEventListener(
        "dragging-changed",
        async (e) => {
          this.controls.enabled = !e.value;

          if (!e.value && this.spa) {
            snapToPool(this.spa);
            updateSpa(this.spa);

            await this.pbrManager.applyTilesToSpa(this.spa);

            updatePoolWaterVoid(this.poolGroup, this.spa);
          }
        }
      );

      this.scene.add(this.transformControls);
    }

    this.transformControls.attach(this.spa);
    this.setSpaSlidersEnabled(true);
  }

  removeSpa() {
    if (!this.spa) return;

    this.scene.remove(this.spa);

    const index = spas.indexOf(this.spa);
    if (index !== -1) spas.splice(index, 1);

    this.spa = null;
    setSelectedSpa(null);

    if (this.transformControls) this.transformControls.detach();

    this.setSpaSlidersEnabled(false);

    if (this.poolGroup) updatePoolWaterVoid(this.poolGroup, null);
  }

  setSpaSlidersEnabled(state) {
    ["spaLength", "spaWidth", "spaTopHeight"].forEach((id) => {
      const slider = document.getElementById(id);
      if (slider) slider.disabled = !state;
    });
  }

// --------------------------------------------------------------
// FREEFORM POLYGON EDITOR
// --------------------------------------------------------------
setupPoolEditor() {
  this.destroyPoolEditor();
  if (!this.isPolygonShape() || !this.editablePolygon) return;

  this.poolEditor = new PoolEditor(
    this.scene,
    this.editablePolygon,
    this.renderer.domElement,
    {
      handleSize: 0.15,

      onPolygonChange: () => {
        if (!this.isPolygonShape()) return;
        if (!this.scene || !this.editablePolygon) return;

        // Remove old pool
        if (this.poolGroup) {
          this._removePoolGroupSafely(this.poolGroup);
        }

        // 🔴 FULL REBUILD — REQUIRED FOR FLOOR + STEPS + WALLS
        this.poolGroup = createPoolGroup(
          this.poolParams,
          this.tileSize,
          this.editablePolygon
        );

        this.scene.add(this.poolGroup);

        // Ground + water void must be updated immediately
        updateGroundVoid(this.ground, this.poolGroup);
          updateGrassForPool(this.scene, this.poolGroup);
        updateGrassForPool(this.scene, this.poolGroup);

        // 🔴 THESE TWO LINES WERE MISSING
        // They force floor + steps to deform with the polygon
        this.computeAndStoreUVOrigins();
        this.rebakePoolTilingUVs();

        // Defer expensive PBR + spa logic (prevents tile popping)
        this._schedulePBRApply();
      }
    }
  );
}

  // --------------------------------------------------------------
  // SHAPE UI
  // --------------------------------------------------------------
  setupShapeDropdown() {
    const select = document.getElementById("shape");
    if (!select) return;

    select.value = this.poolParams.shape;

    select.addEventListener("change", async (e) => {
      this.poolParams.shape = e.target.value;

      this.updateShapeUIVisibility();

      if (this.isPolygonShape()) {
        this.editablePolygon = EditablePolygon.fromRectangle(
          this.poolParams.length,
          this.poolParams.width
        );
        this.editablePolygon.isRectangular = true;
        this.editablePolygon.minVertices = 3;
      } else {
        this.editablePolygon = null;
        this.destroyPoolEditor();
      }

      // keep UI in sync with current params, including shape
      this.syncSlidersFromParams();

      await this.rebuildPoolForCurrentShape();

    // Final defensive attach (in case materials changed during rebuild)
    try { this.caustics?.attachToGroup?.(this.poolGroup, { waterMesh: (this.poolGroup?.userData?.waterMesh || this.poolGroup?.userData?.water || null), light: (this.scene?.userData?.dirLight || null) }) } catch (_) {}
    });
  }

  updateShapeUIVisibility() {
    const shape = this.poolParams.shape;

    const kidney = document.getElementById("kidney-controls");
    const lshape = document.getElementById("lshape-controls");
    const freeform = document.getElementById("freeform-hint");

    if (kidney) kidney.style.display = shape === "kidney" ? "block" : "none";
    if (lshape) lshape.style.display = shape === "L" ? "block" : "none";
    if (freeform)
      freeform.style.display = shape === "freeform" ? "block" : "none";
  }

  // --------------------------------------------------------------
  // SPA SLIDERS
  // --------------------------------------------------------------
  setupSpaSliders() {
    ["spaLength", "spaWidth", "spaTopHeight"].forEach((id) => {
      const slider = document.getElementById(id);
      const output = document.getElementById(`${id}-val`);
      if (!slider) return;

      slider.addEventListener("input", async (e) => {
        if (!this.spa) return;

        const val = parseFloat(e.target.value);
        if (output) output.textContent = val.toFixed(2) + " m";

        if (id === "spaLength") this.spa.userData.spaLength = val;
        else if (id === "spaWidth") this.spa.userData.spaWidth = val;
        else if (id === "spaTopHeight") setSpaTopOffset(val);

        updateSpa(this.spa);
        await this.pbrManager.applyTilesToSpa(this.spa);

        if (this.poolGroup) updatePoolWaterVoid(this.poolGroup, this.spa);
      });
    });
  }

  // --------------------------------------------------------------
  // POOL SLIDERS
  // --------------------------------------------------------------
  setupPoolSliders() {
    const ids = [
      "length",
      "width",
      "shallow",
      "deep",
      "shallowFlat",
      "deepFlat",
      "stepCount",
      "stepDepth",
      "notchLengthX",
      "notchWidthY",
      "kidneyLeftRadius",
      "kidneyRightRadius",
      "kidneyOffset"
    ];

    ids.forEach((id) => {
      const slider = document.getElementById(id);
      const output = document.getElementById(`${id}-val`);
      if (!slider) return;

      slider.addEventListener("input", async (e) => {
        let val = parseFloat(e.target.value);
        if (id === "stepCount") val = Math.floor(val);

        this.poolParams[id] = val;

        if (output) {
          if (
            id === "length" ||
            id === "width" ||
            id === "shallow" ||
            id === "deep" ||
            id === "shallowFlat" ||
            id === "deepFlat" ||
            id === "stepDepth" ||
            id === "kidneyLeftRadius" ||
            id === "kidneyRightRadius" ||
            id === "kidneyOffset"
          ) {
            output.textContent = val.toFixed(2) + " m";
          } else {
            output.textContent = val.toString();
          }
        }

        if ((id === "length" || id === "width") && this.isPolygonShape()) {
          if (this.editablePolygon?.rescaleTo) {
            this.editablePolygon.rescaleTo(
              this.poolParams.length,
              this.poolParams.width
            );
          }

          if (this.poolGroup && this.scene)
            this.scene.remove(this.poolGroup);

          this.poolGroup = createPoolGroup(
            this.poolParams,
            this.tileSize,
            this.editablePolygon
          );
          this.scene.add(this.poolGroup);
          updateGroundVoid(this.ground, this.poolGroup);
          updateGrassForPool(this.scene, this.poolGroup);
        updateGrassForPool(this.scene, this.poolGroup);

          if (this.pbrManager) {
            this.pbrManager.setPoolGroup(this.poolGroup);
            this.pbrManager.updatePoolParamsRef(this.poolParams);
            await this.pbrManager.applyCurrentToGroup();
          }

          if (this.spa && this.pbrManager) {
            snapToPool(this.spa);
            updateSpa(this.spa);
            await this.pbrManager.applyTilesToSpa(this.spa);
            updatePoolWaterVoid(this.poolGroup, this.spa);
          }

          return;
        }

        await this.rebuildPoolForCurrentShape();

    // Final defensive attach (in case materials changed during rebuild)
    try { this.caustics?.attachToGroup?.(this.poolGroup, { waterMesh: (this.poolGroup?.userData?.waterMesh || this.poolGroup?.userData?.water || null), light: (this.scene?.userData?.dirLight || null) }) } catch (_) {}
      });
    });
  }

  // --------------------------------------------------------------
// RIPPLE
  // --------------------------------------------------------------
  setupRippleClick() {
    this.renderer.domElement.addEventListener("dblclick", (event) => {
      if (this.poolEditor?.isDragging) return;
      if (!this.poolGroup?.userData?.waterMesh) return;

      const rect = this.renderer.domElement.getBoundingClientRect();
      const mouseX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      const mouseY = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(mouseX, mouseY), this.camera);

      const hit = ray.intersectObject(this.poolGroup.userData.waterMesh);
      if (!hit.length) return;

      const p = hit[0].point;

      // ✅ SAFE GUARD (RESTORES OLD FREEFORM BEHAVIOUR)
      if (typeof this.poolGroup.userData.triggerRipple === "function") {
        this.poolGroup.userData.triggerRipple(
          p.x,
          p.y,
          this.poolParams.length,
          this.poolParams.width
        );
      }
    });
  }

  // --------------------------------------------------------------
  // NEW: keep UI sliders in sync with poolParams
  // --------------------------------------------------------------
  syncSlidersFromParams() {
    const ids = [
      "length",
      "width",
      "shallow",
      "deep",
      "shallowFlat",
      "deepFlat",
      "stepCount",
      "stepDepth",
      "notchLengthX",
      "notchWidthY",
      "kidneyLeftRadius",
      "kidneyRightRadius",
      "kidneyOffset"
    ];

    ids.forEach((id) => {
      const slider = document.getElementById(id);
      const output = document.getElementById(`${id}-val`);
      if (!slider) return;
      if (!(id in this.poolParams)) return;

      const val = this.poolParams[id];
      slider.value = val;

      if (output) {
        if (
          id === "length" ||
          id === "width" ||
          id === "shallow" ||
          id === "deep" ||
          id === "shallowFlat" ||
          id === "deepFlat" ||
          id === "stepDepth" ||
          id === "kidneyLeftRadius" ||
          id === "kidneyRightRadius" ||
          id === "kidneyOffset"
        ) {
          output.textContent = Number(val).toFixed(2) + " m";
        } else {
          output.textContent = val.toString();
        }
      }
    });

    // shape dropdown
    const shapeSelect = document.getElementById("shape");
    if (shapeSelect && this.poolParams.shape) {
      shapeSelect.value = this.poolParams.shape;
    }
  }

  // --------------------------------------------------------------
  // LOOP
  // --------------------------------------------------------------
  animate() {
    requestAnimationFrame(() => this.animate());

    const delta = this.clock.getDelta();

const dirLight = this.scene?.userData?.dirLight || null;

if (this.poolGroup?.userData?.animatables) {
  this.poolGroup.userData.animatables.forEach((obj) => {
    obj.userData.animate?.(delta, this.clock, this.camera, dirLight, this.renderer);
  });
}

spas.forEach((spaItem) => {
  spaItem.userData.waterMesh?.userData.animate?.(delta, this.clock, this.camera, dirLight, this.renderer);
});


    // Pool water animation (GPU sim)
    this.poolGroup?.userData?.waterMesh?.userData?.animate?.(delta, this.clock, this.camera, dirLight, this.renderer);

    if (this.caustics) {
      if (!this._loggedCausticsTick) { console.log('✅ Caustics update ticking'); this._loggedCausticsTick = true; }
      // Drive caustics from the live water GPU height texture (same mechanism as Water.zip)
      const wm = this.poolGroup?.userData?.waterMesh;
      const ht = wm?.material?.uniforms?.heightTex?.value || null;
      this.caustics.setWaterHeightTexture?.(ht, 512);

      this.caustics.update(delta, (dirLight && dirLight.position) ? dirLight.position : null);
    }
// Keep freeform handles screen-aligned and interactive
    this.poolEditor?.update?.();

    this.scene?.userData?.grassSystem?.update?.(this.camera);
    // Stylized water prepass:
// Render scene WITHOUT any water meshes into offscreen RTs, then let the water shader
// sample those textures for refraction + thickness absorption.
const _poolWater = this.poolGroup?.userData?.waterMesh || null;
const _poolU = _poolWater?.material?.uniforms || null;

// Collect all water meshes (pool + spas) so none of them contaminate the prepasses
const _hiddenWater = [];
if (_poolWater) _hiddenWater.push(_poolWater);
spas.forEach((s) => {
  const wm = s?.userData?.waterMesh;
  if (wm && wm !== _poolWater) _hiddenWater.push(wm);
});

if (_poolWater && _poolU && this._waterInteriorRT) {
  // Use drawing-buffer size (accounts for devicePixelRatio), because gl_FragCoord is in buffer pixels
  const _buf = new THREE.Vector2();
  this.renderer.getDrawingBufferSize(_buf);

  // Keep RT sizes synced (defensive: resize handler covers most cases, but DPR can change)
  if (this._waterInteriorRT.width !== _buf.x || this._waterInteriorRT.height !== _buf.y) {
    this._waterInteriorRT.setSize(_buf.x, _buf.y);
  }
  if (this._waterDepthRT && (this._waterDepthRT.width !== _buf.x || this._waterDepthRT.height !== _buf.y)) {
    this._waterDepthRT.setSize(_buf.x, _buf.y);
  }

  if (_poolU.resolution) _poolU.resolution.value.set(_buf.x, _buf.y);
  if (_poolU.interiorTex) _poolU.interiorTex.value = this._waterInteriorRT.texture;

  // Hide water meshes for BOTH passes
  _hiddenWater.forEach((m) => (m.visible = false));

  // Depth prepass (DepthTexture) – must not contain water
  if (this._waterDepthRT && _poolU.depthTex) {
    _poolU.depthTex.value = this._waterDepthRT.depthTexture;
    if (_poolU.cameraNear) _poolU.cameraNear.value = this.camera.near;
    if (_poolU.cameraFar)  _poolU.cameraFar.value  = this.camera.far;

    // Render scene depth into the DepthTexture target
    this.renderer.setRenderTarget(this._waterDepthRT);
    this.renderer.clear(true, true, true);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);

    // Re-bind (defensive) – in case a rebuild replaced water material/uniforms
    if (_poolWater?.userData?.setDepthTex) _poolWater.userData.setDepthTex(this._waterDepthRT.depthTexture);
  }

  // Color prepass (scene without water) for refraction
  this.renderer.setRenderTarget(this._waterInteriorRT);
  this.renderer.clear(true, true, true);
  this.renderer.render(this.scene, this.camera);
  this.renderer.setRenderTarget(null);

  if (_poolWater?.userData?.setInteriorTex) _poolWater.userData.setInteriorTex(this._waterInteriorRT.texture);

  // Restore visibility
  _hiddenWater.forEach((m) => (m.visible = true));
}

this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}