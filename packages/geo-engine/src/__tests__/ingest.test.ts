import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lngLatToWebMercator } from "../crs";
import { signedRingArea } from "../geometry";
import { ingest } from "../ingest";
import { feature, rect } from "./fixtures";

const congjiangPath = fileURLToPath(new URL("../../../../fixtures/congjiang.json", import.meta.url));

describe("ingest", () => {
  it("读取 DataV 风格属性(adcode / parent.adcode / 别名)", () => {
    const { regions, issues } = ingest({
      type: "FeatureCollection",
      features: [feature({ adcode: 522633, name: "从江县", parent: { adcode: 522600 }, alias: "从江、Congjiang" }, [rect(108, 25, 109, 26)])],
    });
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(regions[0]).toMatchObject({ id: "522633", name: "从江县", parentId: "522600", aliases: ["从江", "Congjiang"] });
  });

  it("修复未闭合环与顺时针外环,跳过非面要素,拒绝重复编码", () => {
    const openCw = [[0, 0], [0, 1], [1, 1], [1, 0]];
    const { regions, issues } = ingest([
      feature({ id: "a", name: "甲" }, [openCw]),
      { type: "Feature", properties: { id: "p" }, geometry: { type: "Point", coordinates: [0, 0] } },
      feature({ id: "a", name: "乙" }, [rect(2, 2, 3, 3)]),
    ]);
    expect(regions).toHaveLength(1);
    const ring = regions[0].polygons[0][0];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(signedRingArea(ring)).toBeGreaterThan(0);
    const codes = issues.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(["ring-closed", "ring-rewound", "non-polygon-skipped", "duplicate-id"]));
  });

  it("自动识别并转换 Web 墨卡托坐标", () => {
    const ring = rect(108, 25, 109, 26).map((p) => lngLatToWebMercator(p));
    const { regions, issues } = ingest(feature({ code: "x", name: "墨卡托" }, [ring]));
    expect(issues.some((i) => i.code === "crs-converted")).toBe(true);
    expect(regions[0].polygons[0][0][0][0]).toBeCloseTo(108, 6);
  });

  it("现有从江 SVG 本地坐标:自动识别失败并要求配准;提供仿射后可导入全部乡镇", () => {
    const source = JSON.parse(readFileSync(congjiangPath, "utf8"));
    const failed = ingest(source);
    expect(failed.regions).toEqual([]);
    expect(failed.issues[0].code).toBe("crs-unknown");

    // 粗略配准:3000×2250 → 从江县经纬度范围(仅用于验证流程,非真实配准参数)
    const ok = ingest(source, { crs: { affine: [0.000387, 0, 108.17, 0, -0.000354, 26.1] }, idKey: "name", level: "township", parentId: "522633" });
    expect(ok.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(ok.regions.length).toBe(source.features.length);
    for (const region of ok.regions) {
      const [lng, lat] = region.polygons[0][0][0];
      expect(lng).toBeGreaterThan(108);
      expect(lat).toBeLessThan(26.2);
      expect(signedRingArea(region.polygons[0][0])).toBeGreaterThan(0); // y 轴翻转后已重新统一绕向
    }
  });

  it("无法解析的输入返回错误而不是抛出", () => {
    expect(ingest(42).issues[0].code).toBe("invalid-input");
  });
});
