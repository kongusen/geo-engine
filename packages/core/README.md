# @geodive/core（引擎层）

与渲染无关的引擎核心。它把数据层提供的区域组织成一棵可以无限下钻的树，维护"当前看哪里"这一状态，并在状态变化时向渲染器推送一**帧**（`EngineFrame`）。

- 只依赖 `@geodive/data`，并整体转出它的导出，所以从本包可以拿到数据层的全部能力。
- 同一个引擎可以挂 three.js 大屏场景（`@geodive/three`），也可以挂自己写的 SVG 或 MapLibre 渲染器。

- [核心概念](#核心概念)
- [创建与生命周期](#创建与生命周期)
- [下钻与定位](#下钻与定位)
- [事件](#事件)
- [图层规格](#图层规格)
- [业务数据绑定与分级](#业务数据绑定与分级)
- [插件与自动巡游](#插件与自动巡游)
- [自己写渲染器：EngineFrame 与 SceneAdapter](#自己写渲染器engineframe-与-sceneadapter)
- [区域树 RegionTree](#区域树-regiontree)
- [计算工具](#计算工具)

## 核心概念

| 概念 | 说明 |
|---|---|
| **焦点**（focus） | 当前正在看的区域，`null` 表示顶层（整个地球，或 `rootId` 指定的根）。屏幕上显示的是焦点的子级；焦点是叶子时显示它自身 |
| **路径**（path） | 从顶层到焦点的区域序列，用于面包屑和 URL 恢复 |
| **场景**（scene） | 区域角半径超过 `globeAboveDegrees`（默认 40°）时用 `globe`，否则用 `plane`（立体板块）。顶层总是 `globe` |
| **叶子** | 没有下级的区域，或属于 `leafLevels` 的区域。点击叶子是**选中**，点击非叶子是**下钻** |
| **帧**（frame） | 引擎状态的完整快照，渲染器只根据帧来绘制 |

## 创建与生命周期

```ts
const engine = new GeoEngine({
  sources: [...],            // 数据源与挂载项(见数据层 README);旧版 { id, load(parentId) } 也支持
  layers: [...],             // 图层规格,也可以之后用 setLayers 设置
  rootId: null,              // 顶层区域,如只做某省的大屏可设为 "520000";不在树中时启动时会自动定位
  maxDepth: undefined,       // 相对 rootId 的最大下钻深度
  leafLevels: ["province"],  // 视图叶子层级:这些 level 当作叶子(同一棵树服务多种视图),运行时用 setLeafLevels 切换
  allowLeafFocus: false,     // 叶子也可以作为焦点(例如乡镇 → 乡镇内点位视图)
  redirectActivate: (region, state) => null,  // 点击重定向,见下文
  thresholds: { globeAboveDegrees: 40 },
  treeOptions: { inferParents: true, containment: 0.9 },  // 缺少父级时按空间包含关系推断
  load: { retries: 2, retryDelayMs: 600, timeoutMs: 15000 },
  plugins: [],
});

engine.attach(adapter);        // 挂渲染器;GeoScene 会在构造时自动 attach
await engine.start();          // 加载顶层(或 rootId 的子级),输出首帧;失败时抛出并发出 error 事件
// ...
engine.dispose();              // 释放插件、渲染器与进行中的请求
```

- **直接加数据**：`engine.addRegions(input, options)` 可以直接加入数据，任意 GeoJSON、TopoJSON 或 `RegionInput[]` 都行，返回问题列表。适合数据已经在手里、不需要懒加载的场景。`options` 同时接受 ingest 选项和区域树选项。
- **数据源出错**：重试之后仍失败，会发出 `error` 事件，下钻返回 `false`，层级保持不变，不会抛出异常。失败结果不缓存，用户再次进入时会重新请求。

## 下钻与定位

| 方法 | 用途 |
|---|---|
| `engine.activate(id)` | **点击语义**（渲染器的点击就调用它）：先看是否命中 `redirectActivate`；否则能下钻就下钻，叶子则切换选中状态 |
| `engine.drill.drillTo(id \| null)` | 跳到任意区域（任意深度），`null` 回到顶层 |
| `engine.drill.drillDown(id)` / `drillUp()` / `reset()` | 下钻、上卷一级、回到顶层 |
| `engine.drill.serialize()` / `restore(str)` | 当前焦点序列化成字符串，或从字符串恢复（用于 URL `?region=`） |
| `engine.drill.state` | `{ focusId, path, depth }` |
| `engine.drill.canDrillInto(id)` | 检查是否在根范围内、是否超过最大深度 |
| `engine.ensurePath(id)` | 确保区域及其祖先链都已加载，返回路径 |
| `engine.hover(id \| null)` / `engine.selection` | 悬停与选中状态 |
| `engine.isLeaf(id)` / `setLeafLevels(levels)` | 叶子判定与视图叶子层级 |

**深链接定位**：目标区域还没加载时，`drillTo` / `restore` / 重定向 / `rootId` 会自动调用 `ensurePath`。它的做法是：
1. 向数据源要祖先链；
2. 各级子级**并行请求**，再**自上而下依次写入**区域树；
3. 跳过数据中不存在的中间级。

无法定位时，发出 `blocked`（`reason: "unknown"`），不抛出异常。

**并发**：并发下钻时只有最后一次生效。被取代的请求，结果仍会写入区域树（相当于预热缓存），但不会触发跳转。

**守卫**：

```ts
engine.drill.addGuard(async ({ target, from, direction }) => target?.properties.open !== false);  // 返回 false 阻止
engine.drill.events.on("blocked", ({ targetId, reason }) => {
  /* reason:guard | max-depth | leaf | out-of-root | unknown | error */
});
```

**一步跨级下钻**：`redirectActivate` 返回另一个区域 id 时，点击会直接跳到那个区域，中间层级只出现在面包屑里，渲染器把整段当成一次连续转场。

```ts
redirectActivate: (region, state) => (state.focusId === null && region.id === "CHN" ? "330106" : null)
```

## 事件

```ts
const off = engine.on("drill", ({ from, to, direction }) => {});  // 返回取消订阅函数
```

| 事件 | 负载 | 时机 |
|---|---|---|
| `frame` | `EngineFrame` | 每次状态变化（下钻、图层变化、叶子层级变化） |
| `drill` | `{ from, to, direction }` | 焦点变化。`direction` 取值 `down` / `up` / `jump` / `reset` |
| `loading` | `{ targetId, loading, phase }` | `phase: "path"` 表示正在定位祖先链，`"children"` 表示正在加载子级。**loading 先结束，再报告结果** |
| `hover` | `{ region }` | 悬停变化 |
| `select` | `{ region }` | 叶子选中或取消选中 |
| `issues` | `GeoIssue[]` | 数据导入或建树发现问题（见数据层的问题码） |
| `error` | `{ targetId, error }` | 数据加载重试后仍失败 |

被阻止的下钻在 `engine.drill.events` 上发出 `blocked` 事件。

## 图层规格

图层是**声明式**的：引擎只负责判断图层在当前状态下是否可见，并计算差量；怎么画由渲染器根据 `type` 决定。

```ts
engine.setLayers([
  {
    id: "sales",                  // 唯一 id;相同 id 在下钻前后视为同一图层(只更新,不重建)
    type: "choropleth",           // 由渲染器解释,渲染层 README 列出了内置类型
    data: { values: { "520000": 120 } },
    style: {},
    visible: {                    // 所有条件同时满足才可见;不配置即始终可见
      minDepth: 1, maxDepth: 3,   // 相对 rootId 的深度
      levels: ["province", "county"],   // 焦点区域的 level;顶层为 "root"
      scenes: ["plane"],          // globe | plane
      when: ({ drill, scene }) => drill.focusId !== "CHN",   // 自定义条件
    },
    attribution: "数据来源:某某局",     // 图层可见时进入 frame.attributions(如底图服务商)
  },
]);
```

辅助函数：`isLayerVisible`、`activeLayers`、`diffLayers`（返回 enter / exit / update）、`levelOf(drill)`。

## 业务数据绑定与分级

```ts
// 按编码、名称或别名把业务行关联到区域;同一区域有多行时数值累加
const { values, unmatched } = bindData(engine.tree, rows, {
  key: (row) => row.streetName,      // 编码、名称、别名都可以(名称忽略空白和大小写)
  value: (row) => row.count,
  withinId: "330106",              // 只在该区域的后代中匹配(解决不同区县下的同名街道 / 乡镇)
});
// unmatched 是没匹配上的行,可以用来做数据质量报告

const cls = classify([...values.values()].map((v) => v.value), "quantile", 5);  // linear | equal | quantile | jenks
cls.position(42);      // 0..1,用于取色
cls.classOf(42);       // 第几级(linear 返回 -1)
const legend = legendFor(cls, ["#0d2b3a", "#22d3ee"]);   // [{ color, from, to }]
interpolateColors(["#000", "#fff"], 0.5);
```

渲染层的 `choropleth` 图层内部也用 `classify`，一般直接把 `{ regionId: value }` 交给它就行。

## 插件与自动巡游

```ts
const myPlugin: GeoPlugin = {
  name: "audit",
  install({ engine, on, addGuard, addSource, setLayers }) {
    on("drill", ({ to }) => report(to.focusId));     // 通过 ctx 注册的监听、守卫、数据源,卸载时自动清理
    return () => {};                                  // 额外的清理
  },
};
engine.use(myPlugin);
engine.unuse("audit");
```

**自动巡游**（大屏无人值守）：按站点依次下钻；有人操作（悬停、选中、手动下钻）时让位，空闲一段时间后从下一站继续。

```ts
const tour = autoTour({ stops: ["CHN", "330000", "330106", null], dwellMs: 8000, resumeAfterMs: 30000, autoStart: true, loop: true });
engine.use(tour);
tour.start(); tour.pause(); tour.stop(); tour.running; tour.index;
```

## 自己写渲染器：EngineFrame 与 SceneAdapter

```ts
interface SceneAdapter {
  update(frame: EngineFrame): void | Promise<void>;   // 每次状态变化调用,过渡动画由渲染器负责
  dispose?(): void;
}

interface EngineFrame {
  drill: { focusId, path, depth };
  direction: "down" | "up" | "jump" | "reset" | "init";
  regions: Region[];            // 要画的区域:焦点的子级;焦点是叶子时为焦点自身
  focus: Region | null;         // 焦点区域(外轮廓 / 底板),顶层时为 null
  view: { scene: "globe" | "plane"; center: Position; angularRadius: number };  // 区域中心落在区域外时(含飞地的国家)会改用质心
  anchor: { id, center } | null;  // 平面场景的切平面锚点:同一锚点下各级共用一个切平面,转场连续
  layers: LayerSpec[];          // 当前可见的图层
  layerDiff: { enter, exit, update };
  attributions: string[];       // 当前路径、显示区域和可见图层涉及的数据版权 / 审图号(已去重),渲染器应在画面上展示
}
```

渲染器负责把用户交互转回给引擎：
- 点击区域调用 `engine.activate(id)`；
- 悬停调用 `engine.hover(id)`；
- 返回上一级调用 `engine.drill.drillUp()`。

## 区域树 RegionTree

`engine.tree` 提供以下能力：

- **查询**：`get` / `has` / `all` / `roots` / `children` / `parent` / `path` / `depth` / `descendants` / `isAncestor`。
- **叶子与懒加载状态**：`isLeaf` / `hasLoadedChildren` / `markLeaf`。
- **解析与定位**：
  - `resolve(key, withinId?)`：按编码、名称、别名解析区域；
  - `locate(point, fromId?)`：点定位，返回包含该点的最深区域。
- **增删**：`add(inputs, { inferParents, containment })` / `remove(id)`。
- **父级推断**：区域没有父级编码时，按空间包含关系推断（子区域内部采样点落入候选父区域的比例 ≥ `containment`，取面积最小的候选）。推断结果以 `parent-inferred` 报告。

## 计算工具

| 模块 | 函数 |
|---|---|
| 投影 | `lngLatToSphere` / `sphereToLngLat`、`angularDistance`、`distanceMeters`、`greatCircle`、`tangentFrame`、`createLocalProjection`（方位等距切平面）、`morph`（球面 ↔ 平面插值）、`bboxView` / `viewFor` / `viewForRegion`、`cameraDistance`、`easeInOutCubic`、`EARTH_RADIUS_M` |
| 聚合 | `clusterPoints(points, cellSize, project?)`：网格聚合 |
| 热力 | `densityGrid(points, bounds, cols, rows, radius)`：高斯核密度网格 |
| 事件 | `Emitter` |
