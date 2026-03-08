const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildBackupHostPrefix,
  buildBackupObjectName,
  buildBackupVersion,
  parseBackupObjectName,
  parseMinioEndpoint,
  resolveBackupConfig,
} = require('../src/main/backup/common');

test('parseMinioEndpoint resolves host port and protocol', () => {
  assert.deepEqual(parseMinioEndpoint('http://192.168.0.107:9000'), {
    endPoint: '192.168.0.107',
    port: 9000,
    useSSL: false,
    origin: 'http://192.168.0.107:9000',
  });
});

test('buildBackupVersion returns sortable timestamp string', () => {
  const value = buildBackupVersion(new Date('2026-03-07T12:34:56.789Z'));
  assert.equal(value, '20260307T123456-789Z');
});

test('buildBackupHostPrefix uses prefix and hostname', () => {
  const value = buildBackupHostPrefix({ prefix: 'desktop', hostname: 'my-host' });
  assert.equal(value, 'desktop/my-host');
});

test('buildBackupObjectName uses prefix and hostname', () => {
  const value = buildBackupObjectName({ prefix: 'desktop', hostname: 'my-host', version: 'v1' });
  assert.equal(value, 'desktop/my-host/v1.tar.gz');
});

test('parseBackupObjectName extracts version from object path', () => {
  const value = parseBackupObjectName({
    prefix: 'desktop',
    hostname: 'my-host',
    objectName: 'desktop/my-host/20260307T123456-789Z.tar.gz',
  });
  assert.deepEqual(value, {
    objectName: 'desktop/my-host/20260307T123456-789Z.tar.gz',
    version: '20260307T123456-789Z',
    hostname: 'my-host',
    prefix: 'desktop',
  });
});

test('parseBackupObjectName rejects unrelated object names', () => {
  assert.equal(
    parseBackupObjectName({
      prefix: 'desktop',
      hostname: 'my-host',
      objectName: 'desktop/other-host/20260307T123456-789Z.tar.gz',
    }),
    null,
  );
});

test('resolveBackupConfig uses provided state dir and defaults', () => {
  const config = resolveBackupConfig({
    env: {},
    stateDir: '/tmp/.openclaw',
    userDataDir: '/tmp/openclaw-user',
    appVersion: '0.1.0',
  });
  assert.equal(config.endpoint, 'http://192.168.0.107:9000');
  assert.equal(config.bucket, 'openclaw-state-backups');
  assert.equal(config.intervalMs, 24 * 60 * 60 * 1000);
  assert.equal(config.metadataPath, '/tmp/openclaw-user/backup-artifacts/latest-state.json');
  assert.equal(config.stateDir, '/tmp/.openclaw');
  assert.equal(config.appVersion, '0.1.0');
});
