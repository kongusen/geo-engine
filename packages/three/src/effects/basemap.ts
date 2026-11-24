import * as THREE from "three";
import {
  gcj02ToWgs84,
  tilesInBBox,
  tileToLngLat,
  tileUrl,
  zoomForResolution,
  type BBox,
  type LayerSpec,
  type LayerVisibility,
  type Position,
  type TexImageSource,
  type TileCoord,
  type TileSource,
} from "@geodive/core";
import { defineOverlay, type OverlayContext } from "../overlay";

/** 底图着色:把彩色瓦片调成与大屏主题协调的色调。所有分量 0~1。 */
export interface BasemapStyle {
  /** 整体不透明度,缺省 1。 */
  opacity?: number;
  /** 反相(浅色矢量底图配深色主题时用),缺省 0。 */
  invert?: number;
  /** 去色,缺省 0。 */
  grayscale?: number;
  /** 着色:颜色字符串,或 "accent" 跟随主题主色;null 不着色(缺省)。 */
  tint?: string | null;
  /** 着色强度,缺省 0.6。 */
  tintAmount?: number;
  /** 亮度系数,缺省 1。 */
  brightness?: number;
  /**
   * 输出亮度上限,缺省 0.6。场景泛光的阈值为 0.7,底图作为背景不应参与泛光,
   * 否则浅色底图会整片过曝;关闭泛光(bloom: false)的场景可设为 1。
   */
  maxLuminance?: number;
}

/** type: "basemap" —— 栅格瓦片底图(仅平面场景)。 */
export interface BasemapLayerData {
  /** 瓦片图层栈,自下而上(如天地图底图 + 注记)。 */
  sources: TileSource[];
  style?: BasemapStyle;
  /** 铺设范围:当前层级范围的倍数,缺省 3(大于视野时按视野裁剪)。 */
  extent?: number;
  /** 级别偏移:正数更清晰(瓦片更多),缺省 0。 */
  zoomOffset?: number;
  /** 每个图层每级最多瓦片数,超过时自动降级,缺省 80。 */
  maxTiles?: number;
}

/** 便捷构造底图图层规格:自动带上各图层的版权信息,缺省只在平面场景显示。 */
export function basemap(
  sources: TileSource[],
  options: Omit<BasemapLayerData, "sources"> & { id?: string; visible?: LayerVisibility } = {},
): LayerSpec<BasemapLayerData> {
  const { id = "basemap", visible = { scenes: ["plane"] }, ...data } = options;
  const attribution = [...new Set(sources.map((s) => s.attribution).filter(Boolean))].join(" · ") || undefined;
  return { id, type: "basemap", visible, data: { sources, ...data }, attribution };
}

// ── 纹理缓存(跨层级共享:下钻 / 上卷重建图层时不重复下载) ────────────────

interface CacheEntry {
  url: string;
  texture: THREE.Texture | null;
  promise: Promise<THREE.Texture> | null;
  refs: number;
  lastUsed: number;
  failedAt: number;
}

const MAX_TEXTURES = 320;
const MAX_CONCURRENT = 8;
const RETRY_AFTER_MS = 30_000;
const cache = new Map<string, CacheEntry>();
const queue: Array<{ entry: CacheEntry; run: () => void }> = [];
let active = 0;

function pump(): void {
  while (active < MAX_CONCURRENT && queue.length) {
    // 后请求的优先(镜头最新位置),已无人引用的直接丢弃
    const job = queue.pop()!;
    if (job.entry.refs <= 0) {
      job.entry.promise = null;
      continue;
    }
    active++;
    job.run();
  }
}

async function defaultLoad(url: string): Promise<TexImageSource> {
  const response = await fetch(url, { mode: "cors" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return createImageBitmap(await response.blob());
}

function acquire(source: TileSource, tile: TileCoord): CacheEntry {
  const url = tileUrl(source, tile);
  const key = `${source.id}|${url}`;
  let entry = cache.get(key);
  if (!entry) {
    // failedAt 用 -Infinity:performance.now() 从页面加载起计时,初值 0 会让开头 30 秒内的瓦片都被当成"刚失败"
    entry = { url, texture: null, promise: null, refs: 0, lastUsed: 0, failedAt: -Infinity };
    cache.set(key, entry);
  }
  entry.refs++;
  entry.lastUsed = performance.now();
  if (!entry.texture && !entry.promise && performance.now() - entry.failedAt > RETRY_AFTER_MS) {
    const e = entry;
    e.promise = new Promise<THREE.Texture>((resolve, reject) => {
      queue.push({
        entry: e,
        run: () => {
          const controller = new AbortController();
          Promise.resolve(source.load ? source.load(tile, controller.signal) : defaultLoad(e.url))
            .then((image) => {
              const texture = new THREE.Texture(image as THREE.Texture["image"]);
              texture.colorSpace = THREE.SRGBColorSpace;
              texture.flipY = false;
              texture.anisotropy = 4;
              texture.needsUpdate = true;
              e.texture = texture;
              resolve(texture);
            })
            .catch((error) => {
              e.failedAt = performance.now();
              reject(error);
            })
            .finally(() => {
              e.promise = null;
              active--;
              pump();
            });
        },
      });
      pump();
    });
    e.promise.catch(() => {});
  }
  evict();
  return entry;
}

function release(entry: CacheEntry): void {
  entry.refs = Math.max(0, entry.refs - 1);
  entry.lastUsed = performance.now();
}

function evict(): void {
  if (cache.size <= MAX_TEXTURES) return;
  const idle = [...cache].filter(([, e]) => e.refs <= 0 && !e.promise).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  for (const [key, e] of idle.slice(0, cache.size - MAX_TEXTURES)) {
    e.texture?.dispose();
    cache.delete(key);
  }
}

/** 当前缓存状态(排查用)。 */
export function basemapCacheStats(): { textures: number; loading: number; queued: number } {
  return { textures: [...cache.values()].filter((e) => e.texture).length, loading: active, queued: queue.length };
}

// ── 材质:在 MeshBasicMaterial 上注入着色(保留对数深度等内建片段) ───────

interface StyleUniforms {
  uInvert: { value: number };
  uGray: { value: number };
  uTint: { value: THREE.Color };
  uTintAmount: { value: number };
  uBrightness: { value: number };
  uMaxLum: { value: number };
}

function styleUniforms(style: BasemapStyle | undefined, ctx: OverlayContext): StyleUniforms {
  const tint = style?.tint === "accent" ? ctx.theme.accent : style?.tint;
  return {
    uInvert: { value: style?.invert ?? 0 },
    uGray: { value: style?.grayscale ?? 0 },
    uTint: { value: new THREE.Color(tint ?? "#ffffff") },
    uTintAmount: { value: tint ? style?.tintAmount ?? 0.6 : 0 },
    uBrightness: { value: style?.brightness ?? 1 },
    uMaxLum: { value: style?.maxLuminance ?? 0.6 },
  };
}

function tileMaterial(uniforms: StyleUniforms): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform float uInvert;\nuniform float uGray;\nuniform vec3 uTint;\nuniform float uTintAmount;\nuniform float uBrightness;\nuniform float uMaxLum;",
      )
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
        vec3 bm = mix(diffuseColor.rgb, 1.0 - diffuseColor.rgb, uInvert);
        float bmLum = dot(bm, vec3(0.299, 0.587, 0.114));
        bm = mix(bm, vec3(bmLum), uGray);
        bm = mix(bm, uTint * bmLum * 1.6, uTintAmount);
        bm *= uBrightness;
        float bmOut = dot(bm, vec3(0.299, 0.587, 0.114));
        if (bmOut > uMaxLum) bm *= uMaxLum / bmOut;
        diffuseColor.rgb = bm;`,
      );
  };
  material.customProgramCacheKey = () => "geo-basemap";
  return material;
}

// ── 图层 ─────────────────────────────────────────────────────────────────

interface TileMesh {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  entry: CacheEntry;
}

const SEGMENTS = 16;
const ndc = new THREE.Vector2();
const raycaster = new THREE.Raycaster();

export const basemapLayer = defineOverlay<BasemapLayerData>({
  type: "basemap",
  modes: ["plane"],
  zoomFade: false,
  create(ctx, spec) {
    const group = new THREE.Group();
    group.name = "basemap";
    ctx.group.add(group);
    let data = spec.data ?? { sources: [] };
    let uniforms = styleUniforms(data.style, ctx);
    let opacity = 1;
    const tiles = new Map<string, TileMesh>();
    // 在装饰网格(-0.3 单位高)之下,让网格与光环叠在地图上
    const z = -0.32 * ctx.unitHeight;
    let lastKey = "";
    let lastRefresh = 0;

    const tileOpacity = () => opacity * (data.style?.opacity ?? 1);

    const buildGeometry = (source: TileSource, tile: TileCoord): THREE.BufferGeometry => {
      const n = SEGMENTS;
      const positions = new Float32Array((n + 1) * (n + 1) * 3);
      const uvs = new Float32Array((n + 1) * (n + 1) * 2);
      for (let j = 0; j <= n; j++) {
        for (let i = 0; i <= n; i++) {
          const u = i / n;
          const v = j / n;
          let p: Position = tileToLngLat(source, tile, u, v);
          // 瓦片内容是 GCJ-02 时,把"瓦片上的位置"纠偏为真实 WGS84 位置再投影
          if (source.crs === "gcj02") p = gcj02ToWgs84(p);
          const [x, y] = ctx.planeXY(p)!;
          const k = j * (n + 1) + i;
          positions.set([x, y, z], k * 3);
          uvs.set([u, v], k * 2); // flipY = false:v = 0 为图像顶行
        }
      }
      const index: number[] = [];
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const a = j * (n + 1) + i;
          const b = a + 1;
          const c = a + n + 1;
          const d = c + 1;
          index.push(a, c, b, b, c, d);
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
      geometry.setIndex(index);
      geometry.computeBoundingSphere();
      return geometry;
    };

    const addTile = (key: string, source: TileSource, tile: TileCoord, order: number) => {
      const material = tileMaterial(uniforms);
      const mesh = new THREE.Mesh(buildGeometry(source, tile), material);
      mesh.renderOrder = order;
      mesh.visible = false;
      mesh.raycast = () => {}; // 不参与拾取
      group.add(mesh);
      const entry = acquire(source, tile);
      const show = (texture: THREE.Texture) => {
        if (!tiles.has(key)) return;
        material.map = texture;
        material.opacity = tileOpacity();
        material.needsUpdate = true;
        mesh.visible = true;
      };
      if (entry.texture) show(entry.texture);
      else entry.promise?.then(show, () => {});
      tiles.set(key, { mesh, entry });
    };

    const removeTile = (key: string) => {
      const t = tiles.get(key);
      if (!t) return;
      tiles.delete(key);
      group.remove(t.mesh);
      t.mesh.geometry.dispose();
      t.mesh.material.dispose();
      release(t.entry);
    };

    /** 视野在地图平面上的覆盖范围(经纬度)与屏幕中心的地面分辨率。 */
    const footprint = (): { bbox: BBox; metersPerPixel: number; lat: number } | null => {
      const camera = ctx.camera();
      const bounds = ctx.bounds;
      if (!bounds) return null;
      camera.updateMatrixWorld();
      group.updateWorldMatrix(true, false);
      const inverse = group.matrixWorld.clone().invert();
      const ex = data.extent ?? 3;
      const cx = (bounds.minX + bounds.maxX) / 2;
      const cy = (bounds.minY + bounds.maxY) / 2;
      const hw = ((bounds.maxX - bounds.minX) / 2) * ex;
      const hh = ((bounds.maxY - bounds.minY) / 2) * ex;
      const limit = { minX: cx - hw, maxX: cx + hw, minY: cy - hh, maxY: cy + hh };
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      let missed = false;
      let centerHit: THREE.Vector3 | null = null;
      const N = 6;
      for (let j = 0; j <= N; j++) {
        for (let i = 0; i <= N; i++) {
          ndc.set((i / N) * 2 - 1, (j / N) * 2 - 1);
          raycaster.setFromCamera(ndc, camera);
          const ray = raycaster.ray.clone().applyMatrix4(inverse);
          if (ray.direction.z >= -1e-6) {
            missed = true; // 看向地平线以上
            continue;
          }
          const t = (z - ray.origin.z) / ray.direction.z;
          if (t <= 0) {
            missed = true;
            continue;
          }
          const hit = ray.at(t, new THREE.Vector3());
          if (i === N / 2 && j === N / 2) centerHit = hit;
          minX = Math.min(minX, hit.x); maxX = Math.max(maxX, hit.x);
          minY = Math.min(minY, hit.y); maxY = Math.max(maxY, hit.y);
        }
      }
      if (missed || !Number.isFinite(minX)) {
        minX = Math.min(minX, limit.minX); maxX = Math.max(maxX, limit.maxX);
        minY = Math.min(minY, limit.minY); maxY = Math.max(maxY, limit.maxY);
      }
      minX = Math.max(minX, limit.minX); maxX = Math.min(maxX, limit.maxX);
      minY = Math.max(minY, limit.minY); maxY = Math.min(maxY, limit.maxY);
      if (minX >= maxX || minY >= maxY) return null;

      // 投影边界非直线:沿四边采样后取经纬度包围盒
      let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
      const S = 8;
      for (let k = 0; k <= S; k++) {
        const f = k / S;
        for (const [x, y] of [[minX + (maxX - minX) * f, minY], [minX + (maxX - minX) * f, maxY], [minX, minY + (maxY - minY) * f], [maxX, minY + (maxY - minY) * f]]) {
          const p = ctx.unproject(x, y)!;
          minLng = Math.min(minLng, p[0]); maxLng = Math.max(maxLng, p[0]);
          minLat = Math.min(minLat, p[1]); maxLat = Math.max(maxLat, p[1]);
        }
      }
      // GCJ-02 偏移最大约 700m,外扩一点保证边缘不缺瓦片
      const pad = 0.01;
      const bbox: BBox = [minLng - pad, Math.max(-85, minLat - pad), maxLng + pad, Math.min(85, maxLat + pad)];

      const center = centerHit ?? new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, z);
      const camLocal = camera.getWorldPosition(new THREE.Vector3()).applyMatrix4(inverse);
      const distance = camLocal.distanceTo(center);
      const unitsPerPixel = (2 * distance * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, ctx.resolution().height);
      const a = ctx.unproject(center.x, center.y)!;
      const b = ctx.unproject(center.x + 1, center.y)!;
      const metersPerUnit = haversine(a, b);
      return { bbox, metersPerPixel: unitsPerPixel * metersPerUnit, lat: a[1] };
    };

    const refresh = () => {
      const view = footprint();
      const wanted = new Map<string, { source: TileSource; tile: TileCoord; order: number }>();
      if (view) {
        data.sources.forEach((source, si) => {
          const min = source.minZoom ?? 0;
          const max = source.maxZoom ?? 18;
          let zoom = Math.round(zoomForResolution(source, view.metersPerPixel, view.lat) + (data.zoomOffset ?? 0));
          zoom = Math.max(min, Math.min(max, zoom));
          let list = tilesInBBox(source, view.bbox, zoom);
          while (list.length > (data.maxTiles ?? 80) && zoom > min) list = tilesInBBox(source, view.bbox, --zoom);
          // 粗一级(z-3)垫底:精细瓦片未到时先显示模糊版本,数量很少。
          // 只用于最底层:注记等透明叠加层放大 8 倍后是巨大的模糊文字,宁可晚一点出现
          const coarse = Math.max(min, zoom - 3);
          const layers: Array<[TileCoord[], number]> = [[list, 1]];
          if (si === 0 && coarse < zoom) layers.unshift([tilesInBBox(source, view.bbox, coarse), 0]);
          for (const [set, fine] of layers) {
            for (const tile of set) wanted.set(`${si}|${tile.z}/${tile.x}/${tile.y}`, { source, tile, order: -100 + si * 2 + fine });
          }
        });
      }
      for (const key of [...tiles.keys()]) if (!wanted.has(key)) removeTile(key);
      for (const [key, w] of wanted) if (!tiles.has(key)) addTile(key, w.source, w.tile, w.order);
    };

    const applyStyle = () => {
      const next = styleUniforms(data.style, ctx);
      for (const name of Object.keys(next) as Array<keyof StyleUniforms>) (uniforms[name] as { value: unknown }).value = next[name].value;
      for (const t of tiles.values()) if (t.mesh.material.map) t.mesh.material.opacity = tileOpacity();
    };

    return {
      update(next) {
        const nextData = (next.data ?? { sources: [] }) as BasemapLayerData;
        const same = nextData.sources.length === data.sources.length && nextData.sources.every((s, i) => s.id === data.sources[i].id);
        if (!same) return false;
        data = nextData;
        applyStyle();
        lastKey = "";
        return true;
      },
      tick() {
        // 相机或画布变化时(节流 150ms)重新选瓦片
        const now = performance.now();
        if (now - lastRefresh < 150) return;
        const camera = ctx.camera();
        const { width, height } = ctx.resolution();
        const key = `${camera.matrixWorld.elements.map((v) => v.toFixed(4)).join(",")}|${width}x${height}`;
        if (key === lastKey) return;
        lastKey = key;
        lastRefresh = now;
        refresh();
      },
      setOpacity(k) {
        opacity = k;
        for (const t of tiles.values()) if (t.mesh.material.map) t.mesh.material.opacity = tileOpacity();
      },
      dispose() {
        for (const key of [...tiles.keys()]) removeTile(key);
        group.removeFromParent();
        uniforms = styleUniforms(undefined, ctx);
      },
    };
  },
});

function haversine(a: Position, b: Position): number {
  const R = 6371008.8;
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLng = (b[0] - a[0]) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
