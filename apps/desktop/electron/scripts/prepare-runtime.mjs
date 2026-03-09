#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const runtimeBundlesRoot = path.join(appRoot, 'runtime-bundles');
const runtimeRoot = path.join(appRoot, 'runtime');
const runtimeOpenClawRoot = path.join(runtimeRoot, 'openclaw');
const runtimeManifestPath = path.join(runtimeRoot, 'manifest.json');

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
    throw new Error('universal bundle is not supported; prepare a concrete arch bundle such as darwin-arm64 or darwin-x64');
  }
  return `${platform}-${arch}`;
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
      try {
        await fsp.rm(targetPath, { recursive: true, force: true });
      } catch {}
      await fsp.symlink(linkTarget, targetPath);
      continue;
    }
    await fsp.copyFile(sourcePath, targetPath);
  }
}

function resolveSourceRuntimeRoot(bundleId) {
  return path.join(runtimeBundlesRoot, bundleId, 'openclaw');
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

async function assertRuntimeShape(bundleRoot, bundleId) {
  const missing = getRequiredRuntimePaths().filter((relativePath) => !fs.existsSync(path.join(bundleRoot, relativePath)));
  if (missing.length > 0) {
    throw new Error(`runtime bundle ${bundleId} is incomplete; missing: ${missing.join(', ')}`);
  }
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function readRuntimeVersion(bundleRoot) {
  const runtimePkgPath = path.join(bundleRoot, 'package.json');
  const runtimePkg = JSON.parse(await fsp.readFile(runtimePkgPath, 'utf8'));
  return runtimePkg.version ?? 'unknown';
}

async function isPreparedRuntimeReusable({ bundleId, platform, arch, version }) {
  const manifest = await readJsonIfExists(runtimeManifestPath);
  if (!manifest) return false;
  if (manifest.bundleId !== bundleId) return false;
  if (manifest.platform !== platform) return false;
  if (manifest.arch !== arch) return false;
  if (manifest.version !== version) return false;
  try {
    await assertRuntimeShape(runtimeOpenClawRoot, bundleId);
    return true;
  } catch {
    return false;
  }
}

async function writeManifest({ bundleId, platform, arch, version }) {
  const payload = {
    bundleId,
    platform,
    arch,
    version,
    preparedAt: new Date().toISOString(),
  };
  await fsp.writeFile(runtimeManifestPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const force = args.force === true || args.force === 'true' || process.env.OPENCLAW_RUNTIME_FORCE === '1';
  const platform = normalizePlatform(args.platform || process.env.OPENCLAW_RUNTIME_PLATFORM);
  const arch = normalizeArch(args.arch || process.env.OPENCLAW_RUNTIME_ARCH);
  const bundleId = process.env.OPENCLAW_RUNTIME_BUNDLE_ID || args['bundle-id'] || resolveBundleId({ platform, arch });
  const sourceRoot = resolveSourceRuntimeRoot(bundleId);

  if (!fs.existsSync(sourceRoot)) {
    throw new Error(
      `runtime bundle not found: ${sourceRoot}\n` +
      `Build it from vendored source with: node scripts/build-runtime-bundle.mjs --platform=${platform} --arch=${arch}\n` +
      `Or place a complete runtime at runtime-bundles/${bundleId}/openclaw/ before packaging or running the desktop app.`,
    );
  }

  await assertRuntimeShape(sourceRoot, bundleId);
  const version = await readRuntimeVersion(sourceRoot);
  await fsp.mkdir(runtimeRoot, { recursive: true });

  if (!force && await isPreparedRuntimeReusable({ bundleId, platform, arch, version })) {
    process.stdout.write(`Runtime bundle ${bundleId} v${version} already prepared at ${runtimeOpenClawRoot}; skipping copy.\n`);
    return;
  }

  await fsp.rm(runtimeOpenClawRoot, { recursive: true, force: true });
  await copyDir(sourceRoot, runtimeOpenClawRoot);
  await writeManifest({ bundleId, platform, arch, version });

  process.stdout.write(`Prepared runtime bundle ${bundleId} v${version} -> ${runtimeOpenClawRoot}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
