import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

function isHyprlandSession(env = process.env) {
  return Boolean(
    env.HYPRLAND_INSTANCE_SIGNATURE
      || env.HYPRLAND_CMD
      || String(env.XDG_CURRENT_DESKTOP || '').toLowerCase().includes('hyprland')
      || String(env.XDG_SESSION_DESKTOP || '').toLowerCase().includes('hyprland'),
  );
}

function hasExplicitOzoneOverride(argv = process.argv.slice(2), env = process.env) {
  return argv.some((arg) => arg.startsWith('--ozone-platform') || arg.startsWith('--ozone-platform-hint'))
    || Boolean(env.ELECTRON_OZONE_PLATFORM_HINT)
    || Boolean(env.OZONE_PLATFORM)
    || Boolean(env.OPENCLAW_DESKTOP_OZONE_PLATFORM);
}

const env = { ...process.env };
const extraArgs = [];

if (process.platform === 'linux' && isHyprlandSession(env) && !hasExplicitOzoneOverride(process.argv.slice(2), env)) {
  env.ELECTRON_OZONE_PLATFORM_HINT = 'x11';
  extraArgs.push('--ozone-platform=x11', '--ozone-platform-hint=x11');
}

const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const child = spawn(electronBinary, [...extraArgs, '.', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on('error', (error) => {
  console.error('[desktop] Failed to start Electron dev process:', error);
  process.exit(1);
});
