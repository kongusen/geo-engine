import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { datavSource } from "../adapters/datav";
import { naturalEarthSource } from "../adapters/natural-earth";
import { composeSources, mount } from "../compose";
import type { RegionSource } from "../source";

const fixture = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../fixtures/${name}`, import.meta.url)), "utf8"));
const ne = fixture("naturalearth-sample.json");
const datav: Record<string, unknown> = fixture("datav-sample.json");
const ctx = { signal: new AbortController().signal };

function neFetch() {
  return vi.fn(async (url: string) => (url.includes("admin_1") ? ne.admin1 : ne.countries));
}
function datavFetch() {
  return vi.fn(async (url: string) => {
    const file = url.split("/").pop()!.replace(/\.json$/, "");
    if (!(file in datav)) throw new Error(`HTTP 404:${url}`);
    return datav[file];
  });
}

describe("naturalEarthSource", () => {
  it("顶层为各国:ADM0_A3 编码、中文名、按覆盖清单标记可下钻,且不下载 admin1 文件", async () => {
    const fetch = neFetch();
    const out = (await composeSources([naturalEarthSource({ fetch, exclude: ["TWN"] })]).children(null, ctx))!;
    const byId = Object.fromEntries(out.regions.map((r) => [r.id, r]));
    expect(Object.keys(byId).sort()).toEqual(["CHN", "FRA", "IND", "JPN", "USA"]);
    expect(byId.USA).toMatchObject({ name: "美国", level: "country", expandable: true, parentId: null });
    expect(byId.JPN.expandable).toBe(false);
    expect(out.attribution).toBe("Natural Earth");
    expect(fetch.mock.calls.map(([u]) => u).some((u) => u.includes("admin_1"))).toBe(false);
  });

  it("一级行政区:ISO 3166-2 编码,祖先链需要时才读 admin1", async () => {
    const src = naturalEarthSource({ fetch: neFetch() });
    const router = composeSources([src]);
    await router.children(null, ctx);
    const states = (await router.children("USA", ctx))!;
    expect(states.regions.map((r) => [r.id, r.name, r.parentId, r.level, r.expandable])).toEqual([
      ["US-CA", "加利福尼亚州", "USA", "province", false],
      ["US-NY", "纽约州", "USA", "province", false],
      ["US-TX", "得克萨斯州", "USA", "province", false],
    ]);
    expect((await src.ancestors!("US-CA", ctx))!.map((r) => r.id)).toEqual(["USA"]);
    expect(await src.ancestors!("USA", ctx)).toEqual([]);
    expect(await src.ancestors!("XX-ZZ", ctx)).toBeNull();
    expect(await src.ancestors!("522633", ctx)).toBeNull();
  });

  it("英文名、改名与自定义过滤", async () => {
    const src = naturalEarthSource({ fetch: neFetch(), lang: "en", rename: { USA: "United States" }, filter: (p, level) => level !== "country" || p.ADM0_A3 !== "FRA" });
    const out = (await composeSources([src]).children(null, ctx))!;
    expect(out.regions.find((r) => r.id === "USA")!.name).toBe("United States");
    expect(out.regions.find((r) => r.id === "IND")!.name).toBe("India");
    expect(out.regions.some((r) => r.id === "FRA")).toBe(false);
  });
});

describe("挂载 adopt:接缝区域采用权威几何", () => {
  it("中国轮廓换成 DataV 的 100000,版权随之改为 DataV;其他国家不受影响", async () => {
    const world = naturalEarthSource({ fetch: neFetch(), exclude: ["TWN"] });
    const router = composeSources([world, mount({ at: "CHN", source: datavSource({ fetch: datavFetch() }), root: "100000", adopt: true })]);
    const out = (await router.children(null, ctx))!;
    const chn = out.regions.find((r) => r.id === "CHN")!;
    const dv = (datav["100000"] as { features: Array<{ geometry: { coordinates: number[][][][] } }> }).features[0].geometry.coordinates[0][0];
    // DataV 样本为外接矩形(GCJ-02),纠偏后经度最小值应接近 DataV 的值,而不是 Natural Earth 的
    const minLng = Math.min(...chn.polygons.flat(2).map((p) => p[0]));
    expect(minLng).toBeCloseTo(Math.min(...dv.map((p) => p[0])), 1);
    expect(chn.expandable).toBe(true);
    expect(out.regionAttributions).toEqual({ CHN: "行政区划:DataV.GeoAtlas" });
    // 中国以下走 DataV(挂载优先于 Natural Earth 的 admin1)
    const provinces = (await router.children("CHN", ctx))!;
    expect(provinces.sourceId).toBe("datav");
  });

  it("权威几何取不到时整批失败,不悄悄退回上层轮廓", async () => {
    const broken: RegionSource = { id: "broken", children: async () => ({ regions: [] }), region: async () => Promise.reject(new Error("down")) };
    const router = composeSources([naturalEarthSource({ fetch: neFetch() }), mount({ at: "CHN", source: broken, root: "x", adopt: true })], { policy: false });
    await expect(router.children(null, ctx)).rejects.toThrow("down");
  });
});
