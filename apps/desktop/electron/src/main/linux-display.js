function hasExplicitOzoneOverride(argv = process.argv, env = process.env) {
  return argv.some((arg) => arg.startsWith('--ozone-platform') || arg.startsWith('--ozone-platform-hint'))
    || Boolean(env.ELECTRON_OZONE_PLATFORM_HINT)
    || Boolean(env.OZONE_PLATFORM)
    || Boolean(env.OPENCLAW_DESKTOP_OZONE_PLATFORM);
}

function isHyprlandSession(env = process.env) {
  return Boolean(
    env.HYPRLAND_INSTANCE_SIGNATURE
      || env.HYPRLAND_CMD
      || String(env.XDG_CURRENT_DESKTOP || '').toLowerCase().includes('hyprland')
      || String(env.XDG_SESSION_DESKTOP || '').toLowerCase().includes('hyprland'),
  );
}

function shouldPreferXWayland({ platform = process.platform, argv = process.argv, env = process.env } = {}) {
  if (platform !== 'linux') {
    return false;
  }
  if (!isHyprlandSession(env)) {
    return false;
  }
  if (hasExplicitOzoneOverride(argv, env)) {
    return false;
  }
  return true;
}

function applyLinuxDisplayPreferences({ app, platform = process.platform, argv = process.argv, env = process.env } = {}) {
  if (!app || typeof app.commandLine?.appendSwitch !== 'function') {
    return false;
  }
  if (!shouldPreferXWayland({ platform, argv, env })) {
    return false;
  }

  env.ELECTRON_OZONE_PLATFORM_HINT = 'x11';
  app.commandLine.appendSwitch('ozone-platform', 'x11');
  app.commandLine.appendSwitch('ozone-platform-hint', 'x11');
  return true;
}

module.exports = {
  applyLinuxDisplayPreferences,
  hasExplicitOzoneOverride,
  isHyprlandSession,
  shouldPreferXWayland,
};
