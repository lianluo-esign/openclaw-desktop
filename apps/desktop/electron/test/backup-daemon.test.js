const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { isBackupDue, shouldBackupForReason } = require('../src/main/backup/daemon');

const source = fs.readFileSync(path.join(__dirname, '../src/main/backup/daemon.js'), 'utf8');

test('backup daemon uploads tar archives and latest manifest', () => {
  assert.match(source, /new Minio\.Client/);
  assert.match(source, /tar\.c\(/);
  assert.match(source, /fPutObject/);
  assert.match(source, /buildLatestManifestObjectName/);
  assert.match(source, /shutdown/);
});

test('backup daemon checks state signatures and skips unchanged uploads', () => {
  assert.match(source, /collectStateSignature/);
  assert.match(source, /createHash\('sha256'\)/);
  assert.match(source, /shouldBackupForReason/);
  assert.match(source, /isBackupDue/);
  assert.match(source, /backup-skipped/);
  assert.match(source, /scheduleNextBackup\('scheduled', config\.intervalMs\)/);
});

test('backup daemon only treats scheduled backup as due after interval', () => {
  const now = Date.UTC(2026, 2, 8, 12, 0, 0);
  const intervalMs = 24 * 60 * 60 * 1000;

  assert.equal(isBackupDue({ reason: 'scheduled', lastSuccessfulBackupAt: null, intervalMs, now }), true);
  assert.equal(isBackupDue({ reason: 'manual', lastSuccessfulBackupAt: now, intervalMs, now }), true);
  assert.equal(isBackupDue({ reason: 'scheduled', lastSuccessfulBackupAt: now - intervalMs + 1_000, intervalMs, now }), false);
  assert.equal(isBackupDue({ reason: 'scheduled', lastSuccessfulBackupAt: now - intervalMs, intervalMs, now }), true);
});

test('backup daemon skips automatic shutdown backup when interval not reached', () => {
  const now = Date.UTC(2026, 2, 8, 12, 0, 0);
  const intervalMs = 24 * 60 * 60 * 1000;

  assert.equal(shouldBackupForReason({
    reason: 'shutdown',
    lastUploadedSignature: 'old-signature',
    currentSignature: 'new-signature',
    lastSuccessfulBackupAt: now - (12 * 60 * 60 * 1000),
    intervalMs,
    now,
  }), false);

  assert.equal(shouldBackupForReason({
    reason: 'shutdown',
    lastUploadedSignature: 'old-signature',
    currentSignature: 'new-signature',
    lastSuccessfulBackupAt: now - (25 * 60 * 60 * 1000),
    intervalMs,
    now,
  }), true);
});

test('backup daemon allows shutdown inspection during intentional exit', () => {
  assert.match(source, /inspectAndMaybeBackup\('shutdown', \{ allowDuringShutdown: true \}\)/);
  assert.match(source, /process\.on\('SIGINT', \(\) => \{\s+void shutdown\(true\)/);
});
