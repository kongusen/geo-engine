import { DrillController, type DrillChange, type DrillGuard, type DrillState } from "./drill";
import { Emitter, type Unsubscribe } from "./events";
import { ingest, type IngestOptions } from "./ingest";
import { activeLayers, diffLayers, type LayerDiff, type LayerSpec } from "./layers";
import { viewFor, type SceneThresholds, type ViewTarget } from "./projection";
import { RegionTree, type AddRegionsOptions } from "./region-tree";
import type { GeoIssue, Position, Region, RegionInput } from "./types";

/**
 * 区域数据源:按父级懒加载子级区域。parentId 为 null 时加载顶层。
 * 返回 RegionInput[] 或任意 GeoJSON/TopoJSON(会经过 ingest)。
 */
export interface GeoSource {
  id: string;
  /** 此数据源是否负责该父级(多个数据源按注册顺序询问)。缺省为全部负责。 */
  handles?(parentId: string | null): boolean;
  load(parentId: string | null): Promise<RegionInput[] | { input: unknown; options?: IngestOptions }>;
}

/** 渲染器(场景)适配器:three.js / SVG / MapLibre 实现此接口。 */
export interface SceneAdapter {
  /** 引擎状态变化时调用,适配器负责过渡动画。 */
  update(frame: EngineFrame): void | Promise<void>;
  dispose?(): void;
}

export interface EngineFrame {
  drill: DrillState;
  view: ViewTarget;
  /** 当前应显示的区域(聚焦区域的子级;到叶子时显示叶子本身)。 */
  regions: Region[];
  /** 聚焦区域本身(作为外轮廓/底板),顶层时为 null。 */
  focus: Region | null;
  layers: LayerSpec[];
  layerDiff: LayerDiff;
  /**
   * 平面场景的切平面锚点:聚焦路径(含根)上第一个使用平面场景的区域。
   * 同一锚点下的各级下钻共用一个切平面,转场连续;球面场景时为 null。
   */
  anchor: { id: string; center: Position } | null;
  direction: DrillChange["direction"] | "init";
}

type EngineEvents = {
  frame: EngineFrame;
  drill: DrillChange;
  issues: GeoIssue[];
  loading: { targetId: string | null; loading: boolean };
  hover: { region: Region | null };
  select: { region: Region | null };
  /** 区域数据加载失败(已按 load.retries 重试)。targetId 为要进入的区域,顶层加载为 null。 */
  error: { targetId: string | null; error: unknown };
};

export interface LoadPolicy {
  /** 失败后重试次数,默认 2。 */
  retries?: number;
  /** 首次重试前等待(毫秒),之后每次翻倍,默认 600。 */
  retryDelayMs?: number;
  /** 单次加载超时(毫秒),默认 15000;0 为不限。 */
  timeoutMs?: number;
}

export interface PluginContext {
  engine: GeoEngine;
  on: GeoEngine["on"];
  addGuard(guard: DrillGuard): Unsubscribe;
  addSource(source: GeoSource): Unsubscribe;
  setLayers(update: (layers: LayerSpec[]) => LayerSpec[]): void;
}

export interface GeoPlugin {
  name: string;
  /** 返回清理函数。 */
  install(ctx: PluginContext): void | (() => void);
}

export interface GeoEngineOptions {
  rootId?: string | null;
  maxDepth?: number;
  /** 叶子区域也可以聚焦(见 DrillOptions.allowLeafFocus)。 */
  allowLeafFocus?: boolean;
  sources?: GeoSource[];
  layers?: LayerSpec[];
  plugins?: GeoPlugin[];
  thresholds?: SceneThresholds;
  treeOptions?: AddRegionsOptions;
  /**
   * 点击重定向:返回另一个区域 id 时,点击直接跳到该区域(可跨多级,如地球上点中国直达某县),
   * 返回 null / undefined 走默认点击语义。目标须在区域树中(祖先链完整)。
   */
  redirectActivate?: (region: Region, state: DrillState) => string | null | undefined;
  /** 数据源加载的重试与超时策略。失败不会缓存,之后再次进入会重新加载。 */
  load?: LoadPolicy;
}

/**
 * 引擎核心:组合 区域树 + 数据源 + 下钻状态机 + 图层 + 插件,向渲染器输出"帧"。
 * 不依赖任何渲染库;同一个引擎可以挂载 three.js 大屏场景,也可以挂 SVG 降级场景。
 */
export class GeoEngine {
  readonly tree: RegionTree;
  readonly drill: DrillController;
  private events = new Emitter<EngineEvents>();
  private sources: GeoSource[];
  private layers: LayerSpec[];
  private prevLayers: LayerSpec[] = [];
  private scenes = new Set<SceneAdapter>();
  private plugins = new Map<string, () => void>();
  private pending = new Map<string, Promise<void>>();
  private loadedParents = new Set<string>();
  private selected: string | null = null;

  constructor(private options: GeoEngineOptions = {}) {
    this.tree = new RegionTree();
    this.sources = [...(options.sources ?? [])];
    this.layers = [...(options.layers ?? [])];
    this.drill = new DrillController(this.tree, {
      rootId: options.rootId ?? null,
      maxDepth: options.maxDepth,
      allowLeafFocus: options.allowLeafFocus,
      loadChildren: (id) => this.loadChildren(id),
    });
    this.drill.events.on("change", (change) => {
      this.selected = null;
      this.events.emit("drill", change);
      this.emitFrame(change.direction);
    });
    this.drill.events.on("loading", (e) => this.events.emit("loading", e));
    this.drill.events.on("blocked", (e) => {
      if (e.reason === "error") this.events.emit("error", { targetId: e.targetId, error: e.error });
    });
    for (const plugin of options.plugins ?? []) this.use(plugin);
  }

  on<K extends keyof EngineEvents>(event: K, handler: (payload: EngineEvents[K]) => void): Unsubscribe {
    return this.events.on(event, handler);
  }

  use(plugin: GeoPlugin): this {
    if (this.plugins.has(plugin.name)) return this;
    const cleanups: Array<() => void> = [];
    const ctx: PluginContext = {
      engine: this,
      on: (event, handler) => {
        const off = this.on(event, handler);
        cleanups.push(off);
        return off;
      },
      addGuard: (guard) => {
        const off = this.drill.addGuard(guard);
        cleanups.push(off);
        return off;
      },
      addSource: (source) => {
        this.sources.push(source);
        const off = () => {
          this.sources = this.sources.filter((s) => s !== source);
        };
        cleanups.push(off);
        return off;
      },
      setLayers: (update) => this.setLayers(update(this.layers)),
    };
    const dispose = plugin.install(ctx);
    this.plugins.set(plugin.name, () => {
      dispose?.();
      cleanups.forEach((fn) => fn());
    });
    return this;
  }

  unuse(name: string): void {
    this.plugins.get(name)?.();
    this.plugins.delete(name);
  }

  /** 直接加入区域数据(任意 GeoJSON / TopoJSON / RegionInput[])。 */
  addRegions(input: unknown, options: IngestOptions & AddRegionsOptions = {}): GeoIssue[] {
    const { regions, issues } = isRegionInputs(input) ? { regions: input, issues: [] as GeoIssue[] } : ingest(input, options);
    const treeIssues = this.tree.add(regions, { ...this.options.treeOptions, ...options });
    const all = [...issues, ...treeIssues];
    if (all.length) this.events.emit("issues", all);
    return all;
  }

  /** 初始化:加载顶层(或根区域的子级)并输出首帧。 */
  async start(): Promise<void> {
    const root = this.drill.rootId;
    try {
      if (!this.tree.size) await this.loadChildren(null);
      if (root) await this.loadChildren(root);
    } catch (error) {
      this.events.emit("error", { targetId: root, error });
      throw error;
    }
    this.emitFrame("init");
  }

  setLayers(layers: LayerSpec[]): void {
    this.layers = [...layers];
    this.emitFrame("init");
  }

  attach(scene: SceneAdapter): Unsubscribe {
    this.scenes.add(scene);
    if (this.tree.size) void scene.update(this.frame("init"));
    return () => {
      this.scenes.delete(scene);
      scene.dispose?.();
    };
  }

  hover(regionId: string | null): void {
    this.events.emit("hover", { region: regionId ? this.tree.get(regionId) ?? null : null });
  }

  /** 点击语义:可下钻则下钻;叶子则切换选中(allowLeafFocus 时叶子也下钻)。 */
  async activate(regionId: string): Promise<void> {
    if (regionId === this.drill.state.focusId) return;
    const region = this.tree.get(regionId);
    const redirect = region ? this.options.redirectActivate?.(region, this.drill.state) : null;
    if (redirect && redirect !== regionId && this.tree.has(redirect)) {
      if (await this.drill.drillTo(redirect)) return;
    }
    const leaf = this.tree.isLeaf(regionId);
    if ((!leaf || this.options.allowLeafFocus) && this.drill.canDrillInto(regionId)) {
      const ok = await this.drill.drillDown(regionId);
      if (ok) return;
    }
    this.selected = this.selected === regionId ? null : regionId;
    this.events.emit("select", { region: this.selected ? this.tree.get(this.selected) ?? null : null });
  }

  get selection(): Region | null {
    return this.selected ? this.tree.get(this.selected) ?? null : null;
  }

  /** 当前帧(供渲染器首屏或 React 同步读取)。 */
  frame(direction: EngineFrame["direction"] = "init"): EngineFrame {
    const drill = this.drill.state;
    const focus = drill.focusId ? this.tree.get(drill.focusId) ?? null : null;
    const children = this.tree.children(drill.focusId);
    const regions = children.length ? children : focus ? [focus] : [];
    const view = viewFor(focus?.bbox ?? null, this.options.thresholds);
    const layers = activeLayers(this.layers, { drill, scene: view.scene });
    let anchor: EngineFrame["anchor"] = null;
    if (view.scene === "plane" && focus) {
      const first = this.tree.path(focus.id).find((r) => viewFor(r.bbox, this.options.thresholds).scene === "plane") ?? focus;
      anchor = { id: first.id, center: viewFor(first.bbox, this.options.thresholds).center };
    }
    return { drill, view, regions, focus, layers, layerDiff: diffLayers(this.prevLayers, layers), direction, anchor };
  }

  dispose(): void {
    for (const name of [...this.plugins.keys()]) this.unuse(name);
    for (const scene of this.scenes) scene.dispose?.();
    this.scenes.clear();
    this.events.clear();
    this.drill.events.clear();
  }

  private emitFrame(direction: EngineFrame["direction"]): void {
    const frame = this.frame(direction);
    this.prevLayers = frame.layers;
    this.events.emit("frame", frame);
    for (const scene of this.scenes) void scene.update(frame);
  }

  private async loadWithRetry(source: GeoSource, parentId: string | null): ReturnType<GeoSource["load"]> {
    const { retries = 2, retryDelayMs = 600, timeoutMs = 15000 } = this.options.load ?? {};
    for (let attempt = 0; ; attempt++) {
      try {
        return await withTimeout(Promise.resolve().then(() => source.load(parentId)), timeoutMs, parentId ?? "顶层");
      } catch (error) {
        if (attempt >= retries) throw error;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * 2 ** attempt));
      }
    }
  }

  /** 去重的懒加载:同一父级只加载一次,并发请求共享同一个 Promise。 */
  private loadChildren(parentId: string | null): Promise<void> {
    const key = parentId ?? "\u0000root";
    if (this.loadedParents.has(key)) return Promise.resolve();
    const inflight = this.pending.get(key);
    if (inflight) return inflight;
    const source = this.sources.find((s) => !s.handles || s.handles(parentId));
    if (!source) return Promise.resolve();
    const task = this.loadWithRetry(source, parentId)
      .then((result) => {
        const options: IngestOptions = Array.isArray(result) ? {} : { ...result.options };
        const input = Array.isArray(result) ? result : result.input;
        if (parentId) options.parentId ??= parentId;
        this.addRegions(input, options);
        this.loadedParents.add(key);
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  if (!ms) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`加载区域数据超时(${label},${ms}ms)`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isRegionInputs(input: unknown): input is RegionInput[] {
  return Array.isArray(input) && input.every((item) => item && typeof item === "object" && "polygons" in item && "id" in item);
}
