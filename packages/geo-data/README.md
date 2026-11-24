# @yaoyu/geo-data（数据层）

这一层负责区域数据的来源和规范化，以及底图瓦片的描述，零运行时依赖，不涉及渲染和交互。

`@yaoyu/geo-engine` 会整体转出本包的导出，所以接入方一般直接从 `@yaoyu/geo-engine` 导入。只有不用引擎、单独做数据处理时（比如在 Node 里跑预处理），才需要直接依赖本包。

- [区域模型](#区域模型)
- [导入与坐标系](#导入与坐标系)
- [数据源接口 RegionSource](#数据源接口-regionsource)
- [内置数据源](#内置数据源)
- [多数据集拼接：挂载与编码映射](#多数据集拼接挂载与编码映射)
- [加载策略](#加载策略)
- [瓦片底图描述 TileSource](#瓦片底图描述-tilesource)
- [几何与坐标工具](#几何与坐标工具)

## 区域模型

任何能被闭合多边形围起来的范围都是**区域**，比如国家、省、乡镇、园区、地块。引擎内部一律使用 **WGS84 经纬度**，其他坐标系在导入时统一转换。

```ts
interface RegionInput {          // 你提供的
  id: string;                    // 全局唯一编码
  name: string;
  aliases?: string[];            // 别名(名称解析、数据绑定时可用)
  parentId?: string | null;      // 不给时可按空间包含关系推断(见引擎层 RegionTree)
  level?: string;                // 语义层级标签,如 country / province / township;引擎只依赖树深度,图层显隐可按它控制
  polygons: MultiPolygonCoords;  // [[外环, 洞...], ...],外环逆时针
  expandable?: boolean;          // 子级尚未加载但存在(懒加载时决定能否下钻)
  source?: { id: string; localId: string };  // 来源数据源与源内原始编码(数据源路由自动填写)
  properties?: Record<string, unknown>;
}

interface Region extends RegionInput {  // 引擎派生的
  bbox: [minLng, minLat, maxLng, maxLat];
  centroid: Position;            // 面积加权质心(可能落在凹多边形外)
  anchor: Position;              // 保证落在区域内部的点(标签、点击落点)
  areaKm2: number;
}
```

## 导入与坐标系

`ingest(input, options)` 支持 GeoJSON（FeatureCollection / Feature / Geometry）、TopoJSON 和 Feature 数组，输出 `RegionInput[]` 和一份问题报告。它**不抛出可修复的错误**，所有问题都写进 `issues`，适合直接用来生成后台的数据校验报告。

处理顺序：坐标系识别与转换 → 闭合未闭合的环 → 展开跨 180° 经线的区域 → 统一绕向 → 抽稀 → 读取编码、名称、父级、层级、别名。

```ts
const { regions, issues } = ingest(geojson, {
  idKey: "adcode",            // 缺省依次尝试 adcode / code / id / ID / gb,最后 feature.id
  nameKey: "name",            // 缺省 name / NAME / 名称 / label
  parentKey: "parent",        // 缺省 parent / parentCode / parent_adcode / parentId / pid;兼容 DataV 的 { parent: { adcode } }
  levelKey: "level",
  aliasKey: "aliases",        // 数组,或以 , ; 、 分隔的字符串
  // 以上都可以是 字符串 | 字符串数组 | (properties, feature) => 值
  crs: "auto",                // auto | wgs84 | gcj02 | epsg3857 | { affine }
  simplify: 0.001,            // 抽稀容差(度),0 不抽稀
  parentId: "522633",         // 没有父级信息的要素统一挂到此父级
  level: "township",          // 没有 level 字段时使用
  topologyObject: "counties", // TopoJSON 对象名,缺省合并全部
});
```

**坐标系说明**：

- `auto` 能识别 WGS84 和 EPSG:3857。识别不出时报 `crs-unknown`，常见于 SVG 等本地坐标。
- **GCJ-02 无法自动识别**。高德、腾讯、DataV 的数据必须显式声明 `crs: "gcj02"`。
- 本地坐标（例如 SVG 描出来的边界）用控制点配准：

```ts
const { affine, maxResidual } = fitAffine([
  { source: [1407.6, 331.2], target: [108.6775, 25.9818] },   // 本地坐标 → WGS84,至少 3 个,尽量分散在四周
  // ...
]);
ingest(svgGeojson, { crs: { affine } });
```

**问题码**（`GeoIssue.code`）：

| 类别 | 问题码 |
|---|---|
| 坐标系 | `crs-converted`、`crs-unknown` |
| 几何修复 | `ring-closed`、`ring-rewound`、`ring-degenerate`、`antimeridian-unwrapped`、`non-polygon-skipped` |
| 编码 | `missing-id`、`duplicate-id`、`id-collision` |
| 父级 | `missing-parent`、`parent-inferred`、`parent-not-found` |
| 其他 | `invalid-input` |

## 数据源接口 RegionSource

数据源负责**按父级懒加载子级**，引擎只在用户下钻或深链接定位时才去请求。数据源始终只处理**自己的编码**，与引擎全局 id 之间的转换由挂载时的 `IdMapper` 负责（见后文）。

```ts
interface RegionSource {
  id: string;
  children(parentId: string | null, ctx: { signal: AbortSignal }): Promise<RegionPayload>;   // 必需;null 为本源顶层
  ancestors?(id: string, ctx): Promise<RegionRef[] | null>;  // 祖先链(顶层在前,不含自身);不认识返回 null。深链接依赖它
  region?(id: string, ctx): Promise<RegionPayload>;          // 单个区域自身的几何;挂载的 adopt 依赖它
  handles?(parentId: string | null): boolean;                 // 是否负责该父级,缺省全部负责
  owns?(id: string): boolean;                                 // 编码是否属于本源,缺省全部属于
  defaultHasChildren?: boolean | ((ref: RegionRef) => boolean); // 缺少下级信息时的默认判断
}

interface RegionPayload {
  regions: RegionInput[] | { input: unknown; options?: IngestOptions };  // 也可以直接给 GeoJSON / TopoJSON
  refs?: Record<string, { hasChildren?: boolean; level?: string }>;     // 按源内编码补充元数据
  attribution?: string;                                                  // 数据版权 / 审图号,会显示在画面角标
}
```

**能否下钻**按以下优先级判断：
1. 该区域上挂载了其他数据源，一定可以下钻；
2. `refs[id].hasChildren`；
3. 数据自带的 `expandable`；
4. 数据源的 `defaultHasChildren`。

懒加载时，如果某个区域加载回来的子级为空，引擎会把它标记为叶子，不再重复请求。

**祖先链里可以包含数据中不存在的中间级**。例如按代码推导出的直辖市"市辖区" `110100`，引擎在深链接定位时会自动跳过。

自定义数据源示例（后端按父级返回 GeoJSON）：

```ts
const mySource: RegionSource = {
  id: "my-api",
  defaultHasChildren: (ref) => ref.level !== "plot",
  async children(parentId, { signal }) {
    const res = await fetch(`/api/regions?parent=${parentId ?? ""}`, { signal });
    return { regions: { input: await res.json(), options: { crs: "gcj02" } }, attribution: "某某测绘" };
  },
  async ancestors(id, { signal }) {
    const res = await fetch(`/api/regions/${id}/ancestors`, { signal });
    return res.ok ? res.json() : null;          // [{ id }, { id }, ...]
  },
};
```

## 内置数据源

### staticSource(regions, { id?, attribution? })

内存数据源，每个区域都要带 `parentId`。按父级切分返回，能否下钻和祖先链都由数据本身推出。适合业务方自有的小规模边界，比如园区、地块、示意乡镇。

### httpSource({ id, url, ingest?, ancestors?, owns?, defaultHasChildren?, attribution?, fetch? })

通用 HTTP 数据源，每个父级对应一个文件。

- `url(parentId)` 返回请求地址；返回 `null` 表示本源不负责该父级。
- `defaultHasChildren` 缺省为 `true`：先允许下钻，加载回来是空的再标记为叶子。
- `fetch` 可以自定义请求，用来加鉴权头、签名等。

### datavSource({ baseUrl?, root?, includeRoot?, crs?, simplify?, filter?, attribution?, fetch? })

阿里云 DataV GeoAtlas 的行政区划，覆盖国家 → 省 → 市 → 区县。

- 每个父级请求一个 `{adcode}_full.json`。能否下钻取自 `childrenNum`，区县是叶子。
- 坐标缺省按 `gcj02` 纠偏到 WGS84。如果自建了 WGS84 镜像，传 `crs: "wgs84"`。
- 祖先链按行政区划代码推导，不发请求。直辖市、省直辖县这类缺少中间级的情况会自动跳过。
- `root` 可以设为某个省或市（如 `"520000"`），只服务这个范围。
- `includeRoot` 缺省为 `true`：作为顶层数据源使用时，顶层返回 root 区域本身。
- 无名称的装饰要素（如南海九段线 `100000_JD`）默认被过滤，用 `datav.decorations()` 取出 WGS84 折线，交给渲染层的 `line` 图层绘制。
- `region(id)` 返回单个区域的边界，可以作为 `adopt` 的权威几何来源。
- 生产环境建议把文件同步到自己的静态服务，再用 `baseUrl` 指过去。
- DataV 不含乡镇级。乡镇及以下可以在区县上挂载其他数据源。

### naturalEarthSource({ countriesUrl?, admin1Url?, admin1Countries?, lang?, exclude?, filter?, rename?, simplify?, attribution?, fetch? })

Natural Earth 世界数据。顶层是各国，编码用 `ADM0_A3`，如 `CHN`、`USA`；下一级是一级行政区，编码用 ISO 3166-2，如 `US-CA`。

- `lang` 缺省为 `"zh"`，显示中文名；`rename` 可以改写个别名称；`exclude` 和 `filter` 用来剔除要素。
- 缺省的一级行政区数据（1:50m）覆盖美、加、俄、澳、巴西、印尼、南非、印度、中国 9 国。能否下钻按已知清单判断，打开地球时**不会下载**一级行政区文件。
- 用自定义数据（`admin1Url`）时，用 `admin1Countries` 声明有下级的国家，不声明则首次加载时读文件判断。
- 被挂载了其他数据源的国家，以挂载源为准。

> **边界合规由接入方负责。** Natural Earth 按"事实控制"绘制国界，与各国官方立场不一定一致。面向公开发布时，可以组合使用以下手段：
> - 有权威数据的国家，挂载权威数据源并开启 `adopt`；
> - 不应单独出现的要素，用 `exclude` 剔除；
> - 把 `countriesUrl` 指向自行审核、预处理过的数据。

### 祖先解析器

祖先解析器可以单独复用，挂到任意数据源上，比如 `httpSource({ ancestors })`：

- `adcodeHierarchy({ root? })`：按国标行政区划代码推导，支持 6 位（县及以上）、9 位（乡镇）、12 位（村），不发请求。
- `parentMapHierarchy(map | loader)`：子 → 父对照表，可以异步加载，只加载一次。

## 多数据集拼接：挂载与编码映射

`sources` 里可以放普通数据源，也可以放挂载项。普通数据源等价于挂在顶层（`at: null`）。

```ts
mount({
  at: "CHN",               // 挂载点:全局区域树中的 id(null 为顶层)
  source: datavSource(),
  root: "100000",          // 与挂载点对应的源内编码:children("CHN") 会转为 source.children("100000")
  ids: identityIds(),      // 源内编码 ↔ 全局 id,缺省原样
  adopt: true,             // 接缝区域 CHN 的几何换成 source.region("100000") 的结果
})
```

**某个父级由哪个数据源加载**，按以下顺序决定：
1. 挂载点正好是这个父级的；
2. 提供了这个父级区域的数据源；
3. 按注册顺序，第一个认领它的数据源（`ids.toLocal` 非空，且 `owns` / `handles` 不否认）。

**深链接定位**时，路由器先找到认识目标编码的数据源，再沿挂载点逐级向上拼出完整的祖先链。这样一次 `drillTo("cj:丙妹镇")` 就能跨三个数据集完成定位。

**编码映射 IdMapper**（`{ toGlobal(localId), toLocal(globalId) | null }`）：

| 映射 | 用途 |
|---|---|
| `identityIds()` | 缺省。各数据集编码天然不冲突时使用，如 ISO3 国家码与 6 位行政区划代码 |
| `prefixIds("cj:")` | 加命名空间，编码空间可能冲突时使用 |
| `tableIds({ "156": "CHN" }, fallback?)` | 个别编码改名 |
| 自定义对象 | 任意规则 |

**注意事项**：
- 同一个全局 id 由两个数据源提供时，会报 `id-collision`。
- `region.source.localId` 保留了源内原始编码，按原始编码绑定业务数据时用得上。
- `adopt` 的权威几何取不到时，整批加载失败，不会悄悄退回上层数据集的轮廓。这样做是为了避免显示不该显示的国界。

`composeSources(sources, { policy })` 会返回一个独立的路由器（`SourceRouter`），不用引擎时也能直接使用。

## 加载策略

`withPolicy(source, { retries = 2, retryDelayMs = 600, timeoutMs = 15000 })` 给数据源加上重试（间隔逐次翻倍）和超时，请求被中止后不再重试。

引擎的 `load` 选项会对每个数据源自动应用这层包装。

## 瓦片底图描述 TileSource

这里只描述瓦片从哪里取、用什么坐标；选哪些瓦片、怎么绘制，由渲染层的 `basemap` 图层负责。

```ts
interface TileSource {
  id: string;
  url: string | ((z, x, y) => string);  // 模板支持 {z} {x} {y} {s}
  subdomains?: string[];
  matrix?: "webmercator" | "geographic"; // 缺省 webmercator;geographic 为经纬度瓦片(天地图 _c 系列)
  scheme?: "xyz" | "tms";
  tileSize?: number; minZoom?: number; maxZoom?: number;
  crs?: "wgs84" | "gcj02";               // gcj02 的瓦片会在渲染时逐顶点纠偏
  attribution?: string;
  load?: (tile, signal) => Promise<ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas>;  // 接管请求:鉴权、离线包、自绘
}
```

| 服务商 | 返回 | 说明 |
|---|---|---|
| `tianditu({ key, layer?: "vec" \| "img" \| "ter", label?, matrix?: "w" \| "c", attribution? })` | 底图 + 注记两层 | 浏览器端 key 需要在天地图控制台配置域名白名单。CGCS2000 按 WGS84 处理 |
| `amapTiles({ layer?: "vec" \| "img", attribution? })` | 一层 | GCJ-02，渲染时纠偏。商用前请确认服务条款 |
| `xyzTiles(url, options)` | 一层 | 任意 XYZ / TMS 服务 |

**审图号**由接入方按服务商当年公布的内容，填写在 `attribution` 里。

**瓦片计算工具**：`tileUrl`、`tileToLngLat`、`lngLatToTile`、`tilesInBBox`、`zoomForResolution`。

## 几何与坐标工具

| 类别 | 函数 |
|---|---|
| 坐标转换 | `wgs84ToGcj02` / `gcj02ToWgs84`、`lngLatToWebMercator` / `webMercatorToLngLat`、`fitAffine` / `applyAffine`、`detectCrs`、`converterFor` |
| 点与面 | `pointInRing` / `pointInPolygon` / `pointInMultiPolygon`、`bboxOf` / `bboxUnion` / `bboxContainsPoint` |
| 面积与中心 | `areaKm2`、`centroidOf`、`interiorPoint`、`samplePoints` |
| 环处理 | `signedRingArea`、`closeRing`、`orientRing`、`rewindPolygon`、`unwrapRing` |
| 抽稀 | `simplifyRing` / `simplifyPolygons` |
| 边界线 | `boundaryLines`（共享边只出一次）、`outerOutline`（合并后的外轮廓） |
| 格式 | `topologyToFeatures`、`isTopology`、`toFeatures`、`toRegion` |
