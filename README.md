# geo-engine

可插拔的 GIS 地图引擎，支持从地球一路下钻到县、乡镇等任意层级。最初为 yaoyu-data 大屏开发，现在独立维护，供多个项目复用。

| 包 | 内容 |
|---|---|
| [`@yaoyu/geo-engine`](packages/geo-engine/README.md) | 与渲染无关的核心：数据导入与坐标系转换、区域树、下钻状态机、数据绑定、投影、图层、聚合与热力计算、自动巡游。零运行时依赖。 |
| [`@yaoyu/geo-engine-three`](packages/geo-engine-three/README.md) | three.js 渲染器：地球与平面之间的变形转场、立体区块、标签、效果插件、WebGL 上下文丢失后自动恢复（`SceneHost`）。`three >= 0.170` 作为 peer 依赖。 |

## 开发

```bash
pnpm install
pnpm test           # 两个包的单元测试
pnpm typecheck
pnpm playground     # 演示页 http://localhost:5199
pnpm visual-check   # 画面回归：关键转场逐帧检查黑屏 / 白屏 / 空画面，约 1 分钟
pnpm soak --minutes 600 --lose-every 20   # 长时间运行巡检
```

仓库内的包之间直接引用 TS 源码，开发时不需要先构建。打包时，`publishConfig` 会把入口切换到 `dist`（esbuild 打出 ESM，tsc 生成类型声明）。

`fixtures/` 存放测试和演示页共用的样例数据，`packages/geo-engine-three/playground/demo-data/` 存放演示页用的区域数据快照。这些都只在开发时使用，不会打进发布包。

## 在其他项目中使用

目前不发布到 npm，而是打成 `.tgz`，放进使用方的仓库。这样使用方的 CI 和 Docker 构建都不需要访问本仓库。

```bash
# 1. 在本仓库打包（会先跑类型检查和测试）
pnpm pack:to ../your-project/vendor/geo
```

```jsonc
// 2. 使用方 package.json（pnpm）
{
  "dependencies": {
    "@yaoyu/geo-engine": "file:vendor/geo/yaoyu-geo-engine-0.1.0.tgz",
    "@yaoyu/geo-engine-three": "file:vendor/geo/yaoyu-geo-engine-three-0.1.0.tgz",
    "three": "0.187.0"
  },
  // geo-engine-three 依赖 @yaoyu/geo-engine@0.1.0，这个版本不在 npm 上，需要用 overrides 指向本地包
  "pnpm": {
    "overrides": { "@yaoyu/geo-engine": "file:vendor/geo/yaoyu-geo-engine-0.1.0.tgz" }
  }
}
```

npm 和 yarn 也有对应的 `overrides` / `resolutions` 写法。包已经构建成普通的 ESM JS，使用方不需要配置 `transpilePackages`。

yaoyu-data 已经把这些步骤写成 `pnpm geo:update`（见该仓库的 `scripts/geo-update.mjs`）。

### 发版约定

- 每次给使用方更新前，先升 `packages/*/package.json` 里的版本号，两个包保持同一版本。如果同名同版本的包内容变了，使用方 lockfile 里的校验值会对不上，CI 用 `--frozen-lockfile` 安装时会失败。
- 改了场景或着色器，打包前先跑一次 `pnpm visual-check`。
