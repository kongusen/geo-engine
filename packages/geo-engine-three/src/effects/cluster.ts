import * as THREE from "three";
import { clusterPoints, type Position } from "@yaoyu/geo-engine";
import { defineOverlay, disposeTree, scaleOpacity } from "../overlay";

export interface ClusterDatum {
  id: string;
  name?: string;
  position: Position;
  weight?: number;
}

/** type: "cluster" —— 点位聚合(企业 / 门店较密时),气泡大小与数量相关。仅平面模式。 */
export interface ClusterLayerData {
  points: ClusterDatum[];
  /** 聚合格大小(相对特征长度),默认 0.12;下钻后特征长度变小,聚合自然展开。 */
  cellSize?: number;
  color?: string;
  /** 单点(未聚合)时显示名称,默认 false。 */
  showNames?: boolean;
}

export const clusterLayer = defineOverlay<ClusterLayerData>({
  type: "cluster",
  modes: ["plane"],
  create(ctx, spec) {
    const data = spec.data ?? { points: [] };
    const group = new THREE.Group();
    ctx.group.add(group);
    const inside = data.points.filter((p) => ctx.contains(p.position));
    const clusters = clusterPoints(inside, ctx.scale * (data.cellSize ?? 0.12), (p) => ctx.planeXY(p) ?? p);
    const maxCount = Math.max(1, ...clusters.map((c) => c.count));
    const color = new THREE.Color(data.color ?? ctx.theme.point);
    const base = ctx.scale * 0.014;
    const bubbles: THREE.Mesh[] = [];
    for (const cluster of clusters) {
      const single = cluster.count === 1;
      const r = single ? base * 0.6 : base * (1 + 1.6 * Math.sqrt(cluster.count / maxCount));
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(r, 24, 16),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: single ? 0.95 : 0.55, depthWrite: false }),
      );
      mesh.position.copy(ctx.position(cluster.position, r * 1.2));
      mesh.userData.baseZ = mesh.position.z;
      mesh.renderOrder = 7;
      if (!single) {
        const halo = new THREE.Mesh(
          new THREE.RingGeometry(r * 1.15, r * 1.3, 48),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false }),
        );
        mesh.add(halo);
        const label = ctx.label(String(cluster.count), { fontSize: "16px", color: "#0b1220", textShadow: "none" });
        mesh.add(label);
      } else if (data.showNames && cluster.members[0].name) {
        const label = ctx.label(cluster.members[0].name, { fontSize: "13px", transform: "translateY(-14px)" });
        mesh.add(label);
      }
      bubbles.push(mesh);
      group.add(mesh);
    }
    return {
      tick(t) {
        // 轻微上下浮动
        bubbles.forEach((b, i) => (b.position.z = b.userData.baseZ + Math.sin(t * 1.4 + i) * ctx.unitHeight * 0.08));
      },
      setOpacity(k) {
        scaleOpacity(group, k);
      },
      dispose() {
        disposeTree(group);
      },
    };
  },
});
