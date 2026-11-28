import * as THREE from "three";
import type { BarDatum, BarLayerData, Position } from "@geodive/core";
import { LOGDEPTH, alignToUp, defineOverlay, disposeTree, scaleOpacity } from "../overlay";

export type { BarDatum, BarLayerData };

const VERTEX = /* glsl */ `
${LOGDEPTH.vertexPars}
varying float vH;
void main() {
  vH = position.z;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  ${LOGDEPTH.vertex}
}`;

const FRAGMENT = /* glsl */ `
${LOGDEPTH.fragmentPars}
uniform vec3 uColor;
uniform float uOpacity;
varying float vH;
void main() {
  ${LOGDEPTH.fragment}
  float h = clamp(vH, 0.0, 1.0);
  vec3 c = mix(uColor * 0.25, uColor, h);
  c = mix(c, vec3(1.0), smoothstep(0.96, 1.0, h) * 0.6);
  gl_FragColor = vec4(c, uOpacity * (0.35 + 0.65 * h));
  #include <colorspace_fragment>
}`;

export const barLayer = defineOverlay<BarLayerData>({
  type: "bar",
  modes: ["plane", "globe"],
  create(ctx, spec) {
    const data = spec.data ?? { bars: [] };
    const group = new THREE.Group();
    ctx.group.add(group);
    const items = data.bars
      .map((bar) => ({ bar, position: bar.position ?? (bar.regionId ? ctx.region(bar.regionId)?.anchor : undefined) }))
      .filter((item): item is { bar: BarDatum; position: Position } => !!item.position && ctx.contains(item.position));
    const maxValue = Math.max(1e-9, ...items.map((i) => i.bar.value));
    const maxHeight = ctx.scale * (data.maxHeight ?? 0.32);
    const width = ctx.scale * (data.width ?? 0.022);
    const format = data.format ?? ((v: number, u?: string) => `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(v)}${u ? ` ${u}` : ""}`);
    // 单位高度的柱体,底面在 z=0,通过 scale.z 控制高度
    const geometry = new THREE.BoxGeometry(width, width, 1);
    geometry.translate(0, 0, 0.5);
    const columns: Array<{ mesh: THREE.Mesh; height: number; label: THREE.Object3D | null; delay: number }> = [];

    items.forEach(({ bar, position }, i) => {
      const height = Math.max(maxHeight * 0.02, (maxHeight * bar.value) / maxValue);
      const material = new THREE.ShaderMaterial({
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        transparent: true,
        uniforms: { uColor: { value: new THREE.Color(bar.color ?? data.color ?? ctx.theme.accent) }, uOpacity: { value: 0.95 } },
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.copy(ctx.position(position));
      alignToUp(mesh, ctx.up(position));
      mesh.scale.z = 1e-4;
      mesh.renderOrder = 5;
      group.add(mesh);
      let label: THREE.Object3D | null = null;
      if (data.showValue ?? true) {
        const text = bar.label ? `${bar.label} ${format(bar.value, data.unit)}` : format(bar.value, data.unit);
        label = ctx.label(text, { fontSize: "14px", color: ctx.theme.labelValue, transform: "translateY(-12px)" });
        label.position.set(0, 0, 1);
        label.visible = false;
        mesh.add(label);
      }
      columns.push({ mesh, height, label, delay: i * 0.04 });
    });

    let born = -1;
    return {
      tick(t) {
        if (born < 0) born = t;
        for (const c of columns) {
          const k = Math.min(1, Math.max(0, (t - born - c.delay) / 0.9));
          const eased = 1 - (1 - k) ** 3;
          c.mesh.scale.z = Math.max(1e-4, c.height * eased);
          // 标签在单位高度柱体的顶端;scale.z 会拉伸子对象,所以标签放在 z=1
          if (c.label) c.label.visible = k > 0.6;
        }
      },
      setOpacity(k) {
        scaleOpacity(group, k);
      },
      dispose() {
        geometry.dispose();
        disposeTree(group);
      },
    };
  },
});
