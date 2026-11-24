import { identityIds, type IdMapper } from "./ids";
import { ingest } from "./ingest";
import { withPolicy, type LoadPolicy } from "./policy";
import type { LoadContext, RegionPayload, RegionRef, RegionSource } from "./source";
import type { GeoIssue, RegionInput } from "./types";

/**
 * 挂载:把一个数据源接到全局区域树的某个节点下。
 *
 *   mount({ at: "CHN", source: datav, root: "100000" })
 *
 * - children("CHN") 转为 datav.children("100000"),结果挂到 "CHN" 下;
 * - 源内编码 root 与全局的 at 视为同一个区域(两个数据集的"接缝");
 * - 其余编码经 ids 映射为全局 id(缺省原样)。
 */
export interface SourceMount {
  /** 挂载点(全局 id);null 表示挂在顶层。 */
  at: string | null;
  source: RegionSource;
  /** 与挂载点对应的源内编码;null(缺省)表示源的顶层。 */
  root?: string | null;
  /** 源内编码 ↔ 全局 id。缺省原样。 */
  ids?: IdMapper;
  /**
   * 接缝区域(at)采用本源的几何(经 source.region(root) 获取),替换上层数据集中的轮廓。
   * 用于国界等需要以权威数据为准的场景,如世界数据集中的中国轮廓换成国内标准地图数据。
   * 获取失败时整批加载失败(不会悄悄退回上层轮廓)。
   */
  adopt?: boolean;
}

export function mount(options: SourceMount): SourceMount {
  return options;
}

/** 已规范化、已映射为全局 id 的子级结果,可直接写入区域树。 */
export interface ResolvedChildren {
  regions: RegionInput[];
  issues: GeoIssue[];
  attribution?: string;
  /** 个别区域的版权与整批不同(接缝区域采用了挂载源的几何)。 */
  regionAttributions?: Record<string, string>;
  sourceId: string;
}

export interface AncestorQueryContext extends LoadContext {
  /** 引擎已知的路径(含自身,顶层在前);未知返回 null。用于在挂载点处截断递归。 */
  knownPath?(id: string): string[] | null;
}

export interface ComposeOptions {
  /** 应用到每个数据源的重试 / 超时策略;传 false 不包装。 */
  policy?: LoadPolicy | false;
}

interface Entry {
  at: string | null;
  root: string | null;
  ids: IdMapper;
  source: RegionSource;
  adopt: boolean;
}

/**
 * 多数据源路由。按以下顺序决定某个父级由谁加载:
 * 1. 挂载点正好是该父级的(at === parentId),按注册顺序;
 * 2. 该父级本身由哪个源提供,就继续问那个源(来源记录);
 * 3. 按注册顺序第一个认领(ids.toLocal 非空且 handles / owns 不否认)的源。
 * 不带 mount 的普通数据源等价于 mount({ at: null, source }),与旧版"按顺序询问 handles"行为一致。
 */
export class SourceRouter {
  private entries: Entry[] = [];
  /** 全局 id → 提供它的挂载项。 */
  private provenance = new Map<string, Entry>();

  constructor(
    sources: Array<RegionSource | SourceMount> = [],
    private options: ComposeOptions = {},
  ) {
    for (const source of sources) this.add(source);
  }

  get size(): number {
    return this.entries.length;
  }

  /** 加入数据源,返回移除函数。 */
  add(source: RegionSource | SourceMount): () => void {
    const m: SourceMount = "source" in source && "at" in source ? source : { at: null, source };
    const policy = this.options.policy;
    const entry: Entry = {
      at: m.at,
      root: m.root ?? null,
      ids: m.ids ?? identityIds(),
      source: policy === false ? m.source : withPolicy(m.source, policy ?? {}),
      adopt: m.adopt ?? false,
    };
    this.entries.push(entry);
    return () => {
      this.entries = this.entries.filter((e) => e !== entry);
      for (const [id, e] of this.provenance) if (e === entry) this.provenance.delete(id);
    };
  }

  /** 加载全局父级的子级;没有数据源负责时返回 null。 */
  async children(parentId: string | null, ctx: LoadContext): Promise<ResolvedChildren | null> {
    const entry = this.route(parentId);
    if (!entry) return null;
    const localParent = parentId === entry.at ? entry.root : entry.ids.toLocal(parentId!);
    const payload = await entry.source.children(localParent, ctx);
    const resolved = this.resolve(entry, localParent, payload);
    await this.adoptSeams(resolved, ctx);
    return resolved;
  }

  /** 接缝区域换用挂载源的权威几何(并行获取)。 */
  private async adoptSeams(resolved: ResolvedChildren, ctx: LoadContext): Promise<void> {
    await Promise.all(
      resolved.regions.map(async (region) => {
        const seam = this.entries.find((e) => e.adopt && e.at === region.id);
        if (!seam) return;
        if (seam.root === null || !seam.source.region) {
          resolved.issues.push({ severity: "warning", code: "invalid-input", message: `挂载点 ${region.id}:adopt 需要 root 与 source.region(),已沿用原轮廓`, regionId: region.id });
          return;
        }
        const payload = await seam.source.region(seam.root, ctx);
        const own = this.normalize(payload, null).regions;
        const geometry = own.find((r) => r.id === seam.root) ?? own[0];
        if (!geometry?.polygons.length) throw new Error(`接缝区域 ${region.id} 的权威几何为空(数据源 ${seam.source.id}:${seam.root})`);
        region.polygons = geometry.polygons;
        if (payload.attribution) (resolved.regionAttributions ??= {})[region.id] = payload.attribution;
      }),
    );
  }

  private normalize(payload: RegionPayload, localParent: string | null): { regions: RegionInput[]; issues: GeoIssue[] } {
    if (Array.isArray(payload.regions)) return { regions: payload.regions, issues: [] };
    const options = { ...payload.regions.options };
    if (localParent !== null) options.parentId ??= localParent;
    return ingest(payload.regions.input, options);
  }

  /**
   * 全局 id 的祖先链(全局 id,顶层在前,不含自身);无法解析返回 null。
   * 跨挂载点时自动拼接:挂载源给出挂载点以下的部分,挂载点以上递归向上层源询问。
   */
  async ancestors(id: string, ctx: AncestorQueryContext): Promise<string[] | null> {
    return this.ancestorsOf(id, ctx, new Set());
  }

  private async ancestorsOf(id: string, ctx: AncestorQueryContext, visiting: Set<string>): Promise<string[] | null> {
    if (visiting.has(id)) return null;
    visiting.add(id);
    for (const entry of this.candidatesFor(id)) {
      if (!entry.source.ancestors) continue;
      const local = entry.ids.toLocal(id);
      if (local === null || (entry.at === id && local === entry.root)) continue;
      const refs = await entry.source.ancestors(local, ctx);
      if (!refs) continue;
      let chain = refs.map((r) => r.id);
      if (entry.root !== null) {
        const i = chain.indexOf(entry.root);
        if (i < 0) continue; // 不在本挂载范围内
        chain = chain.slice(i + 1);
      }
      const mapped = chain.map((l) => entry.ids.toGlobal(l));
      for (const g of [...mapped, id]) if (!this.provenance.has(g)) this.provenance.set(g, entry);
      if (entry.at === null) return mapped;
      const upper = ctx.knownPath?.(entry.at) ?? (await this.withAt(entry.at, ctx, visiting));
      if (!upper) continue;
      return [...upper, ...mapped];
    }
    return null;
  }

  /** 挂载点自身的完整路径(含自身)。 */
  private async withAt(at: string, ctx: AncestorQueryContext, visiting: Set<string>): Promise<string[] | null> {
    const up = await this.ancestorsOf(at, ctx, visiting);
    return up ? [...up, at] : null;
  }

  /** 祖先查询的候选顺序:来源记录优先,其次后注册(通常更具体)的挂载。 */
  private candidatesFor(id: string): Entry[] {
    const known = this.provenance.get(id);
    const rest = [...this.entries].reverse().filter((e) => e !== known && this.claims(e, id));
    return known ? [known, ...rest] : rest;
  }

  private claims(entry: Entry, id: string): boolean {
    const local = entry.ids.toLocal(id);
    return local !== null && entry.source.owns?.(local) !== false;
  }

  private route(parentId: string | null): Entry | undefined {
    const handles = (e: Entry, local: string | null) => e.source.handles?.(local) !== false;
    const atMount = this.entries.find((e) => e.at === parentId && handles(e, e.root));
    if (atMount || parentId === null) return atMount;
    const known = this.provenance.get(parentId);
    if (known) {
      const local = known.ids.toLocal(parentId);
      if (local !== null && handles(known, local)) return known;
    }
    return this.entries.find((e) => {
      const local = e.ids.toLocal(parentId);
      return local !== null && e.source.owns?.(local) !== false && handles(e, local);
    });
  }

  private resolve(entry: Entry, localParent: string | null, payload: RegionPayload): ResolvedChildren {
    const { regions, issues } = this.normalize(payload, localParent);
    const toGlobalParent = (local: string | null | undefined): string | null => {
      const p = local ?? localParent;
      return p === entry.root ? entry.at : entry.ids.toGlobal(p!);
    };
    const resolved = regions.map((region): RegionInput => {
      const ref = payload.refs?.[region.id];
      const id = entry.ids.toGlobal(region.id);
      const prev = this.provenance.get(id);
      if (prev && prev !== entry) {
        issues.push({
          severity: "error",
          code: "id-collision",
          message: `编码冲突:${id} 同时由数据源 ${prev.source.id} 与 ${entry.source.id} 提供,请为其中一个挂载配置 ids 映射`,
          regionId: id,
        });
      }
      this.provenance.set(id, entry);
      return {
        ...region,
        id,
        parentId: toGlobalParent(region.parentId),
        level: region.level ?? ref?.level,
        // 挂载了其他数据源的节点一定有下级(即使本源认为它是叶子,如 DataV 的区县下挂乡镇数据)
        expandable: this.entries.some((e) => e.at === id)
          ? true
          : ref?.hasChildren ?? region.expandable ?? hasChildrenDefault(entry.source, { ...ref, id: region.id, level: region.level ?? ref?.level }),
        source: { id: entry.source.id, localId: region.id },
      };
    });
    return { regions: resolved, issues, attribution: payload.attribution, sourceId: entry.source.id };
  }
}

function hasChildrenDefault(source: RegionSource, ref: RegionRef): boolean | undefined {
  const d = source.defaultHasChildren;
  return typeof d === "function" ? d(ref) : d;
}

/** 组合多个数据源 / 挂载为一个路由器。 */
export function composeSources(sources: Array<RegionSource | SourceMount>, options: ComposeOptions = {}): SourceRouter {
  return new SourceRouter(sources, options);
}
