import { describe, expect, it } from "vitest";
import { GeoEngine, type EngineFrame } from "../engine";
import { nested } from "./fixtures";

function engineWith(leafLevels?: string[]) {
  const engine = new GeoEngine({ allowLeafFocus: true, leafLevels });
  engine.addRegions(nested);
  return engine;
}

describe("视图叶子层级 leafLevels", () => {
  it("省视为叶子:聚焦省时显示省本身,而不是其下的县", async () => {
    const engine = engineWith(["province"]);
    expect(engine.isLeaf("A")).toBe(true);
    expect(await engine.drill.drillTo("A")).toBe(true);
    expect(engine.frame().regions.map((r) => r.id)).toEqual(["A"]);
  });

  it("点击省(activate)在叶子模式下聚焦省自身", async () => {
    const engine = engineWith(["province"]);
    await engine.drill.drillTo("CN");
    await engine.activate("A");
    expect(engine.drill.state.focusId).toBe("A");
    expect(engine.frame().regions.map((r) => r.id)).toEqual(["A"]);
  });

  it("运行时切换:取消叶子层级后同一省展开为县,并重发帧", async () => {
    const engine = engineWith(["province"]);
    await engine.drill.drillTo("A");
    const frames: EngineFrame[] = [];
    engine.on("frame", (frame) => frames.push(frame));
    engine.setLeafLevels(null);
    expect(frames).toHaveLength(1);
    expect(frames[0].regions.map((r) => r.id).sort()).toEqual(["A1", "A2"]);
    // 相同设置不重复发帧
    engine.setLeafLevels([]);
    expect(frames).toHaveLength(1);
    // 叶子层级之外的下钻照常
    expect(await engine.drill.drillTo("A1")).toBe(true);
  });

  it("不设置时行为不变", () => {
    const engine = engineWith();
    expect(engine.isLeaf("A")).toBe(false);
    expect(engine.isLeaf("A1")).toBe(true);
  });
});
