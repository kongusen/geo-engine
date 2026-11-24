import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { lngLatToSphere, outerOutline, tangentFrame, type MultiPolygonCoords, type Position, type Region } from "@yaoyu/geo-engine";
import type { SceneTheme } from "./theme";

export interface GlobeOptions {
  /** 陆地环(经纬度),只作装饰底图,不可交互。 */
  land?: Position[][];
  /** 自转速度(度/秒),默认 6;0 关闭。 */
  autoRotateDegPerSec?: number;
  /** 初始视角中心 [经度, 纬度],默认 [105, 18]。 */
  initialView?: Position;
  /** 地球占视口的比例(按短边),默认 0.86。 */
  fill?: number;
}

export interface GlobePoint {
  id: string;
  name: string;
  position: Position;
  label?: string;
  color?: string;
}

/** 三角面细分:最长边超过 maxEdgeDeg 时一分为四,使大面贴合球面而不穿入球体。 */
function subdivide(a: Position, b: Position, c: Position, maxEdgeDeg: number, out: Position[], depth = 0): void {
  const len = (p: Position, q: Position) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  if (depth > 8 || Math.max(len(a, b), len(b, c), len(c, a)) <= maxEdgeDeg) {
    out.push(a, b, c);
    return;
  }
  const mid = (p: Position, q: Position): Position => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const ab = mid(a, b);
  const bc = mid(b, c);
  const ca = mid(c, a);
  subdivide(a, ab, ca, maxEdgeDeg, out, depth + 1);
  subdivide(ab, b, bc, maxEdgeDeg, out, depth + 1);
  subdivide(ca, bc, c, maxEdgeDeg, out, depth + 1);
  subdivide(ab, bc, ca, maxEdgeDeg, out, depth + 1);
}

/** 多边形(经纬度)→ 贴合球面的三角网格位置数组。 */
export function spherePatchPositions(polygons: MultiPolygonCoords, radius: number, maxEdgeDeg = 3): Float32Array {
  const triangles: Position[] = [];
  for (const polygon of polygons) {
    const open = (ring: Position[]) => (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring);
    const contour = open(polygon[0] ?? []).map(([x, y]) => new THREE.Vector2(x, y));
    if (contour.length < 3) continue;
    const holes = polygon.slice(1).map((ring) => open(ring).map(([x, y]) => new THREE.Vector2(x, y)));
    const all = [...contour, ...holes.flat()];
    for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(contour, holes)) {
      subdivide([all[i].x, all[i].y], [all[j].x, all[j].y], [all[k].x, all[k].y], maxEdgeDeg, triangles);
    }
  }
  const out = new Float32Array(triangles.length * 3);
  triangles.forEach((p, i) => out.set(lngLatToSphere(p, radius), i * 3));
  return out;
}

/** 折线(经纬度)→ 球面线段对,长边按 maxStepDeg 细分以贴合曲面。 */
export function sphereSegments(lines: Position[][], radius: number, maxStepDeg = 2): number[] {
  const out: number[] = [];
  for (const line of lines) {
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i];
      const b = line[i + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / maxStepDeg));
      for (let s = 0; s < steps; s++) {
        const p: Position = [a[0] + ((b[0] - a[0]) * s) / steps, a[1] + ((b[1] - a[1]) * s) / steps];
        const q: Position = [a[0] + ((b[0] - a[0]) * (s + 1)) / steps, a[1] + ((b[1] - a[1]) * (s + 1)) / steps];
        out.push(...lngLatToSphere(p, radius), ...lngLatToSphere(q, radius));
      }
    }
  }
  return out;
}

const LOGDEPTH_V = "#include <common>\n#include <logdepthbuf_pars_vertex>";

const OCEAN_VERTEX = /* glsl */ `
${LOGDEPTH_V}
varying vec3 vNormalV;
varying vec3 vViewV;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vNormalV = normalize(normalMatrix * normal);
  vViewV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}`;

const OCEAN_FRAGMENT = /* glsl */ `
#include <logdepthbuf_pars_fragment>
uniform vec3 uDeep;
uniform vec3 uAccent;
uniform float uOpacity;
varying vec3 vNormalV;
varying vec3 vViewV;
void main() {
  #include <logdepthbuf_fragment>
  // dot 可能因舍入略大于 1;pow 的底数为负时结果是 NaN,会被泛光模糊扩散成整帧黑屏
  float f = clamp(1.0 - dot(normalize(vNormalV), normalize(vViewV)), 0.0, 1.0);
  vec3 c = mix(uDeep, uAccent * 0.55, pow(f, 2.2));
  gl_FragColor = vec4(c, uOpacity);
  #include <colorspace_fragment>
}`;

const ATMOSPHERE_FRAGMENT = /* glsl */ `
#include <logdepthbuf_pars_fragment>
uniform vec3 uAccent;
uniform float uOpacity;
varying vec3 vNormalV;
varying vec3 vViewV;
void main() {
  #include <logdepthbuf_fragment>
  // 背面:外缘处 dot≈0,靠近星球边缘 dot≈-0.38;辉光在星球边缘最亮、向外衰减
  float d = -dot(normalize(vNormalV), normalize(vViewV));
  float i = pow(smoothstep(0.0, 0.38, d), 2.2) * (1.0 - smoothstep(0.38, 0.6, d));
  gl_FragColor = vec4(uAccent * i, i * uOpacity);
  #include <colorspace_fragment>
}`;

interface RegionPatch {
  region: Region;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  outline: LineSegments2;
  label: CSS2DObject | null;
  drillable: boolean;
  fade: number;
}

/**
 * 风格化地球:深色海洋 + 主色边缘光、大气辉光、经纬网、陆地(装饰)和可交互的区域块。
 * 整体放在 group 中,由 setAnchor 决定朝向:锚点位于世界原点、法线朝 +Y,球心在 (0,-R,0)。
 */
export class GlobeLayer {
  readonly group = new THREE.Group();
  private readonly ocean: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private readonly atmosphere: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private readonly decor = new THREE.Group();
  private readonly regionGroup = new THREE.Group();
  private readonly pointGroup = new THREE.Group();
  /** 叠加图层(飞线、柱体、涟漪等)挂载点,球体局部坐标。 */
  readonly overlayGroup = new THREE.Group();
  private readonly lineMaterials: LineMaterial[] = [];
  private patches = new Map<string, RegionPatch>();
  private hovered: string | null = null;
  private highlighted: string | null = null;
  private opacity = 1;
  private sink = 0;
  private anchor: Position = [0, 0];
  private readonly accent: THREE.Color;

  constructor(
    readonly radius: number,
    private readonly theme: SceneTheme,
    options: GlobeOptions,
    private resolution: { width: number; height: number },
  ) {
    this.group.matrixAutoUpdate = false;
    const accent = new THREE.Color(theme.accent);
    this.accent = accent;

    this.ocean = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 96, 64),
      new THREE.ShaderMaterial({
        vertexShader: OCEAN_VERTEX,
        fragmentShader: OCEAN_FRAGMENT,
        transparent: true,
        uniforms: { uDeep: { value: new THREE.Color("#04101f") }, uAccent: { value: accent }, uOpacity: { value: 0.96 } },
      }),
    );
    this.ocean.renderOrder = 0;
    this.atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(radius * 1.08, 64, 48),
      new THREE.ShaderMaterial({
        vertexShader: OCEAN_VERTEX,
        fragmentShader: ATMOSPHERE_FRAGMENT,
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: { uAccent: { value: accent }, uOpacity: { value: 0.75 } },
      }),
    );

    // 经纬网
    const graticule: Position[][] = [];
    for (let lat = -60; lat <= 60; lat += 30) graticule.push(Array.from({ length: 73 }, (_, i) => [-180 + i * 5, lat] as Position));
    for (let lng = -180; lng < 180; lng += 30) graticule.push(Array.from({ length: 37 }, (_, i) => [lng, -90 + i * 5] as Position));
    this.decor.add(this.segments(sphereSegments(graticule, radius * 1.0008), theme.accent, 1, 0.16));

    // 陆地
    if (options.land?.length) {
      const polygons: MultiPolygonCoords = options.land.filter((ring) => ring.length >= 4).map((ring) => [ring]);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(spherePatchPositions(polygons, radius * 1.0015, 4), 3));
      const fill = new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({ color: theme.accent, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }),
      );
      fill.renderOrder = 1;
      // 只画海岸线:相邻国家的共享边(国界)由外轮廓算法去掉
      const coast = outerOutline(polygons, { cells: 2400 });
      this.decor.add(fill, this.segments(sphereSegments(coast, radius * 1.002), theme.accent, 1, 0.6));
    }

    this.group.add(this.ocean, this.atmosphere, this.decor, this.regionGroup, this.pointGroup, this.overlayGroup);
  }

  setResolution(width: number, height: number): void {
    this.resolution = { width, height };
    this.lineMaterials.forEach((m) => m.resolution.set(width, height));
  }

  /** 锚点(经纬度)置于世界原点、法线朝上;sink(0..1)把地球整体略微下沉,避免与平面内容穿插。 */
  setAnchor(anchor: Position, sink = this.sink): void {
    this.anchor = anchor;
    this.sink = sink;
    const { east, north, up } = tangentFrame(anchor);
    const R = this.radius;
    const s = 1 - 0.006 * sink;
    const m = new THREE.Matrix4().set(
      east[0], east[1], east[2], 0,
      up[0], up[1], up[2], 0,
      -north[0], -north[1], -north[2], 0,
      0, 0, 0, 1,
    );
    m.premultiply(new THREE.Matrix4().makeScale(s, s, s));
    m.premultiply(new THREE.Matrix4().makeTranslation(0, -R, 0));
    this.group.matrix.copy(m);
    this.group.matrixWorldNeedsUpdate = true;
  }

  getAnchor(): Position {
    return this.anchor;
  }

  /** 世界坐标下的球心。 */
  get center(): THREE.Vector3 {
    return new THREE.Vector3(0, -this.radius, 0);
  }

  setRegions(regions: Region[], isDrillable: (id: string) => boolean): void {
    const keep = new Set(regions.map((r) => r.id));
    for (const [id, patch] of this.patches) {
      if (keep.has(id)) continue;
      this.disposePatch(patch);
      this.patches.delete(id);
    }
    for (const region of regions) {
      if (this.patches.has(region.id)) {
        this.patches.get(region.id)!.drillable = isDrillable(region.id);
        continue;
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(spherePatchPositions(region.polygons, this.radius * 1.003, 2), 3));
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: this.theme.accent, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide }));
      mesh.renderOrder = 2;
      mesh.userData.regionId = region.id;
      const outline = this.segments(sphereSegments(outerOutline(region.polygons, { cells: 1200 }), this.radius * 1.0035, 1), this.theme.edge, 2, 1);
      outline.renderOrder = 3;
      const drillable = isDrillable(region.id);
      let label: CSS2DObject | null = null;
      if (drillable) {
        const outer = document.createElement("div");
        const inner = document.createElement("div");
        inner.textContent = region.name;
        Object.assign(inner.style, {
          fontFamily: this.theme.fontFamily,
          color: this.theme.label,
          fontSize: "22px",
          fontWeight: "800",
          letterSpacing: "0.12em",
          textShadow: `0 0 6px ${this.theme.labelShadow}, 0 0 14px ${this.theme.labelShadow}`,
          pointerEvents: "none",
        });
        outer.append(inner);
        outer.style.pointerEvents = "none";
        label = new CSS2DObject(outer);
        label.position.set(...lngLatToSphere(region.anchor, this.radius * 1.02));
        this.regionGroup.add(label);
      }
      this.regionGroup.add(mesh, outline);
      this.patches.set(region.id, { region, mesh, outline, label, drillable, fade: 1 });
    }
    this.repaint();
  }

  setPoints(points: GlobePoint[]): void {
    for (const child of [...this.pointGroup.children]) {
      child.removeFromParent();
      disposeTree(child);
    }
    const size = this.radius * 0.012;
    for (const point of points) {
      const normal = new THREE.Vector3(...lngLatToSphere(point.position, 1));
      const g = new THREE.Group();
      g.position.copy(normal.clone().multiplyScalar(this.radius * 1.004));
      g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
      g.userData.phase = Math.random();
      const color = new THREE.Color(point.color ?? this.theme.point);
      const head = new THREE.Mesh(new THREE.SphereGeometry(size * 0.5, 16, 12), new THREE.MeshBasicMaterial({ color }));
      head.position.z = size * 1.2;
      head.userData.point = point;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(size * 0.8, size * 1.1, 40),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }),
      );
      ring.name = "pulse";
      g.add(head, ring);
      if (point.label) {
        const outer = document.createElement("div");
        const inner = document.createElement("div");
        inner.textContent = point.label;
        Object.assign(inner.style, {
          fontFamily: this.theme.fontFamily,
          color: this.theme.point,
          fontSize: "16px",
          fontWeight: "700",
          whiteSpace: "nowrap",
          transform: "translateY(-18px)",
          textShadow: `0 0 6px ${this.theme.labelShadow}`,
        });
        outer.append(inner);
        outer.style.pointerEvents = "none";
        const label = new CSS2DObject(outer);
        label.position.z = size * 2;
        g.add(label);
      }
      this.pointGroup.add(g);
    }
  }

  setHover(id: string | null): void {
    this.hovered = id;
    this.repaint();
  }

  setHighlight(id: string | null): void {
    if (id === this.highlighted) return;
    this.highlighted = id;
    this.repaint();
  }

  /** 主题主色变化后刷新颜色(theme 对象与场景共享,由场景修改)。 */
  applyTheme(): void {
    this.accent.set(this.theme.accent);
    this.decor.traverse((o) => {
      const m = (o as THREE.Mesh).material as (THREE.Material & { color?: THREE.Color }) | undefined;
      m?.color?.set(this.theme.accent);
    });
    this.pointGroup.traverse((o) => {
      const m = (o as THREE.Mesh).material as (THREE.Material & { color?: THREE.Color }) | undefined;
      m?.color?.set(this.theme.point);
    });
    this.repaint();
  }

  /** 整体透明度(0..1)。 */
  setOpacity(k: number): void {
    this.opacity = k;
    this.ocean.material.uniforms.uOpacity.value = 0.96 * k;
    this.atmosphere.material.uniforms.uOpacity.value = 0.75 * k * k;
    this.decor.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (!m) return;
      m.userData.baseOpacity ??= m.opacity;
      m.opacity = m.userData.baseOpacity * k;
    });
    this.repaint();
  }

  /** 单个区域块淡入淡出(下钻进入该区域时淡出,让位给平面板块)。 */
  setRegionFade(id: string, k: number): void {
    const patch = this.patches.get(id);
    if (!patch) return;
    patch.fade = k;
    this.repaint();
  }

  /** 只隐藏点位与叠加效果(按地球尺度绘制,镜头下降到县级时会被放大成满屏光斑),区域块保留用于淡出。 */
  setMarkersVisible(visible: boolean): void {
    for (const g of [this.pointGroup, this.overlayGroup]) {
      g.visible = visible;
      g.traverse((o) => {
        if (o instanceof CSS2DObject) o.visible = visible;
      });
    }
  }

  setOverlayVisible(visible: boolean): void {
    this.regionGroup.visible = visible;
    this.pointGroup.visible = visible;
    this.overlayGroup.visible = visible;
    for (const patch of this.patches.values()) if (patch.label) patch.label.visible = visible;
    for (const g of [this.pointGroup, this.overlayGroup]) {
      g.traverse((o) => {
        if (o instanceof CSS2DObject) o.visible = visible;
      });
    }
  }

  /** 拾取:被海洋球体遮挡(背面)的区域不可选。 */
  pick(raycaster: THREE.Raycaster): string | null {
    if (!this.regionGroup.visible) return null;
    const meshes = [...this.patches.values()].map((p) => p.mesh);
    const hit = raycaster.intersectObjects([this.ocean, ...meshes], false)[0];
    if (!hit || hit.object === this.ocean) return null;
    return hit.object.userData.regionId ?? null;
  }

  /** 拾取地球表面点位:被海洋球体遮挡(背面)的点位不可选。 */
  pickPoint(raycaster: THREE.Raycaster): GlobePoint | null {
    if (!this.pointGroup.visible) return null;
    const targets: THREE.Object3D[] = [];
    for (const g of this.pointGroup.children) {
      for (const child of g.children) {
        if (child.userData.point) targets.push(child);
      }
    }
    if (!targets.length) return null;
    const hit = raycaster.intersectObjects([this.ocean, ...targets], false)[0];
    if (!hit || hit.object === this.ocean) return null;
    return (hit.object.userData.point as GlobePoint | undefined) ?? null;
  }

  /** 每帧:脉冲动画、背面标签隐藏。 */
  tick(t: number, camera: THREE.Camera): void {
    const center = this.center;
    const world = new THREE.Vector3();
    const hideBackside = (object: THREE.Object3D) => {
      const el = (object as CSS2DObject).element?.firstElementChild as HTMLElement | null;
      if (!el) return;
      object.getWorldPosition(world);
      const normal = world.clone().sub(center).normalize();
      const toCamera = camera.position.clone().sub(world).normalize();
      el.style.visibility = normal.dot(toCamera) > 0.15 ? "visible" : "hidden";
    };
    for (const patch of this.patches.values()) if (patch.label) hideBackside(patch.label);
    this.overlayGroup.traverse((o) => {
      if (o instanceof CSS2DObject) hideBackside(o);
    });
    for (const g of this.pointGroup.children) {
      const pulse = g.getObjectByName("pulse") as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | undefined;
      if (pulse) {
        const k = (t * 0.7 + g.userData.phase) % 1;
        pulse.scale.setScalar(1 + k * 2.4);
        pulse.material.opacity = 0.8 * (1 - k) * this.opacity;
      }
      g.traverse((o) => {
        if (o instanceof CSS2DObject) hideBackside(o);
      });
    }
  }

  dispose(): void {
    for (const patch of this.patches.values()) this.disposePatch(patch);
    this.patches.clear();
    disposeTree(this.group);
    this.group.removeFromParent();
  }

  private repaint(): void {
    for (const patch of this.patches.values()) {
      const hovered = patch.region.id === this.hovered || patch.region.id === this.highlighted;
      const base = patch.drillable ? 0.55 : 0.28;
      patch.mesh.material.opacity = (hovered ? 0.8 : base) * patch.fade * this.opacity;
      patch.mesh.material.color.set(hovered ? this.theme.highlight : this.theme.accent);
      patch.outline.material.opacity = patch.fade * this.opacity;
      patch.outline.material.color.set(hovered ? this.theme.highlight : this.theme.edge);
      if (patch.label) (patch.label.element as HTMLElement).style.opacity = String(patch.fade * this.opacity);
    }
  }

  private segments(positions: number[], color: string, width: number, opacity: number): LineSegments2 {
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(positions);
    const material = new LineMaterial({ color: new THREE.Color(color).getHex(), linewidth: width, transparent: true, opacity, depthWrite: false });
    material.resolution.set(this.resolution.width, this.resolution.height);
    this.lineMaterials.push(material);
    return new LineSegments2(geometry, material);
  }

  private disposePatch(patch: RegionPatch): void {
    patch.label?.element.remove();
    for (const o of [patch.mesh, patch.outline, patch.label].filter(Boolean) as THREE.Object3D[]) {
      o.removeFromParent();
      disposeTree(o);
    }
  }
}

function disposeTree(object: THREE.Object3D): void {
  object.traverse((o) => {
    if (o instanceof CSS2DObject) o.element.remove();
    const mesh = o as THREE.Mesh;
    mesh.geometry?.dispose();
    const mats = mesh.material;
    if (mats) for (const m of [mats].flat()) m.dispose();
  });
}
