import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Emitter, type Position } from "@geodive/core";
import type {
  AnchorOptions,
  FitBoundsOptions,
  FlyToOptions,
  GeoSceneOptions,
  MapClickEvent,
  PlateStyleSpec,
  SceneAnchor,
  SceneCameraInfo,
  SceneEventMap,
  ScenePickEvent,
  SceneStats,
  SceneTransitionInfo,
  ViewportInset,
} from "../geo-scene";
import { SceneHost, type HostedScene, type SceneHostStatus } from "../scene-host";

type Fake = HostedScene & {
  options: GeoSceneOptions;
  events: Emitter<SceneEventMap>;
  disposed: boolean;
  accent: string[];
  labels: boolean[];
  overlays: string[];
  insets: Array<{ inset: ViewportInset; animate?: boolean }>;
  plateStyles: Array<PlateStyleSpec | undefined>;
  highlights: Array<string | string[] | null>;
  flies: FlyToOptions[];
  resets: boolean[];
  fits: Array<{ positions: Position[]; options?: FitBoundsOptions }>;
  pitches: Array<{ pitchDeg: number; animate?: boolean }>;
  zooms: Array<{ factor: number; animate?: boolean }>;
  anchors: Array<{ position: Position; element: HTMLElement; options?: AnchorOptions; disposed: boolean }>;
  idleResolved: boolean;
};

function factory(failures: number[] = []) {
  const created: Fake[] = [];
  let call = 0;
  const createScene = (options: GeoSceneOptions): Fake => {
    if (failures.includes(call++)) throw new Error("Error creating WebGL context");
    const events = new Emitter<SceneEventMap>();
    const scene: Fake = {
      options,
      events,
      disposed: false,
      accent: [],
      labels: [],
      overlays: [],
      insets: [],
      plateStyles: [],
      highlights: [],
      flies: [],
      resets: [],
      fits: [],
      pitches: [],
      zooms: [],
      anchors: [],
      idleResolved: false,
      setAccent: (a) => scene.accent.push(a),
      setLabelsVisible: (v) => scene.labels.push(v),
      setViewportInset: (inset, animate) => scene.insets.push({ inset, animate }),
      setPlateStyle: (style) => scene.plateStyles.push(style),
      setHighlight: (id) => scene.highlights.push(id),
      flyTo: async (opts) => {
        scene.flies.push(opts);
      },
      resetView: async (animate = true) => {
        scene.resets.push(animate);
      },
      fitBounds: async (positions, opts) => {
        scene.fits.push({ positions, options: opts });
      },
      setPitch: async (pitchDeg, animate) => {
        scene.pitches.push({ pitchDeg, animate });
      },
      zoomBy: async (factor, animate) => {
        scene.zooms.push({ factor, animate });
      },
      getCameraState: () => ({ mode: "plane", center: [102.7, 25], distance: 12, pitchDeg: 35, zoomRatio: 1.5 }),
      project: () => ({ x: 120, y: 80, visible: true }),
      unproject: () => [102.7, 25],
      createAnchor: (position, element, opts): SceneAnchor => {
        const rec = { position, element, options: opts, disposed: false };
        scene.anchors.push(rec);
        return {
          setPosition: (p) => (rec.position = p),
          setOffset: () => {},
          setVisible: () => {},
          dispose: () => (rec.disposed = true),
        };
      },
      on: (ev, handler) => events.on(ev, handler),
      whenIdle: async () => {
        scene.idleResolved = true;
      },
      registerOverlay: (p) => scene.overlays.push(p.type),
      stats: () => ({ fps: 60 }) as SceneStats,
      dispose: () => {
        scene.disposed = true;
        events.clear();
      },
    };
    created.push(scene);
    return scene;
  };
  return { created, createScene };
}

const base = { container: {} as HTMLElement, engine: {} as GeoSceneOptions["engine"], theme: { accent: "#10b981" } };

describe("SceneHost", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("上下文丢失后等待恢复,超时在新画布上重建,并恢复主色 / 标签 / 视口留白 / 外部高亮 / 自定义效果", () => {
    const { created, createScene } = factory();
    const statuses: SceneHostStatus[] = [];
    const host = new SceneHost(base, { createScene, restoreWaitMs: 2000, onStatus: (s) => statuses.push(s) });
    host.setAccent("#f59e0b");
    host.setLabelsVisible(false);
    host.setViewportInset({ top: 180, right: 416, bottom: 232, left: 416 });
    host.setHighlight("330106");
    host.registerOverlay({ type: "custom", modes: ["plane"], create: () => ({ dispose() {} }) });

    expect(created[0].insets).toEqual([{ inset: { top: 180, right: 416, bottom: 232, left: 416 }, animate: true }]);
    expect(created[0].highlights).toEqual(["330106"]);

    created[0].options.onContextLost!();
    expect(host.state).toBe("recovering");
    vi.advanceTimersByTime(1999);
    expect(created).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(created).toHaveLength(2);
    expect(created[0].disposed).toBe(true);
    expect(created[1].options.theme?.accent).toBe("#f59e0b");
    expect(created[1].options.viewportInset).toEqual({ top: 180, right: 416, bottom: 232, left: 416 });
    expect(created[1].labels).toEqual([false]);
    expect(created[1].highlights).toEqual(["330106"]);
    expect(created[1].overlays).toEqual(["custom"]);
    expect(statuses).toEqual(["ready", "recovering", "ready"]);
    expect(host.builds).toBe(2);
  });

  it("浏览器发出 restored 时立即重建;旧场景迟到的事件被忽略", () => {
    const { created, createScene } = factory();
    const host = new SceneHost(base, { createScene });
    const stale = created[0].options;
    stale.onContextLost!();
    stale.onContextRestored!();
    expect(created).toHaveLength(2);
    expect(host.state).toBe("ready");
    stale.onContextLost!(); // 已被替换的场景
    expect(host.state).toBe("ready");
    vi.advanceTimersByTime(10000);
    expect(created).toHaveLength(2);
  });

  it("创建失败按退避重试,用尽后 failed,之后低频重试成功回到 ready", () => {
    const { created, createScene } = factory([0, 1, 2]);
    const statuses: SceneHostStatus[] = [];
    const host = new SceneHost(base, { createScene, retryDelaysMs: [100, 200], failedRetryMs: 5000, onStatus: (s) => statuses.push(s) });
    expect(host.state).toBe("recovering");
    vi.advanceTimersByTime(100); // 第 2 次失败
    vi.advanceTimersByTime(200); // 第 3 次失败 → failed
    expect(host.state).toBe("failed");
    vi.advanceTimersByTime(5000); // 第 4 次成功
    expect(host.state).toBe("ready");
    expect(created).toHaveLength(1);
    expect(statuses).toEqual(["recovering", "recovering", "failed", "ready"]);
  });

  it("dispose 后不再重建", () => {
    const { created, createScene } = factory();
    const host = new SceneHost(base, { createScene });
    created[0].options.onContextLost!();
    host.dispose();
    vi.advanceTimersByTime(60000);
    expect(created).toHaveLength(1);
    expect(created[0].disposed).toBe(true);
  });

  it("转发异步相机 API 并在重建后保留 transition 监听", async () => {
    const { created, createScene } = factory();
    const starts: SceneTransitionInfo[] = [];
    const ends: SceneTransitionInfo[] = [];
    const host = new SceneHost(base, { createScene });
    host.on("transitionstart", (i) => starts.push(i));
    host.on("transitionend", (i) => ends.push(i));

    await host.flyTo({ position: [102.7, 25.0], zoom: 3 });
    await host.resetView(false);
    await host.whenIdle();
    expect(created[0].flies).toEqual([{ position: [102.7, 25.0], zoom: 3 }]);
    expect(created[0].resets).toEqual([false]);
    expect(created[0].idleResolved).toBe(true);

    created[0].events.emit("transitionstart", { focusId: "530000", mode: "plane" });
    created[0].events.emit("transitionend", { focusId: "530000", mode: "plane" });

    // 上下文丢失并重建后,新场景仍转发到同一订阅者,旧场景被忽略
    const stale = created[0];
    stale.options.onContextLost!();
    stale.options.onContextRestored!();
    stale.events.emit("transitionstart", { focusId: "stale", mode: "plane" });
    created[1].events.emit("transitionstart", { focusId: "530100", mode: "plane" });
    created[1].events.emit("transitionend", { focusId: "530100", mode: "plane" });

    expect(starts).toEqual([
      { focusId: "530000", mode: "plane" },
      { focusId: "530100", mode: "plane" },
    ]);
    expect(ends).toEqual([
      { focusId: "530000", mode: "plane" },
      { focusId: "530100", mode: "plane" },
    ]);
  });

  it("转发并重建恢复 plateStyle / pitch / 多区域高亮 / DOM 锚点 / onLayer 与统一交互事件", async () => {
    const { created, createScene } = factory();
    const clicks: ScenePickEvent[] = [];
    const markerClicks: Array<{ id: string }> = [];
    const markerHovers: Array<string | null> = [];
    const mapClicks: MapClickEvent[] = [];
    const camChanges: SceneCameraInfo[] = [];

    const host = new SceneHost(base, { createScene });
    host.on("click", (e) => clicks.push(e));
    host.on("mapclick", (e) => mapClicks.push(e));
    host.on("camerachange", (e) => camChanges.push(e));
    host.onLayer<{ id: string }>("mk", "click", (ev) => markerClicks.push(ev.item));
    host.onLayer<{ id: string }>("mk", "hover", (ev) => markerHovers.push(ev?.item.id ?? null));

    host.setPlateStyle("outline");
    host.setHighlight(["530100", "530300"]);
    await host.setPitch(12, false);
    await host.zoomBy(2);
    await host.fitBounds([
      [102.6, 24.9],
      [102.8, 25.1],
    ]);
    expect(host.getCameraState()?.mode).toBe("plane");
    expect(host.project([102.7, 25])).toEqual({ x: 120, y: 80, visible: true });
    expect(host.unproject(120, 80)).toEqual([102.7, 25]);

    const popupEl = {} as HTMLElement;
    const anchor = host.createAnchor([102.7, 25], popupEl, { align: "bottom" });
    anchor.setPosition([102.75, 25.05]);
    expect(created[0].anchors).toHaveLength(1);
    expect(created[0].anchors[0].position).toEqual([102.75, 25.05]);

    created[0].events.emit("click", { layerId: "mk", layerType: "marker", item: { id: "c1" }, screen: [10, 20] });
    created[0].events.emit("hover", { layerId: "mk", layerType: "marker", item: { id: "c1" }, screen: [10, 20] });
    created[0].events.emit("hover", { layerId: "other", layerType: "point", item: { id: "p1" }, screen: [15, 25] });
    created[0].events.emit("mapclick", { position: [102.7, 25], screen: [10, 20], regionId: "530100", hit: null });
    created[0].events.emit("camerachange", { mode: "plane", center: [102.7, 25], distance: 10, pitchDeg: 12, zoomRatio: 2 });

    expect(clicks).toHaveLength(1);
    expect(markerClicks).toEqual([{ id: "c1" }]);
    expect(markerHovers).toEqual(["c1", null]);
    expect(mapClicks).toHaveLength(1);
    expect(camChanges).toHaveLength(1);

    // 上下文丢失后重建:恢复 plateStyle / pitchDeg / 多选 highlight / DOM anchor
    created[0].options.onContextLost!();
    created[0].options.onContextRestored!();
    expect(created[1].options.plateStyle).toBe("outline");
    expect(created[1].options.pitchDeg).toBe(12);
    expect(created[1].highlights).toEqual([["530100", "530300"]]);
    expect(created[1].anchors).toHaveLength(1);
    expect(created[1].anchors[0].position).toEqual([102.75, 25.05]);

    anchor.dispose();
    expect(created[1].anchors[0].disposed).toBe(true);
  });
});
