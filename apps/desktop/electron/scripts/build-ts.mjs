#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const workspaceRoot = path.resolve(appRoot, '../../..');
const require = createRequire(import.meta.url);

function resolveFrom(paths) {
  try {
    return require.resolve('typescript/bin/tsc', { paths });
  } catch {
    return null;
  }
}

function resolveTscPath() {
  const fileCandidates = [
    path.resolve(appRoot, 'node_modules/typescript/bin/tsc'),
    path.resolve(appRoot, '../../node_modules/typescript/bin/tsc'),
    path.resolve(appRoot, '../../../node_modules/typescript/bin/tsc'),
    '/tmp/openclaw-desktop-tsc/node_modules/typescript/bin/tsc',
  ];

  for (const candidate of fileCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const resolved = [
    resolveFrom([appRoot]),
    resolveFrom([workspaceRoot]),
    resolveFrom(['/tmp/openclaw-desktop-tsc']),
    resolveFrom([path.resolve(appRoot, 'openclaw-runtime')]),
    resolveFrom([path.resolve(appRoot, 'release/linux-unpacked/resources/openclaw-runtime')]),
    resolveFrom([path.resolve(appRoot, 'release/mac/resources/openclaw-runtime')]),
    resolveFrom([path.resolve(appRoot, 'release/mac-arm64/resources/openclaw-runtime')]),
  ].find(Boolean);

  if (resolved) {
    return resolved;
  }

  throw new Error(
    'TypeScript compiler not found. Install dependencies in apps/desktop/electron, or provide /tmp/openclaw-desktop-tsc/node_modules/typescript/bin/tsc.',
  );
}

const result = spawnSync(process.execPath, [resolveTscPath(), '-p', 'tsconfig.json', ...process.argv.slice(2)], {
  cwd: appRoot,
  stdio: 'inherit',
  env: process.env,
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
