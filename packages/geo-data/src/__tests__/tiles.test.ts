import { describe, expect, it } from "vitest";
import { amapTiles, lngLatToTile, tianditu, tilesInBBox, tileToLngLat, tileUrl, xyzTiles, zoomForResolution, type TileSource } from "../tiles";

const merc: TileSource = { id: "m", url: "https://{s}.t/{z}/{x}/{y}.png", subdomains: ["a", "b"] };
const geo: TileSource = { ...merc, matrix: "geographic" };

describe("瓦片计算", () => {
  it("墨卡托:经纬度与瓦片号互逆", () => {
    // 从江县城在 z=10:x = (108.905+180)/360·1024 ≈ 821.8;y = (1 − ln(tanφ+secφ)/π)/2·1024 ≈ 436.2
    const [fx, fy] = lngLatToTile(merc, [108.905, 25.747], 10);
    expect([Math.floor(fx), Math.floor(fy)]).toEqual([821, 436]);
    const [lng, lat] = tileToLngLat(merc, { z: 10, x: Math.floor(fx), y: Math.floor(fy) }, fx % 1, fy % 1);
    expect(lng).toBeCloseTo(108.905, 6);
    expect(lat).toBeCloseTo(25.747, 6);
    expect(tileToLngLat(merc, { z: 0, x: 0, y: 0 })).toEqual([-180, expect.closeTo(85.0511, 3)]);
  });

  it("经纬度矩阵(天地图 c):z 级 2^z 列 × 2^(z-1) 行", () => {
    expect(tileToLngLat(geo, { z: 1, x: 1, y: 0 }, 1, 1)).toEqual([180, -90]);
    const [fx, fy] = lngLatToTile(geo, [108.905, 25.747], 10);
    expect(tileToLngLat(geo, { z: 10, x: 0, y: 0 }, fx, fy)).toEqual([expect.closeTo(108.905, 6), expect.closeTo(25.747, 6)]);
  });

  it("地址模板、子域轮换、tms 行号翻转", () => {
    expect(tileUrl(merc, { z: 3, x: 5, y: 2 })).toBe("https://b.t/3/5/2.png");
    expect(tileUrl({ ...merc, scheme: "tms" }, { z: 3, x: 5, y: 2 })).toBe("https://a.t/3/5/5.png");
    expect(tileUrl({ ...merc, url: (z, x, y) => `${z}-${x}-${y}` }, { z: 1, x: 1, y: 0 })).toBe("1-1-0");
  });

  it("bbox 覆盖瓦片按距中心排序", () => {
    const tiles = tilesInBBox(merc, [108.2, 25.3, 109.3, 26.0], 9);
    expect(tiles.length).toBeGreaterThan(1);
    const keys = tiles.map((t) => `${t.x},${t.y}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(tiles.every((t) => t.z === 9)).toBe(true);
  });

  it("按地面分辨率选级别", () => {
    // 赤道 z=0 时每像素约 156543 米
    expect(zoomForResolution(merc, 156543.03, 0)).toBeCloseTo(0, 3);
    expect(zoomForResolution(merc, 156543.03 / 1024, 0)).toBeCloseTo(10, 3);
  });

  it("服务商:天地图底图 + 注记,高德标注 gcj02", () => {
    const [base, label] = tianditu({ key: "k&1" });
    expect(tileUrl(base, { z: 5, x: 25, y: 13 })).toMatch(/^https:\/\/t\d\.tianditu\.gov\.cn\/vec_w\/wmts\?.*TILEMATRIX=5&TILEROW=13&TILECOL=25&tk=k%261$/);
    expect(label.id).toBe("tianditu-cva_w");
    expect(tianditu({ key: "k", label: false, layer: "img", matrix: "c" })).toEqual([expect.objectContaining({ id: "tianditu-img_c", matrix: "geographic" })]);
    expect(amapTiles()[0].crs).toBe("gcj02");
    expect(xyzTiles("https://x/{z}/{x}/{y}.png", { maxZoom: 12 })[0]).toMatchObject({ id: "xyz", maxZoom: 12 });
  });
});
