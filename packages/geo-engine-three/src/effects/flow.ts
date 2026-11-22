import * as THREE from "three";
import { angularDistance, greatCircle, type Position } from "@yaoyu/geo-engine";
import { LOGDEPTH, alignToUp, defineOverlay, disposeTree, scaleOpacity, type OverlayContext } from "../overlay";

export interface FlowDatum {
  from: Position;
  to: Position;
  /** 数值:决定线宽(按本图层最大值归一)。 */
  value?: number;
  color?: string;
}

/** type: "flow" —— OD 飞线(原料调度、物流、客源),彗星拖尾沿弧线流动。 */
export interface FlowLayerData {
  flows: FlowDatum[];
  color?: string;
  /** 每秒流动圈数,默认 0.45。 */
  speed?: number;
  /** 弧高(相对两端距离),默认 0.28。 */
  arcHeight?: number;
  /** 线宽系数,默认 1。 */
  width?: number;
  /** 拖尾长度(占全程比例),默认 0.28。 */
  trail?: number;
  /** 终点涟漪,默认 true。 */
  endpoints?: boolean;
}

const VERTEX = /* glsl */ `
${LOGDEPTH.vertexPars}
varying float vT;
void main() {
  vT = uv.x;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  ${LOGDEPTH.vertex}
}`;

const FRAGMENT = /* glsl */ `
${LOGDEPTH.fragmentPars}
uniform vec3 uColor;
uniform float uTime;
uniform float uSpeed;
uniform float uPhase;
uniform float uTrail;
uniform float uOpacity;
varying float vT;
void main() {
  ${LOGDEPTH.fragment}
  float head = fract(uTime * uSpeed + uPhase);
  float d = head - vT;
  if (d < 0.0) d += 1.0;
  float comet = 1.0 - smoothstep(0.0, uTrail, d);
  float glow = comet * comet;
  vec3 color = mix(uColor, vec3(1.0), glow * 0.55);
  gl_FragColor = vec4(color, uOpacity * (0.16 + 0.84 * glow));
  #include <colorspace_fragment>
}`;

/** 弧线采样点:平面为抬高的二次曲线,地球为抬离球面的大圆弧。 */
export function flowArc(ctx: OverlayContext, from: Position, to: Position, arcHeight: number, samples = 64): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  if (ctx.mode === "globe") {
    const height = angularDistance(from, to) * ctx.scale * arcHeight;
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      points.push(ctx.position(greatCircle(from, to, t), Math.sin(Math.PI * t) * height));
    }
    return points;
  }
  const a = ctx.position(from);
  const b = ctx.position(to);
  const lift = a.distanceTo(b) * arcHeight;
  const control = a.clone().lerp(b, 0.5).add(ctx.up(from).multiplyScalar(lift));
  const curve = new THREE.QuadraticBezierCurve3(a, control, b);
  for (let i = 0; i <= samples; i++) points.push(curve.getPoint(i / samples));
  return points;
}

export const flowLayer = defineOverlay<FlowLayerData>({
  type: "flow",
  modes: ["plane", "globe"],
  create(ctx, spec) {
    const data = spec.data ?? { flows: [] };
    const group = new THREE.Group();
    ctx.group.add(group);
    const maxValue = Math.max(1e-9, ...data.flows.map((f) => f.value ?? 1));
    const materials: THREE.ShaderMaterial[] = [];
    const rings: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>[] = [];
    const baseRadius = ctx.scale * 0.0042 * (data.width ?? 1);

    data.flows.forEach((flow, i) => {
      if (ctx.mode === "plane" && !(ctx.contains(flow.from) || ctx.contains(flow.to))) return;
      const color = new THREE.Color(flow.color ?? data.color ?? ctx.theme.highlight);
      const points = flowArc(ctx, flow.from, flow.to, data.arcHeight ?? 0.28);
      const curve = new THREE.CatmullRomCurve3(points);
      const radius = baseRadius * (0.6 + Math.sqrt((flow.value ?? 1) / maxValue));
      const material = new THREE.ShaderMaterial({
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uColor: { value: color },
          uTime: { value: 0 },
          uSpeed: { value: data.speed ?? 0.45 },
          uPhase: { value: (i * 0.37) % 1 },
          uTrail: { value: data.trail ?? 0.28 },
          uOpacity: { value: 1 },
        },
      });
      materials.push(material);
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 96, radius, 6, false), material);
      tube.renderOrder = 6;
      group.add(tube);

      if (data.endpoints ?? true) {
        const start = new THREE.Mesh(
          new THREE.SphereGeometry(radius * 1.8, 12, 8),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }),
        );
        start.position.copy(points[0]);
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(radius * 3, radius * 4.2, 40),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }),
        );
        ring.position.copy(points[points.length - 1]);
        alignToUp(ring, ctx.up(flow.to));
        ring.userData.phase = (i * 0.29) % 1;
        rings.push(ring);
        group.add(start, ring);
      }
    });

    return {
      tick(t) {
        for (const m of materials) m.uniforms.uTime.value = t;
        for (const ring of rings) {
          const k = (t * 0.8 + ring.userData.phase) % 1;
          ring.scale.setScalar(1 + k * 2.2);
          ring.material.userData.baseOpacity ??= 0.8;
          ring.material.opacity = ring.material.userData.baseOpacity * (1 - k);
        }
      },
      setOpacity(k) {
        scaleOpacity(group, k);
        for (const ring of rings) ring.material.userData.baseOpacity = 0.8 * k;
      },
      dispose() {
        disposeTree(group);
      },
    };
  },
});
