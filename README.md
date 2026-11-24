# geodive

可插拔的 GIS 地图引擎。它把任意闭合多边形数据组织成一棵可以一直下钻的区域树，从地球到国家、省、县、乡镇、地块都可以，并用 three.js 渲染成"地球 ↔ 立体板块"的大屏场景。

引擎只提供机制，不包含业务数据。用哪份边界、哪家底图、显示什么审图号，都由接入方决定。

当前版本 **v0.1.0**。

## 分层

```
┌──────────── 渲染层 @geodive/three ────────────┐
│ GeoScene / SceneHost · 地球与平面转场 · 板块 · 标签      │
│ 内置图层(填色 / 点位 / 飞线 / 柱 / 热力 / 涟漪 / 聚合    │
│ / 瓦片底图)· 叠加图层插件 · 主题                        │
└──────────────▲─────────────────────────────────────────┘
               │ EngineFrame(每次状态变化推送一帧)
┌──────────────┴─────── 引擎层 @geodive/core ─────────┐
│ GeoEngine · 区域树 · 下钻状态机 · 深链接定位 ensurePath  │
│ 图层规格与显隐 · 数据绑定与分级 · 插件 · 投影计算        │
└──────────────▲─────────────────────────────────────────┘
               │ RegionSource / TileSource
┌──────────────┴─────── 数据层 @geodive/data ───────────┐
│ 数据源接口 · 多数据集挂载与编码映射 · 重试 / 超时        │
│ GeoJSON / TopoJSON 导入 · 坐标系转换 · 几何工具          │
│ 内置数据源:static / http / DataV / Natural Earth        │
│ 瓦片描述:天地图 / 高德 / 任意 XYZ                       │
└─────────────────────────────────────────────────────────┘
```

| 包 | 依赖 | 文档 |
|---|---|---|
| `@geodive/data` | 无 | [数据层](packages/data/README.md)：区域数据从哪来、怎么拼接、底图瓦片在哪 |
| `@geodive/core` | `@geodive/data` | [引擎层](packages/core/README.md)：下钻、图层、数据绑定、事件；同时转出 `@geodive/data` 的全部导出 |
| `@geodive/three` | `@geodive/core`，peer `three >= 0.170` | [渲染层](packages/three/README.md)：three.js 场景 |

依赖只向下。只用引擎层的话，可以自己写渲染器，比如 SVG 或 MapLibre：实现 `SceneAdapter.update(frame)` 即可。

## 完整接入示例

下面的例子从地球下钻到国家，再到一级行政区；中国以下用国内行政区划，一直到区县；某个区县下面再挂上业务方自己的边界数据（园区、地块等）；地图下方铺一层天地图底图。

```ts
import {
  GeoEngine, naturalEarthSource, datavSource, staticSource, mount, prefixIds, tianditu,
} from "@geodive/core";                       // @geodive/data 的导出也从这里取
import { SceneHost, basemap } from "@geodive/three";

// 1. 数据层:把几个数据集拼成一棵树
const engine = new GeoEngine({
  sources: [
    naturalEarthSource({ exclude: ["TWN"] }),                                   // 顶层:各国
    mount({ at: "CHN", source: datavSource(), root: "100000", adopt: true }),   // 中国以下用 DataV,国界也用 DataV 的
    mount({ at: "330106", source: staticSource(myPlots), root: "330106", ids: prefixIds("plot:") }),    // 自有地块数据
  ],
  load: { retries: 2, timeoutMs: 15000 },
});

// 2. 引擎层:声明图层
engine.setLayers([
  basemap(tianditu({ key: TIANDITU_KEY, attribution: "© 天地图 GS(XXXX)XXXX号" }), { style: { invert: 1, grayscale: 1, tint: "accent" } }),
  { id: "values", type: "choropleth", data: { values: { "330000": 120, "320000": 80 }, unit: "家" } },
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

## 安装

```bash
pnpm add @geodive/core @geodive/three three   # 完整能力(npm / yarn 同理)
pnpm add @geodive/core                        # 只用数据层 + 引擎层,自己写渲染器
```

- `@geodive/core` 依赖 `@geodive/data` 并转出它的全部导出，一般不需要单独安装数据层。
- 包是构建好的 ESM JS，带类型声明，使用方不需要配置 `transpilePackages`。
- 每个版本都由 GitHub Actions 从对应 tag 构建发布，并附带 npm provenance（可在 npm 页面核对来源提交）。

### 离线 / 内网环境

不能访问 npm 时，可以把包打成 `.tgz` 放进使用方仓库：

```bash
pnpm pack:to ../your-project/vendor/geo   # 会先跑类型检查和测试,输出三个 .tgz
```

```jsonc
// 使用方 package.json(pnpm)
{
  "dependencies": {
    "@geodive/data": "file:vendor/geo/geodive-data-0.1.0.tgz",
    "@geodive/core": "file:vendor/geo/geodive-core-0.1.0.tgz",
    "@geodive/three": "file:vendor/geo/geodive-three-0.1.0.tgz",
    "three": "0.187.0"
  },
  // 包之间的依赖也要指向本地包,否则会去 npm 拉取
  "pnpm": {
    "overrides": {
      "@geodive/data": "file:vendor/geo/geodive-data-0.1.0.tgz",
      "@geodive/core": "file:vendor/geo/geodive-core-0.1.0.tgz"
    }
  }
}
```

npm 和 yarn 也有对应写法，分别是 `overrides` 和 `resolutions`。

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
- `fixtures/` 存放测试和演示页共用的样例数据；`packages/three/playground/` 是开发用的演示页。两者都不会打进发布包。

## 发版

推送 `v*` tag 即发布，流程见 [.github/workflows/release.yml](.github/workflows/release.yml)。

```bash
pnpm version:set 0.2.0          # 三个包统一改版本号
git commit -am "chore: release v0.2.0"
git tag v0.2.0 && git push origin main v0.2.0
```

- 三个包始终保持同一版本号。tag 与包版本对不上时发布会直接失败。
- 发布前在 CI 里跑类型检查、单元测试和构建。改了场景或着色器的，打 tag 前先在本地跑 `pnpm visual-check`。
- 预发布版本（如 `v0.2.0-beta.1`）发布到 npm 的 `next` dist-tag，正式版发布到 `latest`。
- 已经发布过的版本会跳过，所以对同一 tag 重跑工作流是安全的。npm 上的版本发布后不能覆盖，内容有改动就升版本号。
- 发布使用 npm trusted publishing（GitHub OIDC），仓库里不保存任何 npm token。首次发布前的一次性配置见 [RELEASING.md](RELEASING.md)。

## 许可

[MIT](LICENSE)
