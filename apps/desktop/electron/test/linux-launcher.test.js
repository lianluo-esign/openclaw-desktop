const test = require('node:test');
const assert = require('node:assert/strict');

const { buildLinuxLauncherScript } = require('../src/main/linux-launcher');

test('buildLinuxLauncherScript wraps target binary and applies Hyprland x11 hint', () => {
  const script = buildLinuxLauncherScript('openclaw-desktop-bin');

  assert.match(script, /TARGET="\$\{SCRIPT_DIR\}\/openclaw-desktop-bin"/);
  assert.match(script, /HYPRLAND_INSTANCE_SIGNATURE/);
  assert.match(script, /ELECTRON_OZONE_PLATFORM_HINT=x11/);
  assert.match(script, /exec "\$TARGET" "\$@"/);
});
