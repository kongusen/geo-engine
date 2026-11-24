import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { datavSource } from "../adapters/datav";
import { composeSources, mount } from "../compose";
import { prefixIds } from "../ids";
import { staticSource } from "../source";
import { box } from "./fixtures";

/** DataV 真实属性 + 外接矩形几何的样本(100000 / 100000_full / 330000_full / 330100_full / 110000_full / 420000_full)。 */
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
    expect(provinces.regions.find((r) => r.id === "330000")!.expandable).toBe(true);
    expect(provinces.regions.every((r) => r.parentId === "100000")).toBe(true);
    expect(provinces.attribution).toContain("DataV");
  });

  it("祖先链:按编码推导,链首保留 root;范围外不认", async () => {
    const src = datavSource({ fetch: fakeFetch() });
    expect((await src.ancestors!("330106", ctx))!.map((r) => r.id)).toEqual(["100000", "330000", "330100"]);
    expect(await src.ancestors!("100000", ctx)).toEqual([]);
    expect(await src.ancestors!("CHN", ctx)).toBeNull();
    const zj = datavSource({ root: "330000", fetch: fakeFetch() });
    expect((await zj.ancestors!("330106", ctx))!.map((r) => r.id)).toEqual(["330000", "330100"]);
    expect(await zj.ancestors!("110101", ctx)).toBeNull();
    expect(zj.owns!("110101")).toBe(false);
    expect(zj.owns!("330106")).toBe(true);
  });

  it("挂载到世界数据集下:接缝 100000 ↔ CHN", async () => {
    const world = staticSource([{ id: "CHN", name: "中国", parentId: null, polygons: box(73, 18, 135, 54) }]);
    const router = composeSources([world, mount({ at: "CHN", source: datavSource({ fetch: fakeFetch() }), root: "100000" })]);
    expect(await router.ancestors("330106", ctx)).toEqual(["CHN", "330000", "330100"]);
    const provinces = (await router.children("CHN", ctx))!;
    expect(provinces.regions.every((r) => r.parentId === "CHN")).toBe(true);
  });

  it("区县下挂载自有数据源:区县不再是叶子,自有区域可经前缀映射定位", async () => {
    const plots = staticSource([{ id: "A1", name: "示例地块 A1", parentId: "330106", polygons: box(120.1, 30.2, 120.12, 30.22) }], { id: "plots" });
    const router = composeSources([
      datavSource({ fetch: fakeFetch() }),
      mount({ at: "330106", source: plots, root: "330106", ids: prefixIds("plot:") }),
    ]);
    const counties = (await router.children("330100", ctx))!;
    expect(counties.regions.find((r) => r.id === "330106")!.expandable).toBe(true);
    expect(counties.regions.find((r) => r.id === "330102")!.expandable).toBe(false);
    expect(await router.ancestors("plot:A1", ctx)).toEqual(["100000", "330000", "330100", "330106"]);
    const own = (await router.children("330106", ctx))!;
    expect(own.regions.map((r) => [r.id, r.parentId])).toEqual([["plot:A1", "330106"]]);
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
