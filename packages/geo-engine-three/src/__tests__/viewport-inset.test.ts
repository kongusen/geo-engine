import { describe, expect, it } from "vitest";
import { safeAreaNdc } from "../geo-scene";

describe("safeAreaNdc 安全区视口留白计算", () => {
  it("无留白时铺满标准 NDC [-1, 1]", () => {
    expect(safeAreaNdc(1920, 1080)).toEqual({ cx: 0, cy: 0, halfW: 1, halfH: 1 });
    expect(safeAreaNdc(1920, 1080, {})).toEqual({ cx: 0, cy: 0, halfW: 1, halfH: 1 });
  });

  it("大屏上下左右 HUD 留白:准确计算安全区中心与半宽半高", () => {
    const res = safeAreaNdc(1920, 1080, { top: 210, right: 428, bottom: 272, left: 428 });
    expect(res.cx).toBeCloseTo(0, 6);
    // 可用垂直区 [210, 808],中心 y=509 < 画布中心 540 → WebGL NDC cy > 0(略偏上)
    expect(res.cy).toBeGreaterThan(0);
    expect(res.cy).toBeCloseTo((272 - 210) / 1080, 6);
    expect(res.halfW).toBeCloseTo((1920 - 856) / 1920, 6);
    expect(res.halfH).toBeCloseTo((1080 - 482) / 1080, 6);
  });

  it("非对称左右留白使安全区中心右移", () => {
    const res = safeAreaNdc(1920, 1080, { left: 400, right: 0 });
    expect(res.cx).toBeCloseTo(400 / 1920, 6);
    expect(res.halfW).toBeCloseTo((1920 - 400) / 1920, 6);
  });

  it("负值按 0 处理", () => {
    expect(safeAreaNdc(1920, 1080, { top: -50, right: -20, bottom: -10, left: -30 })).toEqual({
      cx: 0,
      cy: 0,
      halfW: 1,
      halfH: 1,
    });
  });

  it("留白过大或容器极小时安全回退该轴为满幅", () => {
    const overX = safeAreaNdc(1920, 1080, { left: 900, right: 900, top: 100, bottom: 100 });
    expect(overX.cx).toBe(0);
    expect(overX.halfW).toBe(1);
    expect(overX.halfH).toBeCloseTo((1080 - 200) / 1080, 6);

    const tiny = safeAreaNdc(1, 1, { left: 400, top: 200 });
    expect(tiny).toEqual({ cx: 0, cy: 0, halfW: 1, halfH: 1 });
  });
});
