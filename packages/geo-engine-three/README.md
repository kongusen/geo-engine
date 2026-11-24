# @yaoyu/geo-engine-three

`@yaoyu/geo-engine` 的 three.js 渲染器。它提供一个风格化的大屏地理场景：全球层级显示为地球，区域层级显示为 3D 挤出板块，两者之间有连续的变形转场。

```ts
const engine = new GeoEngine({ /* 区域、数据源、图层 */ });
const scene = new GeoScene({
  container,
  engine,
  theme: { accent: "#10b981", background: null }, // background 设为 null 时背景透明（同时关闭泛光）
  globe: { land },                                 // 不传 globe 时为纯平面场景
});
await engine.start();
```

## 开发演示页

```bash
pnpm playground   # http://localhost:5199(在仓库根目录执行)
```

演示页可以切换层级、开关各效果图层、启停自动巡游、切换主色。区域数据是 `playground/demo-data/` 下的快照（世界陆地、全国省级、从江乡镇，取自 yaoyu-data），业务数据是随机生成的示例。

## 图层

图层由 `engine.setLayers([...])` 声明，`type` 决定由哪个实现渲染，`visible` 控制它在哪些层级、哪种场景下显示。

| type | 场景 | data |
|---|---|---|
| `choropleth` | 平面 | `{ values: Record<regionId, number>, unit?, method?, extrudeByValue? }`：板块按数值着色、挤出 |
| `label` | 平面 / 地球 | `{ showValue? }`：区域名称与数值，自动避让 |
| `point` | 平面 / 地球 | `{ points: [{ id, name, position, label?, color? }] }`：脉冲点位 |
| `line` | 平面 | `{ lines: Position[][] }`：线状装饰（如九段线） |
| `flow` | 平面 / 地球 | `{ flows: [{ from, to, value?, color? }], speed?, arcHeight?, width?, trail? }`：OD 飞线，带彗星拖尾 |
| `bar` | 平面 / 地球 | `{ bars: [{ position \| regionId, value, label? }], unit?, maxHeight? }`：3D 数值柱 |
| `heat` | 平面 | `{ points: [{ position, weight? }], radius?, colors? }`：核密度热力图 |
| `ripple` | 平面 / 地球 | `{ points: [{ position, color?, label? }], rings?, speed? }`：扩散波纹（告警、强调） |
| `cluster` | 平面 | `{ points: [{ id, position, name? }], cellSize? }`：点位聚合，下钻后自然展开 |

尺寸参数都相对当前层级的"特征长度"计算，所以同一套参数在全国、县、乡镇各级的视觉比例一致。

## 自定义效果插件

```ts
import { defineOverlay, disposeTree } from "@yaoyu/geo-engine-three";

const myLayer = defineOverlay<{ items: ... }>({
  type: "my-effect",
  modes: ["plane", "globe"],
  create(ctx, spec) {
    const group = new THREE.Group();
    ctx.group.add(group);
    // ctx.position(lngLat, height)  地表位置（平面落在板块顶面，地球落在球面）
    // ctx.up(lngLat)                该点的向上方向
    // ctx.scale / ctx.unitHeight    尺寸基准
    // ctx.label(text)               文字标签（自动参与避让）
    return {
      tick(t, dt) {},       // 每帧调用
      setOpacity(k) {},     // 转场淡入淡出
      update(spec) { return false; }, // 返回 false 时由场景销毁后重建
      dispose() { disposeTree(group); },
    };
  },
});

new GeoScene({ container, engine, overlays: [myLayer] }); // 也可以调用 scene.registerOverlay(myLayer)
```

场景负责插件实例的生命周期：数据更新时调用 update 或重建；下钻转场时调用 setOpacity，并在变形期间隐藏；离开层级时调用 dispose。插件本身不需要关心层级切换。

如果插件使用自定义 `ShaderMaterial`，需要加入 `LOGDEPTH` 中的片段，因为场景开启了对数深度缓冲，以兼顾地球尺度和地块尺度的深度精度。

## 场景方法

- `setAccent(color)`：运行时切换主色。
- `setLabelsVisible(bool)`：显示或隐藏全部文字标签。
- `setViewportInset({ top?, right?, bottom?, left? }, animate?)`：动态调整平面视口四周留白（CSS px），在全屏底图存在浮层 HUD 时让 3D 地图居中适配中央开放窗口；`SceneHost` 重建后自动恢复。
- `setHighlight(regionId | null)`：从外部（如周边排行条悬停）反向高亮并抬升指定区域板块或球面区块；`SceneHost` 重建后自动恢复。
- `registerOverlay(plugin)`：注册叠加图层插件。
- `stats()`：运行状态快照（帧率、几何体 / 纹理 / 着色器数、标签 DOM 数等），用于巡检和排查泄漏。
- `dispose()`：释放场景。

其他选项：

- `viewportInset`：初始平面视口四周留白 `{ top?, right?, bottom?, left? }`（CSS px）。
- `emptyClick`：平面场景单击空白处行为，`"drill-up"` 上卷一级，默认 `"none"`。
- `onPointClick` / `onPointHover`：点击或悬停内置 `point` 3D 点位标记（球茎 / 球头 / 地球点位）时的回调。
- `attribution`：画布右下角的角标文字，例如审图号或“乡镇边界为示意”。公开展示含中国国界的地图必须标注审图号，具体文字由业务侧配置。
- `overlayZoomFade`：镜头比当前层级默认视距近很多时，叠加效果会淡出，默认 `[0.45, 0.2]`，传 `false` 关闭。效果是按所在层级的尺寸绘制的，从地球一路下钻到县的过程中，地球上的飞线、涟漪会被放大成满屏光斑，这个选项就是为了避免这种情况。

## 大屏部署：用 SceneHost 挂载

大屏无人值守时，应该用 `SceneHost` 代替直接 `new GeoScene`：

```ts
const host = new SceneHost(sceneOptions, { onStatus: (status) => { /* ready | recovering | failed */ } });
host.setAccent("#f59e0b"); // 与 GeoScene 相同的方法；重建后会自动恢复
```

- 显卡重置、休眠唤醒等情况会导致 WebGL 上下文丢失。SceneHost 会先等浏览器恢复上下文，超过 2 秒仍未恢复，就在新画布上重建场景。引擎状态（当前层级、图层）不受影响。
- 创建失败时按 1.5s、5s、15s 的间隔重试；仍然失败就进入 `failed`，宿主应显示降级视图。之后每 60 秒再试一次，成功后自动回到 `ready`。
- 页面不可见时场景会停止渲染。

## 自动化检查

```bash
pnpm visual-check                # 画面回归，约 1 分钟
pnpm soak --minutes 600          # 长时间运行巡检，上线前在大屏主机上跑一晚
```

- **visual-check**：在演示页中依次跑以下场景：从地球下钻到县、乡镇往返、从县回到地球、模拟上下文丢失后重建并再次下钻。检查分两层：
  - 截图检查，排除纯色、过曝、空画面；
  - 帧缓冲逐帧采样，抓单帧闪黑。

  截图对照页和 `result.json` 写到 `--out` 指定的目录。不通过时退出码为 1。
- **soak**：用快速自动巡游反复下钻和上卷，每轮回到地球时采样资源占用，判断几何体、纹理、标签 DOM 数和 JS 堆是否持续增长。`--lose-every N` 表示每 N 轮模拟一次上下文丢失。结果写成 CSV，可以直接画曲线。
- 两个脚本都优先使用本机 Chrome，走真实的 GPU 路径。没有本机 Chrome 时先运行 `pnpm exec playwright install chromium`。

## 交互

- 悬停高亮。
- 点击可下钻区域时下钻；点击叶子区域时选中（`engine.on("select")`）。
- 右键返回上一级；在平面中双击空白处也返回上一级。
- 地球模式下可拖拽旋转，无人操作时自转。
