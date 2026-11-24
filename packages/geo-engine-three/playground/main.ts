/**
 * 开发用演示页:pnpm --filter @yaoyu/geo-engine-three playground
 * 区域数据为 demo-data/ 下的快照(取自 yaoyu-data),示例数据为随机生成,不代表真实业务。
 */
import { autoTour, pointInMultiPolygon, type LayerSpec, type Position } from "@yaoyu/geo-engine";
import { SceneHost } from "../src";
import { CHINA_ID, CONGJIANG_SEAT, GUIZHOU_ID, WORLD_LAND, chinaNineDashLines, createOverviewEngine } from "./demo-data/world-regions";

const engine = createOverviewEngine();
const container = document.getElementById("map")!;
// 与大屏一致:SceneHost 负责 WebGL 上下文丢失后的重建
const scene = new SceneHost(
  {
    container,
    engine,
    theme: { accent: "#10b981", background: "#050b16" },
    globe: { land: WORLD_LAND, initialView: [96, 20] },
    attribution: "演示数据 · 非真实业务",
    onPointClick: (point) => {
      const status = document.getElementById("point-status");
      if (status) status.textContent = `已点击点位: ${point.name} (${point.id})`;
    },
  },
  { onStatus: (status) => (document.body.dataset.sceneStatus = status) },
);

// ── 示例数据 ──────────────────────────────────────────────────────────
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const cities: Array<[string, Position]> = [
  ["北京", [116.4, 39.9]], ["上海", [121.47, 31.23]], ["广州", [113.26, 23.13]], ["深圳", [114.06, 22.54]],
  ["成都", [104.07, 30.67]], ["杭州", [120.15, 30.28]], ["武汉", [114.3, 30.59]], ["西安", [108.94, 34.34]], ["贵阳", [106.63, 26.65]],
];
const county = engine.tree.get("522633")!;
const randomIn = (n: number, polygons = county.polygons): Position[] => {
  const [x0, y0, x1, y1] = county.bbox;
  const out: Position[] = [];
  while (out.length < n) {
    const p: Position = [x0 + rand() * (x1 - x0), y0 + rand() * (y1 - y0)];
    if (pointInMultiPolygon(p, polygons)) out.push(p);
  }
  return out;
};
// 热力:围绕 3 个中心的聚集分布
const hotspots = ["丙妹镇", "贯洞镇", "加榜乡"].map((id) => engine.tree.get(id)!.anchor);
const heatPoints = hotspots.flatMap((c, i) => Array.from({ length: 160 }, () => ({ position: [c[0] + (rand() - 0.5) * 0.18, c[1] + (rand() - 0.5) * 0.14] as Position, weight: 1 + i })));

const LAYERS: Record<string, LayerSpec> = {
  flow: { id: "flow", type: "flow", visible: { maxDepth: 1 }, data: { flows: cities.map(([, to], i) => ({ from: CONGJIANG_SEAT, to, value: 10 + i * 6 })) } },
  bar: {
    id: "bar",
    type: "bar",
    visible: { levels: ["country"] },
    data: { unit: "家", bars: engine.tree.children(CHINA_ID).filter(() => rand() > 0.35).map((r) => ({ regionId: r.id, value: Math.round(5 + rand() * 120) })) },
  },
  heat: { id: "heat", type: "heat", visible: { levels: ["county"] }, data: { points: heatPoints } },
  ripple: {
    id: "ripple",
    type: "ripple",
    data: { points: [{ position: CONGJIANG_SEAT, label: "从江" }, ...["西山镇", "停洞镇"].map((id) => ({ position: engine.tree.get(id)!.anchor, color: "#f97316", label: "库存预警" }))] },
  },
  cluster: { id: "cluster", type: "cluster", visible: { levels: ["county"] }, data: { points: randomIn(140).map((position, i) => ({ id: `e${i}`, name: `企业${i}`, position })) } },
};
const enabled = new Set(["flow", "bar", "ripple"]);
const base: LayerSpec[] = [
  { id: "labels", type: "label", data: { showValue: false } },
  { id: "seat", type: "point", visible: { maxDepth: 2 }, data: { points: [{ id: "cj", name: "从江", label: "从江 · 瑶浴之乡", position: CONGJIANG_SEAT }] } },
  { id: "dash", type: "line", visible: { levels: ["country"] }, data: { lines: chinaNineDashLines() } },
];
const apply = () => engine.setLayers([...base, ...[...enabled].map((k) => LAYERS[k])]);
apply();

// ── 面板 ─────────────────────────────────────────────────────────────
const stops: Array<[string, string | null]> = [["地球", null], ["中国", CHINA_ID], ["贵州", GUIZHOU_ID], ["从江县", "522633"]];
for (const [name, id] of stops) {
  const b = document.createElement("button");
  b.textContent = name;
  b.onclick = () => void engine.drill.drillTo(id);
  document.getElementById("stops")!.append(b);
}
for (const key of Object.keys(LAYERS)) {
  const l = document.createElement("label");
  const c = document.createElement("input");
  c.type = "checkbox";
  c.checked = enabled.has(key);
  c.onchange = () => {
    if (c.checked) enabled.add(key);
    else enabled.delete(key);
    apply();
  };
  l.append(c, `${key}(${LAYERS[key].type})`);
  document.getElementById("layers")!.append(l);
}
const tour = autoTour({ stops: [CHINA_ID, GUIZHOU_ID, "522633", null], dwellMs: 7000, autoStart: false });
engine.use(tour);
const tourBtn = document.getElementById("tour")!;
tourBtn.onclick = () => {
  if (tour.running) tour.stop();
  else tour.start();
  tourBtn.textContent = tour.running ? "停止巡游" : "开始巡游";
};
for (const color of ["#10b981", "#38bdf8", "#f59e0b", "#a78bfa"]) {
  const b = document.createElement("button");
  b.textContent = color;
  b.style.borderLeft = `6px solid ${color}`;
  b.onclick = () => scene.setAccent(color);
  document.getElementById("accents")!.append(b);
}
const insetToggle = document.getElementById("safe-inset") as HTMLInputElement | null;
if (insetToggle) {
  insetToggle.onchange = () => {
    scene.setViewportInset(insetToggle.checked ? { top: 120, right: 260, bottom: 140, left: 260 } : {});
  };
}
engine.on("drill", ({ to }) => (document.getElementById("crumbs")!.textContent = ["地球", ...to.path.map((r) => r.name)].join(" › ")));

void engine.start().then(() => Object.assign(window, { ready: true }));
Object.assign(window, { engine, scene, enabled, LAYERS, apply, tour });
// 自动化脚本(scripts/visual-check、scripts/soak)用的钩子
Object.assign(window, {
  __geo: {
    engine,
    host: scene,
    /** 当前转场是否结束。 */
    idle: () => scene.stats()?.busy === false,
    startTour(dwellMs: number) {
      tour.stop();
      engine.unuse(tour.name);
      const fast = autoTour({ stops: [CHINA_ID, GUIZHOU_ID, "522633", "丙妹镇", null, "522633", null], dwellMs, resumeAfterMs: dwellMs });
      engine.use(fast);
      return fast;
    },
    loseContext() {
      const canvas = document.querySelector<HTMLCanvasElement>("canvas[data-geo-scene]");
      const gl = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
    },
  },
});
