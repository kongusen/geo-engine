/**
 * 编码映射:数据源内的原始编码 ↔ 引擎全局 id。
 *
 * 引擎里的区域树只有一个 id 空间,多个数据集拼接时(世界国家 + 国内行政区划 + 自定义地块)编码可能冲突或不一致。
 * 每个挂载的数据源带一个 IdMapper,在数据进出数据层时完成转换;数据源本身始终只处理自己的编码。
 * 内置几种常用映射,也可以直接传入任意实现了此接口的对象。
 */
export interface IdMapper {
  /** 源内编码 → 全局 id。 */
  toGlobal(localId: string): string;
  /** 全局 id → 源内编码;不属于本源时返回 null。 */
  toLocal(globalId: string): string | null;
}

/** 原样使用(默认)。各数据集编码天然不冲突时用,如 ISO3 国家码 + 6 位行政区划代码。 */
export function identityIds(): IdMapper {
  return { toGlobal: (id) => id, toLocal: (id) => id };
}

/** 加命名空间前缀,如 prefixIds("ne:") 把 "CHN" 映射为 "ne:CHN"。编码空间互相冲突时用。 */
export function prefixIds(prefix: string): IdMapper {
  return {
    toGlobal: (id) => prefix + id,
    toLocal: (id) => (id.startsWith(prefix) ? id.slice(prefix.length) : null),
  };
}

/**
 * 对照表:{ 源内编码: 全局 id },表外编码交给 fallback(缺省原样)。
 * 用于个别编码需要改名的场景,如把某数据集的 "156" 对到全局的 "CHN"。
 */
export function tableIds(table: Record<string, string>, fallback: IdMapper = identityIds()): IdMapper {
  const reverse = new Map(Object.entries(table).map(([local, global]) => [global, local]));
  const mapped = new Set(Object.keys(table));
  return {
    toGlobal: (id) => table[id] ?? fallback.toGlobal(id),
    toLocal: (id) => {
      const direct = reverse.get(id);
      if (direct !== undefined) return direct;
      const local = fallback.toLocal(id);
      // 表内编码已被改名,原名不再代表它
      return local !== null && mapped.has(local) ? null : local;
    },
  };
}
