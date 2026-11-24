import type { IngestOptions } from "./ingest";
import type { RegionInput } from "./types";

/** 区域的轻量引用(无几何):用于祖先链、搜索结果、"是否有下级"等元数据。 */
export interface RegionRef {
  id: string;
  /** 祖先链由编码推导时可能没有名称。 */
  name?: string;
  level?: string;
  parentId?: string | null;
  /** 是否存在下级;undefined 表示由数据源的 defaultHasChildren 决定。 */
  hasChildren?: boolean;
}

/** 一次加载的结果。 */
export interface RegionPayload {
  /** RegionInput[],或任意 GeoJSON / TopoJSON(连同 ingest 选项)。 */
  regions: RegionInput[] | { input: unknown; options?: IngestOptions };
  /** 按源内编码补充元数据(GeoJSON 里没有 hasChildren / level 时用)。 */
  refs?: Record<string, Partial<RegionRef>>;
  /** 数据版权 / 审图号;引擎汇总进帧,由渲染层展示。 */
  attribution?: string;
}

export interface LoadContext {
  /** 引擎销毁时中止。 */
  signal: AbortSignal;
}

/**
 * 区域数据源契约。所有编码都是**源内编码**;与引擎全局 id 的对应关系由 IdMapper(见 mount)负责。
 * 只有 children 是必需的,其余能力按需实现。
 */
export interface RegionSource {
  id: string;
  /** 是否负责该父级的子级(源内编码,null 为源的顶层)。缺省全部负责。 */
  handles?(parentId: string | null): boolean;
  /** 该编码是否属于本源的编码空间;用于 ensurePath 判断该问谁。缺省全部属于。 */
  owns?(id: string): boolean;
  /** 加载某父级的全部子级;null 为本源顶层。 */
  children(parentId: string | null, ctx: LoadContext): Promise<RegionPayload>;
  /** 可选:单独加载某个区域自身(不含子级)。挂载的 adopt(接缝采用权威几何)依赖它。 */
  region?(id: string, ctx: LoadContext): Promise<RegionPayload>;
  /**
   * 祖先链,顺序为 顶层 → 直接父级,不含 id 自身;不认识该编码时返回 null。
   * 链中允许出现数据里不存在的中间级(如按编码规则推导出的"市辖区"),ensurePath 会跳过它们。
   */
  ancestors?(id: string, ctx: LoadContext): Promise<RegionRef[] | null>;
  /** 名称搜索(预留)。 */
  search?(query: string, ctx: LoadContext): Promise<RegionRef[]>;
  /** 子级缺少 hasChildren 信息时的默认判断。缺省不判断(没有已加载子级即视为叶子)。 */
  defaultHasChildren?: boolean | ((ref: RegionRef) => boolean);
}

/** 祖先解析器:可独立复用,挂到任意数据源上(见 hierarchy)。 */
export type AncestorResolver = (id: string, ctx: LoadContext) => RegionRef[] | null | Promise<RegionRef[] | null>;

// ── 内置数据源 ─────────────────────────────────────────────────────────

export interface StaticSourceOptions {
  id?: string;
  attribution?: string;
}

/** 内存数据源:一次给出全部区域(须带 parentId),按父级切分返回;祖先链与 hasChildren 由数据本身推出。 */
export function staticSource(regions: RegionInput[], options: StaticSourceOptions = {}): RegionSource {
  const byId = new Map(regions.map((r) => [r.id, r]));
  const byParent = new Map<string | null, RegionInput[]>();
  for (const region of regions) {
    const key = region.parentId ?? null;
    byParent.set(key, [...(byParent.get(key) ?? []), region]);
  }
  return {
    id: options.id ?? "static",
    owns: (id) => byId.has(id),
    async children(parentId) {
      const list = (byParent.get(parentId) ?? []).map((r) => ({ ...r, expandable: r.expandable ?? byParent.has(r.id) }));
      return { regions: list, attribution: options.attribution };
    },
    async region(id) {
      const r = byId.get(id);
      return { regions: r ? [r] : [], attribution: options.attribution };
    },
    async ancestors(id) {
      if (!byId.has(id)) return null;
      const chain: RegionRef[] = [];
      const seen = new Set<string>();
      for (let cur = byId.get(id)?.parentId; cur && !seen.has(cur); cur = byId.get(cur)?.parentId) {
        seen.add(cur);
        const r = byId.get(cur);
        chain.unshift({ id: cur, name: r?.name, level: r?.level, parentId: r?.parentId ?? null });
      }
      return chain;
    },
  };
}

export interface HttpSourceOptions {
  id: string;
  /** 父级(源内编码,null 为顶层)→ 请求地址;返回 null 表示本源不负责该父级。 */
  url: (parentId: string | null) => string | null;
  /** 响应(已解析 JSON)的 ingest 选项。 */
  ingest?: IngestOptions | ((parentId: string | null) => IngestOptions);
  ancestors?: AncestorResolver;
  owns?: (id: string) => boolean;
  /** 缺省 true:按需加载的数据通常不知道下级是否存在,先允许下钻,加载到空再标记为叶子。 */
  defaultHasChildren?: RegionSource["defaultHasChildren"];
  attribution?: string;
  /** 自定义请求(鉴权头、签名等)。缺省使用全局 fetch。 */
  fetch?: (url: string, init: { signal: AbortSignal }) => Promise<unknown>;
}

/** 通用 HTTP 数据源:每个父级一个 GeoJSON / TopoJSON 文件。 */
export function httpSource(options: HttpSourceOptions): RegionSource {
  const load =
    options.fetch ??
    (async (url: string, init: { signal: AbortSignal }) => {
      const response = await fetch(url, init);
      if (!response.ok) throw new Error(`HTTP ${response.status}:${url}`);
      return response.json();
    });
  const ancestors = options.ancestors;
  return {
    id: options.id,
    handles: (parentId) => options.url(parentId) !== null,
    owns: options.owns,
    defaultHasChildren: options.defaultHasChildren ?? true,
    async children(parentId, ctx) {
      const url = options.url(parentId);
      if (url === null) return { regions: [] };
      const input = await load(url, { signal: ctx.signal });
      const ingestOptions = typeof options.ingest === "function" ? options.ingest(parentId) : options.ingest;
      return { regions: { input, options: ingestOptions }, attribution: options.attribution };
    },
    ancestors: ancestors ? async (id, ctx) => ancestors(id, ctx) : undefined,
  };
}
