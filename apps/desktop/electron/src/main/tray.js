const path = require("node:path");
const { nativeImage } = require("electron");

const trayIconPath = path.join(__dirname, "../assets/tray-icon.png");

function createFallbackTrayIcon({ imageApi = nativeImage, platform = process.platform } = {}) {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
      <rect x="8" y="8" width="48" height="48" rx="14" fill="#111827" />
      <path d="M32 18c-7.732 0-14 6.268-14 14s6.268 14 14 14c5.11 0 9.58-2.738 12.018-6.823h-9.018a3 3 0 1 1 0-6h15c1.657 0 3 1.343 3 3 0 10.493-8.507 19-19 19s-19-8.507-19-19 8.507-19 19-19c4.85 0 9.275 1.818 12.636 4.81a3 3 0 1 1-3.993 4.48A12.93 12.93 0 0 0 32 18Z" fill="#F9FAFB" />
    </svg>
  `.trim();
  const image = imageApi.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
  const resized = image.resize({ width: 18, height: 18 });
  if (platform === "darwin") {
    resized.setTemplateImage(true);
  }
  return resized;
}

function createTrayIcon({ imageApi = nativeImage, platform = process.platform, iconPath = trayIconPath } = {}) {
  const image = imageApi.createFromPath(iconPath);
  if (image && !image.isEmpty()) {
    return image.resize({ width: 18, height: 18 });
  }
  return createFallbackTrayIcon({ imageApi, platform });
}

function buildTrayMenuTemplate({ isWindowVisible, runtimeState }) {
  const canStart = runtimeState === "stopped" || runtimeState === "crashed";
  const canRestart = runtimeState !== "starting" && runtimeState !== "stopping";
  const canStop = runtimeState !== "stopped" && runtimeState !== "stopping";

  return [
    { id: "toggle-window", label: isWindowVisible ? "隐藏窗口" : "显示 OpenClaw Desktop" },
    { label: "打开配置向导", id: "open-setup" },
    { type: "separator" },
    { label: "启动 OpenClaw", id: "start-runtime", enabled: canStart },
    { label: "重启 OpenClaw", id: "restart-runtime", enabled: canRestart },
    { label: "停止 OpenClaw", id: "stop-runtime", enabled: canStop },
    { type: "separator" },
    { label: "打开配置目录", id: "open-config" },
    { label: "打开日志目录", id: "open-logs" },
    { type: "separator" },
    { label: "退出", id: "quit" },
  ];
}

module.exports = {
  buildTrayMenuTemplate,
  createTrayIcon,
  trayIconPath,
};
