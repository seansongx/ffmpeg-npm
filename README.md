# @seankit/ffmpeg 打包仓库

把固定版本的上游 FFmpeg 静态构建重新打包为公用 npm 包，供 Node.js 项目直接安装，也供桌面应用在运行时按清单下载。npmmirror 自动同步后作国内源，npmjs 作备用源，两边是同一个文件。

## 发布的包

| 包 | 内容 |
| --- | --- |
| `@seankit/ffmpeg` | 主包：`require('@seankit/ffmpeg').path` 返回本机 ffmpeg 路径；`manifest.json` 列出各平台包的下载地址、大小和 SHA-256 |
| `@seankit/ffmpeg-<平台>` | 单个平台的 `bin/ffmpeg(.exe)`，由主包作为可选依赖引用，npm 只安装当前平台那一个 |
| `@seankit/ffprobe`、`@seankit/ffprobe-<平台>` | 同样结构的 ffprobe |

平台：`win32-x64`、`darwin-arm64`、`darwin-x64`、`linux-x64`、`linux-arm64`。Windows on ARM 通过 x64 模拟运行，`win32-x64` 包同时声明 `x64` 和 `arm64`，清单中 `aliases` 把 `win32-arm64` 指向它。

## 上游来源

当前的 FFmpeg 版本、npm 包版本，以及各平台上游地址、大小和 SHA-256 都在 [sources.json](sources.json)。均为 GPL 构建（含 libx264、libmp3lame）：Windows 取自 gyan.dev essentials，macOS 和 Linux 取自 ffmpeg.martin-riedl.de。

- 可执行文件不做修改，macOS 上游签名保持有效。
- 打包前从可执行文件中读出许可证和编译选项，缺少 `requiredConfigure` 中的选项或含 nonfree 组件时停止。
- 每个包附带许可证全文、上游构建信息（`BUILDINFO.json`）和 FFmpeg 源代码地址。
- tarball 由脚本直接生成（ustar + gzip），条目顺序和时间戳固定；macOS/Linux 可执行文件写入 `0755` 权限，在 Windows 上打包也一样。

## 版本号

前两位跟随 FFmpeg 主、次版本，第三位是本仓库的修订号：FFmpeg 9.1 首次发布为 `9.1.0`，重新打包或跟进 9.1.x 补丁依次为 `9.1.1`、`9.1.2`。确切的 FFmpeg 版本记录在清单的 `ffmpegVersion`。npm 已发布的版本不能覆盖。

## 发布流程

在 GitHub Actions 中发布：上游文件和 npm 都在境外，在 GitHub 的服务器上下载和上传快得多。

1. 首次使用前，在 npmjs.com 为 `@seankit` 创建有发布权限的访问令牌，添加为仓库密钥 `NPM_TOKEN`（Settings → Secrets and variables → Actions）。
2. 在 Actions 页面运行 **Release**，先不勾选“发布到 npm”：工作流会跑测试、下载并校验上游文件、生成 tarball。运行摘要列出每个包的大小和 SHA-256，产物 `npm-packages` 可下载检查。
3. 再次运行 **Release** 并勾选“发布到 npm”：按 `release.json` 的顺序先发平台包、再发主包（已发布的版本自动跳过），附带来源证明（provenance）；随后让 npmmirror 立即同步，等同步完成后从 npmmirror 和 npmjs 分别下载每个 tarball，核对与 `release.json` 一致。

每次推送到 `main` 时，**Test** 工作流会在 Windows、macOS 和 Linux 上运行测试。

### 在本机运行

需要 Node.js 20.12+、curl，以及 bsdtar（Windows 10+ 和 macOS 自带）或 unzip 与 7z。

- `npm run plan`：查看要下载的上游文件，不联网。
- `npm run pack`：下载并校验上游文件，生成 `dist/*.tgz`、`dist/ffmpeg.manifest.json`、`dist/ffprobe.manifest.json` 和 `dist/release.json`。可加 `-- --tool ffmpeg` 或 `-- --platform win32-x64` 只处理一部分；主包在该工具所有平台都生成后才会生成。
- `npm login` 后 `node scripts/publish.mjs publish`：按顺序发布，发布的就是上一步算过哈希的文件。
- `npx --yes cnpm sync <包名...>` 和 `node scripts/publish.mjs wait-mirror`：让 npmmirror 同步并等待完成。
- `npm run verify`：从 npmmirror 和 npmjs 分别下载每个 tarball 并核对。

下载缓存在 `.cache/`，中间文件在 `.work/`，输出在 `dist/`，均不提交。

## 升级 FFmpeg

```sh
npm run bump -- 9.1.1 --dry-run   # 先看会改成什么
npm run bump -- 9.1.1             # 写入 sources.json
```

脚本沿用每个平台现有的上游来源，找到指定版本的文件，读取上游发布的 SHA-256 和文件大小，同时更新 `ffmpegVersion`、`packageVersion`、`sourceTarball` 和 `licenseBaseUrl`。npm 包版本按上面的规则自动递增；只重新打包同一个 FFmpeg 版本，或要回退到更低版本时，用 `--package-version` 指定。某个上游还没发布该版本时脚本会停止，不写文件。

检查 `git diff sources.json` 后按上面的发布流程打包、发布、核对，最后提交 `sources.json`。用到这些包的应用还需要更新内置的下载地址和 SHA-256，从新主包的 `manifest.json` 中取。

martin-riedl.de 从 2027 年 1 月起不再发布 macOS Intel 正式版，之后升级 `darwin-x64` 需要换用 evermeet.cx 等来源。BtbN 提供 9.1 分支的 Windows arm64 构建后，可以增加原生的 `win32-arm64` 包并去掉别名。
