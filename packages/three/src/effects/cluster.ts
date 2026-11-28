import * as THREE from "three";
import { clusterPoints, type Cluster, type ClusterDatum, type ClusterLayerData, type Position } from "@geodive/core";
import { alignToUp, defineOverlay, disposeTree, scaleOpacity } from "../overlay";

export type { ClusterDatum, ClusterLayerData };

const DEG = Math.PI / 180;

export const clusterLayer = defineOverlay<ClusterLayerData>({
  type: "cluster",
  modes: ["plane", "globe"],
  create(ctx, spec) {
    const data = spec.data ?? { points: [] };
    const group = new THREE.Group();
    ctx.group.add(group);
    const inside = data.points.filter((p) => ctx.contains(p.position));
    const project =
      ctx.mode === "plane"
        ? (p: Position) => ctx.planeXY(p) ?? p
        : (p: Position): [number, number] => [p[0] * DEG * ctx.scale, p[1] * DEG * ctx.scale];
    const clusters = clusterPoints(inside, ctx.scale * (data.cellSize ?? 0.12), project);
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
      const up = ctx.up(cluster.position).clone().normalize();
      mesh.position.copy(ctx.position(cluster.position, r * 1.2));
      alignToUp(mesh, up);
      mesh.userData.basePos = mesh.position.clone();
      mesh.userData.up = up;
      mesh.userData.cluster = cluster;
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
        // 轻微沿法线浮动
        bubbles.forEach((b, i) => {
          const basePos = b.userData.basePos as THREE.Vector3;
          const up = b.userData.up as THREE.Vector3;
          b.position.copy(basePos).addScaledVector(up, Math.sin(t * 1.4 + i) * ctx.unitHeight * 0.08);
        });
      },
      setOpacity(k) {
        scaleOpacity(group, k);
      },
      pick(raycaster) {
        const hit = raycaster.intersectObjects(bubbles, false)[0];
        const cluster = hit?.object.userData.cluster as Cluster<ClusterDatum> | undefined;
        return cluster ? { item: cluster, position: cluster.position, distance: hit.distance } : null;
      },
      dispose() {
        disposeTree(group);
      },
    };
  },
});
