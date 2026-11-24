import type { RegionPayload, RegionRef, RegionSource } from "../source";

interface NeFeature {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: unknown } | null;
}
interface NeCollection {
  type: "FeatureCollection";
  features: NeFeature[];
}

const CDN = "https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@v5.1.2/geojson";

export interface NaturalEarthOptions {
  id?: string;
  /** 国家级 GeoJSON 地址,缺省 Natural Earth 1:110m。生产环境建议换成自己托管(及按需预处理)的版本。 */
  countriesUrl?: string;
  /**
   * 一级行政区 GeoJSON 地址,缺省 Natural Earth 1:50m(覆盖美、加、俄、澳、巴西、印尼、南非、印度、中国 9 国);
   * false 表示只到国家级。被挂载了其他数据源的国家(如中国挂 DataV)以挂载源为准。
   */
  admin1Url?: string | false;
  /**
   * 有一级行政区数据的国家(ADM0_A3)。用于在不下载 admin1 文件的情况下判断国家能否下钻;
   * 缺省:默认 admin1 数据时为其覆盖的 9 国,自定义 admin1Url 时在首次加载顶层时读取文件判断。
   */
  admin1Countries?: string[];
  /** 显示名称语言,缺省 "zh"(NAME_ZH,缺失时回退英文名)。 */
  lang?: "zh" | "en";
  /** 排除的国家(ADM0_A3 编码),在任何层级都不出现。 */
  exclude?: string[];
  /** 按要素属性过滤(国家与一级行政区都经过)。 */
  filter?: (properties: Record<string, unknown>, level: "country" | "province") => boolean;
  /** 改写显示名称(如按业务口径统一称谓)。 */
  rename?: Record<string, string>;
  /** 抽稀容差(度),缺省 0。 */
  simplify?: number;
  attribution?: string;
  fetch?: (url: string, init: { signal?: AbortSignal }) => Promise<unknown>;
}

const COUNTRY = /^[A-Z]{3}$/;
/** Natural Earth 1:50m admin1 覆盖的国家。 */
const DEFAULT_ADMIN1 = ["AUS", "BRA", "CAN", "CHN", "IDN", "IND", "RUS", "USA", "ZAF"];
const ADMIN1 = /^[A-Z]{2}-[A-Z0-9]+$/;

/**
 * Natural Earth 世界数据源:顶层为各国(编码 ADM0_A3,如 CHN / USA),下一级为一级行政区(编码 ISO 3166-2,如 US-CA)。
 *
 * 注意:Natural Earth 按"事实控制"绘制国界,与各国官方立场不一定一致。面向公开发布时请使用经审核的数据:
 * 可把有官方数据的国家挂载到其他数据源并开启 adopt(接缝采用权威几何),用 exclude 排除不应单独出现的要素,
 * 或把 countriesUrl 指向自行预处理的版本(如 Natural Earth 的各国视角 point-of-view 数据)。
 */
export function naturalEarthSource(options: NaturalEarthOptions = {}): RegionSource {
  const countriesUrl = options.countriesUrl ?? `${CDN}/ne_110m_admin_0_countries.geojson`;
  const admin1Url = options.admin1Url === false ? null : options.admin1Url ?? `${CDN}/ne_50m_admin_1_states_provinces.geojson`;
  const exclude = new Set(options.exclude ?? []);
  const zh = (options.lang ?? "zh") === "zh";
  const attribution = options.attribution ?? "Natural Earth";
  const fetchJson =
    options.fetch ??
    (async (url: string, init: { signal?: AbortSignal }) => {
      const response = await fetch(url, init);
      if (!response.ok) throw new Error(`HTTP ${response.status}:${url}`);
      return response.json();
    });
  const cache = new Map<string, Promise<NeCollection>>();
  const load = (url: string, signal?: AbortSignal) => {
    let task = cache.get(url);
    if (!task) {
      task = (fetchJson(url, { signal }) as Promise<NeCollection>).catch((error) => {
        cache.delete(url);
        throw error;
      });
      cache.set(url, task);
    }
    return task;
  };

  const str = (v: unknown) => (typeof v === "string" && v && v !== "-99" ? v : undefined);
  const nameOf = (p: Record<string, unknown>, id: string, keys: [string, string]) =>
    options.rename?.[id] ?? (zh ? str(p[keys[0]]) : undefined) ?? str(p[keys[1]]) ?? id;

  const countries = async (signal?: AbortSignal) => {
    const fc = await load(countriesUrl, signal);
    return fc.features.filter((f) => {
      const id = str(f.properties.ADM0_A3);
      return f.geometry && id && !exclude.has(id) && (options.filter?.(f.properties, "country") ?? true);
    });
  };
  const provinces = async (signal?: AbortSignal) => {
    if (!admin1Url) return [];
    const fc = await load(admin1Url, signal);
    return fc.features.filter((f) => {
      const country = str(f.properties.adm0_a3);
      return f.geometry && str(f.properties.iso_3166_2) && country && !exclude.has(country) && (options.filter?.(f.properties, "province") ?? true);
    });
  };
  /** 有一级行政区数据的国家(只在需要时加载 admin1 文件)。 */
  let withAdmin1: Promise<Set<string>> | null = null;
  const declared = options.admin1Countries ?? (options.admin1Url === undefined ? DEFAULT_ADMIN1 : null);
  if (declared) withAdmin1 = Promise.resolve(new Set(declared));
  const admin1Countries = (signal?: AbortSignal) =>
    (withAdmin1 ??= provinces(signal)
      .then((list) => new Set(list.map((f) => String(f.properties.adm0_a3))))
      .catch((error) => {
        withAdmin1 = null;
        throw error;
      }));

  const toPayload = (features: NeFeature[], level: "country" | "province", refs: Record<string, Partial<RegionRef>>): RegionPayload => ({
    regions: {
      input: { type: "FeatureCollection", features },
      options: {
        crs: "wgs84",
        simplify: options.simplify,
        level,
        idKey: (p) => (level === "country" ? str(p.ADM0_A3) : str(p.iso_3166_2)),
        nameKey: (p) =>
          level === "country" ? nameOf(p, String(p.ADM0_A3), ["NAME_ZH", "NAME"]) : nameOf(p, String(p.iso_3166_2), ["name_zh", "name"]),
        parentKey: (p) => (level === "province" ? str(p.adm0_a3) : undefined),
      },
    },
    refs,
    attribution,
  });

  return {
    id: options.id ?? "natural-earth",
    owns: (id) => COUNTRY.test(id) || ADMIN1.test(id),
    handles: (parentId) => parentId === null || COUNTRY.test(parentId),
    defaultHasChildren: false,
    async children(parentId, ctx) {
      if (parentId === null) {
        const [list, has] = await Promise.all([countries(ctx.signal), admin1Url ? admin1Countries(ctx.signal) : Promise.resolve(new Set<string>())]);
        const refs = Object.fromEntries(list.map((f) => [String(f.properties.ADM0_A3), { hasChildren: has.has(String(f.properties.ADM0_A3)) }]));
        return toPayload(list, "country", refs);
      }
      const list = (await provinces(ctx.signal)).filter((f) => f.properties.adm0_a3 === parentId);
      return toPayload(list, "province", {});
    },
    async region(id, ctx) {
      const list = COUNTRY.test(id)
        ? (await countries(ctx.signal)).filter((f) => f.properties.ADM0_A3 === id)
        : (await provinces(ctx.signal)).filter((f) => f.properties.iso_3166_2 === id);
      return toPayload(list, COUNTRY.test(id) ? "country" : "province", {});
    },
    async ancestors(id, ctx) {
      if (COUNTRY.test(id)) return (await countries(ctx.signal)).some((f) => f.properties.ADM0_A3 === id) ? [] : null;
      if (!ADMIN1.test(id)) return null;
      const hit = (await provinces(ctx.signal)).find((f) => f.properties.iso_3166_2 === id);
      return hit ? [{ id: String(hit.properties.adm0_a3), parentId: null }] : null;
    },
  };
}
