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
 * 取地图上能精确对应的地物:乡镇政府驻地、河流交汇点、道路交叉口、县界拐点等,尽量分散在县域四周。
 * 经纬度若取自高德 / 腾讯地图(GCJ-02),先用 gcj02ToWgs84 转换再填入。
 * 少于 3 个时使用上面的近似配准。
 */
export const CONGJIANG_CONTROL_POINTS: ControlPoint[] = [];

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
  for (const township of townships) {
    const alias = congjiangTownshipAliases[township.name];
    township.aliases = alias ? [alias] : [];
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
