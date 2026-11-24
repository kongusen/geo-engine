import {
  ingest,
  SourceRouter,
  type IngestOptions,
  type LoadPolicy,
  type RegionSource,
  type ResolvedChildren,
  type SourceMount,
} from "@yaoyu/geo-data";
import { DrillController, PathUnresolvedError, type DrillChange, type DrillGuard, type DrillState } from "./drill";
import { Emitter, type Unsubscribe } from "./events";
import { activeLayers, diffLayers, type LayerDiff, type LayerSpec } from "./layers";
import { viewFor, viewForRegion, type SceneThresholds, type ViewTarget } from "./projection";
import { RegionTree, type AddRegionsOptions } from "./region-tree";
import type { GeoIssue, Position, Region, RegionInput } from "@yaoyu/geo-data";

/**
 * 旧版区域数据源(仍然支持):按父级懒加载子级区域。新代码请用 @yaoyu/geo-data 的 RegionSource,
 * 它额外支持祖先链(深链接)、hasChildren 元数据、编码映射与挂载。
 * @deprecated 使用 RegionSource
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
  /** 当前路径与所显示区域、以及可见图层涉及的数据版权 / 审图号(去重)。 */
  attributions: string[];
}

/** 引擎接受的数据源:新版 RegionSource、挂载项,或旧版 GeoSource。 */
export type EngineSource = RegionSource | SourceMount | GeoSource;

type EngineEvents = {
  frame: EngineFrame;
  drill: DrillChange;
  issues: GeoIssue[];
  loading: { targetId: string | null; loading: boolean; phase: "path" | "children" };
  hover: { region: Region | null };
  select: { region: Region | null };
  /** 区域数据加载失败(已按 load.retries 重试)。targetId 为要进入的区域,顶层加载为 null。 */
  error: { targetId: string | null; error: unknown };
};

export interface PluginContext {
  engine: GeoEngine;
  on: GeoEngine["on"];
  addGuard(guard: DrillGuard): Unsubscribe;
  addSource(source: EngineSource): Unsubscribe;
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
  /**
   * 视图叶子层级:这些 level 的区域视为叶子(不展开子级,聚焦时显示自身)。
   * 同一棵树服务多种视图时使用,如全国门店视图把省当作叶子,而县域视图仍可从省下钻到县。
   * 运行时用 setLeafLevels 切换。
   */
  leafLevels?: string[];
  /** 叶子区域也可以聚焦(见 DrillOptions.allowLeafFocus)。 */
  allowLeafFocus?: boolean;
  sources?: EngineSource[];
  layers?: LayerSpec[];
  plugins?: GeoPlugin[];
  thresholds?: SceneThresholds;
  treeOptions?: AddRegionsOptions;
  /**
   * 点击重定向:返回另一个区域 id 时,点击直接跳到该区域(可跨多级,如地球上点中国直达某县),
   * 返回 null / undefined 走默认点击语义。目标不在树中时经 ensurePath 加载(数据源需支持 ancestors)。
   */
  redirectActivate?: (region: Region, state: DrillState) => string | null | undefined;
  /** 数据源加载的重试与超时策略(应用到每个数据源)。失败不会缓存,之后再次进入会重新加载。 */
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
  private router: SourceRouter;
  private layers: LayerSpec[];
  private prevLayers: LayerSpec[] = [];
  private scenes = new Set<SceneAdapter>();
  private plugins = new Map<string, () => void>();
  /** 正在请求的子级(按父级去重)。 */
  private fetching = new Map<string, Promise<ResolvedChildren | null>>();
  /** 正在加载并写入的子级。 */
  private pending = new Map<string, Promise<void>>();
  private loadedParents = new Set<string>();
  private resolving = new Map<string, Promise<Region[]>>();
  private attributionOf = new Map<string, string>();
  private abort = new AbortController();
  private selected: string | null = null;
  private leafLevels: Set<string>;

  constructor(private options: GeoEngineOptions = {}) {
    this.leafLevels = new Set(options.leafLevels ?? []);
    this.tree = new RegionTree();
    this.router = new SourceRouter((options.sources ?? []).map(toRegionSource), { policy: options.load ?? {} });
    this.layers = [...(options.layers ?? [])];
    this.drill = new DrillController(this.tree, {
      rootId: options.rootId ?? null,
      maxDepth: options.maxDepth,
      allowLeafFocus: options.allowLeafFocus,
      isLeaf: (id) => this.isLeaf(id),
      loadChildren: (id) => this.loadChildren(id),
      resolvePath: (id) => this.ensurePath(id),
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
        const off = this.router.add(toRegionSource(source));
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
      if (root) {
        if (!this.tree.has(root)) await this.ensurePath(root);
        await this.loadChildren(root);
      }
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

  /** 叶子判定:树上无子级,或属于当前视图叶子层级(见 leafLevels)。 */
  isLeaf(id: string): boolean {
    if (this.tree.isLeaf(id)) return true;
    const level = this.tree.get(id)?.level;
    return level !== undefined && this.leafLevels.has(level);
  }

  /** 切换视图叶子层级;有变化时重发当前帧(当前聚焦若受影响,渲染器随之切换展示内容)。 */
  setLeafLevels(levels: string[] | null): void {
    const next = new Set(levels ?? []);
    if (next.size === this.leafLevels.size && [...next].every((level) => this.leafLevels.has(level))) return;
    this.leafLevels = next;
    this.emitFrame("init");
  }

  hover(regionId: string | null): void {
    this.events.emit("hover", { region: regionId ? this.tree.get(regionId) ?? null : null });
  }

  /** 点击语义:可下钻则下钻;叶子则切换选中(allowLeafFocus 时叶子也下钻)。 */
  async activate(regionId: string): Promise<void> {
    if (regionId === this.drill.state.focusId) return;
    const region = this.tree.get(regionId);
    const redirect = region ? this.options.redirectActivate?.(region, this.drill.state) : null;
    if (redirect && redirect !== regionId) {
      if (await this.drill.drillTo(redirect)) return;
    }
    const leaf = this.isLeaf(regionId);
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
    const children = drill.focusId && this.isLeaf(drill.focusId) ? [] : this.tree.children(drill.focusId);
    const regions = children.length ? children : focus ? [focus] : [];
    const view = focus ? viewForRegion(focus, this.options.thresholds) : viewFor(null, this.options.thresholds);
    const layers = activeLayers(this.layers, { drill, scene: view.scene });
    let anchor: EngineFrame["anchor"] = null;
    if (view.scene === "plane" && focus) {
      const first = this.tree.path(focus.id).find((r) => viewForRegion(r, this.options.thresholds).scene === "plane") ?? focus;
      anchor = { id: first.id, center: viewForRegion(first, this.options.thresholds).center };
    }
    const attributions = [
      ...new Set([...[...drill.path, ...regions].map((r) => this.attributionOf.get(r.id)), ...layers.map((l) => l.attribution)].filter((a): a is string => !!a)),
    ];
    return { drill, view, regions, focus, layers, layerDiff: diffLayers(this.prevLayers, layers), direction, anchor, attributions };
  }

  /**
   * 确保 id 及其祖先链都在树中,返回 顶层 → id 的路径。
   * 向数据源要祖先链,各级子级并行请求、自上而下依次写入;链中数据里不存在的中间级会被跳过。
   * 无法定位时抛出 PathUnresolvedError。drillTo / restore / 重定向 / rootId 都会自动经过这里。
   */
  ensurePath(id: string): Promise<Region[]> {
    if (this.tree.has(id)) return Promise.resolve(this.tree.path(id));
    const inflight = this.resolving.get(id);
    if (inflight) return inflight;
    const task = this.resolvePath(id).finally(() => this.resolving.delete(id));
    this.resolving.set(id, task);
    return task;
  }

  dispose(): void {
    this.abort.abort();
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

  private async resolvePath(id: string): Promise<Region[]> {
    const ctx = {
      signal: this.abort.signal,
      knownPath: (known: string) => (this.tree.has(known) ? this.tree.path(known).map((r) => r.id) : null),
    };
    const chain = await this.router.ancestors(id, ctx);
    if (!chain) throw new PathUnresolvedError(id, "没有数据源能给出其祖先链");
    const parents: Array<string | null> = [null, ...chain];
    // 并行请求各级子级(中间级可能是数据里不存在的虚级,失败先忽略),再自上而下写入
    const fetches = new Map(parents.filter((p) => !this.isLoaded(p)).map((p) => [p, this.fetchChildren(p)]));
    for (const f of fetches.values()) f.catch(() => {});
    for (const parent of parents) {
      if (this.tree.has(id)) break;
      if (parent !== null && !this.tree.has(parent)) continue;
      const fetch = fetches.get(parent);
      if (!fetch) continue;
      const pending = this.pending.get(keyOf(parent));
      if (pending) await pending;
      else this.commit(parent, await fetch);
    }
    if (!this.tree.has(id)) throw new PathUnresolvedError(id, "数据源返回的数据中不包含该区域");
    return this.tree.path(id);
  }

  private isLoaded(parentId: string | null): boolean {
    return this.loadedParents.has(keyOf(parentId));
  }

  /** 请求某父级的子级(只请求不写入),并发共享同一个 Promise。 */
  private fetchChildren(parentId: string | null): Promise<ResolvedChildren | null> {
    const key = keyOf(parentId);
    const inflight = this.fetching.get(key);
    if (inflight) return inflight;
    const task = this.router.children(parentId, { signal: this.abort.signal }).finally(() => this.fetching.delete(key));
    this.fetching.set(key, task);
    return task;
  }

  /** 把一批子级写入树;没有数据源负责时不标记已加载。 */
  private commit(parentId: string | null, result: ResolvedChildren | null): void {
    const key = keyOf(parentId);
    if (!result || this.loadedParents.has(key)) return;
    const issues = this.tree.add(result.regions, { ...this.options.treeOptions });
    for (const r of result.regions) {
      const attribution = result.regionAttributions?.[r.id] ?? result.attribution;
      if (attribution) this.attributionOf.set(r.id, attribution);
    }
    if (parentId !== null && !result.regions.length) this.tree.markLeaf(parentId);
    this.loadedParents.add(key);
    const all = [...result.issues, ...issues];
    if (all.length) this.events.emit("issues", all);
  }

  /** 去重的懒加载:同一父级只加载一次,并发请求共享同一个 Promise。 */
  private loadChildren(parentId: string | null): Promise<void> {
    const key = keyOf(parentId);
    if (this.loadedParents.has(key)) return Promise.resolve();
    const inflight = this.pending.get(key);
    if (inflight) return inflight;
    const task = this.fetchChildren(parentId)
      .then((result) => this.commit(parentId, result))
      .finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }
}

const keyOf = (parentId: string | null) => parentId ?? "\u0000root";

/** 旧版 GeoSource → RegionSource;其余原样。 */
function toRegionSource(source: EngineSource): RegionSource | SourceMount {
  if (!("load" in source)) return source;
  return {
    id: source.id,
    handles: source.handles?.bind(source),
    children: async (parentId) => ({ regions: await source.load(parentId) }),
  };
}

function isRegionInputs(input: unknown): input is RegionInput[] {
  return Array.isArray(input) && input.every((item) => item && typeof item === "object" && "polygons" in item && "id" in item);
}
