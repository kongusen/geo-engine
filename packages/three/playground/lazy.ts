/**
 * 懒加载演示页:pnpm playground 后打开 http://localhost:5199/lazy.html
 *
 * 数据全部按需请求,不打包区域快照:
 * - 地球 → 各国 → 一级行政区:Natural Earth(naturalEarthSource;台湾不作为国家出现)
 * - 中国 → 省 → 市 → 区县:DataV GeoAtlas,挂载到 CHN 下,并以 DataV 的国界替换 Natural Earth 的中国轮廓(adopt)
 * - 西湖区以下的示例地块:程序生成的自有数据(非真实边界),通过 mount 挂到 DataV 的 330106 下,编码加 "plot:" 前缀
 * 地址栏 ?region=<id> 可直接打开任意层级(ensurePath 并行拉取祖先链),下钻时地址同步更新。
 * 底图:?tk=<天地图 key> 使用天地图,否则使用高德(GCJ-02,自动纠偏);面板可切换或关闭。
 */
import { GeoEngine, amapTiles, datavSource, mount, naturalEarthSource, prefixIds, staticSource, tianditu, type LayerSpec, type RegionInput, type TileSource } from "@geodive/core";
import { SceneHost, basemap, type BasemapStyle } from "../src";
import { worldLand } from "./demo-data/world_land_data";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// 抽稀(~500m 容差)减少顶点数。南海细小岛礁不在数据层删除(合规),由渲染层按部件尺寸降低挤出高度。
const datav = datavSource({ simplify: 0.005 });

/** 自有数据示例:西湖区内 3×2 个方形"园区地块"(示意,非真实边界),演示把业务方自己的边界挂到行政区划下。 */
const DEMO_AREA = "330106";
function demoPlots(): RegionInput[] {
  const plots: RegionInput[] = [];
  const [x0, y0, size, gap] = [120.06, 30.235, 0.014, 0.004];
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 3; col++) {
      const x = x0 + col * (size + gap);
      const y = y0 + row * (size + gap);
      const id = `${"AB"[row]}${col + 1}`;
      plots.push({ id, name: `示例地块 ${id}`, level: "plot", parentId: DEMO_AREA, polygons: [[[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]]] });
    }
  }
  return plots;
}
const plots = staticSource(demoPlots(), { id: "plots", attribution: "地块为示例数据" });

// 世界数据按"事实控制"绘制国界:台湾在其中是独立要素(且中文名不符合我国规范),排除;
// 中国的轮廓由 DataV 国界替换(adopt),不使用国际数据集中的中国国界。
const world = naturalEarthSource({ exclude: ["TWN"] });

const engine = new GeoEngine({
  sources: [
    world,
    mount({ at: "CHN", source: datav, root: "100000", adopt: true }),
    mount({ at: DEMO_AREA, source: plots, root: DEMO_AREA, ids: prefixIds("plot:") }),
  ],
  load: { retries: 1, timeoutMs: 20000 },
});

const scene = new SceneHost(
  { container: $("map"), engine, theme: { accent: "#38bdf8", background: "#050b16" }, globe: { land: worldLand, initialView: [104, 30] } },
  { onStatus: (status) => (document.body.dataset.sceneStatus = status) },
);

// ── 图层 ─────────────────────────────────────────────────────────────
const tk = new URL(location.href).searchParams.get("tk");
const providers: Record<string, TileSource[] | null> = {
  ...(tk ? { 天地图矢量: tianditu({ key: tk }), 天地图影像: tianditu({ key: tk, layer: "img" }) } : {}),
  高德矢量: amapTiles(),
  高德影像: amapTiles({ layer: "img" }),
  无底图: null,
};
// 深色大屏:浅色矢量底图反相 + 去色 + 按主色着色;影像只压暗
const STYLES: Record<string, BasemapStyle> = {
  vec: { invert: 1, grayscale: 1, tint: "accent", tintAmount: 0.55, brightness: 0.85 },
  img: { grayscale: 0.6, tint: "accent", tintAmount: 0.35, brightness: 0.55 },
};
let provider = Object.keys(providers)[0];
let dash: LayerSpec | null = null;
const applyLayers = () => {
  const sources = providers[provider];
  const style = provider.includes("影像") ? STYLES.img : STYLES.vec;
  engine.setLayers([
    ...(sources ? [basemap(sources, { style })] : []),
    { id: "labels", type: "label", data: { showValue: false } },
    ...(dash ? [dash] : []),
  ]);
};
applyLayers();
// 南海九段线:DataV 全国文件中的装饰要素,与省级数据共用一次请求
void datav.decorations().then((lines) => {
  dash = { id: "dash", type: "line", visible: { when: ({ drill }) => drill.focusId === "CHN" }, data: { lines } };
  applyLayers();
});
for (const name of Object.keys(providers)) {
  const b = document.createElement("button");
  b.textContent = name;
  b.onclick = () => {
    provider = name;
    applyLayers();
  };
  $("basemaps").append(b);
}

// ── 状态显示 ──────────────────────────────────────────────────────────
const status = $("status");
const show = (text: string, kind: "info" | "error" = "info") => {
  status.textContent = text;
  status.dataset.kind = kind;
};

engine.on("loading", ({ targetId, loading, phase }) => {
  if (loading) show(phase === "path" ? `正在定位 ${targetId}…` : `正在加载 ${engine.tree.get(targetId ?? "")?.name ?? targetId} 的下级…`);
  else show("");
});
engine.drill.events.on("blocked", ({ targetId, reason, error }) => {
  if (reason === "unknown") show(`找不到区域 ${targetId}`, "error");
  else if (reason === "error") show(`加载失败:${(error as Error)?.message ?? error}`, "error");
});
let issueCount = 0;
engine.on("issues", (issues) => {
  issueCount += issues.filter((i) => i.severity !== "info").length;
  $("issues").textContent = issueCount ? `${issueCount} 条数据告警(见控制台)` : "";
  for (const issue of issues) if (issue.severity !== "info") console.warn(`[${issue.code}]`, issue.message);
});
engine.on("frame", (frame) => {
  $("crumbs").textContent = ["地球", ...frame.drill.path.map((r) => r.name)].join(" › ");
  const focus = frame.focus;
  $("focus").textContent = focus ? `${focus.name}  id=${focus.id}${focus.source ? `  源=${focus.source.id}:${focus.source.localId}` : ""}` : "";
});

// ── 地址同步 ──────────────────────────────────────────────────────────
engine.on("drill", () => {
  const url = new URL(location.href);
  const id = engine.drill.serialize();
  if (id) url.searchParams.set("region", id);
  else url.searchParams.delete("region");
  history.replaceState(null, "", url);
});

// ── 跳转 ─────────────────────────────────────────────────────────────
const jumps: Array<[string, string | null]> = [
  ["地球", null],
  ["中国", "CHN"],
  ["美国", "USA"],
  ["美国 · 加利福尼亚(深链接)", "US-CA"],
  ["俄罗斯", "RUS"],
  ["浙江 · 杭州市", "330100"],
  ["西湖区(下挂自有数据)", "330106"],
  ["示例地块 A1(跨三个数据集深链接)", "plot:A1"],
  ["北京 · 东城区(无市辖区级)", "110101"],
  ["湖北 · 仙桃(省直辖)", "429004"],
];
for (const [name, id] of jumps) {
  const b = document.createElement("button");
  b.textContent = name;
  b.onclick = () => void engine.drill.drillTo(id);
  $("jumps").append(b);
}
$<HTMLFormElement>("goto").onsubmit = (event) => {
  event.preventDefault();
  const id = $<HTMLInputElement>("goto-id").value.trim();
  if (id) void engine.drill.drillTo(id);
};

void engine
  .start()
  .then(() => {
    const region = new URL(location.href).searchParams.get("region");
    return region ? engine.drill.restore(region) : undefined;
  })
  .then(() => Object.assign(window, { ready: true }))
  .catch((error) => show(`启动失败:${(error as Error).message}`, "error"));

Object.assign(window, { engine, scene, datav });
