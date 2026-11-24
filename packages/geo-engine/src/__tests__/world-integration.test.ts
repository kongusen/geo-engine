import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { datavSource, mount, naturalEarthSource, prefixIds, staticSource } from "@yaoyu/geo-data";
import { describe, expect, it } from "vitest";
import { GeoEngine } from "../engine";
import { box } from "./fixtures";

const fixture = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../fixtures/${name}`, import.meta.url)), "utf8"));
const ne = fixture("naturalearth-sample.json");
const datav: Record<string, unknown> = fixture("datav-sample.json");

/** 地球 → 各国(Natural Earth)→ 中国挂 DataV(接缝采用 DataV 轮廓)→ 西湖区挂自有地块。 */
function worldEngine() {
  const towns = staticSource([{ id: "北山街道", name: "北山街道", parentId: "330106", polygons: box(108.8, 25.6, 109, 25.8) }], { id: "plots" });
  return new GeoEngine({
    sources: [
      naturalEarthSource({ fetch: async (url) => (url.includes("admin_1") ? ne.admin1 : ne.countries), exclude: ["TWN"] }),
      mount({
        at: "CHN",
        root: "100000",
        adopt: true,
        source: datavSource({
          fetch: async (url) => {
            const file = url.split("/").pop()!.replace(/\.json$/, "");
            if (!(file in datav)) throw new Error(`HTTP 404:${url}`);
            return datav[file];
          },
        }),
      }),
      mount({ at: "330106", root: "330106", source: towns, ids: prefixIds("plot:") }),
    ],
    load: { retries: 0 },
  });
}

describe("世界 → 国家 → 一级行政区 / 国内多级", () => {
  it("地球层级是各国,台湾已排除;中国用 DataV 轮廓与版权", async () => {
    const engine = worldEngine();
    await engine.start();
    const frame = engine.frame();
    expect(frame.view.scene).toBe("globe");
    expect(frame.regions.map((r) => r.id).sort()).toEqual(["CHN", "FRA", "IND", "JPN", "USA"]);
    expect(frame.attributions).toEqual(["Natural Earth", "行政区划:DataV.GeoAtlas"]);
  });

  it("地球 → 美国 → 加州(Natural Earth admin1)", async () => {
    const engine = worldEngine();
    await engine.start();
    await engine.activate("USA");
    expect(engine.frame().regions.map((r) => r.name)).toEqual(["加利福尼亚州", "纽约州", "得克萨斯州"]);
    await engine.activate("US-CA");
    expect(engine.selection?.id).toBe("US-CA"); // 叶子:选中而不是下钻
  });

  it("深链接跨三个数据集:plot:北山街道 一次定位", async () => {
    const engine = worldEngine();
    await engine.start();
    expect(await engine.drill.restore("plot:北山街道")).toBe(true);
    expect(engine.drill.state.path.map((r) => r.id)).toEqual(["CHN", "330000", "330100", "330106", "plot:北山街道"]);
    expect(engine.drill.state.path.map((r) => r.source?.id)).toEqual(["natural-earth", "datav", "datav", "datav", "plots"]);
  });

  it("深链接到另一国的一级行政区", async () => {
    const engine = worldEngine();
    await engine.start();
    expect(await engine.drill.restore("IN-MH")).toBe(true);
    expect(engine.drill.state.path.map((r) => r.name)).toEqual(["印度", "马哈拉施特拉邦"]);
  });
});
