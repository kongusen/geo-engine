# 发布

日常发版只需要推 tag，见 [README · 发版](README.md#发版)。本文是一次性配置和排错。

## 工作流

| 文件 | 触发 | 做什么 |
|---|---|---|
| [ci.yml](.github/workflows/ci.yml) | push 到 main、PR | 类型检查、单元测试、构建、发布演练（`npm publish --dry-run`） |
| [release.yml](.github/workflows/release.yml) | 推送 `v*` tag | 校验 tag 与版本号 → 类型检查、测试 → 按 data → core → three 顺序发布 → 创建 GitHub Release |

发布逻辑在 [scripts/release.mjs](scripts/release.mjs)，本地可以演练：

```bash
node scripts/release.mjs --tag v0.1.0 --dry-run
```

## 一次性配置

npm 的可信发布者（trusted publisher）只能在**已存在的包**上配置，所以第一个版本要借一个临时 token 发出去，之后切换到 trusted publishing 并删掉 token。

### 1. npm 组织

在 npmjs.com 创建组织 `geodive`（公开包免费），发布人加入组织并开启 2FA。

### 2. 首次发布（临时 token）

1. npmjs.com → Access Tokens → Generate New Token → **Granular Access Token**：
   - Packages and scopes：Read and write，范围只选 `@geodive`
   - 有效期选最短（如 7 天）
2. GitHub 仓库 → Settings → Environments → `npm`（推送 tag 后工作流会自动创建，也可以先手动建）→ Environment secrets → 添加 `NPM_TOKEN`。
3. 推送 tag：

   ```bash
   git tag -a v0.1.0 -m "geodive v0.1.0" && git push origin v0.1.0
   ```

   这一次仍然带 provenance（`--provenance` 依赖的是 GitHub OIDC，不是认证方式）。

### 3. 切换到 trusted publishing

对 `@geodive/data`、`@geodive/core`、`@geodive/three` 三个包分别操作：npm 包页面 → Settings → **Trusted Publisher** → GitHub Actions：

| 字段 | 值 |
|---|---|
| Organization or user | `kongusen` |
| Repository | `geo-engine` |
| Workflow filename | `release.yml` |
| Environment name | `npm` |

然后在同一页面把 Publishing access 设为 **Require two-factor authentication and disallow tokens**，这样即使 token 泄露也无法发布。

最后删除 GitHub 上的 `NPM_TOKEN` secret，并在 npm 上吊销该 token。之后的发布只走 OIDC，仓库和 CI 中不再有任何 npm 凭据。

### 4. （可选）发布审批

GitHub → Settings → Environments → `npm` → Required reviewers。设置后每次推 tag 都要指定的人批准，工作流才会开始发布。也可以在这里限制只有匹配 `v*` 的 tag 能使用该环境。

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| `tag vX 与包版本不一致` | 没有先 `pnpm version:set X` 并提交；删掉 tag（`git push origin :vX`），改好后重打 |
| `ENEEDAUTH` / `404 Not Found - PUT` | 可信发布者配置与工作流对不上：仓库名、`release.yml`、环境名 `npm` 必须完全一致；或首次发布时没配 `NPM_TOKEN` |
| `cannot publish over the previously published versions` | 该版本已存在。脚本会跳过已发布版本，出现此错说明有并发发布；npm 版本不能覆盖，改动请升版本号 |
| 发布了一半（如 data 成功、core 失败） | 修复后在 Actions 里对同一 tag 点 Re-run，已发布的包会被跳过 |
| 发错了版本 | 72 小时内可以 `npm unpublish @geodive/xxx@版本`，但同一版本号不能再次使用；更稳妥的做法是 `npm deprecate` 后发补丁版本 |
