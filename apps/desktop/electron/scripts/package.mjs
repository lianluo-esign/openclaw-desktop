#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');

function formatBuildDate(date = new Date()) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: appRoot,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function resolvePlatformArgs(platform) {
  if (platform === 'darwin') {
    return ['--mac'];
  }
  if (platform === 'win32') {
    return ['--win'];
  }
  return ['--linux'];
}

function main() {
  const buildDate = formatBuildDate();
  const env = {
    ...process.env,
    OPENCLAW_BUILD_DATE: process.env.OPENCLAW_BUILD_DATE || buildDate,
    NODE_NO_WARNINGS: process.env.NODE_NO_WARNINGS || '1',
  };

  const explicitTargetArgs = process.argv.slice(2);
  const platformArgs = explicitTargetArgs.length > 0 ? explicitTargetArgs : resolvePlatformArgs(process.platform);

  run('npm', ['run', 'prepare:runtime'], env);
  run('npx', ['electron-builder', ...platformArgs, '--publish', 'never'], env);
}

main();
