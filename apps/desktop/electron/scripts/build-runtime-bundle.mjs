#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const workspaceRoot = path.resolve(appRoot, '../../..');
const runtimeBundlesRoot = path.join(appRoot, 'runtime-bundles');
const vendorDefaultRoot = path.join(workspaceRoot, 'vendor', 'openclaw');
const bootstrapScriptPath = path.join(appRoot, 'scripts', 'bootstrap-vendor-openclaw.mjs');

function parseArgs(argv) {
  const result = {};
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const [key, value] = raw.slice(2).split('=');
    if (!key) continue;
    result[key] = value ?? true;
  }
  return result;
}

function normalizePlatform(value) {
  if (!value) return process.platform;
  if (value === 'mac' || value === 'darwin') return 'darwin';
  if (value === 'win' || value === 'win32' || value === 'windows') return 'win32';
  if (value === 'linux') return 'linux';
  return value;
}

function normalizeArch(value) {
  if (!value) return process.arch;
  if (value === 'amd64') return 'x64';
  return value;
}

function resolveBundleId({ platform, arch }) {
  if (arch === 'universal') {
    throw new Error('universal bundle is not supported; build a concrete arch bundle such as darwin-arm64 or darwin-x64');
  }
  return `${platform}-${arch}`;
}

function resolveVendorRoot(args) {
  const candidate = args.source || process.env.OPENCLAW_VENDOR_DIR || vendorDefaultRoot;
  return path.resolve(candidate);
}

function exists(filePath) {
  return fs.existsSync(filePath);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolvePackageManager(sourcePkg) {
  const spec = typeof sourcePkg.packageManager === 'string' ? sourcePkg.packageManager.trim() : '';
  const [manager] = spec.split('@');
  return manager || 'npm';
}

function hasLockfile(sourceRoot, manager) {
  if (manager === 'pnpm') return exists(path.join(sourceRoot, 'pnpm-lock.yaml'));
  if (manager === 'yarn') return exists(path.join(sourceRoot, 'yarn.lock'));
  if (manager === 'bun') return exists(path.join(sourceRoot, 'bun.lock')) || exists(path.join(sourceRoot, 'bun.lockb'));
  return exists(path.join(sourceRoot, 'package-lock.json'));
}

function hasCorepack() {
  const result = spawnSync('corepack', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' });
  return result.status === 0;
}

function resolvePackageCommand(manager) {
  if (manager !== 'npm' && hasCorepack()) {
    return { command: 'corepack', prefixArgs: [manager] };
  }
  return { command: manager, prefixArgs: [] };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.status !== 0) {
    throw new Error(`command failed: ${command} ${args.join(' ')}`);
  }
}

function runPackageManager(manager, sourceRoot, args, env) {
  const { command, prefixArgs } = resolvePackageCommand(manager);
  run(command, [...prefixArgs, ...args], { cwd: sourceRoot, env });
}

function bootstrapVendorSource(sourceRoot) {
  run(process.execPath, [bootstrapScriptPath, `--source=${sourceRoot}`], { cwd: workspaceRoot, env: process.env });
}

function getRequiredRuntimePaths() {
  return [
    'openclaw.mjs',
    'package.json',
    path.join('dist', 'entry.js'),
    path.join('dist', 'control-ui', 'index.html'),
    'node_modules',
    path.join('docs', 'reference', 'templates', 'AGENTS.md'),
  ];
}

function isPathInsideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function collectBrokenSymlinks(root) {
  const broken = [];

  async function visit(current) {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const currentPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        const linkTarget = await fsp.readlink(currentPath);
        const resolvedTarget = path.resolve(path.dirname(currentPath), linkTarget);
        if (!exists(resolvedTarget)) {
          broken.push(currentPath);
        }
        continue;
      }
      if (entry.isDirectory()) {
        await visit(currentPath);
      }
    }
  }

  if (exists(root)) {
    await visit(root);
  }

  return broken;
}

async function assertRuntimeShape(runtimeRoot, label) {
  const missing = getRequiredRuntimePaths().filter((relativePath) => !exists(path.join(runtimeRoot, relativePath)));
  if (missing.length > 0) {
    throw new Error(`${label} is incomplete; missing: ${missing.join(', ')}`);
  }

  const brokenSymlinks = await collectBrokenSymlinks(runtimeRoot);
  if (brokenSymlinks.length > 0) {
    throw new Error(`${label} contains broken symlinks: ${brokenSymlinks.slice(0, 8).join(', ')}`);
  }
}

async function rmrf(target) {
  await fsp.rm(target, { recursive: true, force: true });
}

async function copyDir(source, target) {
  await fsp.mkdir(target, { recursive: true });
  const entries = await fsp.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await copyDir(sourcePath, targetPath);
      continue;
    }
    if (entry.isSymbolicLink()) {
      const linkTarget = await fsp.readlink(sourcePath);
      await rmrf(targetPath);
      await fsp.symlink(linkTarget, targetPath);
      continue;
    }
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    await fsp.copyFile(sourcePath, targetPath);
  }
}

async function copyPath(sourcePath, targetPath) {
  const stat = await fsp.lstat(sourcePath);
  if (stat.isDirectory()) {
    await copyDir(sourcePath, targetPath);
    return;
  }
  if (stat.isSymbolicLink()) {
    const linkTarget = await fsp.readlink(sourcePath);
    await rmrf(targetPath);
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    await fsp.symlink(linkTarget, targetPath);
    return;
  }
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  await fsp.copyFile(sourcePath, targetPath);
}

async function copySelectedEntries(sourceRoot, targetRoot) {
  const includeEntries = [
    'openclaw.mjs',
    'package.json',
    'LICENSE',
    'README.md',
    'CHANGELOG.md',
    'assets',
    'dist',
    'docs',
    'extensions',
    'node_modules',
    'skills',
  ];

  await fsp.mkdir(targetRoot, { recursive: true });
  for (const entry of includeEntries) {
    const sourcePath = path.join(sourceRoot, entry);
    if (!exists(sourcePath)) {
      continue;
    }
    const targetPath = path.join(targetRoot, entry);
    await copyPath(sourcePath, targetPath);
  }
}

async function materializeInternalSymlinkTargets(sourceRoot, targetRoot) {
  for (let pass = 0; pass < 8; pass += 1) {
    const brokenSymlinks = await collectBrokenSymlinks(targetRoot);
    if (brokenSymlinks.length === 0) {
      return;
    }

    let repaired = 0;
    for (const brokenPath of brokenSymlinks) {
      const relativeBrokenPath = path.relative(targetRoot, brokenPath);
      const sourceLinkPath = path.join(sourceRoot, relativeBrokenPath);
      let sourceStat;
      try {
        sourceStat = await fsp.lstat(sourceLinkPath);
      } catch {
        continue;
      }
      if (!sourceStat.isSymbolicLink()) {
        continue;
      }

      const linkTarget = await fsp.readlink(sourceLinkPath);
      const resolvedSourceTarget = path.resolve(path.dirname(sourceLinkPath), linkTarget);
      if (!exists(resolvedSourceTarget) || !isPathInsideRoot(sourceRoot, resolvedSourceTarget)) {
        continue;
      }

      const relativeResolvedTarget = path.relative(sourceRoot, resolvedSourceTarget);
      const targetResolvedPath = path.join(targetRoot, relativeResolvedTarget);
      if (exists(targetResolvedPath)) {
        continue;
      }

      await copyPath(resolvedSourceTarget, targetResolvedPath);
      repaired += 1;
    }

    if (repaired === 0) {
      break;
    }
  }

  const remainingBroken = await collectBrokenSymlinks(targetRoot);
  if (remainingBroken.length > 0) {
    throw new Error(`runtime bundle still contains broken symlinks after repair: ${remainingBroken.slice(0, 8).join(', ')}`);
  }
}

function resolveBundleMetaPath(bundleRoot) {
  return path.join(bundleRoot, '.openclaw-desktop-bundle.json');
}

async function readBundleMeta(bundleRoot) {
  try {
    return JSON.parse(await fsp.readFile(resolveBundleMetaPath(bundleRoot), 'utf8'));
  } catch {
    return null;
  }
}

async function writeBundleMeta(bundleRoot, payload) {
  await fsp.writeFile(resolveBundleMetaPath(bundleRoot), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function hasBuildTool(sourceRoot, toolName) {
  const candidates = [
    path.join(sourceRoot, 'node_modules', '.bin', toolName),
    path.join(sourceRoot, 'node_modules', `${toolName}.cmd`),
    path.join(sourceRoot, 'node_modules', toolName),
  ];
  return candidates.some((candidate) => exists(candidate));
}

function resolveSourceState(sourceRoot, sourcePkg) {
  const scripts = sourcePkg.scripts || {};
  const hasNodeModules = exists(path.join(sourceRoot, 'node_modules'));
  const hasDistEntry = exists(path.join(sourceRoot, 'dist', 'entry.js')) || exists(path.join(sourceRoot, 'dist', 'entry.mjs'));
  const hasControlUi = exists(path.join(sourceRoot, 'dist', 'control-ui', 'index.html'));
  const hasTypeScriptToolchain = hasBuildTool(sourceRoot, 'tsc');
  const hasRolldownToolchain = hasBuildTool(sourceRoot, 'rolldown');
  return {
    scripts,
    hasNodeModules,
    hasDistEntry,
    hasControlUi,
    hasTypeScriptToolchain,
    hasRolldownToolchain,
  };
}

function needsInstall(sourceState, args) {
  return args.force === true
    || args.force === 'true'
    || args['force-install'] === true
    || args['force-install'] === 'true'
    || !sourceState.hasNodeModules
    || !sourceState.hasTypeScriptToolchain
    || !sourceState.hasRolldownToolchain;
}

function needsBuild(sourceState, args) {
  return args.force === true || args.force === 'true' || args['force-build'] === true || args['force-build'] === 'true' || !sourceState.hasDistEntry || !sourceState.hasControlUi;
}

function installDependencies({ manager, sourceRoot, env, frozen }) {
  const installArgs = ['install'];
  if (manager === 'pnpm') {
    installArgs.push(frozen ? '--frozen-lockfile' : '--no-frozen-lockfile');
  } else if (manager === 'npm') {
    installArgs.push('--include=optional');
  }
  runPackageManager(manager, sourceRoot, installArgs, env);
}

function buildSource({ manager, sourceRoot, scripts, env }) {
  if (scripts.prepack) {
    runPackageManager(manager, sourceRoot, ['run', 'prepack'], env);
    return;
  }
  if (scripts.build) {
    runPackageManager(manager, sourceRoot, ['run', 'build'], env);
  }
  if (scripts['ui:build']) {
    runPackageManager(manager, sourceRoot, ['run', 'ui:build'], env);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const platform = normalizePlatform(args.platform || process.env.OPENCLAW_RUNTIME_PLATFORM);
  const arch = normalizeArch(args.arch || process.env.OPENCLAW_RUNTIME_ARCH);
  const bundleId = args['bundle-id'] || process.env.OPENCLAW_RUNTIME_BUNDLE_ID || resolveBundleId({ platform, arch });
  const sourceRoot = resolveVendorRoot(args);
  const packageJsonPath = path.join(sourceRoot, 'package.json');
  const bundleRoot = path.join(runtimeBundlesRoot, bundleId, 'openclaw');

  if (!exists(packageJsonPath) && args.bootstrap !== 'false') {
    bootstrapVendorSource(sourceRoot);
  }

  if (!exists(packageJsonPath)) {
    throw new Error(
      `vendored OpenClaw source not found at ${sourceRoot}. Bootstrap failed or OPENCLAW_VENDOR_DIR points to an invalid location.`,
    );
  }

  const sourcePkg = readJson(packageJsonPath);
  if (sourcePkg.name !== 'openclaw') {
    throw new Error(`unexpected vendored package at ${sourceRoot}: expected name \"openclaw\", got \"${sourcePkg.name || 'unknown'}\"`);
  }

  const manager = resolvePackageManager(sourcePkg);
  const sourceState = resolveSourceState(sourceRoot, sourcePkg);
  const env = {
    ...process.env,
    NODE_NO_WARNINGS: process.env.NODE_NO_WARNINGS || '1',
  };

  if (needsInstall(sourceState, args)) {
    process.stdout.write(`Installing vendored OpenClaw dependencies with ${manager}...\n`);
    installDependencies({ manager, sourceRoot, env, frozen: hasLockfile(sourceRoot, manager) });
  }

  const refreshedSourceState = resolveSourceState(sourceRoot, sourcePkg);
  if (needsBuild(refreshedSourceState, args)) {
    process.stdout.write(`Building vendored OpenClaw runtime with ${manager}...\n`);
    buildSource({ manager, sourceRoot, scripts: refreshedSourceState.scripts, env });
  }

  await assertRuntimeShape(sourceRoot, 'vendored OpenClaw source build output');

  const existingMeta = await readBundleMeta(bundleRoot);
  if (
    !(args.force === true || args.force === 'true')
    && existingMeta?.sourceVersion === sourcePkg.version
    && existingMeta?.bundleId === bundleId
  ) {
    try {
      await assertRuntimeShape(bundleRoot, `runtime bundle ${bundleId}`);
      process.stdout.write(`Runtime bundle ${bundleId} v${sourcePkg.version} already matches vendored source; skipping rebuild.\n`);
      return;
    } catch {
      // fall through and rebuild
    }
  }

  await rmrf(bundleRoot);
  await copySelectedEntries(sourceRoot, bundleRoot);
  await materializeInternalSymlinkTargets(sourceRoot, bundleRoot);
  await assertRuntimeShape(bundleRoot, `runtime bundle ${bundleId}`);
  await writeBundleMeta(bundleRoot, {
    bundleId,
    platform,
    arch,
    sourceRoot,
    packageManager: manager,
    sourceVersion: sourcePkg.version ?? 'unknown',
    preparedAt: new Date().toISOString(),
  });

  process.stdout.write(`Built runtime bundle ${bundleId} from ${sourceRoot} -> ${bundleRoot}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
