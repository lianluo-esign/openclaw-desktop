const os = require('node:os');
const path = require('node:path');

const DEFAULT_BACKUP_BUCKET = 'openclaw-state-backups';
const DEFAULT_BACKUP_PREFIX = 'openclaw-desktop';
const DEFAULT_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BACKUP_RETRY_MS = 5 * 60 * 1000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10 * 1000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 35 * 1000;

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseMinioEndpoint(rawUrl) {
  const parsed = new URL(rawUrl);
  const useSSL = parsed.protocol === 'https:';
  const port = parsed.port ? Number.parseInt(parsed.port, 10) : useSSL ? 443 : 80;
  return {
    endPoint: parsed.hostname,
    port,
    useSSL,
    origin: parsed.origin,
  };
}

function sanitizePathSegment(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'default';
}

function buildBackupVersion(date = new Date()) {
  return date.toISOString().replaceAll('-', '').replaceAll(':', '').replace('.', '-');
}

function buildBackupHostPrefix({ prefix = DEFAULT_BACKUP_PREFIX, hostname = os.hostname() } = {}) {
  const safePrefix = sanitizePathSegment(prefix);
  const safeHost = sanitizePathSegment(hostname);
  return path.posix.join(safePrefix, safeHost);
}

function buildBackupObjectName({ prefix = DEFAULT_BACKUP_PREFIX, hostname = os.hostname(), version }) {
  return path.posix.join(buildBackupHostPrefix({ prefix, hostname }), `${version}.tar.gz`);
}

function buildLatestManifestObjectName({ prefix = DEFAULT_BACKUP_PREFIX, hostname = os.hostname() }) {
  return path.posix.join(buildBackupHostPrefix({ prefix, hostname }), 'latest.json');
}

function parseBackupObjectName({ prefix = DEFAULT_BACKUP_PREFIX, hostname = os.hostname(), objectName } = {}) {
  if (!objectName) {
    return null;
  }

  const hostPrefix = `${buildBackupHostPrefix({ prefix, hostname })}/`;
  if (!objectName.startsWith(hostPrefix) || !objectName.endsWith('.tar.gz')) {
    return null;
  }

  const fileName = objectName.slice(hostPrefix.length);
  if (!fileName || fileName.includes('/')) {
    return null;
  }

  const version = fileName.slice(0, -'.tar.gz'.length);
  if (!version) {
    return null;
  }

  return {
    objectName,
    version,
    hostname: sanitizePathSegment(hostname),
    prefix: sanitizePathSegment(prefix),
  };
}

function sanitizeBackupConfig(config) {
  return {
    endpoint: config.endpoint,
    bucket: config.bucket,
    prefix: config.prefix,
    stateDir: config.stateDir,
    artifactsDir: config.artifactsDir,
    logPath: config.logPath,
    intervalMs: config.intervalMs,
    retryMs: config.retryMs,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    heartbeatTimeoutMs: config.heartbeatTimeoutMs,
    enabled: config.enabled !== false,
  };
}

function resolveBackupConfig({
  env = process.env,
  stateDir,
  userDataDir,
  appVersion = '0.0.0',
} = {}) {
  if (!stateDir) {
    throw new Error('resolveBackupConfig requires stateDir');
  }
  if (!userDataDir) {
    throw new Error('resolveBackupConfig requires userDataDir');
  }

  const endpoint = env.OPENCLAW_BACKUP_MINIO_ENDPOINT?.trim() || 'http://192.168.0.107:9000';
  const accessKey = env.OPENCLAW_BACKUP_MINIO_ACCESS_KEY?.trim() || 'minioadmin';
  const secretKey = env.OPENCLAW_BACKUP_MINIO_SECRET_KEY?.trim() || 'minioadmin';
  const bucket = env.OPENCLAW_BACKUP_MINIO_BUCKET?.trim() || DEFAULT_BACKUP_BUCKET;
  const prefix = env.OPENCLAW_BACKUP_MINIO_PREFIX?.trim() || DEFAULT_BACKUP_PREFIX;
  const enabled = env.OPENCLAW_BACKUP_DISABLED !== '1';

  return {
    enabled,
    endpoint,
    accessKey,
    secretKey,
    bucket,
    prefix,
    appVersion,
    stateDir,
    artifactsDir: path.join(userDataDir, 'backup-artifacts'),
    metadataPath: path.join(userDataDir, 'backup-artifacts', 'latest-state.json'),
    logPath: path.join(userDataDir, 'logs', 'openclaw-backup-daemon.log'),
    intervalMs: normalizePositiveInteger(env.OPENCLAW_BACKUP_INTERVAL_MS, DEFAULT_BACKUP_INTERVAL_MS),
    retryMs: normalizePositiveInteger(env.OPENCLAW_BACKUP_RETRY_MS, DEFAULT_BACKUP_RETRY_MS),
    heartbeatIntervalMs: normalizePositiveInteger(
      env.OPENCLAW_BACKUP_HEARTBEAT_INTERVAL_MS,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
    ),
    heartbeatTimeoutMs: normalizePositiveInteger(
      env.OPENCLAW_BACKUP_HEARTBEAT_TIMEOUT_MS,
      DEFAULT_HEARTBEAT_TIMEOUT_MS,
    ),
  };
}

module.exports = {
  DEFAULT_BACKUP_BUCKET,
  DEFAULT_BACKUP_INTERVAL_MS,
  DEFAULT_BACKUP_PREFIX,
  DEFAULT_BACKUP_RETRY_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  buildBackupHostPrefix,
  buildBackupObjectName,
  buildBackupVersion,
  buildLatestManifestObjectName,
  parseBackupObjectName,
  parseMinioEndpoint,
  resolveBackupConfig,
  sanitizeBackupConfig,
  sanitizePathSegment,
};
