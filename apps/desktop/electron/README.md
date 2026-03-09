# OpenClaw Desktop Electron

桌面端 MVP 直接托管本地 OpenClaw runtime，并把 Gateway 提供的 Control UI 作为主工作界面加载到 Electron 窗口里。

## 当前能力

- 应用启动时自动拉起本地 OpenClaw runtime
- 使用 Electron 自带 Node 运行时，不依赖系统单独安装 Node
- 主窗口自动切到本地 Gateway Control UI，并用本地 token 免手填接入
- 默认把 Control UI 的界面语言预设为 `zh-CN`
- 若未配置模型 Provider 或接入渠道，进入 UI 后会自动弹出配置向导；可以本次跳过，但下次启动会再次提醒
- 原生菜单 `运行时 -> 打开配置向导` 可随时重新打开 UI 内向导
- 向导现在包含欢迎页、字段校验、完成后进入聊天，以及“填充测试消息”快捷动作
- 桌面菜单与页面浮层支持启动、停止、重启、打开日志/配置目录、导出诊断信息
- 已打包应用以纯壳模式运行，并直接携带对应平台/架构的专用 `openclaw` runtime bundle
- runtime 由仓库内 `runtime-bundles/<platform-arch>/openclaw/` 维护，推荐从 `vendor/openclaw/` 在目标平台本机构建生成
- 启动时直接复用 Electron 自带的 Node 能力执行内置 `openclaw.mjs`，不依赖系统单独安装 `node` 或 `npm`

## 开发

```bash
npm install
npm run dev
```

开发态与打包态现在都会优先使用仓库内准备好的 `runtime/openclaw/`；也可通过 `OPENCLAW_DESKTOP_RUNTIME_DIR` 显式覆盖 runtime 根目录。

## 打包前准备

默认情况下，`npm run package` 会先自动检查并初始化 `vendor/openclaw`，再在目标平台本机构建 vendored OpenClaw runtime：

```bash
npm run bootstrap:vendor-openclaw
npm run build:runtime-bundle
```

也可以显式指定：

```bash
npm run build:runtime-bundle:linux
npm run build:runtime-bundle:mac:arm64
npm run build:runtime-bundle:mac:x64
npm run build:runtime-bundle:win
```

然后执行打包：

```bash
npm run package
```

打包后的桌面应用以纯壳模式运行：推荐先把官方 `openclaw` 源码以 submodule 或 subtree 放到 `vendor/openclaw/`，再由 `scripts/build-runtime-bundle.mjs` 在目标平台本机构建出 `runtime-bundles/<platform-arch>/openclaw/`。打包前会把目标 bundle 复制到 `runtime/openclaw/`，并将这套 runtime 一起打进安装包。启动时直接用 Electron 自带的 Node 执行内置 `openclaw` 入口。runtime 与桌面应用一起发布，不再做壳内在线下载更新。

`npm run package` 会根据当前宿主平台输出对应安装包：

- macOS：输出到 `apps/desktop/electron/dist`，默认按当前机器架构产出 `dmg` 与 `zip`，文件名如 `openclaw-desktop-2026-03-08.dmg` / `openclaw-desktop-2026-03-08.zip`
- Windows：输出到 `apps/desktop/electron/dist`，默认产出 `nsis` 安装包，文件名如 `openclaw-desktop-2026-03-08.exe`
- Linux：输出到 `apps/desktop/electron/dist`，默认产出 `AppImage`，文件名如 `openclaw-desktop-2026-03-08.AppImage`

如需显式指定平台，也可以使用：`npm run package:mac`、`npm run package:mac:arm64`、`npm run package:mac:x64`、`npm run package:win`、`npm run package:linux`。其中 `package:mac` 默认按当前 Mac 的实际架构构建，避免 `universal` 合包时的 Mach-O 数量不一致报错。构建日期默认取当天本地日期，也可通过环境变量 `OPENCLAW_BUILD_DATE` 覆盖。

## 云备份（MinIO）

桌面端现在会在启动时自动拉起独立的云备份守护进程：

- 默认每 24 小时检查一次 `~/.openclaw`（或 `OPENCLAW_STATE_DIR`）是否需要备份；仅在到达间隔且检测到变化时打包为 `tar.gz`
- 将带版本号的备份对象上传到 MinIO/S3 兼容对象存储
- 通过心跳检测自动重启异常退出的备份守护进程
- 在 Electron 启动页可查看云端版本列表，并执行一键回滚 `~/.openclaw`
- 在应用退出或用户主动终止进程时，会先检查是否到达备份条件；如需备份则先完成备份，再关闭守护进程

默认目标：

- Endpoint：`http://192.168.0.107:9000`
- Access Key：`minioadmin`
- Secret Key：`minioadmin`
- Bucket：`openclaw-state-backups`

可在应用菜单 `云备份` 中手动触发“立即备份 / 启停 / 重启 / 打开日志目录”。

## 可选环境变量

- `OPENCLAW_DESKTOP_RUNTIME_DIR`：指定已经构建好的 OpenClaw runtime 目录
- `OPENCLAW_STATE_DIR`：指定 OpenClaw 状态目录；默认是 `~/.openclaw`
- `OPENCLAW_GATEWAY_TOKEN`：显式指定本地 Gateway token；未设置时桌面应用会自动生成并写入 `~/.openclaw/openclaw.json`
- `OPENCLAW_BACKUP_DISABLED=1`：禁用云备份守护进程
- `OPENCLAW_BACKUP_MINIO_ENDPOINT`：覆盖 MinIO/S3 兼容对象存储地址
- `OPENCLAW_BACKUP_MINIO_ACCESS_KEY` / `OPENCLAW_BACKUP_MINIO_SECRET_KEY`：覆盖对象存储凭证
- `OPENCLAW_BACKUP_MINIO_BUCKET`：覆盖备份 bucket 名称
- `OPENCLAW_BACKUP_MINIO_PREFIX`：覆盖对象前缀（默认 `openclaw-desktop`）
- `OPENCLAW_BACKUP_INTERVAL_MS`：备份检查间隔（默认 24 小时，仅在到达间隔且检测到目录变化时才上传）
- `OPENCLAW_BACKUP_RETRY_MS`：备份失败后的重试间隔
