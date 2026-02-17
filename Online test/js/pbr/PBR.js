import * as THREE from "https://esm.sh/three@0.158.0";
import { spas } from "../pool/spa.js";

/**
 * PBRManager
 * Uses geometry UVs that are already meter-scaled.
 * No UV scaling here — avoids cross-mesh texture bleed.
 */
export class PBRManager {
  constructor(poolParamsRef, tileSize, causticsSystem) {
    this.poolParamsRef = poolParamsRef;
    this.tileSize = tileSize;
    this.caustics = causticsSystem;

    this.loader = new THREE.TextureLoader();
    this.tileLibrary = {};
    this.currentTileKey = "blue";
    this.poolGroup = null;
  }

  setPoolGroup(group) {
    this.poolGroup = group;
  }

  updatePoolParamsRef(ref) {
    this.poolParamsRef = ref;
  }

  async initButtons(initialPoolGroup) {
    this.poolGroup = initialPoolGroup;

    const buttons = Array.from(document.querySelectorAll(".tile-btn"));
    buttons.forEach((btn) => {
      btn.addEventListener("click", async () => {
        this.currentTileKey = btn.dataset.tile;
        buttons.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        await this.applyCurrentToGroup();
      });
    });

    await this.applyCurrentToGroup();
  }

  loadTexture(path, isColor = false) {
    return new Promise((resolve) => {
      if (!path) return resolve(null);

      this.loader.load(
        path,
        (tex) => {
          tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
          tex.repeat.set(1, 1);
          tex.anisotropy = 8;
          tex.colorSpace = isColor
            ? THREE.SRGBColorSpace
            : THREE.NoColorSpace;
          resolve(tex);
        },
        undefined,
        () => resolve(null)
      );
    });
  }

  async ensureTileLoaded(tileKey) {
    if (this.tileLibrary[tileKey]) return this.tileLibrary[tileKey];

    // We ship PBR tile sets for blue/black/white as folders:
    // textures/pbr_tiles/<key>/{basecolor,normal,roughness,ao,displacement}.jpg
    // (Older single-image "white_tile.jpg" style assets are not present.)
    const folder = (tileKey === "blue" || tileKey === "black" || tileKey === "white") ? tileKey : "white";
    const base = `textures/pbr_tiles/${folder}/`;

    const maps = {
      map: await this.loadTexture(base + "basecolor.jpg", true),
      normalMap: await this.loadTexture(base + "normal.jpg"),
      roughnessMap: await this.loadTexture(base + "roughness.jpg"),
      aoMap: await this.loadTexture(base + "ao.jpg"),
      displacementMap: await this.loadTexture(base + "displacement.jpg")
    };

    this.tileLibrary[tileKey] = maps;
    return maps;
  }

async applyCurrentToGroup(group = null) {
    if (group) this.poolGroup = group;
    if (!this.poolGroup) return;

    const maps = await this.ensureTileLoaded(this.currentTileKey);
    if (!maps || !maps.map) return;

    this.caustics?.reset?.();

    this.poolGroup.traverse((mesh) => {
      if (!mesh.isMesh || !mesh.geometry) return;
      if (mesh.userData?.isCoping) return;
      if (mesh === this.poolGroup.userData?.waterMesh) return;

      const mat = new THREE.MeshStandardMaterial({
        map: maps.map,
        normalMap: maps.normalMap || null,
        roughnessMap: maps.roughnessMap || null,
        aoMap: maps.aoMap || null,
        displacementMap:
          mesh.userData?.type === "floor" ? maps.displacementMap : null,
        displacementScale:
          mesh.userData?.type === "floor" ? 0.003 : 0,
        metalness: 0.0,
        roughness: maps.roughnessMap ? 0.85 : 0.65
      });

      if (maps.aoMap && !mesh.geometry.attributes.uv2) {
        mesh.geometry.setAttribute(
          "uv2",
          mesh.geometry.attributes.uv.clone()
        );
      }

      this.caustics?.addToMaterial?.(mat);

      mesh.material = mat;
      mesh.material.needsUpdate = true;
    });

    spas.forEach((spa) => this.applyTilesToSpa(spa));
  }

  async applyTilesToSpa(spa) {
    if (!spa) return;

    const maps = await this.ensureTileLoaded(this.currentTileKey);
    if (!maps || !maps.map) return;

    spa.traverse((mesh) => {
      if (!mesh.isMesh || mesh.userData?.isSpaWater) return;

      const mat = new THREE.MeshStandardMaterial({
        map: maps.map,
        normalMap: maps.normalMap || null,
        roughnessMap: maps.roughnessMap || null,
        aoMap: maps.aoMap || null,
        metalness: 0.0,
        roughness: maps.roughnessMap ? 0.85 : 0.65
      });

      if (maps.aoMap && !mesh.geometry.attributes.uv2) {
        mesh.geometry.setAttribute(
          "uv2",
          mesh.geometry.attributes.uv.clone()
        );
      }

      this.caustics?.addToMaterial?.(mat);

      mesh.material = mat;
      mesh.material.needsUpdate = true;
    });
  }
}
