import { Emitter, type Position, type Unsubscribe } from "@geodive/core";
import {
  GeoScene,
  type AnchorOptions,
  type FitBoundsOptions,
  type FlyToOptions,
  type GeoSceneOptions,
  type PlateStyleSpec,
  type SceneAnchor,
  type SceneCameraInfo,
  type SceneEventMap,
  type ScenePickEvent,
  type SceneStats,
  type ScreenPoint,
  type ViewportInset,
} from "./geo-scene";
import type { OverlayPlugin } from "./overlay";

export type SceneHostStatus = "ready" | "recovering" | "failed";

/** SceneHost 用到的场景能力(便于测试替换)。 */
export interface HostedScene {
  setAccent(accent: string): void;
  setLabelsVisible(visible: boolean): void;
  setViewportInset?(inset: ViewportInset, animate?: boolean): void;
  setPlateStyle?(style: PlateStyleSpec | undefined): void;
  setHighlight?(id: string | string[] | null): void;
  flyTo?(options: FlyToOptions): Promise<void>;
  resetView?(animate?: boolean): Promise<void>;
  fitBounds?(positions: Position[], options?: FitBoundsOptions): Promise<void>;
  setPitch?(pitchDeg: number, animate?: boolean): Promise<void>;
  zoomBy?(factor: number, animate?: boolean): Promise<void>;
  getCameraState?(): SceneCameraInfo | null;
  project?(position: Position, heightOffset?: number): ScreenPoint | null;
  unproject?(screenX: number, screenY: number): Position | null;
  createAnchor?(position: Position, element: HTMLElement, options?: AnchorOptions): SceneAnchor;
  on?<K extends keyof SceneEventMap>(event: K, handler: (payload: SceneEventMap[K]) => void): Unsubscribe;
  whenIdle?(): Promise<void>;
  registerOverlay(plugin: OverlayPlugin): void;
  stats(): SceneStats;
  dispose(): void;
}

export interface SceneHostOptions {
  /** 重建失败后的等待序列(毫秒),依次使用,默认 [1500, 5000, 15000]。 */
  retryDelaysMs?: number[];
  /** 序列用完仍失败则进入 failed(宿主显示降级视图),之后每隔多久再试一次,默认 60000;0 为不再尝试。 */
  failedRetryMs?: number;
  /** 上下文丢失后等待浏览器恢复的时间,超时直接在新画布上重建,默认 2000。 */
  restoreWaitMs?: number;
  onStatus?(status: SceneHostStatus, error?: unknown): void;
  /** 创建场景(测试注入);默认 new GeoScene。 */
  createScene?(options: GeoSceneOptions): HostedScene;
}

/**
 * 场景宿主:负责 GeoScene 的生命周期与故障恢复,适合无人值守的大屏。
 * - WebGL 上下文丢失(显卡重置、休眠唤醒)后,在新画布上重建场景;引擎状态(当前层级、图层)不受影响;
 * - 创建失败按退避序列重试,仍失败进入 failed,之后低频重试,成功后自动回到 ready;
 * - 记住主色、标签显隐、视口留白、外部高亮、自定义效果插件,重建后原样恢复。
 */
export class SceneHost {
  private current: HostedScene | null = null;
  private status: SceneHostStatus = "recovering";
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private accent: string | undefined;
  private labelsVisible: boolean | undefined;
  private viewportInset: ViewportInset | undefined;
  private plateStyle: PlateStyleSpec | undefined;
  private hasCustomPlateStyle = false;
  private pitchDeg: number | undefined;
  private highlighted: string | string[] | null | undefined;
  private readonly overlays: OverlayPlugin[] = [];
  private readonly anchors = new Set<{
    position: Position;
    element: HTMLElement;
    options?: AnchorOptions;
    offset?: [number, number];
    visible?: boolean;
    inner: SceneAnchor | null;
  }>();
  private readonly events = new Emitter<SceneEventMap>();
  private unsubScene: Unsubscribe[] = [];
  private building = false;
  /** 重建次数(含首次创建),用于巡检。 */
  builds = 0;

  constructor(
    private readonly sceneOptions: GeoSceneOptions,
    private readonly options: SceneHostOptions = {},
  ) {
    this.accent = sceneOptions.theme?.accent;
    this.viewportInset = sceneOptions.viewportInset ? { ...sceneOptions.viewportInset } : undefined;
    this.plateStyle = sceneOptions.plateStyle;
    this.build();
  }

  get scene(): HostedScene | null {
    return this.current;
  }

  get state(): SceneHostStatus {
    return this.status;
  }

  setAccent(accent: string): void {
    this.accent = accent;
    this.current?.setAccent(accent);
  }

  setLabelsVisible(visible: boolean): void {
    this.labelsVisible = visible;
    this.current?.setLabelsVisible(visible);
  }

  setViewportInset(inset: ViewportInset, animate = true): void {
    this.viewportInset = { ...inset };
    this.current?.setViewportInset?.(inset, animate);
  }

  setPlateStyle(style: PlateStyleSpec | undefined): void {
    this.plateStyle = style;
    this.hasCustomPlateStyle = true;
    this.current?.setPlateStyle?.(style);
  }

  setHighlight(id: string | string[] | null): void {
    this.highlighted = Array.isArray(id) ? [...id] : id;
    this.current?.setHighlight?.(id);
  }

  flyTo(options: FlyToOptions): Promise<void> {
    return this.current?.flyTo?.(options) ?? Promise.resolve();
  }

  resetView(animate = true): Promise<void> {
    this.pitchDeg = undefined;
    return this.current?.resetView?.(animate) ?? Promise.resolve();
  }

  fitBounds(positions: Position[], options?: FitBoundsOptions): Promise<void> {
    return this.current?.fitBounds?.(positions, options) ?? Promise.resolve();
  }

  setPitch(pitchDeg: number, animate = true): Promise<void> {
    this.pitchDeg = pitchDeg;
    return this.current?.setPitch?.(pitchDeg, animate) ?? Promise.resolve();
  }

  zoomBy(factor: number, animate = true): Promise<void> {
    return this.current?.zoomBy?.(factor, animate) ?? Promise.resolve();
  }

  getCameraState(): SceneCameraInfo | null {
    return this.current?.getCameraState?.() ?? null;
  }

  project(position: Position, heightOffset = 0): ScreenPoint | null {
    return this.current?.project?.(position, heightOffset) ?? null;
  }

  unproject(screenX: number, screenY: number): Position | null {
    return this.current?.unproject?.(screenX, screenY) ?? null;
  }

  createAnchor(position: Position, element: HTMLElement, options?: AnchorOptions): SceneAnchor {
    const record: {
      position: Position;
      element: HTMLElement;
      options?: AnchorOptions;
      offset?: [number, number];
      visible?: boolean;
      inner: SceneAnchor | null;
    } = {
      position: [...position],
      element,
      options,
      offset: options?.offset ? [...options.offset] : undefined,
      visible: options?.visible,
      inner: this.current?.createAnchor?.(position, element, options) ?? null,
    };
    this.anchors.add(record);
    return {
      setPosition: (next) => {
        record.position = [...next];
        record.inner?.setPosition(next);
      },
      setOffset: (next) => {
        record.offset = [...next];
        record.inner?.setOffset(next);
      },
      setVisible: (next) => {
        record.visible = next;
        record.inner?.setVisible(next);
      },
      dispose: () => {
        this.anchors.delete(record);
        record.inner?.dispose();
        record.inner = null;
      },
    };
  }

  on<K extends keyof SceneEventMap>(event: K, handler: (payload: SceneEventMap[K]) => void): Unsubscribe {
    return this.events.on(event, handler);
  }

  /** 按图层 id 订阅点击或悬停事件(悬停离开该图层时派发 null)。 */
  onLayer<T = unknown>(layerId: string, event: "click", handler: (event: ScenePickEvent<T>) => void): Unsubscribe;
  onLayer<T = unknown>(layerId: string, event: "hover", handler: (event: ScenePickEvent<T> | null) => void): Unsubscribe;
  onLayer<T = unknown>(layerId: string, event: "click" | "hover", handler: ((event: ScenePickEvent<T>) => void) | ((event: ScenePickEvent<T> | null) => void)): Unsubscribe {
    if (event === "click") {
      const fn = handler as (event: ScenePickEvent<T>) => void;
      return this.events.on("click", (ev) => {
        if (ev.layerId === layerId) fn(ev as ScenePickEvent<T>);
      });
    }
    const fn = handler as (event: ScenePickEvent<T> | null) => void;
    let active = false;
    return this.events.on("hover", (ev) => {
      if (ev?.layerId === layerId) {
        active = true;
        fn(ev as ScenePickEvent<T>);
      } else if (active) {
        active = false;
        fn(null);
      }
    });
  }

  whenIdle(): Promise<void> {
    return this.current?.whenIdle ? this.current.whenIdle() : Promise.resolve();
  }

  registerOverlay(plugin: OverlayPlugin): void {
    this.overlays.push(plugin);
    this.current?.registerOverlay(plugin);
  }

  stats(): (SceneStats & { builds: number; status: SceneHostStatus }) | null {
    return this.current ? { ...this.current.stats(), builds: this.builds, status: this.status } : null;
  }

  /** 立即重建(如宿主检测到画面异常)。 */
  rebuild(): void {
    if (this.disposed) return;
    this.clearTimer();
    this.build();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.events.clear();
    for (const a of [...this.anchors]) a.inner?.dispose();
    this.anchors.clear();
    this.teardown();
  }

  private build(): void {
    this.teardown();
    this.building = true;
    try {
      const create = this.options.createScene ?? ((o: GeoSceneOptions) => new GeoScene(o));
      const scene = create({
        ...this.sceneOptions,
        theme: { ...this.sceneOptions.theme, ...(this.accent ? { accent: this.accent } : {}) },
        ...(this.viewportInset ? { viewportInset: this.viewportInset } : {}),
        ...(this.hasCustomPlateStyle ? { plateStyle: this.plateStyle } : {}),
        ...(this.pitchDeg !== undefined ? { pitchDeg: this.pitchDeg } : {}),
        onContextLost: () => {
          this.sceneOptions.onContextLost?.();
          if (this.current === scene) this.onLost();
        },
        onContextRestored: () => {
          this.sceneOptions.onContextRestored?.();
          if (this.current === scene && this.status === "recovering") this.rebuild();
        },
      });
      this.builds++;
      this.current = scene;
      const events: Array<keyof SceneEventMap> = ["click", "hover", "mapclick", "camerachange", "transitionstart", "transitionend"];
      for (const ev of events) {
        const off = scene.on?.(ev, (payload) => {
          if (this.disposed || (this.current !== scene && !this.building)) return;
          this.events.emit(ev, payload as never);
        });
        if (off) this.unsubScene.push(off);
      }
      for (const plugin of this.overlays) scene.registerOverlay(plugin);
      if (this.labelsVisible !== undefined) scene.setLabelsVisible(this.labelsVisible);
      if (this.highlighted !== undefined) scene.setHighlight?.(this.highlighted);
      for (const a of this.anchors) {
        a.inner =
          scene.createAnchor?.(a.position, a.element, {
            ...a.options,
            ...(a.offset ? { offset: a.offset } : {}),
            ...(a.visible !== undefined ? { visible: a.visible } : {}),
          }) ?? null;
      }
      this.attempt = 0;
      this.setStatus("ready");
    } catch (error) {
      console.error("[scene-host] 场景创建失败", error);
      this.scheduleRetry(error);
    } finally {
      this.building = false;
    }
  }

  private onLost(): void {
    this.setStatus("recovering");
    this.clearTimer();
    // 先等浏览器恢复上下文(restored 事件会触发重建),超时再强制在新画布上重建
    this.timer = setTimeout(() => this.build(), this.options.restoreWaitMs ?? 2000);
  }

  private scheduleRetry(error: unknown): void {
    this.teardown();
    const delays = this.options.retryDelaysMs ?? [1500, 5000, 15000];
    if (this.attempt < delays.length) {
      this.setStatus("recovering", error);
      this.timer = setTimeout(() => this.build(), delays[this.attempt++]);
      return;
    }
    this.setStatus("failed", error);
    const slow = this.options.failedRetryMs ?? 60000;
    if (slow > 0) this.timer = setTimeout(() => this.build(), slow);
  }

  private setStatus(status: SceneHostStatus, error?: unknown): void {
    if (this.disposed) return;
    const changed = status !== this.status;
    this.status = status;
    if (changed || error) this.options.onStatus?.(status, error);
  }

  private teardown(): void {
    for (const off of this.unsubScene) off();
    this.unsubScene = [];
    const scene = this.current;
    this.current = null;
    try {
      scene?.dispose();
    } catch (error) {
      console.warn("[scene-host] 释放旧场景出错(上下文已丢失时可忽略)", error);
    }
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
