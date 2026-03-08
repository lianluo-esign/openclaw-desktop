const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

const Minio = require('minio');
const tar = require('tar');

const {
  buildBackupObjectName,
  buildBackupVersion,
  buildLatestManifestObjectName,
  parseMinioEndpoint,
  sanitizeBackupConfig,
} = require('./common');

const FORCE_BACKUP_REASONS = new Set(['manual']);

function normalizeTimestamp(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function isBackupDue({ reason, lastSuccessfulBackupAt, intervalMs, now = Date.now() }) {
  if (FORCE_BACKUP_REASONS.has(reason)) {
    return true;
  }
  if (!lastSuccessfulBackupAt) {
    return true;
  }
  return now - lastSuccessfulBackupAt >= intervalMs;
}

function sendMessage(type, payload = {}) {
  if (typeof process.send === 'function') {
    process.send({ type, ...payload });
  }
}

function emitState(state) {
  sendMessage('state', { state });
}

async function collectStateSignature(stateDir) {
  const hash = createHash('sha256');
  let fileCount = 0;
  let dirCount = 0;
  let totalSize = 0;
  let latestMtimeMs = 0;

  async function walk(relativeDir) {
    const currentDir = path.join(stateDir, relativeDir);
    const entries = await fsp.readdir(currentDir, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
      const absolutePath = path.join(stateDir, relativePath);
      const stats = await fsp.lstat(absolutePath);
      latestMtimeMs = Math.max(latestMtimeMs, Number(stats.mtimeMs) || 0);

      if (entry.isDirectory()) {
        dirCount += 1;
        hash.update(`dir:${relativePath}:${stats.mode}:${Math.trunc(stats.mtimeMs)}\n`);
        await walk(relativePath);
        continue;
      }

      if (entry.isFile()) {
        fileCount += 1;
        totalSize += Number(stats.size) || 0;
        hash.update(`file:${relativePath}:${stats.size}:${stats.mode}:${Math.trunc(stats.mtimeMs)}\n`);
        continue;
      }

      if (entry.isSymbolicLink()) {
        const target = await fsp.readlink(absolutePath).catch(() => '');
        hash.update(`symlink:${relativePath}:${target}:${stats.mode}:${Math.trunc(stats.mtimeMs)}\n`);
        continue;
      }

      hash.update(`other:${relativePath}:${stats.mode}:${Math.trunc(stats.mtimeMs)}\n`);
    }
  }

  await fsp.mkdir(stateDir, { recursive: true });
  await walk('');

  const signature = hash.digest('hex');
  return {
    signature,
    fileCount,
    dirCount,
    totalSize,
    latestMtimeMs,
  };
}

function shouldBackupForReason({
  reason,
  lastUploadedSignature,
  currentSignature,
  lastSuccessfulBackupAt,
  intervalMs,
  now,
}) {
  if (FORCE_BACKUP_REASONS.has(reason)) {
    return true;
  }
  if (!isBackupDue({ reason, lastSuccessfulBackupAt, intervalMs, now })) {
    return false;
  }
  if (!lastUploadedSignature) {
    return true;
  }
  return currentSignature !== lastUploadedSignature;
}

function createDaemon(rawConfig) {
  const config = { ...rawConfig };
  const endpoint = parseMinioEndpoint(config.endpoint);
  const client = new Minio.Client({
    endPoint: endpoint.endPoint,
    port: endpoint.port,
    useSSL: endpoint.useSSL,
    accessKey: config.accessKey,
    secretKey: config.secretKey,
  });

  let stopped = false;
  let shuttingDown = false;
  let backupPromise = null;
  let pendingBackupReason = null;
  let backupTimer = null;
  let heartbeatTimer = null;
  let currentArchivePath = null;
  let lastObservedSignature = null;
  let lastUploadedSignature = null;

  const state = {
    state: config.enabled === false ? 'disabled' : 'starting',
    enabled: config.enabled !== false,
    lastError: null,
    startedAt: Date.now(),
    lastHeartbeatAt: null,
    lastBackupAt: null,
    lastBackupVersion: null,
    lastBackupObject: null,
    lastSuccessfulBackupAt: null,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    intervalMs: config.intervalMs,
    retryMs: config.retryMs,
    bucket: config.bucket,
    endpoint: config.endpoint,
    prefix: config.prefix,
    stateDir: config.stateDir,
    logPath: config.logPath,
    appVersion: config.appVersion,
    hostname: os.hostname(),
  };

  async function ensureBucket() {
    const exists = await client.bucketExists(config.bucket);
    if (!exists) {
      await client.makeBucket(config.bucket, 'us-east-1');
    }
  }

  async function loadPersistedBackupState() {
    if (!config.metadataPath) {
      return;
    }

    try {
      const raw = await fsp.readFile(config.metadataPath, 'utf8');
      const persisted = JSON.parse(raw);
      const lastBackupAt = normalizeTimestamp(persisted.lastBackupAt);
      lastUploadedSignature = typeof persisted.lastUploadedSignature === 'string' && persisted.lastUploadedSignature
        ? persisted.lastUploadedSignature
        : null;
      lastObservedSignature = lastUploadedSignature;
      state.lastBackupAt = lastBackupAt;
      state.lastSuccessfulBackupAt = lastBackupAt;
      state.lastBackupVersion = typeof persisted.lastBackupVersion === 'string' ? persisted.lastBackupVersion : null;
      state.lastBackupObject = typeof persisted.lastBackupObject === 'string' ? persisted.lastBackupObject : null;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async function persistBackupState() {
    if (!config.metadataPath) {
      return;
    }

    const payload = {
      lastBackupAt: state.lastBackupAt,
      lastBackupVersion: state.lastBackupVersion,
      lastBackupObject: state.lastBackupObject,
      lastUploadedSignature,
      updatedAt: new Date().toISOString(),
    };
    const buffer = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    const tempPath = `${config.metadataPath}.tmp`;

    await fsp.mkdir(path.dirname(config.metadataPath), { recursive: true });
    await fsp.writeFile(tempPath, buffer);
    await fsp.rename(tempPath, config.metadataPath);
  }

  function scheduleNextBackup(reason, waitMs) {
    clearTimeout(backupTimer);
    if (stopped || shuttingDown || config.enabled === false) {
      return;
    }
    backupTimer = setTimeout(() => {
      void inspectAndMaybeBackup(reason);
    }, waitMs);
  }

  function publishHeartbeat() {
    state.lastHeartbeatAt = Date.now();
    sendMessage('heartbeat', { at: state.lastHeartbeatAt });
  }

  async function createArchive(version) {
    await fsp.mkdir(config.artifactsDir, { recursive: true });
    const archivePath = path.join(config.artifactsDir, `${version}.tar.gz`);
    currentArchivePath = archivePath;
    await tar.c(
      {
        gzip: true,
        cwd: config.stateDir,
        file: archivePath,
        portable: true,
      },
      ['.'],
    );
    const stats = await fsp.stat(archivePath);
    return { archivePath, size: stats.size };
  }

  async function writeLatestManifest({ version, objectName, size, reason }) {
    const payload = {
      version,
      objectName,
      size,
      reason,
      backedUpAt: new Date().toISOString(),
      hostname: state.hostname,
      stateDir: config.stateDir,
      appVersion: config.appVersion,
    };
    const buffer = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await client.putObject(
      config.bucket,
      buildLatestManifestObjectName({ prefix: config.prefix, hostname: state.hostname }),
      buffer,
      buffer.length,
      { 'Content-Type': 'application/json' },
    );
  }

  async function performBackup(reason, { signature } = {}) {
    const stateSnapshot = signature ? { signature } : await collectStateSignature(config.stateDir);
    const version = buildBackupVersion(new Date());
    const objectName = buildBackupObjectName({
      prefix: config.prefix,
      hostname: state.hostname,
      version,
    });

    state.state = 'backing-up';
    state.lastError = null;
    emitState({ ...state });

    const { archivePath, size } = await createArchive(version);
    await ensureBucket();
    await client.fPutObject(config.bucket, objectName, archivePath, {
      'Content-Type': 'application/gzip',
      'X-Amz-Meta-Backup-Version': version,
      'X-Amz-Meta-Backup-Reason': reason,
      'X-Amz-Meta-Hostname': state.hostname,
      'X-Amz-Meta-App-Version': config.appVersion,
    });
    await writeLatestManifest({ version, objectName, size, reason });

    lastUploadedSignature = stateSnapshot.signature;
    lastObservedSignature = stateSnapshot.signature;
    state.state = 'running';
    state.lastBackupAt = Date.now();
    state.lastSuccessfulBackupAt = state.lastBackupAt;
    state.lastBackupVersion = version;
    state.lastBackupObject = objectName;
    await persistBackupState();
    emitState({ ...state });
    sendMessage('backup-complete', { version, objectName, size, reason, at: state.lastBackupAt });

    try {
      await fsp.rm(archivePath, { force: true });
    } catch {
      // ignore best-effort cleanup
    }
    currentArchivePath = null;
    scheduleNextBackup('scheduled', config.intervalMs);
  }

  async function requestBackup(reason, opts = {}) {
    if ((stopped || (shuttingDown && opts.allowDuringShutdown !== true)) || config.enabled === false) {
      return;
    }
    if (backupPromise) {
      pendingBackupReason = reason;
      return backupPromise;
    }

    backupPromise = performBackup(reason, opts).catch((error) => {
      state.state = 'degraded';
      state.lastError = String(error?.message || error);
      emitState({ ...state });
      sendMessage('backup-error', { error: state.lastError, reason });
      scheduleNextBackup('retry', config.retryMs);
    }).finally(async () => {
      backupPromise = null;
      const nextReason = pendingBackupReason;
      pendingBackupReason = null;
      if (nextReason && !stopped && !shuttingDown) {
        await delay(250);
        if (FORCE_BACKUP_REASONS.has(nextReason)) {
          void requestBackup(nextReason);
        } else {
          void inspectAndMaybeBackup(nextReason);
        }
      }
    });

    return backupPromise;
  }

  async function inspectAndMaybeBackup(reason, { allowDuringShutdown = false } = {}) {
    if (stopped || config.enabled === false) {
      return;
    }
    if (shuttingDown && !allowDuringShutdown) {
      return;
    }

    try {
      const snapshot = await collectStateSignature(config.stateDir);
      lastObservedSignature = snapshot.signature;

      if (!shouldBackupForReason({
        reason,
        lastUploadedSignature,
        currentSignature: snapshot.signature,
        lastSuccessfulBackupAt: state.lastSuccessfulBackupAt,
        intervalMs: config.intervalMs,
      })) {
        sendMessage('backup-skipped', {
          reason,
          at: Date.now(),
          signature: snapshot.signature,
        });
        scheduleNextBackup('scheduled', config.intervalMs);
        return;
      }

      await requestBackup(reason, { signature: snapshot.signature });
    } catch (error) {
      state.state = 'degraded';
      state.lastError = String(error?.message || error);
      emitState({ ...state });
      sendMessage('backup-error', { error: state.lastError, reason });
      scheduleNextBackup('retry', config.retryMs);
    }
  }

  async function shutdown(finalBackup) {
    shuttingDown = true;
    clearTimeout(backupTimer);
    clearInterval(heartbeatTimer);
    state.state = 'stopping';
    emitState({ ...state });
    if (finalBackup && config.enabled !== false) {
      await inspectAndMaybeBackup('shutdown', { allowDuringShutdown: true });
      if (backupPromise) {
        await backupPromise;
      }
    }
    if (backupPromise) {
      await backupPromise;
    }
    if (currentArchivePath) {
      try {
        await fsp.rm(currentArchivePath, { force: true });
      } catch {
        // ignore
      }
      currentArchivePath = null;
    }
    stopped = true;
    state.state = 'stopped';
    emitState({ ...state });
  }

  function handleMessage(message) {
    if (!message || typeof message !== 'object') {
      return;
    }
    if (message.type === 'backup-now') {
      void requestBackup(message.reason || 'manual');
      return;
    }
    if (message.type === 'shutdown') {
      void shutdown(message.finalBackup !== false).finally(() => process.exit(0));
    }
  }

  async function start() {
    await fsp.mkdir(config.artifactsDir, { recursive: true });
    await fsp.mkdir(path.dirname(config.logPath), { recursive: true });

    if (!fs.existsSync(config.stateDir)) {
      await fsp.mkdir(config.stateDir, { recursive: true });
    }

    await loadPersistedBackupState();

    process.on('message', handleMessage);
    process.on('SIGTERM', () => {
      void shutdown(true).finally(() => process.exit(0));
    });
    process.on('SIGINT', () => {
      void shutdown(true).finally(() => process.exit(0));
    });

    heartbeatTimer = setInterval(publishHeartbeat, config.heartbeatIntervalMs);
    publishHeartbeat();

    state.state = config.enabled === false ? 'disabled' : 'running';
    emitState({ ...state, config: sanitizeBackupConfig(config) });
    sendMessage('ready', { config: sanitizeBackupConfig(config) });

    if (config.enabled !== false) {
      scheduleNextBackup('startup', 2_000);
    }
  }

  return {
    start,
  };
}

async function main() {
  const raw = process.env.OPENCLAW_BACKUP_DAEMON_CONFIG;
  if (!raw) {
    throw new Error('OPENCLAW_BACKUP_DAEMON_CONFIG is required');
  }
  const daemon = createDaemon(JSON.parse(raw));
  await daemon.start();
}

if (require.main === module) {
  main().catch((error) => {
    sendMessage('fatal', { error: String(error?.stack || error) });
    process.exitCode = 1;
  });
}

module.exports = {
  collectStateSignature,
  createDaemon,
  isBackupDue,
  shouldBackupForReason,
};
