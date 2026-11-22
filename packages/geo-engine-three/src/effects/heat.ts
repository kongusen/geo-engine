import * as THREE from "three";
import { densityGrid, type Position } from "@yaoyu/geo-engine";
import { defineOverlay, disposeTree } from "../overlay";

export interface HeatDatum {
  position: Position;
  weight?: number;
}

/** type: "heat" —— 核密度热力图(产量分布、客流密度),铺在当前层级上方。仅平面模式。 */
export interface HeatLayerData {
  points: HeatDatum[];
  /** 影响半径(相对特征长度),默认 0.12。 */
  radius?: number;
  /** 色带(由低到高);默认 主色 → 黄 → 橙 → 红。 */
  colors?: string[];
  /** 整体不透明度,默认 0.85。 */
  opacity?: number;
  /** 网格分辨率(长边格数),默认 220。 */
  resolution?: number;
}

/** 把密度网格着色为 RGBA 纹理数据(低密度透明)。 */
export function colorizeDensity(values: Float32Array, max: number, colors: string[]): Uint8Array {
  const stops = colors.map((c) => new THREE.Color(c));
  const out = new Uint8Array(values.length * 4);
  const tmp = new THREE.Color();
  for (let i = 0; i < values.length; i++) {
    const v = max > 0 ? values[i] / max : 0;
    if (v <= 0.01) continue;
    const x = Math.min(0.9999, v) * (stops.length - 1);
    const j = Math.floor(x);
    tmp.copy(stops[j]).lerp(stops[j + 1], x - j);
    out[i * 4] = Math.round(tmp.r * 255);
    out[i * 4 + 1] = Math.round(tmp.g * 255);
    out[i * 4 + 2] = Math.round(tmp.b * 255);
    out[i * 4 + 3] = Math.round(255 * Math.min(1, Math.pow(v, 0.7) * 1.15));
  }
  return out;
}

export const heatLayer = defineOverlay<HeatLayerData>({
  type: "heat",
  modes: ["plane"],
  create(ctx, spec) {
    const data = spec.data ?? { points: [] };
    const group = new THREE.Group();
    ctx.group.add(group);
    const bounds = ctx.bounds!;
    const radius = ctx.scale * (data.radius ?? 0.12);
    const pad = radius;
    const b = { minX: bounds.minX - pad, minY: bounds.minY - pad, maxX: bounds.maxX + pad, maxY: bounds.maxY + pad };
    const w = b.maxX - b.minX;
    const h = b.maxY - b.minY;
    const res = data.resolution ?? 220;
    const cols = w >= h ? res : Math.max(8, Math.round((res * w) / h));
    const rows = w >= h ? Math.max(8, Math.round((res * h) / w)) : res;
    const pts = data.points
      .filter((p) => ctx.contains(p.position))
      .map((p) => {
        const [x, y] = ctx.planeXY(p.position)!;
        return { x, y, weight: p.weight };
      });
    const grid = densityGrid(pts, b, cols, rows, radius);
    const colors = data.colors ?? [ctx.theme.accent, "#fde047", "#fb923c", "#ef4444"];
    const texture = new THREE.DataTexture(colorizeDensity(grid.values, grid.max, colors), cols, rows, THREE.RGBAFormat);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: data.opacity ?? 0.85, depthWrite: false, blending: THREE.AdditiveBlending });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
    mesh.position.set((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, ctx.maxSurface + ctx.unitHeight * 0.05);
    mesh.renderOrder = 4;
    group.add(mesh);
    const base = material.opacity;
    return {
      tick(t) {
        // 轻微呼吸,提示这是动态分布
        material.opacity = (material.userData.k ?? 1) * base * (0.9 + 0.1 * Math.sin(t * 1.6));
      },
      setOpacity(k) {
        material.userData.k = k;
        material.opacity = base * k;
      },
      dispose() {
        texture.dispose();
        disposeTree(group);
      },
    };
  },
});
