# @yaoyu/geo-engine

与渲染无关的 GIS 引擎核心。负责把任意闭合多边形数据变成一棵可以一直下钻的区域树，然后输出“帧”给渲染器（three.js、SVG 或 MapLibre）。本包零运行时依赖。

## 能力

| 模块 | 作用 |
|---|---|
| `ingest` | 支持 GeoJSON / TopoJSON / Feature[]。依次识别并转换坐标系（WGS84 / GCJ-02 / EPSG:3857 / 控制点仿射），然后闭合环、统一绕向、展开跨 180° 经线的区域、抽稀，并输出问题报告 |
| `RegionTree` | 树深度不限，叶子节点就是最小级。数据有父级编码时按编码建树，没有时按**空间包含关系推断**。支持名称和别名解析、路径（面包屑）、点定位 |
| `DrillController` | 下钻状态机，提供 down / up / jump / reset。支持根节点范围、最大深度、守卫、懒加载子级。并发下钻时只有最后一次生效 |
| `bindData` / `classify` | 按编码、名称或别名把业务数据关联到区域。分级方式有线性、等距、分位数、自然断点，可生成色阶和图例 |
| `projection` | 球面坐标、方位等距切平面（RTC 局部坐标）、球面与平面之间的变形插值、大圆插值、场景选择、相机距离 |
| `layers` | 声明式图层规格，可按深度、层级标签或场景控制显隐，下钻时给出 enter / exit / update 差量 |
| `clusterPoints` / `densityGrid` | 点位网格聚合、高斯核密度网格（聚合和热力效果的计算部分） |
| `autoTour` | 自动巡游插件：按站点序列下钻，有人操作时暂停，空闲后从下一站继续 |
| `GeoEngine` | 把上面各部分组合起来，提供数据源懒加载、插件机制（`use` / `unuse`）、`activate`（能下钻就下钻，叶子节点则选中），并把帧推送给 `SceneAdapter` |

## 用法

```ts
const engine = new GeoEngine({
  sources: [{ id: "regions", load: (parentId) => fetch(`/geo/${parentId ?? "world"}.topo.json`).then((r) => r.json()).then((input) => ({ input })) }],
  layers: [
    { id: "globe", type: "choropleth", visible: { scenes: ["globe"] } },
    { id: "plates", type: "choropleth", visible: { scenes: ["plane"] }, style: { extrude: true } },
    { id: "labels", type: "label" },
  ],
});
engine.attach(threeSceneAdapter);   // 渲染器只需实现 update(frame)
await engine.start();
await engine.activate("CN");        // 地球 → 中国:frame.view.scene 依区域大小在 globe / plane 间切换
```

一步跨级下钻（点击重定向）：`redirectActivate` 返回另一个区域 id 时，点击直接跳到该区域，中间层级只在面包屑里出现，渲染器把整段当成一次连续转场。目标必须已经在区域树中（懒加载的数据源需要先加载好祖先链）。

```ts
new GeoEngine({
  redirectActivate: (region, state) => (state.focusId === null && region.id === "CHN" ? "522633" : null),
});
```

接入用户自己的数据（例如 SVG 描出的本地坐标边界）：

```ts
const { affine } = fitAffine(controlPoints);           // ≥3 个控制点
engine.addRegions(json, { crs: { affine }, parentId: "522633", level: "township" });
```

自动巡游：

```ts
const tour = autoTour({ stops: ["CHN", "520000", "522633", null], dwellMs: 8000, resumeAfterMs: 30000 });
engine.use(tour); // tour.start() / tour.pause() / tour.stop()
```

数据加载失败：数据源出错或超时（默认 15 秒）时，引擎按 `load` 策略重试，默认重试 2 次，间隔 600ms 并逐次翻倍。仍然失败时发出 `error` 事件，下钻返回 `false`，当前层级不变，不会抛出异常。失败结果不会缓存，用户再次点击时会重新加载。

```ts
const engine = new GeoEngine({ load: { retries: 2, retryDelayMs: 600, timeoutMs: 15000 } });
engine.on("error", ({ targetId, error }) => showToast(`${targetId} 加载失败`));
engine.on("loading", ({ loading }) => setSpinner(loading));
```

