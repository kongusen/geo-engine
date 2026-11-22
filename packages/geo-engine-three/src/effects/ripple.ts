import * as THREE from "three";
import type { Position } from "@yaoyu/geo-engine";
import { alignToUp, defineOverlay, disposeTree } from "../overlay";

export interface RippleDatum {
  position: Position;
  color?: string;
  /** 尺寸系数,默认 1。 */
  size?: number;
  label?: string;
}

/** type: "ripple" —— 扩散波纹(告警、重点区域强调)。 */
export interface RippleLayerData {
  points: RippleDatum[];
  /** 同时存在的波纹圈数,默认 3。 */
  rings?: number;
  /** 每秒扩散周期数,默认 0.5。 */
  speed?: number;
  color?: string;
}

export const rippleLayer = defineOverlay<RippleLayerData>({
  type: "ripple",
  modes: ["plane", "globe"],
  create(ctx, spec) {
    const data = spec.data ?? { points: [] };
    const group = new THREE.Group();
    ctx.group.add(group);
    const ringCount = data.rings ?? 3;
    const rings: Array<{ mesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>; offset: number }> = [];
    let opacity = 1;
    const cores: THREE.MeshBasicMaterial[] = [];
    for (const point of data.points) {
      if (!ctx.contains(point.position)) continue;
      const size = ctx.scale * 0.035 * (point.size ?? 1);
      const color = new THREE.Color(point.color ?? data.color ?? "#f87171");
      const anchor = new THREE.Group();
      anchor.position.copy(ctx.position(point.position, ctx.unitHeight * 0.02));
      alignToUp(anchor, ctx.up(point.position));
      const core = new THREE.Mesh(new THREE.CircleGeometry(size * 0.18, 24), new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false }));
      anchor.add(core);
      cores.push(core.material);
      for (let i = 0; i < ringCount; i++) {
        const mesh = new THREE.Mesh(
          new THREE.RingGeometry(size * 0.92, size, 64),
          new THREE.MeshBasicMaterial({ color, transparent: true, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
        );
        mesh.renderOrder = 6;
        anchor.add(mesh);
        rings.push({ mesh, offset: i / ringCount });
      }
      if (point.label) {
        const label = ctx.label(point.label, { color: `#${color.getHexString()}`, transform: "translateY(-22px)" });
        anchor.add(label);
      }
      group.add(anchor);
    }
    const speed = data.speed ?? 0.5;
    return {
      tick(t) {
        for (const { mesh, offset } of rings) {
          const k = (t * speed + offset) % 1;
          mesh.scale.setScalar(0.15 + k);
          mesh.material.opacity = opacity * (1 - k) ** 1.5;
        }
      },
      setOpacity(k) {
        opacity = k;
        for (const m of cores) m.opacity = k;
        group.traverse((o) => {
          if ((o as { isCSS2DObject?: boolean }).isCSS2DObject) (o as unknown as { element: HTMLElement }).element.style.opacity = String(k);
        });
      },
      dispose() {
        disposeTree(group);
      },
    };
  },
});
