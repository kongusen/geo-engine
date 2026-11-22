import { describe, expect, it } from "vitest";
import { bindData, classify, interpolateColors, legendFor } from "../binding";
import { RegionTree } from "../region-tree";
import { box } from "./fixtures";

describe("binding", () => {
  const tree = new RegionTree(
    [
      { id: "522633101", name: "丙妹镇", polygons: box(0, 0, 1, 1) },
      { id: "522633210", name: "翠里瑶族壮族乡", aliases: ["翠里乡"], polygons: box(1, 0, 2, 1) },
    ],
    { inferParents: false },
  );

  it("按编码/名称/别名关联,同区域累加,记录未匹配行", () => {
    const rows = [
      { town: "522633101", area: 10 },
      { town: "丙妹镇", area: 5 },
      { town: "翠里乡", area: 7 },
      { town: "不存在乡", area: 1 },
      { town: "翠里瑶族壮族乡", area: null },
    ];
    const { values, unmatched } = bindData(tree, rows, { key: (r) => r.town, value: (r) => r.area });
    expect(values.get("522633101")?.value).toBe(15);
    expect(values.get("522633210")?.value).toBe(7);
    expect(unmatched).toEqual([{ town: "不存在乡", area: 1 }]);
  });

  it("分级:线性 / 等距 / 分位数 / 自然断点", () => {
    const linear = classify([0, 50, 100]);
    expect(linear.position(25)).toBe(0.25);
    expect(classify([0, 10], "equal", 2).breaks).toEqual([0, 5, 10]);
    expect(classify([1, 2, 3, 4, 5, 6, 7, 8], "quantile", 4).classOf(8)).toBe(3);

    // 三个明显的簇
    const jenks = classify([1, 2, 3, 50, 51, 52, 100, 101, 102], "jenks", 3);
    expect(jenks.classOf(2)).toBe(0);
    expect(jenks.classOf(51)).toBe(1);
    expect(jenks.classOf(101)).toBe(2);
    expect(jenks.breaks[0]).toBe(1);
    expect(jenks.breaks[3]).toBe(102);
  });

  it("全部相同或为空时不出错", () => {
    expect(classify([5, 5, 5], "jenks").position(5)).toBe(1);
    expect(classify([]).breaks).toEqual([]);
  });

  it("颜色插值与图例", () => {
    expect(interpolateColors(["#000000", "#ffffff"], 0.5)).toBe("#808080");
    expect(interpolateColors(["#000", "#f00", "#fff"], 1)).toBe("#ffffff");
    const legend = legendFor(classify([0, 10], "equal", 2), ["#000000", "#ffffff"]);
    expect(legend).toEqual([
      { color: "#404040", from: 0, to: 5 },
      { color: "#bfbfbf", from: 5, to: 10 },
    ]);
  });
});
