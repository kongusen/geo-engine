import type { MultiPolygonCoords, Ring } from "../types";

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
