import source from "../../../../fixtures/congjiang.json";

export type CongjiangGeoJsonPosition = [number, number];

export type CongjiangGeoJsonFeature = {
  type: "Feature";
  id: string;
  properties: {
    name: string;
    label: string;
    sourceLayer: string;
    centroid: CongjiangGeoJsonPosition;
    bbox: [number, number, number, number];
    coordinateSpace: "svg:3000x2250";
  };
  geometry: {
    type: "Polygon";
    coordinates: CongjiangGeoJsonPosition[][];
  };
};

export type CongjiangGeoJson = {
  type: "FeatureCollection";
  name: "congjiang-townships";
  title: string;
  source: string;
  coordinateReferenceSystem: "SVG_LOCAL";
  coordinateSpace: {
    width: 3000;
    height: 2250;
    yAxis: "down";
    unit: "svg-unit";
  };
  features: CongjiangGeoJsonFeature[];
};

/** 从 SVG 解析出的完整 21 个乡镇边界，作为一产 GIS 的权威底图数据。 */
export const congjiangGeoJson = source as CongjiangGeoJson;
export const congjiangGeoJsonViewBox = `0 0 ${congjiangGeoJson.coordinateSpace.width} ${congjiangGeoJson.coordinateSpace.height}`;

/** SVG 中较短的历史行政名称与台账中的名称别名。 */
export const congjiangTownshipAliases: Record<string, string> = {
  翠里乡: "翠里瑶族壮族乡",
  刚边乡: "刚边壮族乡",
  秀塘乡: "秀塘壮族乡",
  斗里乡: "斗里镇",
  庆云乡: "庆云镇",
  东朗乡: "东朗镇",
};

export function findCongjiangGeoJsonFeature(name: string): CongjiangGeoJsonFeature | undefined {
  const feature = congjiangGeoJson.features.find((item) => item.properties.name === name);
  if (feature) return feature;
  const svgName = Object.entries(congjiangTownshipAliases).find(([, alias]) => alias === name)?.[0];
  return svgName ? congjiangGeoJson.features.find((item) => item.properties.name === svgName) : undefined;
}

export function townshipDataName(featureName: string): string {
  return congjiangTownshipAliases[featureName] ?? featureName;
}

export function townshipFeatureName(name: string): string {
  return findCongjiangGeoJsonFeature(name)?.properties.name ?? name;
}
