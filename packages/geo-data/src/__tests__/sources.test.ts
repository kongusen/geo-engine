import { describe, expect, it, vi } from "vitest";
import { composeSources, mount } from "../compose";
import { adcodeHierarchy, parentMapHierarchy } from "../hierarchy";
import { identityIds, prefixIds, tableIds } from "../ids";
import { withPolicy } from "../policy";
import { staticSource, type RegionSource } from "../source";
import type { RegionInput } from "../types";
import { box } from "./fixtures";

const ctx = { signal: new AbortController().signal };
const r = (id: string, parentId: string | null, extra: Partial<RegionInput> = {}): RegionInput => ({ id, name: id, parentId, polygons: box(0, 0, 1, 1), ...extra });

describe("IdMapper", () => {
  it("prefix 双向映射,非本空间返回 null", () => {
    const ids = prefixIds("ne:");
    expect(ids.toGlobal("CHN")).toBe("ne:CHN");
    expect(ids.toLocal("ne:CHN")).toBe("CHN");
    expect(ids.toLocal("CHN")).toBeNull();
  });

  it("table 改名后原名不再指向它,表外走 fallback", () => {
    const ids = tableIds({ "156": "CHN" });
    expect(ids.toGlobal("156")).toBe("CHN");
    expect(ids.toLocal("CHN")).toBe("156");
    expect(ids.toLocal("156")).toBeNull();
    expect(ids.toGlobal("840")).toBe("840");
    expect(identityIds().toLocal("x")).toBe("x");
  });
});

describe("hierarchy", () => {
  const adcode = adcodeHierarchy();
  const ids = (id: string) => (adcode(id, ctx) as { id: string }[] | null)?.map((x) => x.id) ?? null;

  it("按行政区划代码推导祖先", () => {
    expect(ids("522633")).toEqual(["100000", "520000", "522600"]);
    expect(ids("522633101")).toEqual(["100000", "520000", "522600", "522633"]);
    expect(ids("522633101201")).toEqual(["100000", "520000", "522600", "522633", "522633101"]);
    expect(ids("520000")).toEqual(["100000"]);
    expect(ids("100000")).toBeNull();
    expect(ids("CHN")).toBeNull();
    expect((adcodeHierarchy({ root: null })("522633", ctx) as { id: string }[]).map((x) => x.id)).toEqual(["520000", "522600"]);
  });

  it("parentMap 异步表只加载一次", async () => {
    const load = vi.fn(async () => ({ a: null, b: "a", c: "b" }));
    const resolve = parentMapHierarchy(load);
    expect((await resolve("c", ctx))!.map((x) => x.id)).toEqual(["a", "b"]);
    expect(await resolve("zz", ctx)).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("staticSource", () => {
  it("按父级切分、推出 hasChildren 与祖先链", async () => {
    const src = staticSource([r("A", null), r("A1", "A"), r("A1x", "A1")]);
    const top = await src.children(null, ctx);
    expect((top.regions as RegionInput[]).map((x) => [x.id, x.expandable])).toEqual([["A", true]]);
    const leaf = await src.children("A1", ctx);
    expect((leaf.regions as RegionInput[])[0].expandable).toBe(false);
    expect((await src.ancestors!("A1x", ctx))!.map((x) => x.id)).toEqual(["A", "A1"]);
    expect(await src.ancestors!("nope", ctx)).toBeNull();
  });
});

describe("SourceRouter", () => {
  it("普通数据源按注册顺序询问 handles(兼容旧行为)", async () => {
    const top: RegionSource = { id: "top", handles: (p) => p === null, children: async () => ({ regions: [r("CN", null)] }) };
    const rest: RegionSource = { id: "rest", children: async (p) => ({ regions: [r(`${p}-1`, null)] }) };
    const router = composeSources([top, rest]);
    expect((await router.children(null, ctx))!.regions.map((x) => x.id)).toEqual(["CN"]);
    const kids = (await router.children("CN", ctx))!;
    expect(kids.sourceId).toBe("rest");
    // 未声明 parentId 的子级挂到请求的父级下
    expect(kids.regions[0].parentId).toBe("CN");
  });

  it("挂载:接缝编码对到挂载点,子级经映射成为全局 id,并记录来源", async () => {
    const world = staticSource([r("CHN", null), r("USA", null)], { id: "world" });
    const cn = staticSource([r("100000", null), r("520000", "100000"), r("522633", "520000")], { id: "cn", attribution: "审图号 GS(2024)0000" });
    const router = composeSources([world, mount({ at: "CHN", source: cn, root: "100000", ids: prefixIds("cn:") })]);
    await router.children(null, ctx);
    const provinces = (await router.children("CHN", ctx))!;
    expect(provinces.regions.map((x) => [x.id, x.parentId, x.source])).toEqual([["cn:520000", "CHN", { id: "cn", localId: "520000" }]]);
    expect(provinces.attribution).toContain("审图号");
    const counties = (await router.children("cn:520000", ctx))!;
    expect(counties.regions.map((x) => [x.id, x.parentId])).toEqual([["cn:522633", "cn:520000"]]);
  });

  it("跨挂载点解析祖先链", async () => {
    const world = staticSource([r("CHN", null), r("USA", null)], { id: "world" });
    const cn: RegionSource = {
      id: "cn",
      owns: (id) => /^\d+$/.test(id),
      ancestors: async (id, c) => adcodeHierarchy()(id, c),
      children: async () => ({ regions: [] }),
    };
    const router = composeSources([world, mount({ at: "CHN", source: cn, root: "100000" })]);
    expect(await router.ancestors("522633", ctx)).toEqual(["CHN", "520000", "522600"]);
    expect(await router.ancestors("USA", ctx)).toEqual([]);
    expect(await router.ancestors("ZZZ", ctx)).toBeNull();
    // 引擎已知挂载点路径时直接截断
    expect(await router.ancestors("522633", { ...ctx, knownPath: (id) => (id === "CHN" ? ["EARTH", "CHN"] : null) })).toEqual(["EARTH", "CHN", "520000", "522600"]);
  });

  it("hasChildren:refs > 数据自带 > 源默认", async () => {
    const src: RegionSource = {
      id: "s",
      defaultHasChildren: (ref) => ref.level !== "township",
      children: async () => ({
        regions: [r("a", null, { level: "county" }), r("b", null, { level: "township" }), r("c", null, { level: "township" }), r("d", null, { expandable: false })],
        refs: { c: { hasChildren: true } },
      }),
    };
    const out = (await composeSources([src]).children(null, ctx))!;
    expect(out.regions.map((x) => x.expandable)).toEqual([true, false, true, false]);
  });

  it("两个源给出同一全局 id 时报 id-collision", async () => {
    const a = staticSource([r("X", null), r("dup", "X")], { id: "a" });
    const b: RegionSource = { id: "b", children: async () => ({ regions: [r("dup", null)] }) };
    const router = composeSources([a, mount({ at: "dup", source: b })]);
    await router.children(null, ctx);
    await router.children("X", ctx);
    expect((await router.children("dup", ctx))!.issues.map((i) => i.code)).toEqual(["id-collision"]);
  });
});

describe("withPolicy", () => {
  it("失败重试,中止后不再重试", async () => {
    let n = 0;
    const flaky: RegionSource = { id: "f", children: async () => (++n < 2 ? Promise.reject(new Error("x")) : { regions: [] }) };
    await withPolicy(flaky, { retries: 2, retryDelayMs: 1 }).children(null, ctx);
    expect(n).toBe(2);
    const ac = new AbortController();
    ac.abort();
    n = -10;
    await expect(withPolicy(flaky, { retries: 5, retryDelayMs: 1 }).children(null, { signal: ac.signal })).rejects.toThrow("x");
    expect(n).toBe(-9);
  });
});
