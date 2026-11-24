# @yaoyu/geo-data

geo-engine 的数据层：定义区域数据源契约，提供编码映射、多数据源路由与挂载、加载策略，以及 GeoJSON / TopoJSON 规范化和坐标系转换。不依赖引擎和渲染器。`@yaoyu/geo-engine` 会整体转出本包，旧的导入路径仍然可用。

## 数据源契约

```ts
interface RegionSource {
  id: string;
  children(parentId: string | null, ctx): Promise<RegionPayload>;      // 必需
  ancestors?(id: string, ctx): Promise<RegionRef[] | null>;            // 深链接 / ensurePath 依赖
  handles?(parentId): boolean;   owns?(id): boolean;                   // 路由用
  defaultHasChildren?: boolean | ((ref) => boolean);                   // 懒加载时决定能否下钻
}
```

数据源只处理**自己的编码**。它和引擎全局 id 之间的对应关系由挂载时的 `IdMapper` 负责。

内置数据源：
- `staticSource(regions)`：内存数据，祖先链和是否有下级由数据本身推出。
- `httpSource({ url: (parentId) => ..., ancestors?, ingest? })`：每个父级对应一个文件。

祖先解析器：
- `adcodeHierarchy()`：按国标行政区划代码推导，不发请求。
- `parentMapHierarchy(index)`：子 → 父对照表。

## DataV 行政区划

```ts
const datav = datavSource({ simplify: 0.005 });   // 国家 → 省 → 市 → 区县,按需请求 {adcode}_full.json
new GeoEngine({
  sources: [datav, mount({ at: "522633", source: townshipSource, root: "522633", ids: prefixIds("cj:") })],  // 区县下挂乡镇
});
const nineDash = await datav.decorations();       // 南海九段线等装饰要素(WGS84 折线),与省级请求共用一次下载
```

- **下级判断**：取自 `childrenNum`。区县没有 `_full` 文件，适配器不会去请求。挂载了其他数据源的节点一定可以下钻。
- **坐标系**：缺省 `gcj02`，导入时自动纠偏到 WGS84。如果自建了 WGS84 镜像，传 `crs: "wgs84"`。
- **`root`**：可以设为省或市（如 `"520000"`），只服务这个范围。
- **`baseUrl`**：可以指向自己的镜像。生产环境建议同步一份文件到自有静态服务，不要直接依赖第三方站点。
- **虚级**：按代码推导出的中间级（直辖市的 `110100`、省直辖县的 `429000`）在数据里不存在，`ensurePath` 会跳过。代价是会多一次失败的预取请求（404）。

## Natural Earth 世界数据

```ts
const world = naturalEarthSource({ exclude: ["TWN"] });  // 顶层各国(ADM0_A3:CHN / USA …),下一级为一级行政区(ISO 3166-2:US-CA …)
new GeoEngine({
  sources: [
    world,
    mount({ at: "CHN", source: datavSource(), root: "100000", adopt: true }),  // 中国以下走 DataV,且中国轮廓换成 DataV 国界
  ],
});
```

- **名称与编码**：
  - 默认显示中文名（`NAME_ZH`），`lang: "en"` 切换为英文。`rename` 可以改写个别名称。
  - 国家用 `ADM0_A3` 作编码，不用 `ISO_A3`，因为后者在法国、挪威等国家上是 `-99`。
- **一级行政区**：默认数据（1:50m）覆盖 9 个国家。能否下钻按已知清单判断，打开地球时不会下载 2.3MB 的省/州文件。使用自定义数据时，用 `admin1Countries` 声明有下级的国家，不声明则读文件判断。
- **合规**：
  - Natural Earth 按"事实控制"绘制国界，与各国官方立场不一定一致。
  - 公开发布时，用挂载的 `adopt` 让接缝区域采用权威几何，用 `exclude` 排除不应单独出现的要素。
  - 也可以把 `countriesUrl` 指向自行预处理的版本，例如 Natural Earth 的中国视角数据（目前只有 1:10m 精度，约 13MB，需要先抽稀）。
- **`adopt` 的取舍**：被挂载的数据源需要实现 `region(id)`（DataV、static 已实现）。权威几何取不到时，整批加载失败，不会悄悄退回国际数据集的轮廓。

## 多数据集拼接

```ts
new GeoEngine({
  sources: [
    worldSource,                                                          // 顶层:各国(CHN、USA…)
    mount({ at: "CHN", source: cnSource, root: "100000" }),               // cnSource 的 100000 即全局的 CHN
    mount({ at: "522633", source: campusSource, ids: prefixIds("cj:") }), // 编码可能冲突时加命名空间
  ],
  load: { retries: 2, timeoutMs: 15000 },                                 // 应用到每个数据源
});
await engine.drill.drillTo("522633");  // 不在树中时自动 ensurePath:并行拉取各级、按层级顺序写入
```

编码映射：
- `identityIds()`：缺省，原样使用。
- `prefixIds(p)`：加命名空间前缀。
- `tableIds({ 源内编码: 全局 id })`：对照表改名。
- 也可以传入任意实现了 `{ toGlobal, toLocal }` 的对象。

同一个全局 id 由两个数据源提供时，会报 `id-collision`。区域上的 `region.source` 记录了数据源 id 和源内原始编码，可用于按原始编码绑定业务数据。

## 瓦片底图描述

`TileSource` 只描述瓦片从哪里取、用什么坐标，选哪些瓦片、怎么绘制由渲染层负责：

- **服务商**：
  - `tianditu({ key, layer?, label?, matrix? })`：返回底图和注记两层，按 WGS84 处理（CGCS2000 与 WGS84 相差在厘米级）。
  - `amapTiles({ layer? })`：标注为 `crs: "gcj02"`，渲染时会纠偏。
  - `xyzTiles(url, opts)`：通用 XYZ 服务。
- **瓦片计算**：`tileToLngLat` / `lngLatToTile` / `tilesInBBox` / `zoomForResolution` / `tileUrl`。支持 webmercator 和 geographic 两种瓦片矩阵，以及 xyz / tms 两种行号方向。
