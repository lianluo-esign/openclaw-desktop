const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyLinuxDisplayPreferences,
  hasExplicitOzoneOverride,
  isHyprlandSession,
  isWaylandWithX11Fallback,
  shouldPreferXWayland,
} = require('../src/main/linux-display');

test('isHyprlandSession detects Hyprland environment markers', () => {
  assert.equal(isHyprlandSession({ HYPRLAND_INSTANCE_SIGNATURE: 'abc' }), true);
  assert.equal(isHyprlandSession({ XDG_CURRENT_DESKTOP: 'Hyprland' }), true);
  assert.equal(isHyprlandSession({ XDG_SESSION_DESKTOP: 'hyprland' }), true);
  assert.equal(isHyprlandSession({ XDG_CURRENT_DESKTOP: 'GNOME' }), false);
});

test('isWaylandWithX11Fallback detects mixed wayland/x11 sessions', () => {
  assert.equal(isWaylandWithX11Fallback({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }), true);
  assert.equal(isWaylandWithX11Fallback({ WAYLAND_DISPLAY: 'wayland-0' }), false);
  assert.equal(isWaylandWithX11Fallback({ DISPLAY: ':0' }), false);
});

test('hasExplicitOzoneOverride respects argv and env overrides', () => {
  assert.equal(hasExplicitOzoneOverride(['electron', '--ozone-platform=wayland'], {}), true);
  assert.equal(hasExplicitOzoneOverride(['electron'], { ELECTRON_OZONE_PLATFORM_HINT: 'auto' }), true);
  assert.equal(hasExplicitOzoneOverride(['electron'], { OPENCLAW_DESKTOP_OZONE_PLATFORM: 'wayland' }), true);
  assert.equal(hasExplicitOzoneOverride(['electron'], {}), false);
});

test('shouldPreferXWayland enables on Linux when Hyprland or Wayland+X11 is present without override', () => {
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
      argv: ['electron'],
      env: { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' },
    }),
    true,
  );
  assert.equal(
    shouldPreferXWayland({
      platform: 'linux',
      argv: ['electron', '--ozone-platform=wayland'],
      env: { XDG_CURRENT_DESKTOP: 'Hyprland', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' },
    }),
    false,
  );
  assert.equal(
    shouldPreferXWayland({
      platform: 'darwin',
      argv: ['electron'],
      env: { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' },
    }),
    false,
  );
});

test('applyLinuxDisplayPreferences appends x11 switches for Linux XWayland preference', () => {
  const appended = [];
  const env = { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' };
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
  assert.equal(env.XDG_SESSION_TYPE, 'x11');
  assert.equal('WAYLAND_DISPLAY' in env, false);
});
