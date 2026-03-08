const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyLinuxDisplayPreferences,
  hasExplicitOzoneOverride,
  isHyprlandSession,
  shouldPreferXWayland,
} = require('../src/main/linux-display');

test('isHyprlandSession detects Hyprland environment markers', () => {
  assert.equal(isHyprlandSession({ HYPRLAND_INSTANCE_SIGNATURE: 'abc' }), true);
  assert.equal(isHyprlandSession({ XDG_CURRENT_DESKTOP: 'Hyprland' }), true);
  assert.equal(isHyprlandSession({ XDG_SESSION_DESKTOP: 'hyprland' }), true);
  assert.equal(isHyprlandSession({ XDG_CURRENT_DESKTOP: 'GNOME' }), false);
});

test('hasExplicitOzoneOverride respects argv and env overrides', () => {
  assert.equal(hasExplicitOzoneOverride(['electron', '--ozone-platform=wayland'], {}), true);
  assert.equal(hasExplicitOzoneOverride(['electron'], { ELECTRON_OZONE_PLATFORM_HINT: 'auto' }), true);
  assert.equal(hasExplicitOzoneOverride(['electron'], { OPENCLAW_DESKTOP_OZONE_PLATFORM: 'wayland' }), true);
  assert.equal(hasExplicitOzoneOverride(['electron'], {}), false);
});

test('shouldPreferXWayland only enables on Linux Hyprland without override', () => {
  assert.equal(
    shouldPreferXWayland({
      platform: 'linux',
      argv: ['electron'],
      env: { XDG_CURRENT_DESKTOP: 'Hyprland' },
    }),
    true,
  );
  assert.equal(
    shouldPreferXWayland({
      platform: 'linux',
      argv: ['electron', '--ozone-platform=wayland'],
      env: { XDG_CURRENT_DESKTOP: 'Hyprland' },
    }),
    false,
  );
  assert.equal(
    shouldPreferXWayland({
      platform: 'darwin',
      argv: ['electron'],
      env: { XDG_CURRENT_DESKTOP: 'Hyprland' },
    }),
    false,
  );
});

test('applyLinuxDisplayPreferences appends x11 switches for Hyprland defaults', () => {
  const appended = [];
  const env = { XDG_CURRENT_DESKTOP: 'Hyprland' };
  const changed = applyLinuxDisplayPreferences({
    app: { commandLine: { appendSwitch: (name, value) => appended.push([name, value]) } },
    platform: 'linux',
    argv: ['electron'],
    env,
  });

  assert.equal(changed, true);
  assert.deepEqual(appended, [
    ['ozone-platform', 'x11'],
    ['ozone-platform-hint', 'x11'],
  ]);
  assert.equal(env.ELECTRON_OZONE_PLATFORM_HINT, 'x11');
});
