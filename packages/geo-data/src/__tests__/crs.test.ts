import { describe, expect, it } from "vitest";
import {
  applyAffine,
  crsFromGeoJsonMember,
  detectCrs,
  fitAffine,
  gcj02ToWgs84,
  lngLatToWebMercator,
  webMercatorToLngLat,
  wgs84ToGcj02,
} from "../crs";

describe("crs", () => {
  it("Web 墨卡托往返", () => {
    const p = webMercatorToLngLat(lngLatToWebMercator([108.9, 25.75]));
    expect(p[0]).toBeCloseTo(108.9, 9);
    expect(p[1]).toBeCloseTo(25.75, 9);
  });

  it("GCJ-02 纠偏往返精度优于 1e-6 度,境外不偏移", () => {
    const wgs: [number, number] = [108.9, 25.75];
    const gcj = wgs84ToGcj02(wgs);
    expect(Math.hypot(gcj[0] - wgs[0], gcj[1] - wgs[1])).toBeGreaterThan(1e-4); // 确有偏移
    const back = gcj02ToWgs84(gcj);
    expect(back[0]).toBeCloseTo(wgs[0], 6);
    expect(back[1]).toBeCloseTo(wgs[1], 6);
    expect(wgs84ToGcj02([2.35, 48.85])).toEqual([2.35, 48.85]);
  });

  it("由控制点还原仿射参数(SVG 本地坐标 → 经纬度)", () => {
    const truth = [0.0002, 0, 108.5, 0, -0.0002, 26.1] as const;
    const src: [number, number][] = [
      [0, 0],
      [3000, 0],
      [0, 2250],
      [1500, 1000],
    ];
    const points = src.map((s) => ({ source: s, target: applyAffine([...truth], s) }));
    const { affine, maxResidual } = fitAffine(points);
    expect(maxResidual).toBeLessThan(1e-9);
    affine.forEach((v, i) => expect(v).toBeCloseTo(truth[i], 9));
    expect(() => fitAffine(points.slice(0, 2))).toThrow();
  });

  it("按数值范围推断坐标系", () => {
    expect(detectCrs([[108.9, 25.7]])).toBe("wgs84");
    expect(detectCrs([[12123456, 2970000]])).toBe("epsg3857");
    expect(detectCrs([[2800, 1900]])).toBe("unknown"); // SVG 本地坐标
    expect(crsFromGeoJsonMember({ properties: { name: "urn:ogc:def:crs:EPSG::3857" } })).toBe("epsg3857");
    expect(crsFromGeoJsonMember({ properties: { name: "EPSG:4490" } })).toBe("wgs84");
  });
});
