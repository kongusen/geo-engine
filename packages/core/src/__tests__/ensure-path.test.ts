import { adcodeHierarchy, mount, staticSource, type RegionInput, type RegionSource } from "@geodive/data";
import { describe, expect, it } from "vitest";
import { GeoEngine, type EngineFrame } from "../engine";
import { box } from "./fixtures";

/**
 * 模拟按行政区划代码懒加载的数据源(如 DataV):每个父级一个文件,不存在的父级 404。
 * 北京 110000 下直接是区(没有 110100"市辖区"这一级),用于验证虚级跳过。
 */
function adcodeSource(attribution?: string) {
  const data: RegionInput[] = [
    { id: "100000", name: "中国", parentId: null, polygons: box(73, 18, 135, 54) },
    { id: "330000", name: "浙江", parentId: "100000", polygons: box(103, 24, 110, 29) },
    { id: "330100", name: "杭州", parentId: "330000", polygons: box(107, 25, 110, 27.5) },
    { id: "330106", name: "西湖区", parentId: "330100", polygons: box(108.5, 25.3, 109.3, 26) },
    { id: "330106001", name: "北山街道", parentId: "330106", polygons: box(108.8, 25.6, 109, 25.8), level: "township" },
    { id: "110000", name: "北京", parentId: "100000", polygons: box(115.4, 39.4, 117.5, 41) },
    { id: "110101", name: "东城区", parentId: "110000", polygons: box(116.38, 39.86, 116.45, 39.97) },
  ];
  const calls: Array<string | null> = [];
  let inflight = 0;
  let maxInflight = 0;
  const source: RegionSource = {
    id: "adcode",
    owns: (id) => /^\d+$/.test(id),
    ancestors: async (id, ctx) => adcodeHierarchy()(id, ctx),
    defaultHasChildren: (ref) => ref.level !== "township",
    attribution,
    async children(parentId) {
      calls.push(parentId);
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inflight--;
      const key = parentId ?? "100000";
      if (!data.some((r) => r.id === key)) throw new Error(`404 ${key}`);
      return { regions: data.filter((r) => r.parentId === key).map(({ parentId: _, ...rest }) => rest), attribution };
    },
  } as RegionSource & { attribution?: string };
  return { source, calls, stats: () => ({ maxInflight }) };
}

const world = () =>
  staticSource(
    [
      { id: "CHN", name: "中国", parentId: null, polygons: box(73, 18, 135, 54) },
      { id: "USA", name: "美国", parentId: null, polygons: box(-125, 25, -66, 49) },
    ],
    { id: "world", attribution: "Natural Earth" },
  );

describe("ensurePath", () => {
  it("深链接:一次定位到乡镇,各级子级并行请求", async () => {
    const { source, calls, stats } = adcodeSource();
    const engine = new GeoEngine({ sources: [source], load: { retries: 0 } });
    await engine.start();
    const phases: string[] = [];
    engine.on("loading", (e) => e.loading && phases.push(e.phase));

    expect(await engine.drill.drillTo("330106001")).toBe(true);
    expect(engine.drill.state.path.map((r) => r.name)).toEqual(["浙江", "杭州", "西湖区", "北山街道"]);
    expect(phases[0]).toBe("path");
    expect(calls).toEqual(expect.arrayContaining(["330000", "330100", "330106"]));
    expect(stats().maxInflight).toBeGreaterThan(1);
    // 乡镇按源默认是叶子
    expect(engine.isLeaf("330106001")).toBe(true);
  });

  it("跳过数据中不存在的中间级(直辖市没有市辖区)", async () => {
    const { source } = adcodeSource();
    const engine = new GeoEngine({ sources: [source], load: { retries: 0 } });
    await engine.start();
    const path = await engine.ensurePath("110101");
    expect(path.map((r) => r.id)).toEqual(["110000", "110101"]);
  });

  it("无法定位时 blocked: unknown,不抛出,状态不变", async () => {
    const { source } = adcodeSource();
    const engine = new GeoEngine({ sources: [source], load: { retries: 0 } });
    await engine.start();
    const events: string[] = [];
    engine.drill.events.on("blocked", (e) => events.push(`blocked:${e.reason}`));
    engine.drill.events.on("loading", (e) => events.push(`loading:${e.loading}`));
    expect(await engine.drill.drillTo("999999")).toBe(false);
    expect(await engine.drill.drillTo("not-a-code")).toBe(false);
    // loading 先结束,再报告结果(宿主据此先清空"加载中"再显示错误)
    expect(events).toEqual(["loading:true", "loading:false", "blocked:unknown", "loading:true", "loading:false", "blocked:unknown"]);
    expect(engine.drill.state.focusId).toBeNull();
  });

  it("被后来的跳转取代时不生效,但已加载的数据保留", async () => {
    const { source } = adcodeSource();
    const engine = new GeoEngine({ sources: [source], load: { retries: 0 } });
    await engine.start();
    const first = engine.drill.drillTo("330106001");
    const second = engine.drill.drillTo("110000");
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(engine.drill.state.focusId).toBe("110000");
    await engine.ensurePath("330106001");
    expect(engine.tree.has("330106")).toBe(true);
  });

  it("rootId 可以是尚未加载的深层区域", async () => {
    const { source } = adcodeSource();
    const engine = new GeoEngine({ rootId: "330106", sources: [source], load: { retries: 0 } });
    const frames: EngineFrame[] = [];
    engine.on("frame", (f) => frames.push(f));
    await engine.start();
    expect(frames.at(-1)!.regions.map((r) => r.name)).toEqual(["北山街道"]);
  });

  it("跨数据集挂载:世界 → 中国(接缝)→ 县,并汇总版权信息", async () => {
    const { source } = adcodeSource("审图号 GS(2024)0000");
    const engine = new GeoEngine({ sources: [world(), mount({ at: "CHN", source, root: "100000" })], load: { retries: 0 } });
    await engine.start();
    expect(engine.tree.roots().map((r) => r.id)).toEqual(["CHN", "USA"]);

    expect(await engine.drill.drillTo("330106")).toBe(true);
    expect(engine.tree.path("330106").map((r) => r.id)).toEqual(["CHN", "330000", "330100", "330106"]);
    expect(engine.tree.get("330000")!.source).toEqual({ id: "adcode", localId: "330000" });
    expect(engine.frame().attributions).toEqual(["Natural Earth", "审图号 GS(2024)0000"]);
  });

  it("点击重定向到尚未加载的区域", async () => {
    const { source } = adcodeSource();
    const engine = new GeoEngine({
      sources: [world(), mount({ at: "CHN", source, root: "100000" })],
      redirectActivate: (region, state) => (state.focusId === null && region.id === "CHN" ? "330106" : null),
      load: { retries: 0 },
    });
    await engine.start();
    await engine.activate("CHN");
    expect(engine.drill.state.focusId).toBe("330106");
  });

  it("加载到空子级后标记为叶子,不再请求", async () => {
    const empty: RegionSource = {
      id: "e",
      defaultHasChildren: true,
      children: async (p) => ({ regions: p === null ? [{ id: "A", name: "A", polygons: box(0, 0, 1, 1) }] : [] }),
    };
    const engine = new GeoEngine({ sources: [empty] });
    await engine.start();
    expect(engine.isLeaf("A")).toBe(false);
    await engine.drill.drillDown("A");
    expect(engine.isLeaf("A")).toBe(true);
  });
});

describe("attributions", () => {
  it("汇总可见图层的版权信息,不可见的不计入", async () => {
    const engine = new GeoEngine({
      sources: [world()],
      layers: [
        { id: "basemap", type: "basemap", attribution: "© 天地图", visible: { scenes: ["plane"] } },
        { id: "globe-only", type: "x", attribution: "球面专用", visible: { scenes: ["globe"] } },
      ],
    });
    await engine.start();
    expect(engine.frame().attributions).toEqual(["Natural Earth", "球面专用"]);
    await engine.drill.drillTo("CHN");
    expect(engine.frame().attributions).toEqual(["Natural Earth", "© 天地图"]);
  });
});
