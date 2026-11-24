# @geodive/three（渲染层）

`@geodive/core` 的 three.js 渲染器，提供风格化的大屏地理场景：

- 顶层和大区域显示为**可旋转、可点击的地球**；
- 国家及以下显示为 **3D 挤出板块**；
- 两者之间有连续的变形转场。

依赖：`@geodive/core`，以及 peer 依赖 `three >= 0.170`。

- [最小接入](#最小接入)
- [场景选项 GeoSceneOptions](#场景选项-geosceneoptions)
- [大屏部署：SceneHost](#大屏部署scenehost)
- [场景方法](#场景方法)
- [内置图层](#内置图层)
- [瓦片底图 basemap](#瓦片底图-basemap)
- [主题](#主题)
- [交互](#交互)
- [自定义叠加图层插件](#自定义叠加图层插件)
- [巡检与自动化检查](#巡检与自动化检查)

## 最小接入

```ts
import { GeoEngine } from "@geodive/core";
import { SceneHost } from "@geodive/three";

const engine = new GeoEngine({ sources: [...], layers: [{ id: "labels", type: "label" }] });
const host = new SceneHost({
  container: document.getElementById("map")!,   // 场景会铺满容器;容器需要有确定的宽高
  engine,                                        // 构造时自动 engine.attach,点击 / 悬停自动回传引擎
  theme: { accent: "#22d3ee" },
  globe: { land: worldLandRings },               // 不传 globe 时所有层级按平面处理
});
await engine.start();
```

`globe.land` 是只用于装饰的陆地轮廓（`Position[][]`，不可交互），由接入方提供，比如从 Natural Earth 的陆地数据中抽取外环。可点击的国家、区域来自引擎的区域数据，和 `land` 无关。

## 场景选项 GeoSceneOptions

| 选项 | 默认 | 说明 |
|---|---|---|
| `container` / `engine` | 必填 | 挂载容器与引擎 |
| `theme` | 见[主题](#主题) | 颜色与字体，可以只传 `accent`，其他颜色会自动派生 |
| `globe` | 不启用 | `{ land?, autoRotateDegPerSec = 6, initialView = [105, 18], fill = 0.86 }`；传 `false` 或不传时为纯平面场景 |
| `pitchDeg` | 38 | 平面场景相机与竖直方向的夹角，0 为正俯视 |
| `fovDeg` | 30 | 视场角 |
| `padding` | 1.08 | 区域装入视口时的留白系数 |
| `viewportInset` | 无 | 平面视口四周留白 `{ top, right, bottom, left }`（CSS px）。全屏地图四周有 HUD 浮层时，让板块居中在中间的可见窗口里 |
| `bloom` | true | 泛光；背景透明（`theme.background: null`）时自动关闭 |
| `transitionMs` | 1200 | 下钻转场时长；地球 ↔ 平面转场约为它的 1.9 倍 |
| `decor` | true | 底部装饰网格与扫描环 |
| `maxPixelRatio` | 2 | 设备像素比上限，4K 大屏可以调低以保证帧率 |
| `overlays` | — | 额外的叠加图层插件；与内置插件 `type` 相同时会覆盖内置的 |
| `overlayZoomFade` | `[0.45, 0.2]` | 镜头远近于层级默认视距的一定比例时，叠加效果淡出，避免飞线等效果在下钻途中被放大成满屏光斑；`false` 关闭 |
| `emptyClick` | `"none"` | 平面场景单击空白处的行为，`"drill-up"` 表示上卷一级 |
| `onPointClick` / `onPointHover` | — | 内置 `point` 点位的点击 / 悬停回调 |
| `attribution` | — | 角标里的固定文字，会和 `frame.attributions`（数据源与底图的版权）合并显示在右下角 |
| `onContextLost` / `onContextRestored` | — | WebGL 上下文丢失 / 恢复（直接用 `GeoScene` 时需要宿主自行处理；用 `SceneHost` 时它会负责） |

## 大屏部署：SceneHost

**生产环境请用 `SceneHost` 代替直接 `new GeoScene`。** 它接受同样的场景选项，并负责故障恢复：

```ts
const host = new SceneHost(sceneOptions, {
  onStatus: (status, error) => {},   // ready | recovering | failed;failed 时宿主应显示降级视图
  restoreWaitMs: 2000,               // 上下文丢失后,等待浏览器恢复的时间
  retryDelaysMs: [1500, 5000, 15000],// 创建失败时的重试间隔
  failedRetryMs: 60000,              // 进入 failed 后,每隔多久再试一次;0 为不再尝试
});
```

- **上下文丢失**：显卡重置、休眠唤醒等会导致 WebGL 上下文丢失。超过 `restoreWaitMs` 仍未恢复时，SceneHost 会在新画布上重建场景。引擎状态（层级、图层）不受影响。
- **状态保持**：通过 `host` 调用的 `setAccent`、`setLabelsVisible`、`setViewportInset`、`setHighlight`、`registerOverlay`，重建后会自动恢复。
- **其他接口**：`host.scene`（当前场景实例）、`host.state`、`host.rebuild()`、`host.dispose()`。
- **页面不可见时**，场景停止渲染。

## 场景方法

`GeoScene` 和 `SceneHost` 都提供以下方法：

| 方法 | 说明 |
|---|---|
| `setAccent(color)` | 运行时切换主色，派生色会一起更新 |
| `setLabelsVisible(bool)` | 显示或隐藏全部文字标签 |
| `setViewportInset(inset, animate = true)` | 动态调整视口留白 |
| `setHighlight(regionId \| null)` | 从外部反向高亮并抬升指定区域，例如悬停在旁边的排行榜上时 |
| `registerOverlay(plugin)` | 注册叠加图层插件 |
| `stats()` | 运行状态快照：模式、焦点、是否在转场中、fps、几何体 / 纹理 / 着色器数、draw call、三角形数、标签 DOM 数、叠加图层数、上下文是否丢失 |
| `dispose()` | 释放场景 |

## 内置图层

图层由 `engine.setLayers([...])` 声明（详见引擎层 README）：`type` 决定由哪个实现来画，`visible` 控制它在哪些层级、哪种场景下显示。

尺寸参数都按当前层级的"特征长度"换算，所以同一套参数在全国、县、乡镇各级的视觉比例一致。

| type | 场景 | data |
|---|---|---|
| `choropleth` | 平面 | `{ values: Record<regionId, number>, unit?, method?, extrudeByValue = true }`：板块按数值着色、挤出。`method` 缺省时，值不少于 5 个用分位数，否则线性 |
| `label` | 平面 / 地球 | `{ showValue?, format?(value, unit) }`：区域名称与数值，自动避让 |
| `point` | 平面 / 地球 | `{ points: [{ id, name, position, label?, color? }] }`：脉冲点位。平面场景只显示落在当前板块内的点；点击回调用 `onPointClick` |
| `line` | 平面 | `{ lines: Position[][], color?, width? }`：线状装饰，例如 `datavSource().decorations()` 取出的九段线 |
| `flow` | 平面 / 地球 | `{ flows: [{ from, to, value?, color? }], color?, speed?, arcHeight?, width?, trail?, endpoints? }`：OD 飞线，带彗星拖尾 |
| `bar` | 平面 / 地球 | `{ bars: [{ position? \| regionId?, value, label?, color? }], unit?, maxHeight?, width?, color?, showValue?, format? }`：3D 数值柱 |
| `heat` | 平面 | `{ points: [{ position, weight? }], radius?, colors?, opacity?, resolution? }`：核密度热力图 |
| `ripple` | 平面 / 地球 | `{ points: [{ position, color?, size?, label? }], rings?, speed?, color? }`：扩散波纹，用于告警、强调 |
| `cluster` | 平面 | `{ points: [{ id, position, name?, weight? }], cellSize?, color?, showNames? }`：点位聚合，下钻后自然展开 |
| `basemap` | 平面 | 瓦片底图，见下一节 |

**没有 `choropleth` 时的板块样式**：能下钻的板块更高、颜色更亮，提示用户可以点进去；不能下钻的板块较低、颜色较暗。

**数据类型**：类型定义随包导出，分别是 `ChoroplethLayerData`、`LabelLayerData`、`PointLayerData`、`LineLayerData`、`FlowLayerData`、`BarLayerData`、`HeatLayerData`、`RippleLayerData`、`ClusterLayerData`、`BasemapLayerData`。

## 瓦片底图 basemap

在平面场景的板块下方铺一层在线地图瓦片。瓦片来源由数据层的 `TileSource` 描述（`tianditu` / `amapTiles` / `xyzTiles`，或自定义）。

```ts
import { tianditu } from "@geodive/core";
import { basemap } from "@geodive/three";

engine.setLayers([
  basemap(tianditu({ key, attribution: "© 天地图 GS(XXXX)XXXX号" }), {   // 底图 + 注记,自下而上
    style: { invert: 1, grayscale: 1, tint: "accent", tintAmount: 0.55, brightness: 0.85 },  // 深色大屏配浅色矢量底图
    extent: 3,          // 铺设范围:当前层级范围的倍数(再按视野裁剪)
    zoomOffset: 0,      // 正数更清晰、瓦片更多
    maxTiles: 80,       // 每个图层、每一级的瓦片上限,超过时自动降一级
    id: "basemap",
    visible: { scenes: ["plane"] },
  }),
  ...
]);
```

- **选瓦片**：缩放级别按屏幕分辨率自动选择，只加载视野内的瓦片。最底层还会多加载一层粗三级的瓦片垫底，精细瓦片没到之前先显示模糊版本。注记层不会这样垫底，否则放大后会出现巨大的模糊文字。
- **纠偏**：GCJ-02 的瓦片（如高德）逐顶点纠偏到 WGS84，和区域边界对齐。
- **缓存**：纹理在各层级之间共享（LRU 上限 320 张），下钻、上卷不会重复下载。`basemapCacheStats()` 可以查看缓存状态。
- **着色**（`style`）：
  - `opacity`、`invert`、`grayscale`、`tint`（颜色，或 `"accent"` 跟随主色）、`tintAmount`、`brightness`。
  - `maxLuminance`，默认 0.6：亮度上限。它让底图不参与泛光，避免浅色底图整片过曝；关闭了泛光的场景可以设为 1。
- **版权**：`basemap()` 会把各图层的 `attribution` 带到图层规格上，引擎汇总后，场景角标自动显示。
- **显示范围**：底图只在平面场景显示，变形转场期间随层级淡出；镜头拉近时不淡出。

## 主题

```ts
theme: {
  accent: "#22d3ee",        // 主色:色阶高端、侧壁、点位;只传它时,边线和数值颜色自动由它派生
  background: "#07111f",    // null = 透明背景(同时关闭泛光),用于叠在页面背景上
  plateLow: "#0d2b3a",      // 色阶低端
  plateEmpty: "#132236",    // 无数据板块
  side: "#030b16",          // 侧壁底部
  base: "#0b1e33",          // 父级底板
  edge: "...",              // 板块边线(缺省由主色提亮)
  highlight: "#fde68a",     // 悬停 / 聚焦高亮
  point: "#fde68a",
  label: "#eef6ff", labelValue: "...", labelShadow: "rgba(0,6,16,.95)",
  fontFamily: '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
}
```

`createTheme(partial)` 会返回补全派生色后的完整主题，`mixColor(a, b, t)` 用来混合两种颜色。

## 交互

- **悬停**：高亮区域，并回传 `engine.hover`。
- **点击**：调用 `engine.activate`，能下钻就下钻；点击叶子是选中，通过 `engine.on("select")` 获取。
- **返回上一级**：右键；平面场景双击空白处；或设置 `emptyClick: "drill-up"` 后单击空白处。
- **地球模式**：可以拖拽旋转，无人操作时自转。
- **聚焦叶子区域**：通过 `drillTo` / URL 恢复跳到没有下级的区域时，该区域作为主体完整呈现（主色、正常挤出高度）。
- **平面背景**：平面场景下地球作为半透明背景提供海陆参照，视野缩小到区县 / 乡镇尺度时自动淡出（全球尺度的轮廓在这个尺度已失真）。需要街道级参照时叠加 `basemap()` 底图。
- **大区域聚焦**：角半径超过 `globeAboveDegrees` 的区域（如美国、俄罗斯）聚焦后仍停留在地球模式。地球会转到区域中心并按大小拉近，聚焦期间停止自转；回到顶层时恢复整球视距。

## 自定义叠加图层插件

```ts
import * as THREE from "three";
import { defineOverlay, disposeTree } from "@geodive/three";

const myLayer = defineOverlay<{ items: Array<{ position: [number, number] }> }>({
  type: "my-effect",          // 与 LayerSpec.type 对应
  modes: ["plane", "globe"],
  zoomFade: true,             // 是否参与 overlayZoomFade;背景类图层(如底图)设为 false
  create(ctx, spec) {
    const group = new THREE.Group();
    ctx.group.add(group);
    for (const item of spec.data!.items) {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(ctx.unitHeight), new THREE.MeshBasicMaterial({ color: ctx.theme.accent, transparent: true }));
      mesh.position.copy(ctx.position(item.position, ctx.unitHeight));
      group.add(mesh);
    }
    return {
      tick(t, dt) {},                      // 每帧调用
      setOpacity(k) {},                    // 转场淡入淡出、视距淡出;scaleOpacity(group, k) 可以直接用
      update(next) { return false; },      // 同一图层的数据更新;返回 false 时由场景销毁后重建
      dispose() { disposeTree(group); },
    };
  },
});

new GeoScene({ container, engine, overlays: [myLayer] });   // 或 scene.registerOverlay(myLayer)
```

**插件上下文 `ctx`**：

| 字段 | 说明 |
|---|---|
| `mode` / `group` / `theme` | 当前模式、挂载点、主题 |
| `scale` / `unitHeight` | 尺寸基准：平面为层级外形半径，地球为球半径 |
| `position(p, h?)` / `up(p)` | 地表位置（平面落在板块顶面，地球落在球面）及该点向上的方向 |
| `contains(p)` / `region(id)` | 点是否落在当前显示的区域内；按 id 取区域 |
| `planeXY(p)` / `unproject(x, y)` / `bounds` / `baseHeight` / `maxSurface` | 平面坐标的正算与反算、当前层级范围、板块底面和最高顶面（仅平面模式） |
| `camera()` / `resolution()` | 相机与画布尺寸，需要按视野取数据时使用 |
| `label(text, style?)` | 创建一个跟随 3D 位置的文字标签，自动参与避让 |

**生命周期由场景负责**：数据更新时调用 `update` 或重建；下钻转场时调用 `setOpacity`，变形期间隐藏；离开层级时调用 `dispose`。插件不需要关心层级切换。

**工具函数**：`makeLabel`、`alignToUp`、`disposeTree`、`scaleOpacity`。

**自定义 `ShaderMaterial`** 需要加入 `LOGDEPTH` 里的片段：场景开启了对数深度缓冲，以同时兼顾地球尺度和地块尺度的深度精度。

## 巡检与自动化检查

以下命令在仓库根目录执行，依赖开发演示页：

```bash
pnpm playground          # http://localhost:5199 离线演示;/lazy.html 按需加载演示(?tk=<天地图 key>,?region=<id>)
pnpm visual-check        # 画面回归,约 1 分钟
pnpm soak --minutes 600  # 长时间运行巡检,上线前在大屏主机上跑一晚
```

- **visual-check**：依次跑"地球下钻到县""乡镇往返""县回到地球""模拟上下文丢失后重建并再次下钻"这几个场景。检查分两层：截图检查，排除纯色、过曝、空画面；帧缓冲逐帧采样，抓单帧闪黑。不通过时退出码为 1，截图对照页写到 `--out` 指定的目录。
- **soak**：用快速自动巡游反复下钻和上卷，每轮回到地球时采样资源占用，判断几何体、纹理、标签 DOM 数和 JS 堆是否持续增长。`--lose-every N` 表示每 N 轮模拟一次上下文丢失。结果写成 CSV。
- **浏览器**：两个脚本都优先使用本机 Chrome，走真实的 GPU 路径。没有本机 Chrome 时，先运行 `pnpm exec playwright install chromium`。

## 许可

[MIT](LICENSE)
