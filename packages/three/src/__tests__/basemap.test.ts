import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { gcj02ToWgs84, type TileSource } from "@geodive/core";
import { basemap, basemapLayer } from "../effects/basemap";
import type { OverlayContext } from "../overlay";
import { createPlaneMapper, plateGeometry, regionShapes } from "../shapes";
import { createTheme } from "../theme";

const center: [number, number] = [108.9, 25.7];
const R = 100;

/** 俯视一个县级范围的平面上下文:相机在切点正上方。 */
function planeCtx(): { ctx: OverlayContext; group: THREE.Group } {
  const mapper = createPlaneMapper(center, R);
  const group = new THREE.Group();
  const camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.001, 1000);
  camera.position.set(0, 0, 1.2);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const [x0, y0] = mapper.project([108.2, 25.3]);
  const [x1, y1] = mapper.project([109.3, 26.0]);
  const ctx: OverlayContext = {
    mode: "plane",
    group,
    theme: createTheme(),
    scale: 1,
    unitHeight: 0.02,
    position: (p, h = 0) => new THREE.Vector3(...mapper.project(p), h),
    up: () => new THREE.Vector3(0, 0, 1),
    contains: () => true,
    planeXY: (p) => mapper.project(p),
    bounds: { minX: x0, minY: y0, maxX: x1, maxY: y1 },
    maxSurface: 0,
    baseHeight: 0,
    unproject: (x, y) => mapper.unproject(x, y),
    camera: () => camera,
    region: () => undefined,
    resolution: () => ({ width: 1600, height: 900 }),
    label: () => {
      throw new Error("not used");
    },
  };
  return { ctx, group };
}

const stubSource = (id: string, crs: TileSource["crs"], loads: string[]): TileSource => ({
  id,
  url: "{z}/{x}/{y}",
  crs,
  maxZoom: 18,
  load: async (t) => {
    loads.push(`${t.z}/${t.x}/${t.y}`);
    return { width: 256, height: 256 } as unknown as ImageBitmap;
  },
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("basemap 图层", () => {
  it("按视野选级别铺瓦片,并带一层粗级别垫底", async () => {
    const { ctx, group } = planeCtx();
    const loads: string[] = [];
    const instance = basemapLayer.create(ctx, basemap([stubSource("a", "wgs84", loads)]));
    instance.tick!(0, 0);
    await flush();
    const meshes = group.getObjectByName("basemap")!.children as THREE.Mesh[];
    expect(meshes.length).toBeGreaterThan(1);
    const zooms = [...new Set(loads.map((k) => Number(k.split("/")[0])))].sort((a, b) => a - b);
    expect(zooms).toHaveLength(2);
    expect(zooms[1] - zooms[0]).toBe(3);
    // 县域视野下的级别应在 8~12 之间(约 1 像素 ≈ 百米量级)
    expect(zooms[1]).toBeGreaterThanOrEqual(8);
    expect(zooms[1]).toBeLessThanOrEqual(12);
    expect(meshes.every((m) => m.raycast !== THREE.Mesh.prototype.raycast)).toBe(true);
    instance.dispose();
    expect(group.children).toHaveLength(0);
  });

  it("GCJ-02 瓦片逐顶点纠偏到 WGS84", async () => {
    const a = planeCtx();
    const b = planeCtx();
    const wgs = basemapLayer.create(a.ctx, basemap([stubSource("w", "wgs84", [])]));
    const gcj = basemapLayer.create(b.ctx, basemap([stubSource("g", "gcj02", [])]));
    wgs.tick!(0, 0);
    gcj.tick!(0, 0);
    const first = (g: THREE.Group) => (g.getObjectByName("basemap")!.children.at(-1) as THREE.Mesh).geometry.attributes.position;
    const pw = first(a.group);
    const pg = first(b.group);
    // 同一瓦片同一顶点:GCJ 版本应位于 gcj02ToWgs84 之后的位置
    const lngLat = a.ctx.unproject(pw.getX(0), pw.getY(0))!;
    const expected = a.ctx.planeXY(gcj02ToWgs84(lngLat))!;
    expect(pg.getX(0)).toBeCloseTo(expected[0], 6);
    expect(pg.getY(0)).toBeCloseTo(expected[1], 6);
    expect(Math.hypot(pg.getX(0) - pw.getX(0), pg.getY(0) - pw.getY(0))).toBeGreaterThan(0);
    wgs.dispose();
    gcj.dispose();
  });

  it("basemap() 汇总版权、缺省只在平面显示;同源更新只换样式", () => {
    const spec = basemap([
      { id: "x", url: "", attribution: "© 天地图" },
      { id: "y", url: "", attribution: "© 天地图" },
    ]);
    expect(spec).toMatchObject({ type: "basemap", attribution: "© 天地图", visible: { scenes: ["plane"] } });
    const { ctx } = planeCtx();
    const instance = basemapLayer.create(ctx, spec);
    expect(instance.update!({ ...spec, data: { ...spec.data!, style: { grayscale: 1 } } })).toBe(true);
    expect(instance.update!(basemap([{ id: "z", url: "" }]))).toBe(false);
    instance.dispose();
  });
});

describe("plateGeometry", () => {
  it("小部件降低挤出深度,材质分组保持 0 顶面 / 1 侧面", () => {
    const mapper = createPlaneMapper([110, 20], R);
    const big: [number, number][] = [[109, 19], [111, 19], [111, 21], [109, 21], [109, 19]];
    const islet: [number, number][] = [[112, 16], [112.01, 16], [112.01, 16.01], [112, 16.01], [112, 16]];
    const shapes = regionShapes([[big], [islet]], mapper);
    const geometry = plateGeometry(shapes, 1);
    const z = geometry.attributes.position;
    const depths = new Set<number>();
    for (let i = 0; i < z.count; i++) depths.add(Math.round(z.getZ(i) * 100) / 100);
    expect([...depths].sort()).toEqual([0, 0.12, 1]);
    expect(new Set(geometry.groups.map((g) => g.materialIndex))).toEqual(new Set([0, 1]));
    expect(geometry.groups.reduce((n, g) => n + g.count, 0)).toBe(z.count);
  });
});
