const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, Menu, Tray, ipcMain, shell } = require('electron');

const { BackupManager } = require('./backup-manager');
const { applyLinuxDisplayPreferences } = require('./linux-display');
const { RuntimeManager } = require('./runtime-manager');
const { createShutdownController } = require('./shutdown');
const { buildTrayMenuTemplate, createTrayIcon } = require('./tray');

const isMac = process.platform === 'darwin';
const devAppRoot = path.resolve(__dirname, '../../');

let mainWindow = null;
let runtimeManager = null;
let backupManager = null;
let tray = null;
let quitting = false;
let shutdownController = null;
let restorePromise = null;

const APP_USER_DATA_DIRNAME = 'openclaw-desktop';
const LEGACY_APP_USER_DATA_DIRNAME = 'OpenClaw Desktop';

function shouldDisableHardwareAcceleration(env = process.env, platform = process.platform) {
  return platform === 'linux' && env.OPENCLAW_DESKTOP_DISABLE_GPU === '1';
}

function configureUserDataPath() {
  const appDataDir = app.getPath('appData');
  const userDataDir = path.join(appDataDir, APP_USER_DATA_DIRNAME);
  const legacyUserDataDir = path.join(appDataDir, LEGACY_APP_USER_DATA_DIRNAME);

  if (!fs.existsSync(userDataDir) && fs.existsSync(legacyUserDataDir)) {
    try {
      fs.renameSync(legacyUserDataDir, userDataDir);
    } catch (error) {
      console.warn('[desktop] Failed to migrate legacy userData directory:', error);
    }
  }

  app.setPath('userData', userDataDir);
}

const RUNTIME_LABELS = {
  starting: '启动中',
  running: '运行中',
  stopping: '停止中',
  stopped: '已停止',
  crashed: '异常重试',
};

const BACKUP_LABELS = {
  starting: '启动中',
  running: '运行中',
  'backing-up': '备份中',
  degraded: '异常待恢复',
  stopping: '停止中',
  stopped: '已停止',
  crashed: '异常重启',
  disabled: '已禁用',
  restoring: '回滚中',
};

const RUNTIME_UPDATE_BUSY_PHASES = new Set([
  'checking-local',
  'finalizing',
  'starting-runtime',
  'stopping-runtime',
  'stopping-existing-runtime',
  'updating-runtime',
]);

function isNavigationAbort(error) {
  return Boolean(
    error
      && (error.code === 'ERR_ABORTED'
        || error.errno === -3
        || String(error.message || '').includes('ERR_ABORTED (-3)')),
  );
}

function logNavigationError(label, error) {
  if (isNavigationAbort(error)) {
    return;
  }
  console.error(`[desktop] Failed to ${label}:`, error);
}

function getSplashPath() {
  return path.join(devAppRoot, 'renderer', 'splash.html');
}

function getSplashUrl() {
  return pathToFileURL(getSplashPath()).toString();
}

function isSplashLoaded(targetWindow = mainWindow) {
  if (!targetWindow || targetWindow.isDestroyed()) {
    return false;
  }
  const currentUrl = targetWindow.webContents.getURL();
  return currentUrl === getSplashUrl();
}

function requestOpenSetupWizard() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send('desktop-setup:open');
}

function getRuntimeState() {
  return runtimeManager?.getState().state ?? 'stopped';
}

function getBackupState() {
  return backupManager?.getState().state ?? 'disabled';
}

function getIsWindowVisible() {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
}

function getRuntimeLabel() {
  return RUNTIME_LABELS[getRuntimeState()] || '未就绪';
}

function getBackupLabel() {
  return BACKUP_LABELS[getBackupState()] || '未知';
}

function buildDesktopState() {
  const runtimeState = runtimeManager?.getState() || { state: 'stopped', lastError: null };
  return {
    ...runtimeState,
    backup: backupManager?.getState() || null,
  };
}

function syncDockVisibility() {
  if (!app.dock) {
    return;
  }
  if (getIsWindowVisible()) {
    app.dock.show();
    return;
  }
  app.dock.hide();
}

function updateTrayMenu() {
  if (!tray) {
    return;
  }

  const handlers = {
    'toggle-window': () => {
      if (getIsWindowVisible()) {
        mainWindow.hide();
        return;
      }
      showMainWindow();
    },
    'open-setup': () => showMainWindow({ openSetup: true }),
    'start-runtime': () => void runtimeManager?.start(),
    'restart-runtime': () => void runtimeManager?.restart(),
    'stop-runtime': () => void runtimeManager?.stop(),
    'open-config': () => void runtimeManager?.openConfigDir(),
    'open-logs': () => void runtimeManager?.openLogsDir(),
    quit: () => {
      void requestAppShutdown();
    },
  };

  const template = buildTrayMenuTemplate({
    isWindowVisible: getIsWindowVisible(),
    runtimeState: getRuntimeState(),
  }).map((item) => {
    if (!item.id) {
      return item;
    }
    return {
      ...item,
      click: handlers[item.id],
    };
  });

  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip(`OpenClaw Desktop · ${getRuntimeLabel()} · 备份:${getBackupLabel()}`);
  syncDockVisibility();
}

function syncWindowToRuntimeState() {
  if (getRuntimeState() === 'running') {
    return loadGatewayUi();
  }
  return loadSplash();
}

function requestAppShutdown() {
  if (!shutdownController) {
    quitting = true;
    app.quit();
    return Promise.resolve();
  }
  return shutdownController.requestShutdown();
}

function showMainWindow({ openSetup = false, showSplash = false } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    void (showSplash ? loadSplash() : syncWindowToRuntimeState());
  } else if (showSplash) {
    void loadSplash();
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();

  if (openSetup) {
    requestOpenSetupWizard();
  }

  updateTrayMenu();
}

function createTray() {
  if (tray) {
    return tray;
  }

  tray = new Tray(createTrayIcon());
  tray.on('click', () => showMainWindow());
  tray.on('double-click', () => showMainWindow());
  updateTrayMenu();
  return tray;
}

function buildMenu() {
  const runtimeSnapshot = runtimeManager?.getState() || { state: 'stopped', runtimeTask: null };
  const runtimeUpdateBusy = runtimeSnapshot.state === 'starting'
    || runtimeSnapshot.state === 'stopping'
    || RUNTIME_UPDATE_BUSY_PHASES.has(runtimeSnapshot.runtimeTask?.phase);
  const canUpdateRuntime = Boolean(runtimeManager?.supportsManagedRuntimeUpdates?.()) && !runtimeUpdateBusy;
  const backupState = getBackupState();
  const backupEnabled = backupManager?.getState().enabled !== false;
  const backupBusy = backupState === 'starting' || backupState === 'stopping' || backupState === 'backing-up' || backupState === 'restoring';
  const backupRunning = backupState === 'running' || backupState === 'backing-up' || backupState === 'degraded';

  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about', label: '关于 OpenClaw Desktop' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide', label: '隐藏 OpenClaw Desktop' },
              { role: 'hideOthers', label: '隐藏其他' },
              { role: 'unhide', label: '全部显示' },
              { type: 'separator' },
              { role: 'quit', label: '退出' },
            ],
          },
        ]
      : []),
    {
      label: '配置',
      submenu: [
        { label: '打开配置向导', click: () => requestOpenSetupWizard() },
        { label: '打开配置目录', click: () => void runtimeManager.openConfigDir() },
      ],
    },
    {
      label: '运行时',
      submenu: [
        { label: '打开配置向导', click: () => requestOpenSetupWizard() },
        { type: 'separator' },
        { label: '启动 OpenClaw', click: () => void runtimeManager.start() },
        { label: '重启 OpenClaw', click: () => void runtimeManager.restart() },
        {
          label: '在线更新并重启',
          enabled: canUpdateRuntime,
          click: () => {
            showMainWindow({ showSplash: true });
            void runtimeManager.updateRuntime();
          },
        },
        { label: '停止 OpenClaw', click: () => void runtimeManager.stop() },
        { type: 'separator' },
        { label: '打开配置目录', click: () => void runtimeManager.openConfigDir() },
        { label: '打开日志目录', click: () => void runtimeManager.openLogsDir() },
        {
          label: '导出诊断信息',
          click: async () => {
            const result = await runtimeManager.exportDiagnostics();
            await shell.showItemInFolder(result.filePath);
          },
        },
      ],
    },
    {
      label: '云备份',
      submenu: [
        { label: `状态：${getBackupLabel()}`, enabled: false },
        { label: '打开备份与回滚页', click: () => showMainWindow({ showSplash: true }) },
        {
          label: '立即备份 ~/.openclaw',
          enabled: backupEnabled && backupState !== 'stopping',
          click: () => void backupManager?.backupNow(),
        },
        { type: 'separator' },
        {
          label: '启动云备份守护进程',
          enabled: backupEnabled && !backupRunning && !backupBusy,
          click: () => void backupManager?.start({ reason: 'menu-start' }),
        },
        {
          label: '重启云备份守护进程',
          enabled: backupEnabled && !backupBusy,
          click: () => void backupManager?.restart(),
        },
        {
          label: '停止云备份守护进程',
          enabled: backupEnabled && backupRunning && !backupBusy,
          click: () => void backupManager?.stop({ finalBackup: true }),
        },
        { type: 'separator' },
        {
          label: '打开云备份日志目录',
          click: () => void backupManager?.openLogsDir(),
        },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'reload', label: '重新载入' },
        { role: 'forceReload', label: '强制重新载入' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function loadSplash() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const targetWindow = mainWindow;
  if (isSplashLoaded(targetWindow)) {
    return;
  }
  try {
    await targetWindow.loadFile(getSplashPath());
  } catch (error) {
    if (targetWindow !== mainWindow || targetWindow.isDestroyed()) {
      return;
    }
    logNavigationError('load splash', error);
  }
}

async function loadGatewayUi() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const targetWindow = mainWindow;
  const connection = runtimeManager.getConnectionInfo();
  const targetUrl = connection.token
    ? `${connection.httpBaseUrl}/#token=${encodeURIComponent(connection.token)}`
    : `${connection.httpBaseUrl}/`;
  const currentUrl = targetWindow.webContents.getURL();
  if (currentUrl.startsWith(connection.httpBaseUrl)) {
    return;
  }

  try {
    await targetWindow.loadURL(targetUrl);
  } catch (error) {
    if (targetWindow !== mainWindow || targetWindow.isDestroyed()) {
      return;
    }
    logNavigationError('load gateway UI', error);
  }
}

async function openGatewayHome() {
  showMainWindow();
  if (getRuntimeState() !== 'running') {
    await runtimeManager?.start({ reason: 'open-home' });
  }
  await loadGatewayUi();
  return buildDesktopState();
}

async function restoreBackupVersion(objectName) {
  if (!objectName) {
    throw new Error('restoreBackupVersion requires objectName');
  }
  if (restorePromise) {
    return restorePromise;
  }

  restorePromise = (async () => {
    let backupRestarted = false;
    showMainWindow({ showSplash: true });
    await loadSplash();
    await runtimeManager?.stop();
    await backupManager?.stop({ finalBackup: false });

    try {
      const result = await backupManager?.restoreBackup({ objectName, createSafetyArchive: true });
      await backupManager?.start({ reason: 'post-restore' });
      backupRestarted = true;
      await runtimeManager?.start({ reason: 'post-restore' });
      return result;
    } catch (error) {
      if (!backupRestarted) {
        await backupManager?.start({ reason: 'restore-failed-recover' }).catch(() => null);
      }
      throw error;
    }
  })().finally(() => {
    restorePromise = null;
    buildMenu();
    broadcastState();
    updateTrayMenu();
  });

  return restorePromise;
}

function broadcastState() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send('desktop-runtime:state-changed', buildDesktopState());
}

function attachRuntimeEvents() {
  runtimeManager.on('state', (nextState) => {
    buildMenu();
    broadcastState();
    updateTrayMenu();
    void (async () => {
      if (nextState.state === 'running') {
        await loadGatewayUi();
        return;
      }
      if (!quitting) {
        await loadSplash();
      }
    })();
  });

  runtimeManager.on('setup-status', () => {
    buildMenu();
    broadcastState();
    updateTrayMenu();
  });
}

function attachBackupEvents() {
  backupManager.on('state', () => {
    buildMenu();
    broadcastState();
    updateTrayMenu();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    title: 'OpenClaw Desktop',
    show: false,
    backgroundColor: '#0b1020',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow.show();
    updateTrayMenu();
  });

  mainWindow.on('show', () => updateTrayMenu());
  mainWindow.on('hide', () => updateTrayMenu());
  mainWindow.on('close', (event) => {
    if (quitting) {
      return;
    }
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    updateTrayMenu();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  void loadSplash();
}

function registerIpc() {
  ipcMain.handle('desktop-runtime:get-state', async () => buildDesktopState());
  ipcMain.handle('desktop-runtime:start', async () => runtimeManager.start());
  ipcMain.handle('desktop-runtime:stop', async () => runtimeManager.stop());
  ipcMain.handle('desktop-runtime:restart', async () => runtimeManager.restart());
  ipcMain.handle('desktop-runtime:update', async () => {
    showMainWindow({ showSplash: true });
    return runtimeManager.updateRuntime();
  });
  ipcMain.handle('desktop-runtime:get-connection-info', async () => runtimeManager.getConnectionInfo());
  ipcMain.handle('desktop-runtime:open-home', async () => openGatewayHome());
  ipcMain.handle('desktop-runtime:open-config-dir', async () => runtimeManager.openConfigDir());
  ipcMain.handle('desktop-runtime:open-logs-dir', async () => runtimeManager.openLogsDir());
  ipcMain.handle('desktop-runtime:export-diagnostics', async () => runtimeManager.exportDiagnostics());
  ipcMain.handle('desktop-setup:get-status', async () => runtimeManager.getSetupStatus());
  ipcMain.handle('desktop-setup:apply-provider', async (_event, payload) => runtimeManager.applyProviderSetup(payload));
  ipcMain.handle('desktop-setup:apply-channel', async (_event, payload) => runtimeManager.applyChannelSetup(payload));
  ipcMain.handle('desktop-backup:start', async () => backupManager.start({ reason: 'ipc-start' }));
  ipcMain.handle('desktop-backup:stop', async () => backupManager.stop({ finalBackup: true }));
  ipcMain.handle('desktop-backup:restart', async () => backupManager.restart());
  ipcMain.handle('desktop-backup:backup-now', async () => backupManager.backupNow());
  ipcMain.handle('desktop-backup:list', async () => backupManager.listBackups());
  ipcMain.handle('desktop-backup:restore', async (_event, payload) => restoreBackupVersion(payload?.objectName));
  ipcMain.handle('desktop-backup:open-logs-dir', async () => backupManager.openLogsDir());
}

applyLinuxDisplayPreferences({ app });

if (shouldDisableHardwareAcceleration()) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
}

app.setName('OpenClaw Desktop');
configureUserDataPath();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });

  app.whenReady().then(async () => {
    runtimeManager = new RuntimeManager({ app, shell, devAppRoot });
    backupManager = new BackupManager({ app, shell });
    shutdownController = createShutdownController({
      onStart: () => {
        quitting = true;
        updateTrayMenu();
        buildMenu();
      },
      stopRuntime: async () => {
        await runtimeManager?.stop();
        await backupManager?.stop({ finalBackup: true });
      },
      destroyTray: () => {
        tray?.destroy();
        tray = null;
      },
      appQuit: () => app.quit(),
    });
    buildMenu();
    createTray();
    createWindow();
    registerIpc();
    attachRuntimeEvents();
    attachBackupEvents();
    broadcastState();
    await backupManager.start({ reason: 'app-startup' });
    await runtimeManager.start({ reason: 'app-startup' });
  });
}

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 || !getIsWindowVisible()) {
    showMainWindow();
    broadcastState();
  }
});

app.on('before-quit', (event) => {
  if (shutdownController?.handleBeforeQuit(event)) {
    return;
  }
  quitting = true;
});

app.on('window-all-closed', () => {
  buildMenu();
  updateTrayMenu();
});
