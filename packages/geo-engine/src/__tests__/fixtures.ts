import type { MultiPolygonCoords, RegionInput, Ring } from "../types";

/** 逆时针矩形环。 */
export function rect(x0: number, y0: number, x1: number, y1: number): Ring {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0],
  ];
}

export function box(x0: number, y0: number, x1: number, y1: number): MultiPolygonCoords {
  return [[rect(x0, y0, x1, y1)]];
}

export function feature(properties: Record<string, unknown>, coordinates: unknown, type = "Polygon") {
  return { type: "Feature", properties, geometry: { type, coordinates } };
}

/**
 * 嵌套测试世界(无父级编码,靠空间推断):
 * 大陆 [60,0]-[140,60] ⊃ 国家 [70,10]-[130,50] ⊃ 省 A [100,20]-[110,30]、省 B [110,20]-[120,30]
 * 省 A ⊃ 县 A1 [100,20]-[105,25]、县 A2 [105,20]-[110,25]
 */
export const nested: RegionInput[] = [
  { id: "A1", name: "县A1", polygons: box(100, 20, 105, 25), level: "county" },
  { id: "A2", name: "县A2", polygons: box(105, 20, 110, 25), level: "county" },
  { id: "A", name: "省A", polygons: box(100, 20, 110, 30), level: "province" },
  { id: "B", name: "省B", polygons: box(110, 20, 120, 30), level: "province" },
  { id: "CN", name: "国家", polygons: box(70, 10, 130, 50), level: "country" },
  { id: "AS", name: "大陆", polygons: box(60, 0, 140, 60), level: "continent" },
];
