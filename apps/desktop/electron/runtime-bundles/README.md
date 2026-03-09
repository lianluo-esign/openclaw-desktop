# Runtime Bundles

在这里按平台/架构维护桌面端专用的 OpenClaw runtime bundle。

推荐来源不是手工拷贝，而是把官方源码仓库放到：

- `vendor/openclaw/`

然后在目标平台本机执行：

- `node apps/desktop/electron/scripts/build-runtime-bundle.mjs --platform=linux --arch=x64`
- `node apps/desktop/electron/scripts/build-runtime-bundle.mjs --platform=darwin --arch=arm64`
- `node apps/desktop/electron/scripts/build-runtime-bundle.mjs --platform=darwin --arch=x64`
- `node apps/desktop/electron/scripts/build-runtime-bundle.mjs --platform=win32 --arch=x64`

目录结构：

- `runtime-bundles/linux-x64/openclaw/`
- `runtime-bundles/darwin-arm64/openclaw/`
- `runtime-bundles/darwin-x64/openclaw/`
- `runtime-bundles/win32-x64/openclaw/`

每个 `openclaw/` 目录都必须是完整可运行 bundle，至少包含：

- `openclaw.mjs`
- `package.json`
- `dist/entry.js` 或 `dist/entry.mjs`
- `dist/control-ui/index.html`
- `node_modules/`
- `docs/reference/templates/`

打包或开发启动前会由 `scripts/prepare-runtime.mjs` 将目标 bundle 复制到 `runtime/openclaw/`。
