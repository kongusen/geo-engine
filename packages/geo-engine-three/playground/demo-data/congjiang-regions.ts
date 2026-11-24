import { EARTH_RADIUS_M, GeoEngine, fitAffine, ingest, type Affine, type ControlPoint, type GeoIssue, type RegionInput } from "@yaoyu/geo-engine";
import source from "../../../../fixtures/congjiang.json";
import { congjiangTownshipAliases } from "./congjiang-geojson";

export const CONGJIANG_COUNTY_ID = "522633";

/**
 * 从江乡镇边界(SVG 本地坐标)→ WGS84 的**近似**配准:等比缩放,把 SVG 范围中心对齐到县域中心。
 * 误差约 0.1° 量级,只够做示意底图;企业/基地经纬度点位会有偏差。
 * 拿到 ≥3 个控制点(如乡镇政府驻地的 SVG 坐标与真实经纬度)后用 fitAffine 求解替换,或直接换成真实矢量边界。
 */
export const CONGJIANG_APPROX_AFFINE: Affine = [0.000407, 0, 108.0695, 0, -0.000367, 26.0879];

/**
 * 配准控制点:source 为 congjiang.json 中的 SVG 坐标,target 为同一地物的 WGS84 经纬度。
 * 取自阿里云 DataV 行政区划(522633 从江县外边界,由 GCJ-02 经 gcj02ToWgs84 转 WGS84)
 * 与 congjiang.json 县界外轮廓拐点在全县 8 个方位均匀对齐拟合,最大残差 14 米(远低于 300m 阈值),
 * 并经从江县城、从江高铁站、洛香镇政府、加榜梯田、贯洞镇政府、宰便镇政府 6 个真实地标 WGS84 坐标交叉验证落区无误。
 */
export const CONGJIANG_CONTROL_POINTS: ControlPoint[] = [
  { source: [1407.62, 331.23], target: [108.677457, 25.981762] }, // 往洞镇北界
  { source: [2291.87, 315.59], target: [109.01933, 25.9877] }, // 洛香镇北界
  { source: [2726.36, 654.67], target: [109.187291, 25.856579] }, // 洛香镇东界
  { source: [2459.25, 1441.83], target: [109.084021, 25.552249] }, // 斗里镇东南界
  { source: [1819.92, 1446.94], target: [108.836826, 25.550263] }, // 翠里乡南界
  { source: [1247.12, 2068.86], target: [108.615384, 25.309826] }, // 秀塘乡南端
  { source: [274.14, 1321.49], target: [108.239197, 25.598767] }, // 光辉乡西端
  { source: [753.48, 913.62], target: [108.424679, 25.75662] }, // 加鸠乡西北界
];

/** 控制点拟合的最大残差超过该值(米)视为控制点有误,拒绝使用并回退近似配准。 */
const MAX_RESIDUAL_M = 300;

export interface Georeference {
  affine: Affine;
  /** true 表示仍在用近似配准,点位不可信(业务上应提示或禁用按点位的统计)。 */
  approximate: boolean;
  /** 控制点拟合的最大残差(米),近似配准时为 null。 */
  maxResidualM: number | null;
  warning: string | null;
}

export function georeferenceFrom(points: ControlPoint[]): Georeference {
  if (points.length < 3) {
    return { affine: CONGJIANG_APPROX_AFFINE, approximate: true, maxResidualM: null, warning: "从江乡镇边界为近似配准(误差约 0.1°),点位落区可能有误" };
  }
  const { affine, maxResidual } = fitAffine(points);
  const maxResidualM = Math.round(((maxResidual * Math.PI) / 180) * EARTH_RADIUS_M);
  if (maxResidualM > MAX_RESIDUAL_M) {
    return { affine: CONGJIANG_APPROX_AFFINE, approximate: true, maxResidualM, warning: `控制点拟合残差 ${maxResidualM} 米,超过 ${MAX_RESIDUAL_M} 米,已回退近似配准;请检查控制点` };
  }
  return { affine, approximate: false, maxResidualM, warning: null };
}

/** 当前生效的配准。 */
export const CONGJIANG_GEOREF: Georeference = georeferenceFrom(CONGJIANG_CONTROL_POINTS);

/** 县 + 21 个乡镇。县域多边形取全部乡镇面的集合(暂无独立的县界数据)。 */
export function congjiangRegions(): { regions: RegionInput[]; issues: GeoIssue[] } {
  const { regions: townships, issues } = ingest(source, {
    crs: { affine: CONGJIANG_GEOREF.affine },
    idKey: "name",
    level: "township",
    parentId: CONGJIANG_COUNTY_ID,
    simplify: 0.0002,
  });
  // 显示名统一用台账中的正式名称(如"刚边壮族乡""东朗镇"),边界旧称保留为别名,名称解析两者皆可。区域 id 不变。
  for (const township of townships) {
    const official = congjiangTownshipAliases[township.name];
    township.aliases = official ? [township.name] : [];
    if (official) township.name = official;
  }
  const county: RegionInput = {
    id: CONGJIANG_COUNTY_ID,
    name: "从江县",
    level: "county",
    parentId: null,
    polygons: townships.flatMap((t) => t.polygons),
  };
  return { regions: [county, ...townships], issues };
}

/** 以从江县为根、乡镇可聚焦的引擎实例。 */
export function createCongjiangEngine(): GeoEngine {
  const engine = new GeoEngine({ rootId: CONGJIANG_COUNTY_ID, allowLeafFocus: true });
  engine.addRegions(congjiangRegions().regions, { inferParents: false });
  return engine;
}
