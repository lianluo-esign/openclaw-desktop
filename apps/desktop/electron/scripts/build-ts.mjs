#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');

function resolveTscPath() {
  const candidates = [
    path.resolve(appRoot, '../../../docs/openclaw/node_modules/typescript/bin/tsc'),
    path.resolve(appRoot, 'node_modules/typescript/bin/tsc'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error('TypeScript compiler not found. Run the OpenClaw workspace install first.');
}

const result = spawnSync(process.execPath, [resolveTscPath(), '-p', 'tsconfig.json', ...process.argv.slice(2)], {
  cwd: appRoot,
  stdio: 'inherit',
  env: process.env,
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
