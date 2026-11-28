import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { clusterLayer } from "../effects/cluster";
import { flowArc } from "../effects/flow";
import { colorizeDensity } from "../effects/heat";
import { markerLayer } from "../effects/marker";
import type { OverlayContext } from "../overlay";
import { createTheme } from "../theme";

const base = {
  group: new THREE.Group(),
  theme: createTheme(),
  unitHeight: 1,
  contains: () => true,
  planeXY: () => null,
  bounds: null,
  maxSurface: 0,
  baseHeight: 0,
  unproject: () => null,
  camera: () => new THREE.PerspectiveCamera(),
  region: () => undefined,
  resolution: () => ({ width: 1, height: 1 }),
  label: () => {
    throw new Error("not used");
  },
};

describe("flowArc", () => {
  it("平面:两端落地,中点抬高", () => {
    const ctx: OverlayContext = {
      ...base,
      mode: "plane",
      scale: 10,
      position: ([x, y], h = 0) => new THREE.Vector3(x, y, h),
      up: () => new THREE.Vector3(0, 0, 1),
    };
    const pts = flowArc(ctx, [0, 0], [10, 0], 0.3, 10);
    expect(pts[0].toArray()).toEqual([0, 0, 0]);
    expect(pts[10].toArray()).toEqual([10, 0, 0]);
    expect(pts[5].z).toBeCloseTo(1.5); // 二次贝塞尔中点高度 = 控制点高度 / 2
  });

  it("地球:端点在球面,弧顶离球面最高", () => {
    const R = 100;
    const ctx: OverlayContext = {
      ...base,
      mode: "globe",
      scale: R,
      position: ([lng, lat], h = 0) => {
        const l = (lng * Math.PI) / 180;
        const b = (lat * Math.PI) / 180;
        return new THREE.Vector3(Math.cos(b) * Math.sin(l), Math.sin(b), Math.cos(b) * Math.cos(l)).multiplyScalar(R + h);
      },
      up: () => new THREE.Vector3(0, 1, 0),
    };
    const pts = flowArc(ctx, [100, 20], [120, 30], 0.3, 20);
    expect(pts[0].length()).toBeCloseTo(R);
    expect(pts[20].length()).toBeCloseTo(R);
    const heights = pts.map((p) => p.length() - R);
    expect(Math.max(...heights)).toBeCloseTo(heights[10]);
    expect(heights[10]).toBeGreaterThan(0);
  });
});

describe("colorizeDensity", () => {
  it("低于阈值透明,峰值不透明且取最高色", () => {
    const rgba = colorizeDensity(new Float32Array([0, 0.005, 1]), 1, ["#000000", "#ff0000"]);
    expect(rgba[3]).toBe(0);
    expect(rgba[7]).toBe(0);
    expect(rgba[11]).toBe(255);
    expect(rgba[8]).toBeGreaterThan(250);
  });
});

describe("clusterLayer", () => {
  const points = [
    { id: "a", name: "A", position: [100, 25] as [number, number] },
    { id: "b", name: "B", position: [100.1, 25.05] as [number, number] },
    { id: "c", name: "C", position: [120, 30] as [number, number] },
  ];

  it("平面模式下聚合并沿 +Z 浮动", () => {
    const group = new THREE.Group();
    const ctx: OverlayContext = {
      ...base,
      group,
      mode: "plane",
      scale: 10,
      unitHeight: 0.5,
      planeXY: ([x, y]) => [x, y],
      position: ([x, y], h = 0) => new THREE.Vector3(x, y, h),
      up: () => new THREE.Vector3(0, 0, 1),
      label: () => new THREE.Object3D() as never,
    };
    const instance = clusterLayer.create(ctx, { id: "cl", type: "cluster", data: { points, cellSize: 0.5 } });
    const container = group.children[0] as THREE.Group;
    expect(container.children).toHaveLength(2);
    const clustered = container.children.find((m) => m.children.length > 0)! as THREE.Mesh;
    expect(clustered.children.length).toBeGreaterThanOrEqual(2); // halo + label
    const z0 = clustered.position.z;
    instance.tick?.(Math.PI / (2 * 1.4), 0.016);
    expect(clustered.position.z).not.toBe(z0);
    group.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(new THREE.Vector3(clustered.position.x, clustered.position.y, 10), new THREE.Vector3(0, 0, -1));
    const hit = instance.pick?.(ray);
    expect(hit).toBeTruthy();
    expect((hit!.item as { count: number }).count).toBe(2);
    instance.dispose();
    expect(group.children).toHaveLength(0);
  });

  it("地球模式下按球面弧长聚合并沿法线对齐与浮动", () => {
    const R = 100;
    const group = new THREE.Group();
    const unit = ([lng, lat]: [number, number]) => {
      const l = (lng * Math.PI) / 180;
      const b = (lat * Math.PI) / 180;
      return new THREE.Vector3(Math.cos(b) * Math.sin(l), Math.sin(b), Math.cos(b) * Math.cos(l));
    };
    const ctx: OverlayContext = {
      ...base,
      group,
      mode: "globe",
      scale: R,
      unitHeight: 2,
      position: (p, h = 0) => unit(p).multiplyScalar(R + h),
      up: (p) => unit(p),
      label: () => new THREE.Object3D() as never,
    };
    const instance = clusterLayer.create(ctx, { id: "cl", type: "cluster", data: { points, cellSize: 0.12 } });
    const container = group.children[0] as THREE.Group;
    expect(container.children).toHaveLength(2);
    const bubble = container.children[0] as THREE.Mesh;
    const r0 = bubble.position.length();
    instance.tick?.(Math.PI / (2 * 1.4), 0.016);
    expect(bubble.position.length()).toBeGreaterThan(r0);
    instance.dispose();
    expect(group.children).toHaveLength(0);
  });
});

describe("markerLayer", () => {
  const markers = [
    { id: "m1", name: "卡口1", position: [0, 0] as [number, number], shape: "pin" as const, color: "#22d3ee", sizePx: 32 },
    { id: "m2", name: "卡口2", position: [50, 0] as [number, number], shape: "diamond" as const, active: true },
  ];

  it("平面模式创建 Sprite、支持 clipToRegions 开关、pick 拾取、onHover 与 dispose", () => {
    const group = new THREE.Group();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 1000);
    camera.position.set(0, 0, 100);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();

    const ctx: OverlayContext = {
      ...base,
      group,
      mode: "plane",
      scale: 100,
      unitHeight: 2,
      contains: ([x]) => x < 10,
      position: ([x, y], h = 0) => new THREE.Vector3(x, y, h),
      up: () => new THREE.Vector3(0, 0, 1),
      camera: () => camera,
      resolution: () => ({ width: 1000, height: 1000 }),
      label: () => new THREE.Object3D() as never,
    };

    // 默认 clipToRegions=false 保留全部点位
    const inst = markerLayer.create(ctx, { id: "mk", type: "marker", data: { markers } });
    const container = group.children[0] as THREE.Group;
    expect(container.children).toHaveLength(2);

    inst.tick?.(0, 0.016);
    const s1 = container.children[0] as THREE.Sprite;
    const baseScale = s1.scale.x;
    expect(baseScale).toBeGreaterThan(0);

    group.updateMatrixWorld(true);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(0, 0), camera);
    const hit = inst.pick?.(ray);
    expect((hit?.item as { id: string } | undefined)?.id).toBe("m1");

    inst.onHover?.(hit!);
    expect(s1.scale.x).toBeGreaterThan(baseScale);
    inst.onHover?.(null);
    expect(s1.scale.x).toBeCloseTo(baseScale, 6);

    inst.setOpacity?.(0.5);
    expect(s1.material.opacity).toBe(0.5);

    inst.dispose();
    expect(group.children).toHaveLength(0);

    // clipToRegions=true 时过滤掉板块外的点
    const clipped = markerLayer.create(ctx, { id: "mk2", type: "marker", data: { markers, clipToRegions: true } });
    expect((group.children[0] as THREE.Group).children).toHaveLength(1);
    clipped.dispose();
  });

  it("update() 增量复用现有 Sprite,仅增删改变化条目", () => {
    const group = new THREE.Group();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 1000);
    camera.position.set(0, 0, 100);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();

    const ctx: OverlayContext = {
      ...base,
      group,
      mode: "plane",
      scale: 100,
      unitHeight: 2,
      position: ([x, y], h = 0) => new THREE.Vector3(x, y, h),
      up: () => new THREE.Vector3(0, 0, 1),
      camera: () => camera,
      resolution: () => ({ width: 1000, height: 1000 }),
      label: () => new THREE.Object3D() as never,
    };

    const inst = markerLayer.create(ctx, { id: "mk", type: "marker", data: { markers } });
    const container = group.children[0] as THREE.Group;
    const firstSprite = container.children[0] as THREE.Sprite;

    // 保留 m1(仅改 active 与坐标)、移除 m2、新增 m3
    const ok = inst.update?.({
      id: "mk",
      type: "marker",
      data: {
        markers: [
          { ...markers[0], position: [10, 5], active: true },
          { id: "m3", position: [20, 0], shape: "circle" },
        ],
      },
    });
    expect(ok).toBe(true);
    expect(container.children).toHaveLength(2);
    expect(container.children[0]).toBe(firstSprite); // 复用同一 Sprite 实例
    expect(firstSprite.position.x).toBe(10);
    expect((container.children[1] as THREE.Sprite).name).toBe("marker:m3");
    inst.dispose();
  });

  it("地球模式自动隐藏背面半球标记", () => {
    const R = 100;
    const group = new THREE.Group();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 2000);
    camera.position.set(0, 0, 400);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();

    const unit = ([lng, lat]: [number, number]) => {
      const l = (lng * Math.PI) / 180;
      const b = (lat * Math.PI) / 180;
      return new THREE.Vector3(Math.cos(b) * Math.sin(l), Math.sin(b), Math.cos(b) * Math.cos(l));
    };
    const ctx: OverlayContext = {
      ...base,
      group,
      mode: "globe",
      scale: R,
      unitHeight: 2,
      position: (p, h = 0) => unit(p).multiplyScalar(R + h),
      up: (p) => unit(p),
      camera: () => camera,
      resolution: () => ({ width: 1000, height: 1000 }),
      label: () => new THREE.Object3D() as never,
    };

    const inst = markerLayer.create(ctx, {
      id: "mk-g",
      type: "marker",
      data: {
        markers: [
          { id: "front", position: [0, 0] },
          { id: "back", position: [180, 0] },
        ],
      },
    });
    inst.tick?.(0, 0.016);
    const sprites = (group.children[0] as THREE.Group).children as THREE.Sprite[];
    expect(sprites[0].visible).toBe(true);
    expect(sprites[1].visible).toBe(false);
    inst.dispose();
  });
});
