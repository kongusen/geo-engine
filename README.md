# geo-engine

可插拔的 GIS 地图引擎。它把任意闭合多边形数据组织成一棵可以一直下钻的区域树，从地球到国家、省、县、乡镇、地块都可以，并用 three.js 渲染成"地球 ↔ 立体板块"的大屏场景。

引擎只提供机制，不包含业务数据。用哪份边界、哪家底图、显示什么审图号，都由接入方决定。

当前版本 **v0.1.0**。

## 分层

```
┌──────────── 渲染层 @yaoyu/geo-engine-three ────────────┐
│ GeoScene / SceneHost · 地球与平面转场 · 板块 · 标签      │
│ 内置图层(填色 / 点位 / 飞线 / 柱 / 热力 / 涟漪 / 聚合    │
│ / 瓦片底图)· 叠加图层插件 · 主题                        │
└──────────────▲─────────────────────────────────────────┘
               │ EngineFrame(每次状态变化推送一帧)
┌──────────────┴─────── 引擎层 @yaoyu/geo-engine ─────────┐
│ GeoEngine · 区域树 · 下钻状态机 · 深链接定位 ensurePath  │
│ 图层规格与显隐 · 数据绑定与分级 · 插件 · 投影计算        │
└──────────────▲─────────────────────────────────────────┘
               │ RegionSource / TileSource
┌──────────────┴─────── 数据层 @yaoyu/geo-data ───────────┐
│ 数据源接口 · 多数据集挂载与编码映射 · 重试 / 超时        │
│ GeoJSON / TopoJSON 导入 · 坐标系转换 · 几何工具          │
│ 内置数据源:static / http / DataV / Natural Earth        │
│ 瓦片描述:天地图 / 高德 / 任意 XYZ                       │
└─────────────────────────────────────────────────────────┘
```

| 包 | 依赖 | 文档 |
|---|---|---|
| `@yaoyu/geo-data` | 无 | [数据层](packages/geo-data/README.md)：区域数据从哪来、怎么拼接、底图瓦片在哪 |
| `@yaoyu/geo-engine` | geo-data | [引擎层](packages/geo-engine/README.md)：下钻、图层、数据绑定、事件；同时转出 geo-data 的全部导出 |
| `@yaoyu/geo-engine-three` | geo-engine，peer `three >= 0.170` | [渲染层](packages/geo-engine-three/README.md)：three.js 场景 |

依赖只向下。只用引擎层的话，可以自己写渲染器，比如 SVG 或 MapLibre：实现 `SceneAdapter.update(frame)` 即可。

## 完整接入示例

下面的例子从地球下钻到国家，再到一级行政区；中国以下用国内行政区划，一直到区县；某个县下面再挂上业务方自己的乡镇数据；地图下方铺一层天地图底图。

```ts
import {
  GeoEngine, naturalEarthSource, datavSource, staticSource, mount, prefixIds, tianditu,
} from "@yaoyu/geo-engine";                       // geo-data 的导出也从这里取
import { SceneHost, basemap } from "@yaoyu/geo-engine-three";

// 1. 数据层:把几个数据集拼成一棵树
const engine = new GeoEngine({
  sources: [
    naturalEarthSource({ exclude: ["TWN"] }),                                   // 顶层:各国
    mount({ at: "CHN", source: datavSource(), root: "100000", adopt: true }),   // 中国以下用 DataV,国界也用 DataV 的
    mount({ at: "522633", source: staticSource(myTownships), root: "522633", ids: prefixIds("cj:") }), // 自有乡镇数据
  ],
  load: { retries: 2, timeoutMs: 15000 },
});

// 2. 引擎层:声明图层
engine.setLayers([
  basemap(tianditu({ key: TIANDITU_KEY, attribution: "© 天地图 GS(XXXX)XXXX号" }), { style: { invert: 1, grayscale: 1, tint: "accent" } }),
  { id: "values", type: "choropleth", data: { values: { "520000": 120, "530000": 80 }, unit: "家" } },
  { id: "labels", type: "label", data: { showValue: true } },
]);

// 3. 渲染层:挂到 DOM
const host = new SceneHost(
  { container: document.getElementById("map")!, engine, theme: { accent: "#22d3ee" }, globe: { land: worldLandRings } },
  { onStatus: (s) => console.log("scene", s) },
);

// 4. 启动,并按地址栏恢复层级(不在树中的区域会自动加载祖先链)
await engine.start();
await engine.drill.restore(new URL(location.href).searchParams.get("region"));
engine.on("drill", () => history.replaceState(null, "", `?region=${engine.drill.serialize()}`));
engine.on("select", ({ region }) => openDetailPanel(region));
```

各层的完整用法见对应包的 README。

## 在其他项目中使用

目前不发布到 npm，而是打成 `.tgz` 放进使用方的仓库。这样使用方的 CI 和 Docker 构建都不需要访问本仓库。

```bash
pnpm pack:to ../your-project/vendor/geo   # 会先跑类型检查和测试,输出三个 .tgz
```

```jsonc
// 使用方 package.json(pnpm)
{
  "dependencies": {
    "@yaoyu/geo-data": "file:vendor/geo/yaoyu-geo-data-0.1.0.tgz",
    "@yaoyu/geo-engine": "file:vendor/geo/yaoyu-geo-engine-0.1.0.tgz",
    "@yaoyu/geo-engine-three": "file:vendor/geo/yaoyu-geo-engine-three-0.1.0.tgz",
    "three": "0.187.0"
  },
  // 包之间的依赖在 npm 上不存在,需要用 overrides 指向本地包
  "pnpm": {
    "overrides": {
      "@yaoyu/geo-data": "file:vendor/geo/yaoyu-geo-data-0.1.0.tgz",
      "@yaoyu/geo-engine": "file:vendor/geo/yaoyu-geo-engine-0.1.0.tgz"
    }
  }
}
```

- npm 和 yarn 也有对应写法，分别是 `overrides` 和 `resolutions`。
- 包已经构建成普通的 ESM JS，并带类型声明，使用方不需要配置 `transpilePackages`。
- 只用引擎层的话，不需要装 `three` 和 `@yaoyu/geo-engine-three`。

## 开发

```bash
pnpm install
pnpm test            # 三个包的单元测试
pnpm typecheck
pnpm playground      # http://localhost:5199(离线演示)、/lazy.html(按需加载演示,?tk=<天地图 key>)
pnpm visual-check    # 画面回归:关键转场逐帧检查黑屏 / 白屏 / 空画面,约 1 分钟
pnpm soak --minutes 600 --lose-every 20   # 长时间运行巡检(资源是否持续增长)
```

- 仓库内的包之间直接引用 TS 源码，开发时不需要先构建。打包时 `publishConfig` 会把入口切换到 `dist`（esbuild 打出 ESM，tsc 生成类型声明）。
- `fixtures/` 存放测试和演示页共用的样例数据；`packages/geo-engine-three/playground/` 是开发用的演示页。两者都不会打进发布包。

## 发版约定

- 三个包始终保持同一版本号，发版时一起改 `packages/*/package.json`。
- 同名同版本的包内容一旦变了，使用方 lockfile 里的校验值就对不上，用 `--frozen-lockfile` 安装会失败。所以每次交付都要升版本号。
- 改了场景或着色器，打包前先跑 `pnpm visual-check`。
