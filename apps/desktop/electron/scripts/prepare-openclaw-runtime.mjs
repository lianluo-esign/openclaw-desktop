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

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
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

function shouldCopyRuntimeEntry(source, entry) {
  const relative = path.relative(source, entry).replaceAll("\\", "/");
  if (!relative || relative === ".") {
    return true;
  }

  if (
    relative === "docs" ||
    relative === "docs/reference" ||
    relative === "docs/reference/templates" ||
    relative.startsWith("docs/reference/templates/")
  ) {
    return true;
  }

  return ![
    ".git",
    ".github",
    "docs/",
    "test/",
    ".agents/",
    ".agent/",
    "node_modules/.cache/",
  ].some((pattern) => relative === pattern.replace(/\/$/, "") || relative.startsWith(pattern));
}

function copyTree(source, target) {
  fs.cpSync(source, target, {
    recursive: true,
    force: true,
    filter: (entry) => shouldCopyRuntimeEntry(source, entry),
  });
}

function copyRootNodeModules(sourceRoot, targetRoot) {
  const sourceNodeModules = path.join(sourceRoot, "node_modules");
  const targetNodeModules = path.join(targetRoot, "node_modules");

  if (!fs.existsSync(sourceNodeModules)) {
    throw new Error(`OpenClaw dependencies not found at ${sourceNodeModules}`);
  }

  fs.rmSync(targetNodeModules, { recursive: true, force: true });
  fs.cpSync(sourceNodeModules, targetNodeModules, {
    recursive: true,
    force: true,
    verbatimSymlinks: true,
    filter: (entry) => {
      const relative = path.relative(sourceNodeModules, entry).replaceAll("\\", "/");
      if (!relative || relative === ".") {
        return true;
      }
      return !(relative === ".cache" || relative.startsWith(".cache/"));
    },
  });
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

  console.log("[prepare-runtime] Staging runtime resources...");
  copyTree(sourceRoot, targetRoot);
  console.log("[prepare-runtime] Restoring runtime root node_modules symlinks...");
  copyRootNodeModules(sourceRoot, targetRoot);

  console.log(`[prepare-runtime] Runtime staged at ${targetRoot}`);
}

main();
