import { describe, expect, it, vi } from "vitest";
import { GeoEngine, type EngineFrame, type GeoSource } from "../engine";
import type { RegionInput } from "../types";
import { box, feature, rect } from "./fixtures";

/** 模拟按父级懒加载的数据源:地球 → 国家 → 省 → 县(县为 GeoJSON,无父级字段)。 */
function lazySource(): GeoSource & { calls: (string | null)[] } {
  const calls: (string | null)[] = [];
  const data: Record<string, RegionInput[] | { input: unknown }> = {
    root: [
      { id: "CN", name: "中国", level: "country", polygons: box(73, 18, 135, 54), expandable: true },
      { id: "FR", name: "法国", level: "country", polygons: box(-5, 42, 8, 51), expandable: true },
    ],
    CN: [{ id: "GZ", name: "贵州", level: "province", parentId: "CN", polygons: box(103, 24, 110, 29), expandable: true }],
    GZ: {
      input: {
        type: "FeatureCollection",
        features: [
          feature({ adcode: 522633, name: "从江县", level: "county" }, [rect(108, 25, 109, 26)]),
          feature({ adcode: 520100, name: "贵阳市", level: "city" }, [rect(106, 26, 107, 27)]),
        ],
      },
    },
  };
  return {
    id: "mock",
    calls,
    async load(parentId) {
      calls.push(parentId);
      return data[parentId ?? "root"] ?? [];
    },
  };
}

describe("GeoEngine", () => {
  it("从地球懒加载并下钻到县,帧中场景随层级从球面切换到平面", async () => {
    const source = lazySource();
    const engine = new GeoEngine({ sources: [source] });
    const frames: EngineFrame[] = [];
    engine.on("frame", (f) => frames.push(f));
    await engine.start();
    expect(frames.at(-1)?.view.scene).toBe("globe");
    expect(frames.at(-1)?.regions.map((r) => r.id)).toEqual(["CN", "FR"]);

    await engine.activate("CN");
    await engine.activate("GZ");
    const f = frames.at(-1)!;
    expect(f.drill.path.map((r) => r.name)).toEqual(["中国", "贵州"]);
    expect(f.view.scene).toBe("plane");
    expect(f.regions.map((r) => r.name).sort()).toEqual(["从江县", "贵阳市"]);
    expect(engine.tree.get("522633")?.parentId).toBe("GZ"); // GeoJSON 没有父级字段,由数据源父级补齐
    expect(source.calls).toEqual([null, "CN", "GZ"]);

    // 县是叶子:点击切换选中而不是下钻
    const select = vi.fn();
    engine.on("select", select);
    await engine.activate("522633");
    expect(select).toHaveBeenCalledWith({ region: expect.objectContaining({ name: "从江县" }) });
    expect(engine.drill.state.focusId).toBe("GZ");

    // 再次进入已加载的层级不会重复请求
    await engine.drill.drillUp();
    await engine.activate("GZ");
    expect(source.calls).toEqual([null, "CN", "GZ"]);
  });

  it("点击重定向:地球上点国家可一步跳到已加载的县,面包屑路径完整", async () => {
    const engine = new GeoEngine({
      redirectActivate: (region, state) => (state.focusId === null && region.id === "CN" ? "COUNTY" : null),
    });
    engine.addRegions([
      { id: "CN", name: "中国", level: "country", polygons: box(73, 18, 135, 54) },
      { id: "GZ", name: "贵州", level: "province", parentId: "CN", polygons: box(103, 24, 110, 29) },
      { id: "COUNTY", name: "从江县", level: "county", parentId: "GZ", polygons: box(108, 25, 109, 26) },
      { id: "TOWN", name: "丙妹镇", level: "township", parentId: "COUNTY", polygons: box(108.5, 25.5, 108.8, 25.8) },
    ]);
    await engine.start();
    const changes: string[] = [];
    engine.on("drill", (c) => changes.push(`${c.direction}:${c.to.focusId}`));
    await engine.activate("CN");
    expect(changes).toEqual(["jump:COUNTY"]);
    expect(engine.drill.state.path.map((r) => r.name)).toEqual(["中国", "贵州", "从江县"]);
    expect(engine.frame().view.scene).toBe("plane");

    // 非顶层不重定向:回到中国后点贵州按常规下钻一级
    await engine.drill.drillTo("CN");
    await engine.activate("GZ");
    expect(engine.drill.state.focusId).toBe("GZ");
  });

  it("加载失败:按策略重试,最终失败发出 error 事件而不抛出,状态不变,之后可再次进入", async () => {
    let failures = 3;
    const calls: (string | null)[] = [];
    const engine = new GeoEngine({
      load: { retries: 1, retryDelayMs: 1 },
      sources: [
        {
          id: "flaky",
          async load(parentId) {
            calls.push(parentId);
            if (parentId === null) return [{ id: "CN", name: "中国", level: "country", polygons: box(73, 18, 135, 54), expandable: true }];
            if (failures-- > 0) throw new Error("网络错误");
            return [{ id: "GZ", name: "贵州", level: "province", parentId: "CN", polygons: box(103, 24, 110, 29) }];
          },
        },
      ],
    });
    await engine.start();
    const errors: unknown[] = [];
    const loading: boolean[] = [];
    engine.on("error", (e) => errors.push(e));
    engine.on("loading", (e) => loading.push(e.loading));
    await expect(engine.activate("CN")).resolves.toBeUndefined();
    expect(calls.filter((c) => c === "CN")).toHaveLength(2); // 1 次 + 1 次重试
    expect(errors).toEqual([{ targetId: "CN", error: expect.objectContaining({ message: "网络错误" }) }]);
    expect(loading).toEqual([true, false]);
    expect(engine.drill.state.focusId).toBeNull();

    await engine.activate("CN"); // 第 3 次失败,第 4 次成功
    expect(engine.drill.state.focusId).toBe("CN");
    expect(errors).toHaveLength(1);
  });

  it("加载超时按失败处理", async () => {
    const engine = new GeoEngine({
      load: { retries: 0, timeoutMs: 20 },
      sources: [{ id: "slow", load: (parentId) => (parentId === null ? Promise.resolve([{ id: "CN", name: "中国", polygons: box(73, 18, 135, 54), expandable: true }]) : new Promise(() => {})) }],
    });
    await engine.start();
    const errors: Array<{ error: unknown }> = [];
    engine.on("error", (e) => errors.push(e));
    expect(await engine.drill.drillDown("CN")).toBe(false);
    expect(String((errors[0]?.error as Error)?.message)).toContain("超时");
  });

  it("点击重定向目标不存在时按常规下钻", async () => {
    const engine = new GeoEngine({ redirectActivate: () => "MISSING" });
    engine.addRegions([
      { id: "CN", name: "中国", level: "country", polygons: box(73, 18, 135, 54) },
      { id: "GZ", name: "贵州", level: "province", parentId: "CN", polygons: box(103, 24, 110, 29) },
    ]);
    await engine.start();
    await engine.activate("CN");
    expect(engine.drill.state.focusId).toBe("CN");
  });

  it("图层按层级显示并给出差量", async () => {
    const engine = new GeoEngine({
      sources: [lazySource()],
      layers: [
        { id: "globe-fill", type: "choropleth", visible: { scenes: ["globe"] } },
        { id: "plate", type: "choropleth", visible: { scenes: ["plane"] } },
        { id: "label", type: "label" },
        { id: "county-points", type: "point", visible: { levels: ["province"] } },
      ],
    });
    let frame!: EngineFrame;
    engine.on("frame", (f) => (frame = f));
    await engine.start();
    expect(frame.layers.map((l) => l.id)).toEqual(["globe-fill", "label"]);
    await engine.activate("CN"); // 国家尺度:球面 → 平面
    expect(frame.layerDiff.enter.map((l) => l.id)).toEqual(["plate"]);
    expect(frame.layerDiff.exit.map((l) => l.id)).toEqual(["globe-fill"]);
    expect(frame.layerDiff.update.map((l) => l.id)).toEqual(["label"]);
    await engine.activate("GZ");
    expect(frame.layers.map((l) => l.id)).toEqual(["plate", "label", "county-points"]);
    expect(frame.layerDiff.enter.map((l) => l.id)).toEqual(["county-points"]);
    expect(frame.layerDiff.exit).toEqual([]);
  });

  it("插件:注册守卫与监听,卸载后全部清理", async () => {
    const engine = new GeoEngine({ sources: [lazySource()] });
    const seen: string[] = [];
    engine.use({
      name: "no-france",
      install(ctx) {
        ctx.addGuard(({ target }) => target?.id !== "FR");
        ctx.on("drill", (c) => seen.push(c.to.focusId ?? "root"));
      },
    });
    await engine.start();
    expect(await engine.drill.drillDown("FR")).toBe(false);
    await engine.activate("CN");
    expect(seen).toEqual(["CN"]);
    engine.unuse("no-france");
    await engine.drill.reset();
    expect(await engine.drill.drillDown("FR")).toBe(true);
    expect(seen).toEqual(["CN"]);
  });

  it("以某区域为根(如全景页之外的产业大屏锁定从江县)", async () => {
    const engine = new GeoEngine({ rootId: "GZ" });
    engine.addRegions([
      { id: "GZ", name: "贵州", polygons: box(103, 24, 110, 29) },
      { id: "CJ", name: "从江县", polygons: box(108, 25, 109, 26) },
    ]);
    await engine.start();
    const f = engine.frame();
    expect(f.focus?.id).toBe("GZ");
    expect(f.regions.map((r) => r.id)).toEqual(["CJ"]);
    expect(f.view.scene).toBe("plane");
  });
});

describe("frame.anchor", () => {
  it("平面场景锚点取路径上第一个平面级区域;全球为 null", async () => {
    const engine = new GeoEngine({ sources: [lazySource()] });
    await engine.start();
    expect(engine.frame().anchor).toBeNull();
    await engine.activate("CN");
    expect(engine.frame().anchor?.id).toBe("CN");
    await engine.activate("GZ");
    expect(engine.frame().anchor?.id).toBe("CN");
  });
});
