import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { flowArc } from "../effects/flow";
import { colorizeDensity } from "../effects/heat";
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
