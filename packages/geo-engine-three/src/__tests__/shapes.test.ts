import { describe, expect, it } from "vitest";
import { ShapeUtils } from "three";
import { createPlaneMapper, outlinePositions, regionShapes } from "../shapes";
import { Animator } from "../animator";

const square = (x0: number, y0: number, x1: number, y1: number) => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
  [x0, y0],
] as [number, number][];

describe("shapes", () => {
  const mapper = createPlaneMapper([108.7, 25.7], 100 / 0.01);

  it("中心映射到原点,东为 +x、北为 +y", () => {
    expect(mapper.project([108.7, 25.7])).toEqual([0, 0]);
    const [x, y] = mapper.project([108.8, 25.8]);
    expect(x).toBeGreaterThan(0);
    expect(y).toBeGreaterThan(0);
  });

  it("多边形(含洞)转 Shape,去掉闭合重复点", () => {
    const shapes = regionShapes([[square(108.6, 25.6, 108.8, 25.8), [...square(108.65, 25.65, 108.7, 25.7)].reverse()]], mapper);
    expect(shapes).toHaveLength(1);
    expect(shapes[0].getPoints()).toHaveLength(4); // 闭合重复点已去掉
    expect(shapes[0].holes).toHaveLength(1);
    expect(ShapeUtils.area(shapes[0].getPoints())).not.toBe(0);
  });

  it("描边坐标为闭合的扁平数组", () => {
    const [flat] = outlinePositions([[square(108.6, 25.6, 108.8, 25.8)]], mapper, 1);
    expect(flat).toHaveLength(15);
    expect(flat.slice(0, 3)).toEqual(flat.slice(12, 15));
    expect(flat[2]).toBe(1);
  });
});

describe("Animator", () => {
  it("按延迟与时长推进,同 key 新补间取消旧补间", () => {
    let now = 0;
    const a = new Animator(() => now);
    const seen: number[] = [];
    a.add({ duration: 100, delay: 50, ease: (t) => t, update: (t) => seen.push(t) }, "k");
    a.tick(40);
    expect(seen).toEqual([]);
    a.tick(100);
    expect(seen).toEqual([0.5]);
    const other: number[] = [];
    a.add({ duration: 10, ease: (t) => t, update: (t) => other.push(t) }, "k");
    a.tick(200);
    expect(seen).toEqual([0.5]);
    expect(other).toEqual([1]);
    expect(a.busy).toBe(false);
  });
});
