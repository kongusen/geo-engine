import type { AncestorResolver, LoadContext, RegionRef } from "./source";

export interface AdcodeHierarchyOptions {
  /** 链首的国家级编码,缺省 "100000"(DataV 等数据集把全国作为一个区域);传 null 不加。 */
  root?: string | null;
}

const ADCODE = /^\d{6}(\d{3}(\d{3})?)?$/;

/**
 * 按国标行政区划代码推导祖先,无网络请求:
 * 6 位 省 XX0000 → 市 XXXX00 → 县;9 位乡镇取前 6 位为县;12 位村取前 9 位为乡镇。
 * 直辖市、省直辖县等推导出的中间级在数据中可能不存在,ensurePath 会自动跳过。
 */
export function adcodeHierarchy(options: AdcodeHierarchyOptions = {}): AncestorResolver {
  const root = options.root === undefined ? "100000" : options.root;
  return (id) => {
    if (!ADCODE.test(id) || id === root) return null;
    const county = id.slice(0, 6);
    const chain = [root, `${county.slice(0, 2)}0000`, `${county.slice(0, 4)}00`, county];
    if (id.length === 12) chain.push(id.slice(0, 9));
    const ids = chain.filter((c, i): c is string => c !== null && c !== id && chain.indexOf(c) === i);
    return ids.map((cid, i) => ({ id: cid, parentId: i ? ids[i - 1] : null }));
  };
}

/**
 * 子 → 父 对照表(可异步加载,只加载一次;加载失败下次重试)。
 * 适合自建数据包附带的 index.json:{ "<id>": "<parentId>" | null }。
 */
export function parentMapHierarchy(
  load: Record<string, string | null> | ((ctx: LoadContext) => Promise<Record<string, string | null>>),
): AncestorResolver {
  let cache: Promise<Record<string, string | null>> | null = typeof load === "function" ? null : Promise.resolve(load);
  return async (id, ctx) => {
    if (!cache) cache = (load as (ctx: LoadContext) => Promise<Record<string, string | null>>)(ctx).catch((error) => {
      cache = null;
      throw error;
    });
    const map = await cache;
    if (!(id in map)) return null;
    const chain: RegionRef[] = [];
    const seen = new Set<string>([id]);
    for (let cur = map[id]; cur && !seen.has(cur); cur = map[cur] ?? null) {
      seen.add(cur);
      chain.unshift({ id: cur, parentId: map[cur] ?? null });
    }
    return chain;
  };
}
