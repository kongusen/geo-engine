import { describe, expect, it } from "vitest";
import { RegionTree } from "../region-tree";
import { box, nested } from "./fixtures";

const ids = (rs: { id: string }[]) => rs.map((r) => r.id).sort();

describe("RegionTree", () => {
  it("显式父级建树:路径、深度、叶子", () => {
    const tree = new RegionTree(
      [
        { id: "CN", name: "中国", polygons: box(70, 10, 130, 50) },
        { id: "ZJ", name: "浙江", parentId: "CN", polygons: box(103, 24, 110, 29) },
        { id: "XH", name: "西湖区", parentId: "ZJ", polygons: box(108, 25, 109, 26), aliases: ["西湖"] },
      ],
      { inferParents: false },
    );
    expect(tree.path("XH").map((r) => r.name)).toEqual(["中国", "浙江", "西湖区"]);
    expect(tree.depth("XH")).toBe(2);
    expect(tree.isLeaf("XH")).toBe(true);
    expect(tree.isLeaf("ZJ")).toBe(false);
    expect(tree.resolve("西湖")?.id).toBe("XH");
    expect(tree.resolve(" 西 湖 区 ")?.id).toBe("XH");
  });

  it("无编码数据按空间包含推断出完整层级(乱序一次加入)", () => {
    const tree = new RegionTree([...nested].reverse());
    expect(ids(tree.roots())).toEqual(["AS"]);
    expect(tree.path("A1").map((r) => r.id)).toEqual(["AS", "CN", "A", "A1"]);
    expect(ids(tree.children("A"))).toEqual(["A1", "A2"]);
    expect(tree.parent("B")?.id).toBe("CN");
  });

  it("先加载小区域、后加载大区域时,原根节点会被挂到新的父级下", () => {
    const tree = new RegionTree(nested.filter((r) => r.level === "county"));
    expect(ids(tree.roots())).toEqual(["A1", "A2"]);
    tree.add(nested.filter((r) => r.level !== "county"));
    expect(ids(tree.roots())).toEqual(["AS"]);
    expect(tree.parent("A1")?.id).toBe("A");
  });

  it("不满足包含阈值的区域不被误挂(跨界区域)", () => {
    const tree = new RegionTree([
      { id: "P", name: "父", polygons: box(0, 0, 10, 10) },
      { id: "X", name: "跨界", polygons: box(5, 5, 15, 15) },
    ]);
    expect(tree.get("X")?.parentId).toBeNull();
  });

  it("父级缺失时降级为空间推断,并报告问题", () => {
    const tree = new RegionTree([{ id: "P", name: "父", polygons: box(0, 0, 10, 10) }]);
    const issues = tree.add([{ id: "C", name: "子", parentId: "NOPE", polygons: box(1, 1, 2, 2) }]);
    expect(issues.map((i) => i.code)).toEqual(["missing-parent", "parent-inferred"]);
    expect(tree.get("C")?.parentId).toBe("P");
  });

  it("同名区域可用祖先范围限定;点定位返回最深区域", () => {
    const tree = new RegionTree([
      ...nested,
      { id: "B1", name: "县A1", polygons: box(110, 20, 115, 25) }, // 与 A1 同名,位于省 B
    ]);
    expect(tree.resolve("县A1", "B")?.id).toBe("B1");
    expect(tree.resolve("县A1", "A")?.id).toBe("A1");
    expect(tree.locate([106, 21])?.id).toBe("A2");
    expect(tree.locate([90, 40])?.id).toBe("CN");
    expect(tree.locate([0, 0])).toBeUndefined();
  });

  it("删除区域会连带删除子树", () => {
    const tree = new RegionTree(nested);
    tree.remove("A");
    expect(tree.has("A1")).toBe(false);
    expect(ids(tree.children("CN"))).toEqual(["B"]);
  });
});
