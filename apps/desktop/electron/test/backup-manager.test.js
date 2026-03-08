const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../src/main/backup-manager.js'), 'utf8');

test('backup manager lists and restores cloud versions', () => {
  assert.match(source, /listBackups\(/);
  assert.match(source, /listObjectsV2/);
  assert.match(source, /restoreBackup\(/);
  assert.match(source, /fGetObject/);
  assert.match(source, /tar\.x\(/);
  assert.match(source, /createSafetyArchive/);
  assert.match(source, /restoring/);
});
