import { GeoEngine, interiorPoint, pointInRing, signedRingArea, type MultiPolygonCoords, type Position, type RegionInput, type Ring } from "@yaoyu/geo-engine";
import { chinaProvincesData } from "./china";
import { worldLand } from "./world_land_data";
import { CONGJIANG_COUNTY_ID, congjiangRegions } from "./congjiang-regions";

export const CHINA_ID = "CHN";
export const GUIZHOU_ID = "520000";
/** 从江县城(丙妹镇)位置,用于全球 / 全国层级的定位标记。 */
export const CONGJIANG_SEAT: Position = [108.905, 25.747];

/** china.ts 的预投影 SVG 坐标 → 经纬度(projectChina 的逆变换)。 */
function unprojectChina(x: number, y: number): Position {
  return [(x + 934.4461662873192) / 12.800376739218803, (846.4598878701353 - y) / 15.82166864235793];
}

function parsePath(path: string): Ring[] {
  return path
    .split("M")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) =>
      part
        .replace(/Z/gi, "")
        .split("L")
        .map((pair) => pair.trim())
        .filter(Boolean)
        .map((pair) => {
          const [x, y] = pair.split(",").map(Number);
          return unprojectChina(x, y);
        }),
    )
    .map((ring) => (ring.length && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) ? [...ring, ring[0]] : ring));
}

/**
 * SVG 路径不区分外环与洞(如河北省环绕北京、天津),按奇偶规则组装:
 * 被同一省内奇数个更大环包含的环是洞,挂到直接包含它的外环下。
 */
export function assemblePolygons(rings: Ring[]): MultiPolygonCoords {
  const valid = rings.filter((ring) => ring.length >= 4 && Math.abs(signedRingArea(ring)) > 0);
  const sorted = [...valid].sort((a, b) => Math.abs(signedRingArea(b)) - Math.abs(signedRingArea(a)));
  const polygons: Array<{ outer: Ring; holes: Ring[] }> = [];
  for (const ring of sorted) {
    const probe = interiorPoint([[ring]]);
    const containers = polygons.filter((p) => pointInRing(probe, p.outer) && !p.holes.some((h) => pointInRing(probe, h)));
    const parent = containers[containers.length - 1];
    const depth = sorted.filter((other) => other !== ring && Math.abs(signedRingArea(other)) > Math.abs(signedRingArea(ring)) && pointInRing(probe, other)).length;
    if (parent && depth % 2 === 1) parent.holes.push(ring);
    else polygons.push({ outer: ring, holes: [] });
  }
  return polygons.map((p) => [p.outer, ...p.holes]);
}

/** 中国省级区划(含港澳台),按中国标准地图数据(DataV)。 */
export function chinaProvinceRegions(): RegionInput[] {
  return chinaProvincesData.provinces
    .filter((province) => province.adcode !== "100000_JD" && province.name)
    .map((province) => ({
      id: String(province.adcode),
      name: province.name,
      level: "province",
      parentId: CHINA_ID,
      polygons: assemblePolygons(province.paths.flatMap(parsePath)),
    }));
}

/** 南海九段线(线状要素,在全国层级绘制)。 */
export function chinaNineDashLines(): Position[][] {
  const jd = chinaProvincesData.provinces.find((province) => province.adcode === "100000_JD");
  return (jd?.paths ?? []).flatMap(parsePath).map((ring) => ring.filter((p, i) => ring.findIndex((q) => q[0] === p[0] && q[1] === p[1]) === i));
}

/** 地球装饰底图:陆地轮廓(不含国界,不可交互)。 */
export const WORLD_LAND: Position[][] = worldLand as Position[][];

/**
 * 全景页下钻链:地球 → 中国 → 各省 → (贵州)从江县 → 乡镇。
 * 中国的外形由各省合成,不使用国际数据集中的国界。
 */
export function overviewRegions(): RegionInput[] {
  const provinces = chinaProvinceRegions();
  const china: RegionInput = {
    id: CHINA_ID,
    name: "中国",
    level: "country",
    parentId: null,
    polygons: provinces.flatMap((p) => p.polygons),
  };
  const congjiang = congjiangRegions().regions.map((region) =>
    region.id === CONGJIANG_COUNTY_ID ? { ...region, parentId: GUIZHOU_ID } : region,
  );
  return [china, ...provinces, ...congjiang];
}

/**
 * 全景页引擎。地球上点击中国直达从江县(一段连续转场,中途不用再点);
 * 中国 / 贵州层级仍可经面包屑或"返回上一级"进入,在那里点击按常规逐级下钻。
 */
export function createOverviewEngine({ diveTo = CONGJIANG_COUNTY_ID }: { diveTo?: string | null } = {}): GeoEngine {
  const engine = new GeoEngine({
    rootId: null,
    redirectActivate: (region, state) => (diveTo && state.focusId === null && region.id === CHINA_ID ? diveTo : null),
  });
  engine.addRegions(overviewRegions(), { inferParents: false });
  return engine;
}
