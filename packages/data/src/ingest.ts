import { converterFor, crsFromGeoJsonMember, detectCrs, type CrsSpec } from "./crs";
import {
  areaKm2,
  bboxOf,
  centroidOf,
  closeRing,
  interiorPoint,
  rewindPolygon,
  signedRingArea,
  simplifyPolygons,
  unwrapRing,
} from "./geometry";
import { isTopology, topologyToFeatures, type GeoJsonFeature } from "./topojson";
import type { GeoIssue, MultiPolygonCoords, PolygonCoords, Position, Region, RegionInput } from "./types";

/** 属性键:单个键名、候选键名列表(取第一个有值的),或自定义读取函数。 */
export type KeySpec = string | string[] | ((properties: Record<string, unknown>, feature: GeoJsonFeature) => unknown);

export interface IngestOptions {
  /** 区域编码,默认依次尝试 adcode / code / id / ID,最后用 feature.id。 */
  idKey?: KeySpec;
  /** 名称,默认 name / NAME / 名称。 */
  nameKey?: KeySpec;
  /** 父级编码,默认 parent / parentCode / parent_adcode;兼容 DataV 的 { parent: { adcode } }。 */
  parentKey?: KeySpec;
  levelKey?: KeySpec;
  /** 别名(数组或以 , ; 、 分隔的字符串)。 */
  aliasKey?: KeySpec;
  /** 输入坐标系,默认 auto(GCJ-02 无法自动识别,需显式声明)。 */
  crs?: CrsSpec;
  /** 抽稀容差(度),0 表示不抽稀。 */
  simplify?: number;
  /** 没有父级信息的区域统一挂到此父级下。 */
  parentId?: string | null;
  /** 没有 level 字段时使用的层级标签。 */
  level?: string;
  /** TopoJSON 对象名;缺省合并全部对象。 */
  topologyObject?: string;
}

export interface IngestResult {
  regions: RegionInput[];
  issues: GeoIssue[];
}

const DEFAULT_ID: string[] = ["adcode", "code", "id", "ID", "Id", "gb", "GB"];
const DEFAULT_NAME: string[] = ["name", "NAME", "Name", "名称", "label"];
const DEFAULT_PARENT: string[] = ["parent", "parentCode", "parent_code", "parent_adcode", "parentId", "pid"];
const DEFAULT_LEVEL: string[] = ["level", "LEVEL"];
const DEFAULT_ALIAS: string[] = ["aliases", "alias", "别名"];

function read(spec: KeySpec | undefined, fallback: string[], properties: Record<string, unknown>, feature: GeoJsonFeature): unknown {
  if (typeof spec === "function") return spec(properties, feature);
  const keys = spec === undefined ? fallback : Array.isArray(spec) ? spec : [spec];
  for (const key of keys) {
    const value = properties[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function asId(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  // DataV: parent: { adcode: 330000 }
  if (value && typeof value === "object") {
    const nested = (value as Record<string, unknown>).adcode ?? (value as Record<string, unknown>).code ?? (value as Record<string, unknown>).id;
    return asId(nested);
  }
  return undefined;
}

function asAliases(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string" && !!v.trim()).map((v) => v.trim());
  if (typeof value === "string") return value.split(/[,;、，；]/).map((v) => v.trim()).filter(Boolean);
  return [];
}

/** 接受 FeatureCollection / Feature / Feature[] / Geometry / Topology,统一为 Feature 列表。 */
export function toFeatures(input: unknown, topologyObject?: string): GeoJsonFeature[] {
  if (Array.isArray(input)) return input.flatMap((item) => toFeatures(item, topologyObject));
  if (!input || typeof input !== "object") throw new Error("输入不是 GeoJSON / TopoJSON 对象");
  if (isTopology(input)) return topologyToFeatures(input, topologyObject);
  const obj = input as Record<string, unknown>;
  if (obj.type === "FeatureCollection") return (obj.features as GeoJsonFeature[]) ?? [];
  if (obj.type === "Feature") return [obj as unknown as GeoJsonFeature];
  if (obj.type === "Polygon" || obj.type === "MultiPolygon" || obj.type === "GeometryCollection") {
    return [{ type: "Feature", properties: {}, geometry: obj as GeoJsonFeature["geometry"] }];
  }
  throw new Error(`不支持的 GeoJSON 类型:${String(obj.type)}`);
}

/** 从几何中提取多边形(GeometryCollection 中的非面要素被忽略)。 */
function polygonsOf(geometry: GeoJsonFeature["geometry"]): { polygons: MultiPolygonCoords; skipped: boolean } {
  if (!geometry) return { polygons: [], skipped: true };
  if (geometry.type === "Polygon") return { polygons: [geometry.coordinates as PolygonCoords], skipped: false };
  if (geometry.type === "MultiPolygon") return { polygons: geometry.coordinates as MultiPolygonCoords, skipped: false };
  if (geometry.type === "GeometryCollection") {
    let skipped = false;
    const polygons = (geometry.geometries as GeoJsonFeature["geometry"][]).flatMap((g) => {
      const r = polygonsOf(g);
      skipped ||= r.skipped;
      return r.polygons;
    });
    return { polygons, skipped };
  }
  return { polygons: [], skipped: true };
}

function* allPositions(features: GeoJsonFeature[]): Generator<Position> {
  for (const feature of features) {
    for (const polygon of polygonsOf(feature.geometry).polygons) {
      for (const ring of polygon) yield* ring;
    }
  }
}

/**
 * 规范化任意面要素输入:坐标系转换 → 闭合环 → 跨经线展开 → 统一绕向 → 抽稀 → 读取编码/名称/父级。
 * 不做层级推断(由 RegionTree 负责),只报告发现的问题,不抛出可修复的错误。
 */
export function ingest(input: unknown, options: IngestOptions = {}): IngestResult {
  const issues: GeoIssue[] = [];
  let features: GeoJsonFeature[];
  try {
    features = toFeatures(input, options.topologyObject);
  } catch (error) {
    return { regions: [], issues: [{ severity: "error", code: "invalid-input", message: (error as Error).message }] };
  }

  // 坐标系
  let crs = options.crs ?? "auto";
  if (crs === "auto") {
    const declared = crsFromGeoJsonMember((input as { crs?: unknown } | null)?.crs);
    const detected = declared && declared !== "unknown" ? declared : detectCrs(allPositions(features));
    if (detected === "unknown") {
      issues.push({
        severity: "error",
        code: "crs-unknown",
        message: "无法识别坐标系(疑似本地/SVG 坐标),请声明 crs 或提供控制点做仿射配准",
      });
      return { regions: [], issues };
    }
    crs = detected;
  }
  const convert = converterFor(crs)!;
  if (crs !== "wgs84") {
    issues.push({ severity: "info", code: "crs-converted", message: `坐标已从 ${typeof crs === "object" ? "本地坐标(仿射)" : crs} 转换为 WGS84` });
  }

  const regions: RegionInput[] = [];
  const seen = new Set<string>();

  features.forEach((feature, featureIndex) => {
    const properties = (feature.properties ?? {}) as Record<string, unknown>;
    const { polygons: raw, skipped } = polygonsOf(feature.geometry);
    if (skipped && raw.length === 0) {
      issues.push({ severity: "warning", code: "non-polygon-skipped", message: `要素 #${featureIndex} 不是面要素,已跳过`, featureIndex });
      return;
    }

    let closed = false;
    let rewound = false;
    let unwrapped = false;
    let degenerate = false;
    const polygons: MultiPolygonCoords = [];
    for (const polygon of raw) {
      const rings: PolygonCoords = [];
      polygon.forEach((ring, ringIndex) => {
        let r = ring.map((p) => convert([Number(p[0]), Number(p[1])]));
        const c = closeRing(r);
        if (c !== r) closed = true;
        r = c;
        const u = unwrapRing(r);
        if (u.changed) unwrapped = true;
        r = u.ring;
        if (r.length < 4 || signedRingArea(r) === 0) {
          degenerate = true;
          if (ringIndex === 0) rings.length = 0;
          return;
        }
        if (ringIndex === 0 || rings.length) rings.push(r);
      });
      if (!rings.length) continue;
      const wound = rewindPolygon(rings);
      if (wound.some((ring, i) => ring !== rings[i])) rewound = true;
      polygons.push(wound);
    }

    const simplified = simplifyPolygons(polygons, options.simplify ?? 0);
    const id = asId(read(options.idKey, DEFAULT_ID, properties, feature)) ?? asId(feature.id);
    const name = String(read(options.nameKey, DEFAULT_NAME, properties, feature) ?? id ?? `区域${featureIndex + 1}`);
    const regionId = id ?? `${name}#${featureIndex}`;
    const ref = { featureIndex, regionId };

    if (!simplified.length) {
      issues.push({ severity: "warning", code: "ring-degenerate", message: `${name}:几何退化(点数不足或面积为 0),已跳过`, ...ref });
      return;
    }
    if (!id) issues.push({ severity: "warning", code: "missing-id", message: `${name}:缺少编码,已生成临时编码 ${regionId}`, ...ref });
    if (closed) issues.push({ severity: "info", code: "ring-closed", message: `${name}:存在未闭合的环,已自动闭合`, ...ref });
    if (rewound) issues.push({ severity: "info", code: "ring-rewound", message: `${name}:环绕向已统一为外环逆时针`, ...ref });
    if (unwrapped) issues.push({ severity: "info", code: "antimeridian-unwrapped", message: `${name}:跨越 180° 经线,经度已展开`, ...ref });
    if (degenerate) issues.push({ severity: "warning", code: "ring-degenerate", message: `${name}:部分环退化,已丢弃`, ...ref });
    if (seen.has(regionId)) {
      issues.push({ severity: "error", code: "duplicate-id", message: `编码重复:${regionId}(${name}),后者被忽略`, ...ref });
      return;
    }
    seen.add(regionId);

    const parentRaw = read(options.parentKey, DEFAULT_PARENT, properties, feature);
    const level = read(options.levelKey, DEFAULT_LEVEL, properties, feature);
    regions.push({
      id: regionId,
      name,
      aliases: asAliases(read(options.aliasKey, DEFAULT_ALIAS, properties, feature)),
      parentId: asId(parentRaw) ?? options.parentId ?? undefined,
      level: typeof level === "string" ? level : options.level,
      polygons: simplified,
      properties,
    });
  });

  return { regions, issues };
}

/** 由输入计算派生几何字段。 */
export function toRegion(input: RegionInput): Region {
  return {
    id: input.id,
    name: input.name,
    aliases: input.aliases ?? [],
    parentId: input.parentId ?? null,
    level: input.level,
    polygons: input.polygons,
    bbox: bboxOf(input.polygons),
    centroid: centroidOf(input.polygons),
    anchor: interiorPoint(input.polygons),
    areaKm2: areaKm2(input.polygons),
    expandable: input.expandable,
    source: input.source,
    properties: input.properties ?? {},
  };
}
