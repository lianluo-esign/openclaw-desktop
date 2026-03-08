const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');

const Minio = require('minio');
const tar = require('tar');

const {
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  buildBackupHostPrefix,
  buildBackupVersion,
  buildLatestManifestObjectName,
  parseBackupObjectName,
  parseMinioEndpoint,
  resolveBackupConfig,
  sanitizeBackupConfig,
} = require('./backup/common');
const { resolveDefaultStateDir } = require('./runtime-paths');

const RESTART_DELAYS_MS = [2_000, 5_000, 10_000, 20_000];

function isMissingObjectError(error) {
  return error?.code === 'NoSuchKey' || error?.code === 'NoSuchBucket' || error?.statusCode === 404;
}

async function readStream(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

class BackupManager extends EventEmitter {
  constructor({ app, shell }) {
    super();
    this.app = app;
    this.shell = shell;
    this.hostname = os.hostname();
    this.stateDir = resolveDefaultStateDir();
    this.userDataDir = app.getPath('userData');
    this.child = null;
    this.state = 'stopped';
    this.lastError = null;
    this.lastBackupAt = null;
    this.lastBackupVersion = null;
    this.lastBackupObject = null;
    this.lastRestoreAt = null;
    this.lastRestoreVersion = null;
    this.lastRestoreObject = null;
    this.lastHeartbeatAt = null;
    this.restartCount = 0;
    this.retryTimer = null;
    this.watchdogTimer = null;
    this.intentionalStop = false;
    this.config = resolveBackupConfig({
      stateDir: this.stateDir,
      userDataDir: this.userDataDir,
      appVersion: app.getVersion?.() || '0.1.0',
    });
    this.logPath = this.config.logPath;
  }

  getState() {
    return {
      state: this.state,
      enabled: this.config.enabled !== false,
      lastError: this.lastError,
      lastBackupAt: this.lastBackupAt,
      lastBackupVersion: this.lastBackupVersion,
      lastBackupObject: this.lastBackupObject,
      lastRestoreAt: this.lastRestoreAt,
      lastRestoreVersion: this.lastRestoreVersion,
      lastRestoreObject: this.lastRestoreObject,
      lastHeartbeatAt: this.lastHeartbeatAt,
      restartCount: this.restartCount,
      logPath: this.logPath,
      config: sanitizeBackupConfig(this.config),
    };
  }

  emitState(extra = {}) {
    const snapshot = {
      ...this.getState(),
      ...extra,
    };
    this.emit('state', snapshot);
  }

  setState(nextState, extra = {}) {
    this.state = nextState;
    if (Object.prototype.hasOwnProperty.call(extra, 'lastError')) {
      this.lastError = extra.lastError;
    }
    if (Object.prototype.hasOwnProperty.call(extra, 'lastBackupAt')) {
      this.lastBackupAt = extra.lastBackupAt;
    }
    if (Object.prototype.hasOwnProperty.call(extra, 'lastBackupVersion')) {
      this.lastBackupVersion = extra.lastBackupVersion;
    }
    if (Object.prototype.hasOwnProperty.call(extra, 'lastBackupObject')) {
      this.lastBackupObject = extra.lastBackupObject;
    }
    if (Object.prototype.hasOwnProperty.call(extra, 'lastRestoreAt')) {
      this.lastRestoreAt = extra.lastRestoreAt;
    }
    if (Object.prototype.hasOwnProperty.call(extra, 'lastRestoreVersion')) {
      this.lastRestoreVersion = extra.lastRestoreVersion;
    }
    if (Object.prototype.hasOwnProperty.call(extra, 'lastRestoreObject')) {
      this.lastRestoreObject = extra.lastRestoreObject;
    }
    if (Object.prototype.hasOwnProperty.call(extra, 'lastHeartbeatAt')) {
      this.lastHeartbeatAt = extra.lastHeartbeatAt;
    }
    this.emitState();
  }

  getDaemonEntry() {
    return path.join(__dirname, 'backup', 'daemon.js');
  }

  getHostPrefix() {
    return buildBackupHostPrefix({ prefix: this.config.prefix, hostname: this.hostname });
  }

  createMinioClient() {
    const endpoint = parseMinioEndpoint(this.config.endpoint);
    return new Minio.Client({
      endPoint: endpoint.endPoint,
      port: endpoint.port,
      useSSL: endpoint.useSSL,
      accessKey: this.config.accessKey,
      secretKey: this.config.secretKey,
    });
  }

  async bucketExists(client = this.createMinioClient()) {
    try {
      return await client.bucketExists(this.config.bucket);
    } catch (error) {
      if (error?.code === 'NoSuchBucket' || error?.statusCode === 404) {
        return false;
      }
      throw error;
    }
  }

  refreshWatchdog() {
    clearTimeout(this.watchdogTimer);
    const timeoutMs = this.config.heartbeatTimeoutMs || DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.watchdogTimer = setTimeout(() => {
      this.lastError = `Backup daemon heartbeat stalled for ${timeoutMs}ms`;
      this.setState('crashed', { lastError: this.lastError });
      if (this.child) {
        try {
          this.child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    }, timeoutMs);
  }

  handleChildMessage(message) {
    if (!message || typeof message !== 'object') {
      return;
    }
    if (message.type === 'heartbeat') {
      this.lastHeartbeatAt = message.at || Date.now();
      this.refreshWatchdog();
      this.emitState();
      return;
    }
    if (message.type === 'state' && message.state) {
      const next = message.state;
      if (next.state === 'running' || next.state === 'backing-up' || next.state === 'degraded') {
        this.restartCount = 0;
      }
      this.setState(next.state || this.state, {
        lastError: next.lastError ?? this.lastError,
        lastBackupAt: next.lastBackupAt ?? this.lastBackupAt,
        lastBackupVersion: next.lastBackupVersion ?? this.lastBackupVersion,
        lastBackupObject: next.lastBackupObject ?? this.lastBackupObject,
        lastHeartbeatAt: next.lastHeartbeatAt ?? this.lastHeartbeatAt,
      });
      return;
    }
    if (message.type === 'backup-complete') {
      this.restartCount = 0;
      this.setState('running', {
        lastError: null,
        lastBackupAt: message.at || Date.now(),
        lastBackupVersion: message.version,
        lastBackupObject: message.objectName,
      });
      return;
    }
    if (message.type === 'backup-error') {
      this.setState('degraded', { lastError: message.error || 'Backup failed' });
      return;
    }
    if (message.type === 'fatal') {
      this.setState('crashed', { lastError: message.error || 'Backup daemon crashed' });
    }
  }

  scheduleRestart(reason) {
    clearTimeout(this.retryTimer);
    if (!this.config.enabled) {
      this.setState('disabled', { lastError: reason });
      return;
    }
    const delay = RESTART_DELAYS_MS[Math.min(this.restartCount, RESTART_DELAYS_MS.length - 1)];
    this.restartCount += 1;
    this.setState('crashed', { lastError: `${reason}; retrying in ${delay / 1000}s` });
    this.retryTimer = setTimeout(() => {
      void this.start({ reason: 'auto-restart' });
    }, delay);
  }

  async start({ reason = 'manual-start' } = {}) {
    if (!this.config.enabled) {
      this.setState('disabled', { lastError: null });
      return this.getState();
    }
    if (
      this.child
      || this.state === 'starting'
      || this.state === 'running'
      || this.state === 'backing-up'
      || this.state === 'restoring'
    ) {
      return this.getState();
    }

    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.intentionalStop = false;
    fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
    const out = fs.createWriteStream(this.logPath, { flags: 'a' });

    this.setState('starting', { lastError: null });
    const child = fork(this.getDaemonEntry(), [], {
      execPath: process.execPath,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        OPENCLAW_BACKUP_DAEMON_CONFIG: JSON.stringify(this.config),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    this.child = child;
    this.childLogStream = out;
    child.stdout?.pipe(out, { end: false });
    child.stderr?.pipe(out, { end: false });
    child.on('message', (message) => this.handleChildMessage(message));
    this.refreshWatchdog();

    child.once('exit', (code, signal) => {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
      this.child = null;
      out.end();

      if (this.intentionalStop) {
        this.setState('stopped', { lastError: null });
        return;
      }

      this.scheduleRestart(`Backup daemon exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
    });

    child.once('error', (error) => {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
      this.child = null;
      out.end();
      this.scheduleRestart(`Failed to spawn backup daemon: ${error.message}`);
    });

    return this.getState();
  }

  sendCommand(message) {
    if (!this.child || !this.child.connected) {
      return false;
    }
    this.child.send(message);
    return true;
  }

  async backupNow() {
    if (!this.child) {
      await this.start({ reason: 'manual-backup' });
    }
    this.sendCommand({ type: 'backup-now', reason: 'manual' });
    return this.getState();
  }

  async stop({ finalBackup = true } = {}) {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    clearTimeout(this.watchdogTimer);
    this.watchdogTimer = null;

    if (!this.child) {
      this.setState(this.state === 'restoring' ? 'restoring' : 'stopped', { lastError: null });
      return this.getState();
    }

    this.intentionalStop = true;
    this.setState('stopping', { lastError: null });
    const child = this.child;

    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, 30_000);

      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      if (!this.sendCommand({ type: 'shutdown', finalBackup })) {
        try {
          child.kill('SIGTERM');
        } catch {
          clearTimeout(timeout);
          resolve();
        }
      }
    });

    return this.getState();
  }

  async restart() {
    await this.stop({ finalBackup: false });
    return this.start({ reason: 'manual-restart' });
  }

  async readLatestManifest(client = this.createMinioClient()) {
    if (!(await this.bucketExists(client))) {
      return null;
    }

    try {
      const stream = await client.getObject(
        this.config.bucket,
        buildLatestManifestObjectName({ prefix: this.config.prefix, hostname: this.hostname }),
      );
      return JSON.parse((await readStream(stream)).toString('utf8'));
    } catch (error) {
      if (isMissingObjectError(error)) {
        return null;
      }
      throw error;
    }
  }

  async listBackups() {
    const client = this.createMinioClient();
    if (!(await this.bucketExists(client))) {
      return { items: [], latest: null };
    }

    const latest = await this.readLatestManifest(client);
    const prefix = this.getHostPrefix();
    const objects = await new Promise((resolve, reject) => {
      const items = [];
      const stream = client.listObjectsV2(this.config.bucket, prefix, true);
      stream.on('data', (entry) => items.push(entry));
      stream.on('error', reject);
      stream.on('end', () => resolve(items));
    });

    const items = objects
      .map((entry) => {
        const parsed = parseBackupObjectName({
          prefix: this.config.prefix,
          hostname: this.hostname,
          objectName: entry.name,
        });
        if (!parsed) {
          return null;
        }
        return {
          objectName: entry.name,
          version: parsed.version,
          size: entry.size ?? null,
          lastModified: entry.lastModified ? new Date(entry.lastModified).toISOString() : null,
          isLatest: latest?.objectName === entry.name || latest?.version === parsed.version,
        };
      })
      .filter(Boolean)
      .sort((left, right) => right.version.localeCompare(left.version));

    return { items, latest };
  }

  async createSafetyArchive() {
    if (!fs.existsSync(this.stateDir)) {
      return null;
    }

    await fsp.mkdir(this.config.artifactsDir, { recursive: true });
    const safetyVersion = `pre-restore-${buildBackupVersion(new Date())}`;
    const archivePath = path.join(this.config.artifactsDir, `${safetyVersion}.tar.gz`);
    await tar.c(
      {
        gzip: true,
        cwd: this.stateDir,
        file: archivePath,
        portable: true,
      },
      ['.'],
    );
    return archivePath;
  }

  async restoreBackup({ objectName, createSafetyArchive = true } = {}) {
    if (!objectName) {
      throw new Error('restoreBackup requires objectName');
    }
    if (this.child) {
      throw new Error('backup daemon must be stopped before restore');
    }

    const parsed = parseBackupObjectName({
      prefix: this.config.prefix,
      hostname: this.hostname,
      objectName,
    });
    if (!parsed) {
      throw new Error(`Invalid backup object: ${objectName}`);
    }

    const client = this.createMinioClient();
    if (!(await this.bucketExists(client))) {
      throw new Error(`Backup bucket does not exist: ${this.config.bucket}`);
    }

    await fsp.mkdir(this.config.artifactsDir, { recursive: true });
    const downloadPath = path.join(this.config.artifactsDir, `restore-${parsed.version}.tar.gz`);
    let safetyArchivePath = null;

    this.setState('restoring', { lastError: null });

    try {
      if (createSafetyArchive) {
        safetyArchivePath = await this.createSafetyArchive();
      }

      await client.fGetObject(this.config.bucket, objectName, downloadPath);
      await fsp.rm(this.stateDir, { recursive: true, force: true });
      await fsp.mkdir(this.stateDir, { recursive: true });
      await tar.x({ file: downloadPath, cwd: this.stateDir, portable: true });

      const restoredAt = Date.now();
      this.setState('stopped', {
        lastError: null,
        lastRestoreAt: restoredAt,
        lastRestoreVersion: parsed.version,
        lastRestoreObject: objectName,
      });

      return {
        restoredAt,
        version: parsed.version,
        objectName,
        safetyArchivePath,
      };
    } catch (error) {
      this.setState('stopped', { lastError: String(error?.message || error) });
      throw error;
    } finally {
      try {
        await fsp.rm(downloadPath, { force: true });
      } catch {
        // ignore best-effort cleanup
      }
    }
  }

  async openLogsDir() {
    fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
    return this.shell.openPath(path.dirname(this.logPath));
  }
}

module.exports = {
  BackupManager,
};
