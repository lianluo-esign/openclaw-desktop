let currentSnapshot = null;
let backupVersions = [];
let restoreBusy = false;

function text(nodeId, value) {
  const node = document.getElementById(nodeId);
  if (node) {
    node.textContent = value || '-';
  }
}

function formatTime(value) {
  if (!value) {
    return '-';
  }
  try {
    return new Date(value).toLocaleString('zh-CN');
  } catch {
    return String(value);
  }
}

function formatBytes(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size <= 0) {
    return '-';
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  if (size < 1024 * 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function setBackupListStatus(message) {
  text('backup-list-status', message);
}

function syncBackupActions(snapshot = currentSnapshot) {
  const backupState = snapshot?.backup?.state;
  const backupBusy = ['starting', 'stopping', 'backing-up', 'restoring'].includes(backupState);
  const hasVersions = backupVersions.length > 0;

  document.getElementById('backup-now-btn').disabled = backupState === 'stopping' || backupState === 'restoring';
  document.getElementById('backup-restart-btn').disabled = backupBusy;
  document.getElementById('backup-stop-btn').disabled = backupState === 'stopping' || backupState === 'restoring' || backupState === 'stopped';
  document.getElementById('backup-refresh-btn').disabled = restoreBusy;
  document.getElementById('backup-versions-select').disabled = restoreBusy || !hasVersions;
  document.getElementById('backup-restore-btn').disabled = restoreBusy || backupBusy || !hasVersions;
}

function renderBackupVersions(result) {
  const select = document.getElementById('backup-versions-select');
  const items = Array.isArray(result?.items) ? result.items : [];
  backupVersions = items;
  select.innerHTML = '';

  if (items.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '暂无云端备份版本';
    select.appendChild(option);
    setBackupListStatus('暂无版本');
    syncBackupActions();
    return;
  }

  for (const item of items) {
    const option = document.createElement('option');
    option.value = item.objectName;
    option.textContent = [
      item.version + (item.isLatest ? '（最新）' : ''),
      formatTime(item.lastModified),
      formatBytes(item.size),
    ].join(' · ');
    select.appendChild(option);
  }

  const latestItem = items.find((item) => item.isLatest);
  if (latestItem) {
    select.value = latestItem.objectName;
  }

  setBackupListStatus(`云端版本 ${items.length} 个`);
  syncBackupActions();
}

function applyBackup(snapshot) {
  const backup = snapshot?.backup;
  const state = backup?.state || '未启动';
  text('backup-state', state);
  text('backup-endpoint', backup?.config?.endpoint);
  text('backup-bucket', backup?.config?.bucket);
  text('backup-version', backup?.lastBackupVersion);
  text('backup-object', backup?.lastBackupObject);
  text('backup-time', formatTime(backup?.lastBackupAt));
  text('backup-restore-version', backup?.lastRestoreVersion);
  text('backup-restore-time', formatTime(backup?.lastRestoreAt));
  syncBackupActions(snapshot);
}

function applyState(snapshot) {
  currentSnapshot = snapshot;
  const pill = document.getElementById('state-pill');
  const detail = document.getElementById('state-text');
  const errorNode = document.getElementById('state-error');
  const state = snapshot?.state || 'stopped';

  const labelMap = {
    starting: '启动中',
    running: '运行中',
    stopping: '停止中',
    stopped: '已停止',
    crashed: '异常重试',
  };

  pill.textContent = labelMap[state] || '未就绪';
  pill.className = `pill pill-${state}`;

  if (state === 'running') {
    detail.textContent = 'OpenClaw runtime 已经可用，主窗口会自动跳转到控制台。';
  } else if (state === 'starting') {
    detail.textContent = '正在启动本地 OpenClaw runtime，请稍候…';
  } else if (state === 'crashed') {
    detail.textContent = 'Runtime 启动失败或异常退出，系统会尝试自动恢复。';
  } else if (state === 'stopping') {
    detail.textContent = '正在停止本地 OpenClaw runtime…';
  } else {
    detail.textContent = 'Runtime 当前未运行，可以点击启动手动拉起。';
  }

  if (snapshot?.lastError) {
    errorNode.textContent = snapshot.lastError;
    errorNode.classList.remove('hidden');
  } else if (snapshot?.backup?.lastError) {
    errorNode.textContent = snapshot.backup.lastError;
    errorNode.classList.remove('hidden');
  } else {
    errorNode.textContent = '';
    errorNode.classList.add('hidden');
  }

  text('http-url', snapshot?.connection?.httpBaseUrl);
  text('ws-url', snapshot?.connection?.wsUrl);
  text('state-dir', snapshot?.stateDir);
  text('log-path', snapshot?.logPath);
  applyBackup(snapshot);
}

async function loadBackupVersions({ silent = false } = {}) {
  const runtime = window.desktopRuntime;
  if (!silent) {
    setBackupListStatus('正在读取云端版本…');
  }
  try {
    const result = await runtime.backupList();
    renderBackupVersions(result);
  } catch (error) {
    backupVersions = [];
    renderBackupVersions({ items: [] });
    setBackupListStatus(`读取失败：${error.message || error}`);
  }
}

async function handleRestoreClick() {
  const runtime = window.desktopRuntime;
  const select = document.getElementById('backup-versions-select');
  const objectName = select.value;
  const selected = backupVersions.find((item) => item.objectName === objectName);
  if (!objectName || !selected) {
    return;
  }

  const confirmed = window.confirm(
    `确认回滚到版本 ${selected.version} 吗？\n\n这会覆盖当前 ~/.openclaw，并自动重启本地 runtime。`,
  );
  if (!confirmed) {
    return;
  }

  restoreBusy = true;
  setBackupListStatus(`正在回滚 ${selected.version}…`);
  syncBackupActions();

  try {
    const result = await runtime.backupRestore({ objectName });
    const latest = await runtime.getState();
    applyState(latest);
    await loadBackupVersions({ silent: true });
    setBackupListStatus(`已恢复到 ${result.version}`);
  } catch (error) {
    setBackupListStatus(`回滚失败：${error.message || error}`);
  } finally {
    restoreBusy = false;
    syncBackupActions();
  }
}

async function bootstrap() {
  const runtime = window.desktopRuntime;
  const initial = await runtime.getState();
  applyState(initial);
  await loadBackupVersions();

  runtime.subscribe((snapshot) => {
    applyState(snapshot);
  });

  document.getElementById('start-btn').addEventListener('click', () => void runtime.start());
  document.getElementById('restart-btn').addEventListener('click', () => void runtime.restart());
  document.getElementById('stop-btn').addEventListener('click', () => void runtime.stop());
  document.getElementById('config-btn').addEventListener('click', () => void runtime.openConfigDir());
  document.getElementById('logs-btn').addEventListener('click', () => void runtime.openLogsDir());
  document.getElementById('diag-btn').addEventListener('click', async () => {
    const result = await runtime.exportDiagnostics();
    applyState({ ...(currentSnapshot || initial), lastError: `诊断文件已导出：${result.filePath}` });
  });
  document.getElementById('home-btn').addEventListener('click', () => void runtime.openHome());

  document.getElementById('backup-now-btn').addEventListener('click', () => void runtime.backupNow());
  document.getElementById('backup-restart-btn').addEventListener('click', () => void runtime.backupRestart());
  document.getElementById('backup-stop-btn').addEventListener('click', () => void runtime.backupStop());
  document.getElementById('backup-logs-btn').addEventListener('click', () => void runtime.openBackupLogsDir());
  document.getElementById('backup-refresh-btn').addEventListener('click', () => void loadBackupVersions());
  document.getElementById('backup-restore-btn').addEventListener('click', () => void handleRestoreClick());
}

void bootstrap();
