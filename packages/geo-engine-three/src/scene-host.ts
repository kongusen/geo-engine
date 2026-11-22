import { GeoScene, type GeoSceneOptions, type SceneStats } from "./geo-scene";
import type { OverlayPlugin } from "./overlay";

export type SceneHostStatus = "ready" | "recovering" | "failed";

/** SceneHost 用到的场景能力(便于测试替换)。 */
export interface HostedScene {
  setAccent(accent: string): void;
  setLabelsVisible(visible: boolean): void;
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
 * - 记住主色、标签显隐、自定义效果插件,重建后原样恢复。
 */
export class SceneHost {
  private current: HostedScene | null = null;
  private status: SceneHostStatus = "recovering";
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private accent: string | undefined;
  private labelsVisible: boolean | undefined;
  private readonly overlays: OverlayPlugin[] = [];
  /** 重建次数(含首次创建),用于巡检。 */
  builds = 0;

  constructor(
    private readonly sceneOptions: GeoSceneOptions,
    private readonly options: SceneHostOptions = {},
  ) {
    this.accent = sceneOptions.theme?.accent;
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
    this.teardown();
  }

  private build(): void {
    this.teardown();
    try {
      const create = this.options.createScene ?? ((o: GeoSceneOptions) => new GeoScene(o));
      const scene = create({
        ...this.sceneOptions,
        theme: { ...this.sceneOptions.theme, ...(this.accent ? { accent: this.accent } : {}) },
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
      for (const plugin of this.overlays) scene.registerOverlay(plugin);
      if (this.labelsVisible !== undefined) scene.setLabelsVisible(this.labelsVisible);
      this.attempt = 0;
      this.setStatus("ready");
    } catch (error) {
      console.error("[scene-host] 场景创建失败", error);
      this.scheduleRetry(error);
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
