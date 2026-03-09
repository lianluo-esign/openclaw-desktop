const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const script = fs.readFileSync(path.join(__dirname, '../scripts/dev.mjs'), 'utf8');

test('dev launcher forces x11 flags for Hyprland sessions before Electron starts', () => {
  assert.match(script, /ELECTRON_OZONE_PLATFORM_HINT = 'x11'/);
  assert.match(script, /XDG_SESSION_TYPE = 'x11'/);
  assert.match(script, /delete env\.WAYLAND_DISPLAY/);
  assert.match(script, /--ozone-platform=x11/);
  assert.match(script, /--ozone-platform-hint=x11/);
  assert.match(script, /spawn\(electronBinary/);
});

test('dev launcher disables chromium sandbox on linux by default', () => {
  assert.match(script, /OPENCLAW_DESKTOP_DISABLE_GPU = '1'/);
  assert.match(script, /--disable-dev-shm-usage/);
  assert.match(script, /--disable-gpu/);
  assert.match(script, /--disable-gpu-compositing/);
  assert.match(script, /OPENCLAW_DESKTOP_NO_SANDBOX = '1'/);
  assert.match(script, /--no-sandbox/);
  assert.match(script, /--disable-setuid-sandbox/);
});
