#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const workspaceRoot = path.resolve(appRoot, '../../..');
const vendorDefaultRoot = path.join(workspaceRoot, 'vendor', 'openclaw');
const require = createRequire(import.meta.url);

function formatBuildDate(date = new Date()) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function createBaseEnv() {
  return {
    ...process.env,
    OPENCLAW_BUILD_DATE: process.env.OPENCLAW_BUILD_DATE || formatBuildDate(),
    NODE_NO_WARNINGS: process.env.NODE_NO_WARNINGS || '1',
  };
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

function resolveTargetPlatform(args) {
  if (args.includes('--mac')) return 'darwin';
  if (args.includes('--win')) return 'win32';
  if (args.includes('--linux')) return 'linux';
  return process.platform;
}

function resolveTargetArch(args, platform) {
  if (args.includes('--arm64')) return 'arm64';
  if (args.includes('--x64')) return 'x64';
  if (args.includes('--universal')) {
    throw new Error('Universal packaging requires selecting a concrete runtime bundle arch first. Use --arm64 or --x64.');
  }
  if (platform === 'win32' && process.arch === 'ia32') return 'x64';
  return process.arch;
}

function resolveElectronBuilderCli() {
  return require.resolve('electron-builder/out/cli/cli.js');
}

function patchFile(filePath, transforms) {
  let source = fs.readFileSync(filePath, 'utf8');
  let changed = false;
  for (const [before, after] of transforms) {
    if (source.includes(after)) {
      continue;
    }
    if (source.includes(before)) {
      source = source.replace(before, after);
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(filePath, source, 'utf8');
  }
}

function patchElectronBuilderForUnixNode25() {
  if (process.platform === 'win32') {
    return;
  }

  const collectorPath = require.resolve('app-builder-lib/out/node-module-collector/nodeModulesCollector.js');
  patchFile(collectorPath, [[
    '                shell: true, // `true`` is now required: https://github.com/electron-userland/electron-builder/issues/9488',
    '                shell: process.platform === "win32", // keep shell for Windows .cmd handling; avoid empty stdout on Unix child_process + Node 25',
  ]]);

  const appFileCopierPath = require.resolve('app-builder-lib/out/util/appFileCopier.js');
  patchFile(appFileCopierPath, [[
    '    const pmApproaches = [await packager.getPackageManager(), node_module_collector_1.PM.TRAVERSAL];',
    '    const pmApproaches = process.platform === "win32" ? [await packager.getPackageManager(), node_module_collector_1.PM.TRAVERSAL] : [node_module_collector_1.PM.TRAVERSAL, await packager.getPackageManager()];',
  ]]);
}

function main() {
  const explicitTargetArgs = process.argv.slice(2);
  const platformArgs = explicitTargetArgs.length > 0 ? explicitTargetArgs : resolvePlatformArgs(process.platform);
  const targetPlatform = resolveTargetPlatform(platformArgs);
  const targetArch = resolveTargetArch(platformArgs, targetPlatform);
  const baseEnv = createBaseEnv();
  const vendorSourceRoot = process.env.OPENCLAW_VENDOR_DIR ? path.resolve(process.env.OPENCLAW_VENDOR_DIR) : vendorDefaultRoot;

  run(process.execPath, ['scripts/build-runtime-bundle.mjs', `--platform=${targetPlatform}`, `--arch=${targetArch}`, `--source=${vendorSourceRoot}`], baseEnv);

  run(process.execPath, ['scripts/prepare-runtime.mjs', `--platform=${targetPlatform}`, `--arch=${targetArch}`], baseEnv);
  run(process.execPath, ['scripts/build-ts.mjs'], baseEnv);
  patchElectronBuilderForUnixNode25();
  run(process.execPath, [resolveElectronBuilderCli(), ...platformArgs, '--publish', 'never'], baseEnv);
}

main();
