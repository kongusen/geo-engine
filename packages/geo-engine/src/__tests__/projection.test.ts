import { describe, expect, it } from "vitest";
import {
  angularDistance,
  cameraDistance,
  createLocalProjection,
  distanceMeters,
  greatCircle,
  lngLatToSphere,
  morph,
  sphereToLngLat,
  tangentFrame,
  viewFor,
} from "../projection";

const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe("projection", () => {
  it("球面坐标约定与往返", () => {
    expect(lngLatToSphere([0, 0]).map((v) => +v.toFixed(12))).toEqual([0, 0, 1]);
    expect(lngLatToSphere([90, 0])[0]).toBeCloseTo(1);
    expect(lngLatToSphere([0, 90])[1]).toBeCloseTo(1);
    const p = sphereToLngLat(lngLatToSphere([108.9, 25.75]));
    expect(p[0]).toBeCloseTo(108.9, 10);
    expect(p[1]).toBeCloseTo(25.75, 10);
  });

  it("切平面基正交且 up 指向球面点", () => {
    const { east, north, up } = tangentFrame([108.9, 25.75]);
    expect(dot(east, north)).toBeCloseTo(0);
    expect(dot(east, up)).toBeCloseTo(0);
    expect(dot(north, up)).toBeCloseTo(0);
    expect(dot(north, north)).toBeCloseTo(1);
  });

  it("方位等距投影:往返、到中心距离保真、中心与球面切点重合", () => {
    const center: [number, number] = [108.9, 25.75];
    const proj = createLocalProjection(center);
    const p: [number, number] = [109.5, 26.2];
    const v = proj.forward(p);
    const back = proj.inverse(v);
    expect(back[0]).toBeCloseTo(p[0], 9);
    expect(back[1]).toBeCloseTo(p[1], 9);
    expect(Math.hypot(v[0], v[1])).toBeCloseTo(angularDistance(center, p), 12);
    // x 向东为正,y 向北为正
    expect(v[0]).toBeGreaterThan(0);
    expect(v[1]).toBeGreaterThan(0);
    const t = proj.toTangent3D([0, 0]);
    const s = lngLatToSphere(center);
    t.forEach((x, i) => expect(x).toBeCloseTo(s[i], 12));
  });

  it("变形插值的端点分别是球面与平面", () => {
    expect(morph([0, 0, 1], [1, 0, 1], 0)).toEqual([0, 0, 1]);
    expect(morph([0, 0, 1], [1, 0, 1], 1)).toEqual([1, 0, 1]);
    expect(morph([0, 0, 1], [1, 0, 1], 0.5)).toEqual([0.5, 0, 1]);
  });

  it("大圆插值与距离", () => {
    const mid = greatCircle([0, 0], [90, 0], 0.5);
    expect(mid[0]).toBeCloseTo(45);
    expect(distanceMeters([0, 0], [0, 1]) / 1000).toBeCloseTo(111.19, 1);
  });

  it("按区域大小选择场景,全球为球面", () => {
    expect(viewFor(null).scene).toBe("globe");
    expect(viewFor([73, 18, 135, 54]).scene).toBe("plane"); // 中国:国家尺度用平面板块
    expect(viewFor([-170, -50, 170, 75]).scene).toBe("globe"); // 洲际以上
    expect(viewFor([103.6, 24.6, 109.6, 29.2]).scene).toBe("plane"); // 贵州
    expect(viewFor([108.2, 25.3, 109.3, 26.1]).scene).toBe("plane"); // 从江
  });

  it("相机距离随区域增大而增大", () => {
    expect(cameraDistance(0.02, 45, 16 / 9)).toBeGreaterThan(cameraDistance(0.01, 45, 16 / 9));
    expect(cameraDistance(Math.PI / 2, 45, 16 / 9, 1.1, "globe")).toBeGreaterThan(2);
  });
});

describe("viewForRegion", () => {
  it("外接矩形中心在区域外时改用质心;紧凑区域保持外接矩形中心", async () => {
    const { viewForRegion, viewFor } = await import("../projection");
    const { toRegion } = await import("@yaoyu/geo-data");
    const box = (x0: number, y0: number, x1: number, y1: number) => [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] as [number, number][][];
    // 本土 + 远处小岛:外接矩形中心落在海上
    const split = toRegion({ id: "US", name: "US", polygons: [box(-125, 25, -67, 49), box(-160, 19, -155, 22)] });
    const v = viewForRegion(split);
    expect(v.center[0]).toBeGreaterThan(-125);
    expect(v.center[0]).toBeLessThan(-67);
    const compact = toRegion({ id: "C", name: "C", polygons: [box(100, 20, 110, 30)] });
    expect(viewForRegion(compact)).toEqual(viewFor(compact.bbox));
  });
});
