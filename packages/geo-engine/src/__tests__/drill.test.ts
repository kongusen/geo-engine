import { describe, expect, it, vi } from "vitest";
import { DrillController, type DrillChange } from "../drill";
import { RegionTree } from "../region-tree";
import { nested } from "./fixtures";

const setup = (options: ConstructorParameters<typeof DrillController>[1] = {}) => {
  const tree = new RegionTree(nested);
  const drill = new DrillController(tree, options);
  const changes: DrillChange[] = [];
  drill.events.on("change", (c) => changes.push(c));
  return { tree, drill, changes };
};

describe("DrillController", () => {
  it("下钻、上卷、跳转、重置", async () => {
    const { drill, changes } = setup();
    expect(drill.state).toMatchObject({ focusId: null, depth: 0 });
    expect(await drill.drillDown("AS")).toBe(true);
    expect(await drill.drillDown("CN")).toBe(true);
    expect(drill.state.path.map((r) => r.id)).toEqual(["AS", "CN"]);
    expect(await drill.drillUp()).toBe(true);
    expect(drill.state.focusId).toBe("AS");
    expect(await drill.drillTo("A")).toBe(true);
    expect(drill.state.depth).toBe(3);
    expect(await drill.reset()).toBe(true);
    expect(drill.state.focusId).toBeNull();
    expect(await drill.drillUp()).toBe(false);
    expect(changes.map((c) => c.direction)).toEqual(["down", "down", "up", "jump", "reset"]);
  });

  it("叶子不能作为下钻目标", async () => {
    const { drill } = setup();
    const blocked = vi.fn();
    drill.events.on("blocked", blocked);
    expect(await drill.drillDown("A1")).toBe(false);
    expect(blocked).toHaveBeenCalledWith({ targetId: "A1", reason: "leaf" });
  });

  it("rootId 限定范围,深度相对根计算,上卷不越过根", async () => {
    const { drill } = setup({ rootId: "CN", maxDepth: 1 });
    expect(drill.state).toMatchObject({ focusId: "CN", depth: 0, path: [] });
    expect(await drill.drillTo("AS")).toBe(false); // 根之外
    expect(await drill.drillDown("A")).toBe(true);
    expect(drill.state.path.map((r) => r.id)).toEqual(["A"]);
    expect(await drill.drillTo("A1")).toBe(false); // 超过 maxDepth
    expect(await drill.drillUp()).toBe(true);
    expect(drill.state.focusId).toBe("CN");
    expect(await drill.drillUp()).toBe(false);
  });

  it("守卫可以阻止下钻", async () => {
    const { drill } = setup();
    drill.addGuard(({ target }) => target?.id !== "CN");
    await drill.drillDown("AS");
    expect(await drill.drillDown("CN")).toBe(false);
    expect(drill.state.focusId).toBe("AS");
  });

  it("并发下钻只有最后一次生效;懒加载子级", async () => {
    const tree = new RegionTree(nested);
    let release!: () => void;
    const loadChildren = vi.fn(() => new Promise<void>((r) => (release = r)));
    tree.get("B")!.expandable = true; // B 没有已加载的子级,但可展开
    const drill = new DrillController(tree, { loadChildren });
    const slow = drill.drillTo("B");
    const fast = drill.drillTo("A");
    expect(await fast).toBe(true);
    release();
    expect(await slow).toBe(false);
    expect(drill.state.focusId).toBe("A");
    expect(loadChildren).toHaveBeenCalledWith("B");
  });

  it("序列化与恢复", async () => {
    const { drill } = setup();
    await drill.drillTo("A");
    const s = drill.serialize();
    await drill.reset();
    await drill.restore(s);
    expect(drill.state.focusId).toBe("A");
  });
});

describe("allowLeafFocus", () => {
  it("叶子可以作为下钻目标", async () => {
    const tree = new RegionTree(nested);
    const drill = new DrillController(tree, { allowLeafFocus: true });
    await drill.drillTo("A");
    expect(await drill.drillDown("A1")).toBe(true);
    expect(drill.state.path.map((r) => r.id)).toEqual(["AS", "CN", "A", "A1"]);
  });
});
