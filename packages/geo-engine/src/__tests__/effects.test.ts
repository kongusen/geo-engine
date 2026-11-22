import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clusterPoints } from "../cluster";
import { densityGrid } from "../density";
import { GeoEngine } from "../engine";
import { autoTour } from "../plugins/auto-tour";
import { nested } from "./fixtures";

describe("clusterPoints", () => {
  it("同格合并、按权重求中心", () => {
    const clusters = clusterPoints(
      [
        { id: "a", position: [0.1, 0.1], weight: 1 },
        { id: "b", position: [0.3, 0.3], weight: 3 },
        { id: "c", position: [5, 5] },
      ],
      1,
    );
    expect(clusters).toHaveLength(2);
    const big = clusters.find((c) => c.count === 2)!;
    expect(big.weight).toBe(4);
    expect(big.position[0]).toBeCloseTo(0.25);
  });
});

describe("densityGrid", () => {
  it("峰值在点附近,半径外为 0", () => {
    const grid = densityGrid([{ x: 5, y: 5, weight: 2 }], { minX: 0, minY: 0, maxX: 10, maxY: 10 }, 10, 10, 2);
    const at = (c: number, r: number) => grid.values[r * 10 + c];
    expect(at(4, 4)).toBeCloseTo(grid.max);
    expect(at(0, 0)).toBe(0);
    expect(at(4, 4)).toBeGreaterThan(at(6, 4));
  });
});

describe("autoTour", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("按站点巡游,人工操作暂停,空闲后恢复", async () => {
    const engine = new GeoEngine();
    engine.addRegions(nested, { inferParents: true });
    await engine.start();
    const tour = autoTour({ stops: ["CN", "A", null], dwellMs: 1000, resumeAfterMs: 5000 });
    engine.use(tour);
    await vi.advanceTimersByTimeAsync(1000);
    expect(engine.drill.state.focusId).toBe("CN");
    await vi.advanceTimersByTimeAsync(1000);
    expect(engine.drill.state.focusId).toBe("A");

    // 人工下钻 → 暂停
    await engine.drill.drillTo("B");
    expect(tour.running).toBe(false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(engine.drill.state.focusId).toBe("B");
    // 空闲 5s 后从下一站(null)继续
    await vi.advanceTimersByTimeAsync(2000);
    expect(tour.running).toBe(true);
    expect(engine.drill.state.focusId).toBeNull();
    // 循环回第一站
    await vi.advanceTimersByTimeAsync(1000);
    expect(engine.drill.state.focusId).toBe("CN");
    engine.unuse("auto-tour");
    await vi.advanceTimersByTimeAsync(5000);
    expect(engine.drill.state.focusId).toBe("CN");
  });
});
