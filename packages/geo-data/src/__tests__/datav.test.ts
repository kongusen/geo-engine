import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { datavSource } from "../adapters/datav";
import { composeSources, mount } from "../compose";
import { prefixIds } from "../ids";
import { staticSource } from "../source";
import { box } from "./fixtures";

/** DataV 真实属性 + 外接矩形几何的样本(100000 / 100000_full / 520000_full / 522600_full / 110000_full / 420000_full)。 */
const sample: Record<string, unknown> = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../fixtures/datav-sample.json", import.meta.url)), "utf8"));
const ctx = { signal: new AbortController().signal };

function fakeFetch() {
  return vi.fn(async (url: string) => {
    const file = url.split("/").pop()!.replace(/\.json$/, "");
    if (!(file in sample)) throw new Error(`HTTP 404:${url}`);
    return sample[file];
  });
}

describe("datavSource", () => {
  it("顶层返回 root 区域本身,子级按 childrenNum 标记 hasChildren,坐标按 GCJ-02 纠偏", async () => {
    const fetch = fakeFetch();
    const router = composeSources([datavSource({ fetch, baseUrl: "https://example.test/bound/" })]);
    const top = (await router.children(null, ctx))!;
    expect(top.regions.map((r) => [r.id, r.name, r.level, r.expandable])).toEqual([["100000", "中华人民共和国", "country", true]]);
    expect(fetch).toHaveBeenCalledWith("https://example.test/bound/100000.json", expect.anything());
    expect(top.issues.some((i) => i.code === "crs-converted")).toBe(true);

    const provinces = (await router.children("100000", ctx))!;
    expect(provinces.regions).toHaveLength(34); // 九段线装饰要素已过滤
    const taiwan = provinces.regions.find((r) => r.id === "710000")!;
    expect(taiwan.expandable).toBe(false);
    expect(provinces.regions.find((r) => r.id === "520000")!.expandable).toBe(true);
    expect(provinces.regions.every((r) => r.parentId === "100000")).toBe(true);
    expect(provinces.attribution).toContain("DataV");
  });

  it("祖先链:按编码推导,链首保留 root;范围外不认", async () => {
    const src = datavSource({ fetch: fakeFetch() });
    expect((await src.ancestors!("522633", ctx))!.map((r) => r.id)).toEqual(["100000", "520000", "522600"]);
    expect(await src.ancestors!("100000", ctx)).toEqual([]);
    expect(await src.ancestors!("CHN", ctx)).toBeNull();
    const gz = datavSource({ root: "520000", fetch: fakeFetch() });
    expect((await gz.ancestors!("522633", ctx))!.map((r) => r.id)).toEqual(["520000", "522600"]);
    expect(await gz.ancestors!("110101", ctx)).toBeNull();
    expect(gz.owns!("110101")).toBe(false);
    expect(gz.owns!("522633")).toBe(true);
  });

  it("挂载到世界数据集下:接缝 100000 ↔ CHN", async () => {
    const world = staticSource([{ id: "CHN", name: "中国", parentId: null, polygons: box(73, 18, 135, 54) }]);
    const router = composeSources([world, mount({ at: "CHN", source: datavSource({ fetch: fakeFetch() }), root: "100000" })]);
    expect(await router.ancestors("522633", ctx)).toEqual(["CHN", "520000", "522600"]);
    const provinces = (await router.children("CHN", ctx))!;
    expect(provinces.regions.every((r) => r.parentId === "CHN")).toBe(true);
  });

  it("区县下挂载乡镇数据源:区县不再是叶子,乡镇可经前缀映射定位", async () => {
    const townships = staticSource([{ id: "丙妹镇", name: "丙妹镇", parentId: "522633", polygons: box(108.8, 25.6, 109, 25.8) }], { id: "cj" });
    const router = composeSources([
      datavSource({ fetch: fakeFetch() }),
      mount({ at: "522633", source: townships, root: "522633", ids: prefixIds("cj:") }),
    ]);
    const counties = (await router.children("522600", ctx))!;
    expect(counties.regions.find((r) => r.id === "522633")!.expandable).toBe(true);
    expect(counties.regions.find((r) => r.id === "522622")!.expandable).toBe(false);
    expect(await router.ancestors("cj:丙妹镇", ctx)).toEqual(["100000", "520000", "522600", "522633"]);
    const towns = (await router.children("522633", ctx))!;
    expect(towns.regions.map((r) => [r.id, r.parentId])).toEqual([["cj:丙妹镇", "522633"]]);
  });

  it("decorations 取出九段线并复用同一次请求", async () => {
    const fetch = fakeFetch();
    const src = datavSource({ fetch });
    await src.children("100000", ctx);
    const lines = await src.decorations();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0][0][0]).toBeGreaterThan(100);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
