/** [经度, 纬度](WGS84)。引擎内部一律使用 WGS84 经纬度,输入在 ingest 阶段统一转换。 */
export type Position = [number, number];
/** 闭合环:首尾点相同。 */
export type Ring = Position[];
/** 多边形:第一个环为外环(逆时针),其余为洞(顺时针),遵循 RFC 7946。 */
export type PolygonCoords = Ring[];
export type MultiPolygonCoords = PolygonCoords[];
/** [minLng, minLat, maxLng, maxLat] */
export type BBox = [number, number, number, number];

/** 区域:任何能被闭合多边形围起来的范围——国家、省、乡镇、村、基地地块、园区都是区域。 */
export interface Region {
  id: string;
  name: string;
  aliases: string[];
  parentId: string | null;
  /** 可选的语义层级标签(country / province / township / plot ...),引擎本身只依赖树深度。 */
  level?: string;
  /** 统一为 MultiPolygon,外环逆时针、洞顺时针。 */
  polygons: MultiPolygonCoords;
  bbox: BBox;
  /** 面积加权质心,可能落在凹多边形外部。 */
  centroid: Position;
  /** 保证落在区域内部的点,用于标签、点击落点、空间包含推断。 */
  anchor: Position;
  /** 近似球面面积(km²)。 */
  areaKm2: number;
  /** 子级尚未加载但存在(懒加载数据源用)。 */
  expandable?: boolean;
  /** 来源:提供该区域的数据源 id 与源内原始编码(经 IdMapper 映射前)。直接 addRegions 的区域没有此字段。 */
  source?: RegionSourceRef;
  properties: Record<string, unknown>;
}

export interface RegionSourceRef {
  /** 数据源 id。 */
  id: string;
  /** 源内原始编码。 */
  localId: string;
}

/** 构建区域所需的最小输入;几何派生字段由引擎计算。 */
export interface RegionInput {
  id: string;
  name: string;
  aliases?: string[];
  parentId?: string | null;
  level?: string;
  polygons: MultiPolygonCoords;
  expandable?: boolean;
  source?: RegionSourceRef;
  properties?: Record<string, unknown>;
}

export type IssueSeverity = "info" | "warning" | "error";

/** ingest / 建树 过程中发现的问题,供后台校验报告展示。 */
export interface GeoIssue {
  severity: IssueSeverity;
  code:
    | "crs-converted"
    | "crs-unknown"
    | "ring-closed"
    | "ring-rewound"
    | "ring-degenerate"
    | "antimeridian-unwrapped"
    | "non-polygon-skipped"
    | "missing-id"
    | "duplicate-id"
    | "missing-parent"
    | "parent-inferred"
    | "parent-not-found"
    | "invalid-input"
    | "id-collision";
  message: string;
  featureIndex?: number;
  regionId?: string;
}
