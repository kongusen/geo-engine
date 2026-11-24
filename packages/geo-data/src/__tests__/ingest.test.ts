import { describe, expect, it } from "vitest";
import { lngLatToWebMercator } from "../crs";
import { signedRingArea } from "../geometry";
import { ingest } from "../ingest";
import { feature, rect } from "./fixtures";

/** 本地坐标(如 SVG 3000×2250 画布,y 轴向下)描出的 3×2 网格地块。 */
function svgGrid() {
  const features = [];
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 3; col++) {
      const x0 = 200 + col * 900, y0 = 200 + row * 900;
      // SVG 中顺时针书写(y 向下),转换后应被统一为逆时针外环
      features.push(feature({ name: `地块${row}${col}` }, [[[x0, y0], [x0 + 800, y0], [x0 + 800, y0 + 800], [x0, y0 + 800], [x0, y0]]]));
    }
  }
  return { type: "FeatureCollection", features };
}

describe("ingest", () => {
  it("读取 DataV 风格属性(adcode / parent.adcode / 别名)", () => {
    const { regions, issues } = ingest({
      type: "FeatureCollection",
      features: [feature({ adcode: 330106, name: "西湖区", parent: { adcode: 330100 }, alias: "西湖、Xihu" }, [rect(120, 30.1, 120.2, 30.3)])],
    });
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(regions[0]).toMatchObject({ id: "330106", name: "西湖区", parentId: "330100", aliases: ["西湖", "Xihu"] });
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

  it("SVG 本地坐标:自动识别失败并要求配准;提供仿射后可全部导入", () => {
    const source = svgGrid();
    const failed = ingest(source);
    expect(failed.regions).toEqual([]);
    expect(failed.issues[0].code).toBe("crs-unknown");

    // 示意配准:3000×2250 画布 → 约 1.2°×0.8° 的经纬度范围(仅用于验证流程)
    const ok = ingest(source, { crs: { affine: [0.0004, 0, 108.17, 0, -0.00035, 26.1] }, idKey: "name", level: "plot", parentId: "AREA" });
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
