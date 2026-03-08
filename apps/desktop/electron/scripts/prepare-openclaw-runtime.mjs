#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");
const repoRoot = path.resolve(appRoot, "../../../");
const sourceRoot = path.join(repoRoot, "docs", "openclaw");
const targetRoot = path.join(appRoot, "openclaw-runtime");
const tempStoreDir = path.join(targetRoot, ".pnpm-store");
const tempLockfilePath = path.join(targetRoot, "pnpm-lock.yaml");

const RUNTIME_ROOT_ENTRIES = [
  "package.json",
  "openclaw.mjs",
  "dist",
  "assets",
  "extensions",
  "skills",
];

const RUNTIME_DOCS_ENTRIES = [["docs", "reference", "templates"]];

function run(cmd, args, cwd, extraEnv = {}) {
  const result = spawnSync(cmd, args, {
    cwd,
    env: {
      ...process.env,
      ...extraEnv,
    },
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function resolvePnpmRunner() {
  const direct = spawnSync("pnpm", ["--version"], {
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  if (direct.status === 0) {
    return { cmd: "pnpm", prefix: [] };
  }

  const npxFallback = spawnSync("npx", ["--yes", "pnpm", "--version"], {
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  if (npxFallback.status === 0) {
    return { cmd: "npx", prefix: ["--yes", "pnpm"] };
  }

  throw new Error("pnpm is required to prepare the bundled OpenClaw runtime, and npx pnpm is unavailable.");
}

function copyRequiredEntry(relativePath) {
  const sourcePath = path.join(sourceRoot, relativePath);
  const targetPath = path.join(targetRoot, relativePath);

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Required runtime entry missing at ${sourcePath}`);
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.cpSync(sourcePath, targetPath, {
    recursive: true,
    force: true,
  });
}

function copyRuntimeTree() {
  for (const entry of RUNTIME_ROOT_ENTRIES) {
    copyRequiredEntry(entry);
  }

  for (const segments of RUNTIME_DOCS_ENTRIES) {
    copyRequiredEntry(path.join(...segments));
  }
}

function buildUnixGatewayLauncher() {
  return [
    "#!/bin/sh",
    "set -eu",
    "",
    'SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
    'NODE_EXEC="${OPENCLAW_DESKTOP_NODE_EXEC:-}"',
    "",
    'if [ -z "$NODE_EXEC" ]; then',
    '  echo "OPENCLAW_DESKTOP_NODE_EXEC is required" >&2',
    "  exit 1",
    "fi",
    "",
    'export ELECTRON_RUN_AS_NODE="${ELECTRON_RUN_AS_NODE:-1}"',
    'exec "$NODE_EXEC" "$SCRIPT_DIR/../openclaw.mjs" "$@"',
    "",
  ].join("\n");
}

function buildWindowsGatewayLauncher() {
  return [
    "@echo off",
    "setlocal",
    'if "%OPENCLAW_DESKTOP_NODE_EXEC%"=="" (',
    '  echo OPENCLAW_DESKTOP_NODE_EXEC is required 1>&2',
    '  exit /b 1',
    ')',
    'if "%ELECTRON_RUN_AS_NODE%"=="" set ELECTRON_RUN_AS_NODE=1',
    '"%OPENCLAW_DESKTOP_NODE_EXEC%" "%~dp0..\\openclaw.mjs" %*',
    "",
  ].join("\r\n");
}

function writeRuntimeLaunchers() {
  const binDir = path.join(targetRoot, "bin");
  fs.mkdirSync(binDir, { recursive: true });

  const unixLauncherPath = path.join(binDir, "openclaw-gateway");
  fs.writeFileSync(unixLauncherPath, buildUnixGatewayLauncher(), "utf8");
  fs.chmodSync(unixLauncherPath, 0o755);

  const windowsLauncherPath = path.join(binDir, "openclaw-gateway.cmd");
  fs.writeFileSync(windowsLauncherPath, buildWindowsGatewayLauncher(), "utf8");
}

function installProductionNodeModules(pnpm) {
  const sourceLockfilePath = path.join(sourceRoot, "pnpm-lock.yaml");
  if (!fs.existsSync(sourceLockfilePath)) {
    throw new Error(`OpenClaw lockfile not found at ${sourceLockfilePath}`);
  }

  fs.cpSync(sourceLockfilePath, tempLockfilePath, { force: true });
  run(
    pnpm.cmd,
    [
      ...pnpm.prefix,
      "install",
      "--prod",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--ignore-workspace",
      "--store-dir",
      tempStoreDir,
      "--virtual-store-dir",
      "node_modules/.pnpm",
    ],
    targetRoot,
  );
  fs.rmSync(tempLockfilePath, { force: true });
  fs.rmSync(tempStoreDir, { recursive: true, force: true });
}

function main() {
  const pnpm = resolvePnpmRunner();

  if (!fs.existsSync(path.join(sourceRoot, "package.json"))) {
    throw new Error(`OpenClaw source not found at ${sourceRoot}`);
  }

  console.log("[prepare-runtime] Installing OpenClaw dependencies if needed...");
  run(pnpm.cmd, [...pnpm.prefix, "install"], sourceRoot);

  console.log("[prepare-runtime] Building OpenClaw runtime...");
  run(pnpm.cmd, [...pnpm.prefix, "build"], sourceRoot);

  console.log("[prepare-runtime] Building OpenClaw Control UI...");
  run(pnpm.cmd, [...pnpm.prefix, "ui:build"], sourceRoot);

  if (fs.existsSync(targetRoot)) {
    fs.rmSync(targetRoot, { recursive: true, force: true });
  }

  console.log("[prepare-runtime] Staging runtime bundle...");
  copyRuntimeTree();
  writeRuntimeLaunchers();

  console.log("[prepare-runtime] Installing production runtime dependencies...");
  installProductionNodeModules(pnpm);

  console.log(`[prepare-runtime] Runtime staged at ${targetRoot}`);
}

main();
