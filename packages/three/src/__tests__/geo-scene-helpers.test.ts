import { describe, expect, it } from "vitest";
import { Color } from "three";
import type { EngineFrame } from "@geodive/core";
import { Animator } from "../animator";
import { computePointBaseSize, resolveCameraControl, resolveDrillUpGestures, resolvePlateStyle } from "../geo-scene";
import { createTheme, resolveHighlightFill } from "../theme";

describe("computePointBaseSize", () => {
  it("当默认比例在屏幕上小于 minPixelSize 时自动按像素下限放大", () => {
    const size = computePointBaseSize(10, 50, 30, 1080, 10);
    // 10px 对应世界直径 10 * (2 * 50 * tan(15deg) / 1080) ≈ 0.248，除以 0.84 ≈ 0.295 > 10 * 0.014 = 0.14
    expect(size).toBeGreaterThan(0.29);
    expect(size * 0.84).toBeCloseTo((10 * (2 * 50 * Math.tan((15 * Math.PI) / 180))) / 1080, 6);
  });

  it("关闭保底或本身足够大时沿用 radius * 0.014", () => {
    expect(computePointBaseSize(100, 10, 30, 1080, 8)).toBeCloseTo(1.4);
    expect(computePointBaseSize(10, 50, 30, 1080, 0)).toBeCloseTo(0.14);
  });
});

describe("resolveHighlightFill", () => {
  it("默认 brighten 保持冷色相不变并适度提亮", () => {
    const theme = createTheme({ accent: "#22d3ee" });
    const base = new Color("#0d6b7c");
    const out = resolveHighlightFill(base, theme);
    const hslBase = { h: 0, s: 0, l: 0 };
    const hslOut = { h: 0, s: 0, l: 0 };
    base.getHSL(hslBase);
    out.getHSL(hslOut);
    expect(hslOut.h).toBeCloseTo(hslBase.h, 3);
    expect(hslOut.l).toBeGreaterThan(hslBase.l);
  });

  it("支持 none 与显式颜色混合", () => {
    const base = new Color("#0d6b7c");
    const noneTheme = createTheme({ highlightFill: "none" });
    expect(resolveHighlightFill(base, noneTheme).getHexString()).toBe(base.getHexString());

    const customTheme = createTheme({ highlightFill: "#ffffff" });
    const expected = base.clone().lerp(new Color("#ffffff"), 0.4);
    expect(resolveHighlightFill(base, customTheme).getHexString()).toBe(expected.getHexString());
  });
});

describe("resolveDrillUpGestures", () => {
  it("支持 boolean 与细粒度手势开关", () => {
    expect(resolveDrillUpGestures()).toEqual({ emptyClick: false, doubleClick: true, contextMenu: true });
    expect(resolveDrillUpGestures(false)).toEqual({ emptyClick: false, doubleClick: false, contextMenu: false });
    expect(resolveDrillUpGestures({ emptyClick: true, doubleClick: false })).toEqual({ emptyClick: true, doubleClick: false, contextMenu: true });
  });
});

describe("Animator 入场与高度补间解耦", () => {
  it("独立 key(:in: 与 :h:)不会互相取消入场透明度补间", () => {
    let now = 0;
    const a = new Animator(() => now);
    let opacity = 0;
    let height = 0.001;
    let targetHeight = 1;
    a.add(
      {
        duration: 100,
        ease: (t) => t,
        update: (k) => {
          opacity = Math.min(1, k * 1.6);
          height = targetHeight * k;
        },
      },
      "1:in:530100",
    );
    // 模拟入场中途收到数据更新:改 targetHeight,不抢占 :in: key
    now = 30;
    a.tick(now);
    expect(opacity).toBeGreaterThan(0);
    targetHeight = 2;
    now = 100;
    a.tick(now);
    expect(opacity).toBe(1);
    expect(height).toBe(2);
  });
});

describe("resolvePlateStyle", () => {
  const frameWith = (depth: number, layers: EngineFrame["layers"] = []) =>
    ({ drill: { focusId: depth ? "r" : null, path: [], depth }, layers }) as unknown as EngineFrame;

  it("auto 模式跟随 basemap 激活自动切换 solid / outline / translucent", () => {
    const basemap = { id: "bm", type: "basemap", data: { sources: [] } };
    const basemapSolid = { id: "bm", type: "basemap", data: { sources: [], plateStyle: "solid" as const } };
    const choropleth = { id: "ch", type: "choropleth", data: { values: {} } };

    expect(resolvePlateStyle(undefined, frameWith(1, [])).mode).toBe("solid");
    expect(resolvePlateStyle("auto", frameWith(3, [basemap]))).toMatchObject({ mode: "outline", fillOpacity: 0, flat: true, showDecor: false });
    expect(resolvePlateStyle("auto", frameWith(2, [basemap, choropleth]))).toMatchObject({ mode: "translucent", fillOpacity: 0.42, flat: false });
    expect(resolvePlateStyle("auto", frameWith(3, [basemapSolid])).mode).toBe("solid");
  });

  it("支持 solid / translucent / outline 预设与按帧函数动态切换", () => {
    expect(resolvePlateStyle("solid", frameWith(1))).toMatchObject({ mode: "solid", fillOpacity: 0.96, flat: false, showDecor: true });
    expect(resolvePlateStyle("translucent", frameWith(1))).toMatchObject({ mode: "translucent", fillOpacity: 0.42, flat: false });
    expect(resolvePlateStyle("outline", frameWith(3))).toMatchObject({ mode: "outline", fillOpacity: 0, sideOpacity: 0, baseOpacity: 0, flat: true, showDecor: false });

    const fn = (f: EngineFrame) => (f.drill.depth >= 3 ? "outline" : "solid");
    expect(resolvePlateStyle(fn, frameWith(2)).mode).toBe("solid");
    expect(resolvePlateStyle(fn, frameWith(3)).mode).toBe("outline");
    expect(resolvePlateStyle({ mode: "outline", hoverFillOpacity: 0.25 }, frameWith(3)).hoverFillOpacity).toBe(0.25);
  });
});

describe("resolveCameraControl", () => {
  it("默认开启平移缩放俯仰,传 false 全部关闭,支持局部覆写", () => {
    expect(resolveCameraControl()).toMatchObject({ pan: true, zoom: true, tilt: true, minZoomScale: 0.04, maxZoomScale: 2.5 });
    expect(resolveCameraControl(true)).toMatchObject({ pan: true, zoom: true, tilt: true });
    expect(resolveCameraControl(false)).toMatchObject({ pan: false, zoom: false, tilt: false });
    expect(resolveCameraControl({ zoom: false, pitchRange: [10, 50] })).toMatchObject({ pan: true, zoom: false, tilt: true, pitchRange: [10, 50] });
  });
});
