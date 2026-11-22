import { describe, expect, it } from "vitest";
import {
  areaKm2,
  centroidOf,
  interiorPoint,
  isRingClosed,
  pointInMultiPolygon,
  pointInPolygon,
  rewindPolygon,
  signedRingArea,
  simplifyRing,
  unwrapRing,
} from "../geometry";
import type { Ring } from "../types";
import { rect } from "./fixtures";

describe("geometry", () => {
  it("区分环绕向并统一为外环逆时针、洞顺时针", () => {
    const outerCw = [...rect(0, 0, 10, 10)].reverse();
    const holeCcw = rect(2, 2, 4, 4);
    expect(signedRingArea(outerCw)).toBeLessThan(0);
    const [outer, hole] = rewindPolygon([outerCw, holeCcw]);
    expect(signedRingArea(outer)).toBe(100);
    expect(signedRingArea(hole)).toBe(-4);
  });

  it("点在带洞多边形中的判断", () => {
    const polygon = [rect(0, 0, 10, 10), [...rect(2, 2, 4, 4)].reverse()];
    expect(pointInPolygon([5, 5], polygon)).toBe(true);
    expect(pointInPolygon([3, 3], polygon)).toBe(false);
    expect(pointInPolygon([11, 5], polygon)).toBe(false);
    expect(pointInMultiPolygon([21, 1], [polygon, [rect(20, 0, 22, 2)]])).toBe(true);
  });

  it("质心扣除洞的面积", () => {
    const [x] = centroidOf([[rect(0, 0, 10, 10), [...rect(0, 0, 5, 10)].reverse()]]);
    expect(x).toBeCloseTo(7.5);
  });

  it("凹多边形的锚点落在内部(质心在外)", () => {
    // C 形:质心落在缺口里
    const c: Ring = [
      [0, 0],
      [10, 0],
      [10, 2],
      [2, 2],
      [2, 8],
      [10, 8],
      [10, 10],
      [0, 10],
      [0, 0],
    ];
    const polygons = [[c]];
    expect(pointInMultiPolygon(centroidOf(polygons), polygons)).toBe(false);
    expect(pointInMultiPolygon(interiorPoint(polygons), polygons)).toBe(true);
  });

  it("赤道 1°×1° 面积约 12364 km²", () => {
    expect(areaKm2([[rect(0, 0, 1, 1)]])).toBeGreaterThan(12200);
    expect(areaKm2([[rect(0, 0, 1, 1)]])).toBeLessThan(12500);
    // 60°N 约为一半
    expect(areaKm2([[rect(0, 59.5, 1, 60.5)]]) / areaKm2([[rect(0, 0, 1, 1)]])).toBeCloseTo(0.5, 1);
  });

  it("抽稀保持闭合并减少点数", () => {
    const ring: Ring = [];
    for (let i = 0; i <= 360; i += 2) ring.push([Math.cos((i * Math.PI) / 180) + (i % 4 ? 0.0001 : 0), Math.sin((i * Math.PI) / 180)]);
    ring[ring.length - 1] = ring[0];
    const s = simplifyRing(ring, 0.01);
    expect(s.length).toBeLessThan(ring.length / 3);
    expect(s.length).toBeGreaterThanOrEqual(4);
    expect(isRingClosed(s)).toBe(true);
  });

  it("跨 180° 经线的环展开为连续经度", () => {
    const { ring, changed } = unwrapRing([
      [179, 0],
      [-179, 0],
      [-179, 1],
      [179, 1],
      [179, 0],
    ]);
    expect(changed).toBe(true);
    expect(ring.map((p) => p[0])).toEqual([179, 181, 181, 179, 179]);
  });
});

describe("boundaryLines", () => {
  it("合并相邻多边形时去掉共享边,只保留外轮廓", async () => {
    const { boundaryLines } = await import("../geometry");
    const lines = boundaryLines([[rect(0, 0, 1, 1)], [rect(1, 0, 2, 1)]]);
    const segments = lines.reduce((n, l) => n + l.length - 1, 0);
    expect(segments).toBe(6); // 2×1 矩形外框 6 条单位边,共享边 x=1 被去掉
    expect(lines.flat().some(([x, y]) => x === 1 && y === 0.5)).toBe(false);
  });
});

describe("outerOutline", () => {
  it("相邻多边形边界不吻合(有细缝、顶点不同)时仍只保留外轮廓", async () => {
    const { outerOutline } = await import("../geometry");
    // 左块右边界 x=1(一条边),右块左边界 x=1.001 且多了中间顶点
    const left = [rect(0, 0, 1, 1)];
    const right = [[[1.001, 0], [2, 0], [2, 1], [1.001, 1], [1.001, 0.5], [1.001, 0]] as [number, number][]];
    const lines = outerOutline([left, right], { cells: 200 });
    const pts = lines.flat();
    expect(pts.some(([x, y]) => x > 0.9 && x < 1.1 && y > 0.2 && y < 0.8)).toBe(false);
    const length = lines.reduce((sum, l) => sum + l.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - l[i][0], p[1] - l[i][1]), 0), 0);
    expect(length).toBeGreaterThan(5.9);
    expect(length).toBeLessThan(6.1);
  });
});
