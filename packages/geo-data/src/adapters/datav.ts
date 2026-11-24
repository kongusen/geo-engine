import { gcj02ToWgs84, type CrsSpec } from "../crs";
import { adcodeHierarchy } from "../hierarchy";
import type { RegionPayload, RegionRef, RegionSource } from "../source";
import type { Position } from "../types";

interface DatavFeature {
  type: "Feature";
  properties: { adcode?: number | string; name?: string; childrenNum?: number; adchar?: string; level?: string } & Record<string, unknown>;
  geometry: { type: string; coordinates: unknown };
}
interface DatavCollection {
  type: "FeatureCollection";
  features: DatavFeature[];
}

export interface DatavSourceOptions {
  id?: string;
  /** 边界文件目录,缺省阿里云 DataV GeoAtlas。生产环境建议把文件同步到自己的静态服务。 */
  baseUrl?: string;
  /** 顶层区域编码,缺省 "100000"(全国)。也可以是某个省 / 市,只服务该范围。 */
  root?: string;
  /**
   * 作为顶层数据源使用时,children(null) 返回 root 区域本身(缺省 true)。
   * 挂载到其他数据集下(mount({ at, root }))时不会用到。
   */
  includeRoot?: boolean;
  /** 坐标系,缺省 "gcj02"(DataV 数据为高德坐标)。自建 WGS84 镜像时改为 "wgs84"。 */
  crs?: CrsSpec;
  /** 抽稀容差(度),缺省 0。 */
  simplify?: number;
  /** 要素过滤,缺省去掉无名称的装饰要素(如南海九段线 100000_JD,可用 decorations() 取得)。 */
  filter?: (feature: DatavFeature) => boolean;
  attribution?: string;
  /** 自定义请求(鉴权、镜像签名等)。 */
  fetch?: (url: string, init: { signal?: AbortSignal }) => Promise<unknown>;
}

export interface DatavSource extends RegionSource {
  /** 某区域文件中的装饰线要素(无名称的面要素,如南海九段线),转换为 WGS84 折线。 */
  decorations(parentId?: string): Promise<Position[][]>;
}

const DEFAULT_BASE = "https://geo.datav.aliyun.com/areas_v3/bound";
const isDecoration = (f: DatavFeature) => !f.properties.name || !!f.properties.adchar;

/**
 * DataV GeoAtlas 行政区划数据源(国家 → 省 → 市 → 区县)。
 * 每个父级对应 `{adcode}_full.json`;是否有下级取自 childrenNum;祖先链按行政区划代码推导(无请求)。
 * DataV 不含乡镇级,乡镇及以下可在区县上挂载其他数据源:mount({ at: "522633", source: ... })。
 */
export function datavSource(options: DatavSourceOptions = {}): DatavSource {
  const base = (options.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
  const root = options.root ?? "100000";
  const includeRoot = options.includeRoot ?? true;
  const crs = options.crs ?? "gcj02";
  const filter = options.filter ?? ((f: DatavFeature) => !isDecoration(f));
  const attribution = options.attribution ?? "行政区划:DataV.GeoAtlas";
  const fetchJson =
    options.fetch ??
    (async (url: string, init: { signal?: AbortSignal }) => {
      const response = await fetch(url, init);
      if (!response.ok) throw new Error(`HTTP ${response.status}:${url}`);
      return response.json();
    });
  // 同一文件只请求一次(装饰线与区域共用;失败不缓存)
  const cache = new Map<string, Promise<DatavCollection>>();
  const load = (file: string, signal?: AbortSignal): Promise<DatavCollection> => {
    const url = `${base}/${file}.json`;
    let task = cache.get(url);
    if (!task) {
      task = (fetchJson(url, { signal }) as Promise<DatavCollection>).catch((error) => {
        cache.delete(url);
        throw error;
      });
      cache.set(url, task);
    }
    return task;
  };
  // 始终按全国推导完整链,再按 root 截取(root 可以是省 / 市)
  const ancestors = adcodeHierarchy({ root: "100000" });
  const inScope = (id: string) => id === root || (ancestors(id, { signal: new AbortController().signal }) as RegionRef[] | null)?.some((r) => r.id === root) === true;

  const toPayload = (fc: DatavCollection): RegionPayload => {
    const features = fc.features.filter(filter);
    const refs: Record<string, Partial<RegionRef>> = {};
    for (const f of features) {
      if (f.properties.adcode !== undefined) refs[String(f.properties.adcode)] = { hasChildren: (f.properties.childrenNum ?? 0) > 0 };
    }
    return { regions: { input: { ...fc, features }, options: { crs, simplify: options.simplify } }, refs, attribution };
  };

  return {
    id: options.id ?? "datav",
    owns: (id) => /^\d{6}$/.test(id) && inScope(id),
    defaultHasChildren: false,
    async children(parentId, ctx) {
      if (parentId === null && includeRoot) return toPayload(await load(root, ctx.signal));
      return toPayload(await load(`${parentId ?? root}_full`, ctx.signal));
    },
    async region(id, ctx) {
      return toPayload(await load(id, ctx.signal));
    },
    async ancestors(id, ctx) {
      if (!/^\d{6}$/.test(id)) return null;
      if (id === root) return [];
      const chain = await ancestors(id, ctx);
      // 不在 root 范围内的不认。链首始终保留 root:挂载时路由器以它为接缝;
      // includeRoot 为 false 时它不在树中,ensurePath 会当作虚级跳过。
      const i = chain?.findIndex((r) => r.id === root) ?? -1;
      return i < 0 ? null : chain!.slice(i);
    },
    async decorations(parentId = root) {
      const fc = await load(`${parentId}_full`);
      const toWgs = (p: Position): Position => (crs === "gcj02" ? gcj02ToWgs84(p) : p);
      const lines: Position[][] = [];
      for (const f of fc.features.filter(isDecoration)) {
        const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.type === "MultiPolygon" ? (f.geometry.coordinates as unknown[]) : [];
        for (const poly of polys as Position[][][]) lines.push(...poly.map((ring) => ring.map(toWgs)));
      }
      return lines;
    },
  };
}
