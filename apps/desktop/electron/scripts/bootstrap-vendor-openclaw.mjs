#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const workspaceRoot = path.resolve(appRoot, '../../..');
const vendorDefaultRoot = path.join(workspaceRoot, 'vendor', 'openclaw');
const defaultRepo = 'https://github.com/openclaw/openclaw.git';

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

function resolveSourceRoot(args) {
  return path.resolve(args.source || process.env.OPENCLAW_VENDOR_DIR || vendorDefaultRoot);
}

function resolveRepo(args) {
  return args.repo || process.env.OPENCLAW_VENDOR_REPO || defaultRepo;
}

function resolveRef(args) {
  const value = args.ref || process.env.OPENCLAW_VENDOR_REF;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`command failed: ${command} ${args.join(' ')}`);
  }
}

function isValidOpenClawSource(sourceRoot) {
  try {
    const packageJsonPath = path.join(sourceRoot, 'package.json');
    if (!fs.existsSync(packageJsonPath)) return false;
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    return pkg.name === 'openclaw';
  } catch {
    return false;
  }
}

function hasConfiguredSubmodule(sourceRoot) {
  const gitmodulesPath = path.join(workspaceRoot, '.gitmodules');
  if (!fs.existsSync(gitmodulesPath)) {
    return false;
  }
  const relativeSourceRoot = path.relative(workspaceRoot, sourceRoot).replace(/\\/g, '/');
  const content = fs.readFileSync(gitmodulesPath, 'utf8');
  return content.includes(`path = ${relativeSourceRoot}`);
}

async function ensureParentDir(sourceRoot) {
  await fsp.mkdir(path.dirname(sourceRoot), { recursive: true });
}

function cloneRepo(sourceRoot, repo, ref) {
  run('git', ['clone', '--depth', '1', repo, sourceRoot], workspaceRoot);
  if (ref) {
    run('git', ['-C', sourceRoot, 'fetch', '--depth', '1', 'origin', ref], workspaceRoot);
    run('git', ['-C', sourceRoot, 'checkout', 'FETCH_HEAD'], workspaceRoot);
  }
}

function initSubmodule(sourceRoot) {
  const relativeSourceRoot = path.relative(workspaceRoot, sourceRoot).replace(/\\/g, '/');
  run('git', ['submodule', 'update', '--init', '--depth', '1', '--', relativeSourceRoot], workspaceRoot);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceRoot = resolveSourceRoot(args);
  const repo = resolveRepo(args);
  const ref = resolveRef(args);

  if (isValidOpenClawSource(sourceRoot)) {
    process.stdout.write(`Vendored OpenClaw source is ready at ${sourceRoot}\n`);
    return;
  }

  await ensureParentDir(sourceRoot);

  if (hasConfiguredSubmodule(sourceRoot)) {
    process.stdout.write(`Initializing OpenClaw submodule at ${sourceRoot}...\n`);
    initSubmodule(sourceRoot);
  } else {
    process.stdout.write(`Cloning OpenClaw source into ${sourceRoot}...\n`);
    cloneRepo(sourceRoot, repo, ref);
  }

  if (!isValidOpenClawSource(sourceRoot)) {
    throw new Error(`bootstrapped source at ${sourceRoot} is not a valid openclaw repository`);
  }

  process.stdout.write(`Vendored OpenClaw source is ready at ${sourceRoot}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
