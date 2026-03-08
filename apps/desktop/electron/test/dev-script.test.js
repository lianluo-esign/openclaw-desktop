const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const script = fs.readFileSync(path.join(__dirname, '../scripts/dev.mjs'), 'utf8');

test('dev launcher forces x11 flags for Hyprland sessions before Electron starts', () => {
  assert.match(script, /ELECTRON_OZONE_PLATFORM_HINT = 'x11'/);
  assert.match(script, /--ozone-platform=x11/);
  assert.match(script, /--ozone-platform-hint=x11/);
  assert.match(script, /spawn\(electronBinary/);
});
