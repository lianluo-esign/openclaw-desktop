import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

const PACKAGE_NAME = "openclaw";

type RuntimeSource = "path" | "home-local";

type RuntimeInfo = {
  version: string;
  runtimeRoot: string;
  source: RuntimeSource;
  runtimeCommand: string;
};

type ManagedRuntimeResult = RuntimeInfo & {
  baseDir: string;
  latestVersion: string | null;
};

export type RuntimeInstallProgress = {
  phase: string;
  progress: number | null;
  message: string;
  detail?: string | null;
  version?: string | null;
  latestVersion?: string | null;
};

type ProgressHandler = (update: RuntimeInstallProgress) => void;

function emitProgress(onProgress: ProgressHandler | undefined, next: RuntimeInstallProgress): void {
  if (typeof onProgress === "function") {
    onProgress({ progress: null, detail: null, version: null, latestVersion: null, ...next });
  }
}

function uniqPaths(candidates: string[]): string[] {
  return [...new Set(candidates.filter(Boolean).map((value) => path.resolve(value)))];
}

function readPackageJson(packageRoot: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fsSync.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

export function readRuntimeVersion(runtimeRoot: string | null | undefined): string | null {
  if (!runtimeRoot) return null;
  try {
    const pkg = readPackageJson(runtimeRoot);
    return typeof pkg?.version === "string" && pkg.version.trim() ? pkg.version.trim() : null;
  } catch {
    return null;
  }
}

export function resolveManagedRuntimeDir(_userDataDir: string): string {
  return os.homedir();
}

function homeDir(): string {
  return os.homedir();
}

function homeInstallRoot(): string {
  return path.join(homeDir(), "node_modules", PACKAGE_NAME);
}

function runtimeCommandNames(): string[] {
  if (process.platform === "win32") {
    return ["openclaw.cmd", "openclaw.exe", "openclaw.bat", "openclaw.mjs", "openclaw.js", "openclaw"];
  }
  if (process.platform === "darwin") {
    return ["openclaw.mjs", "openclaw", "openclaw.js", "openclaw.cjs"];
  }
  return ["openclaw", "openclaw.mjs", "openclaw.js", "openclaw.cjs"];
}

function resolvePackageJsonBinCandidates(packageRoot: string): string[] {
  const pkg = readPackageJson(packageRoot);
  if (!pkg) {
    return [];
  }

  const candidates: string[] = [];
  const appendCandidate = (value: unknown) => {
    if (typeof value !== "string" || !value.trim()) {
      return;
    }
    candidates.push(path.resolve(packageRoot, value.trim()));
  };

  if (typeof pkg.bin === "string") {
    appendCandidate(pkg.bin);
  } else if (pkg.bin && typeof pkg.bin === "object") {
    const bin = pkg.bin as Record<string, unknown>;
    appendCandidate(bin[PACKAGE_NAME]);
    for (const value of Object.values(bin)) {
      appendCandidate(value);
    }
  }

  return uniqPaths(candidates);
}

function resolveHomePackageCommandCandidates(): string[] {
  const runtimeRoot = homeInstallRoot();
  return uniqPaths([
    ...resolvePackageJsonBinCandidates(runtimeRoot),
    ...runtimeCommandNames().map((name) => path.join(runtimeRoot, name)),
    ...runtimeCommandNames().map((name) => path.join(runtimeRoot, "bin", name)),
    ...runtimeCommandNames().map((name) => path.join(runtimeRoot, "dist", name)),
  ]);
}

function homeCommandCandidates(): string[] {
  const binDir = path.join(homeDir(), "node_modules", ".bin");
  const binCandidates = process.platform === "win32"
    ? [
      path.join(binDir, "openclaw.cmd"),
      path.join(binDir, "openclaw.exe"),
      path.join(binDir, "openclaw.bat"),
    ]
    : [path.join(binDir, "openclaw")];

  const packageCandidates = resolveHomePackageCommandCandidates();
  if (process.platform === "darwin") {
    return uniqPaths([...packageCandidates, ...binCandidates]);
  }
  return uniqPaths([...binCandidates, ...packageCandidates]);
}

function pathCommandNames(): string[] {
  if (process.platform === "win32") {
    return ["openclaw.cmd", "openclaw.exe", "openclaw.bat", "openclaw"];
  }
  return ["openclaw"];
}

function splitPathEnv(value: string | undefined): string[] {
  return String(value || "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function findCommandOnPath(): string | null {
  const dirs = splitPathEnv(process.env.PATH);
  for (const dir of dirs) {
    for (const name of pathCommandNames()) {
      const candidate = path.join(dir, name);
      if (fsSync.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function resolvePackageRootFromCommand(commandPath: string): string | null {
  try {
    const realCommand = fsSync.realpathSync(commandPath);
    const stats = fsSync.statSync(realCommand);
    let current = stats.isDirectory() ? realCommand : path.dirname(realCommand);
    const candidates: string[] = [current];

    while (true) {
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      candidates.push(parent);
      current = parent;
    }

    candidates.push(homeInstallRoot());

    for (const candidate of uniqPaths(candidates)) {
      const pkg = readPackageJson(candidate);
      if (pkg?.name === PACKAGE_NAME) {
        return candidate;
      }
    }

    return null;
  } catch {
    return null;
  }
}

function inspectRuntimeFromCommand(commandPath: string, source: RuntimeSource): RuntimeInfo | null {
  const runtimeRoot = resolvePackageRootFromCommand(commandPath);
  if (!runtimeRoot) {
    return null;
  }
  const version = readRuntimeVersion(runtimeRoot);
  if (!version) {
    return null;
  }
  return {
    version,
    runtimeRoot,
    source,
    runtimeCommand: commandPath,
  };
}

function resolveNpmCliInvocation(nodeExecPath: string): { command: string; argsPrefix: string[]; env: Record<string, string> } {
  try {
    const npmCliPath = require.resolve("npm/bin/npm-cli.js");
    return { command: nodeExecPath, argsPrefix: [npmCliPath], env: { ELECTRON_RUN_AS_NODE: "1" } };
  } catch {
    return { command: "npm", argsPrefix: [], env: {} };
  }
}

async function runInstallCommand(params: { nodeExecPath: string; onProgress?: ProgressHandler }): Promise<void> {
  const { nodeExecPath, onProgress } = params;
  const invocation = resolveNpmCliInvocation(nodeExecPath);
  const cwd = homeDir();
  const args = [
    ...invocation.argsPrefix,
    "install",
    `${PACKAGE_NAME}@latest`,
    "--no-fund",
    "--no-audit",
    "--loglevel",
    "info",
  ];

  emitProgress(onProgress, {
    phase: "installing",
    progress: 24,
    message: `正在用户目录 ${cwd} 安装 OpenClaw 最新版…`,
  });

  await new Promise<void>((resolve, reject) => {
    const child = spawn(invocation.command, args, {
      cwd,
      env: {
        ...process.env,
        ...invocation.env,
        npm_config_update_notifier: "false",
        npm_config_fund: "false",
        npm_config_audit: "false",
        npm_config_progress: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32" && invocation.command === "npm",
    });

    let progress = 28;
    const recentLines: string[] = [];
    const pushLine = (value: unknown) => {
      const text = String(value || "").trim();
      if (!text) return;
      recentLines.push(text);
      while (recentLines.length > 20) recentLines.shift();
      emitProgress(onProgress, {
        phase: "installing",
        progress,
        detail: text,
        message: "正在安装 OpenClaw…",
      });
    };

    const tick = setInterval(() => {
      progress = Math.min(progress + 2, 88);
      emitProgress(onProgress, {
        phase: "installing",
        progress,
        message: "正在安装 OpenClaw…",
      });
    }, 800);

    child.stdout.on("data", (chunk) => pushLine(chunk));
    child.stderr.on("data", (chunk) => pushLine(chunk));
    child.once("error", (error) => {
      clearInterval(tick);
      reject(error);
    });
    child.once("exit", (code) => {
      clearInterval(tick);
      if (code === 0) {
        resolve();
        return;
      }
      const extra = recentLines.length > 0 ? `\n${recentLines.join("\n")}` : "";
      reject(new Error(`npm install failed with code ${code}${extra}`));
    });
  });
}

function resolveHomeInstalledRuntime(): RuntimeInfo | null {
  for (const candidate of homeCommandCandidates()) {
    if (!fsSync.existsSync(candidate)) {
      continue;
    }
    const inspected = inspectRuntimeFromCommand(candidate, "home-local");
    if (inspected) {
      return inspected;
    }
  }
  return null;
}

async function resolveExistingRuntime(): Promise<RuntimeInfo | null> {
  if (process.platform === "darwin") {
    return resolveHomeInstalledRuntime();
  }

  const pathCommand = findCommandOnPath();
  if (pathCommand) {
    const inspected = inspectRuntimeFromCommand(pathCommand, "path");
    if (inspected) {
      return inspected;
    }
  }

  return resolveHomeInstalledRuntime();
}

export async function ensureManagedRuntime(params: { userDataDir: string; nodeExecPath: string; onProgress?: ProgressHandler }): Promise<ManagedRuntimeResult> {
  const { userDataDir, nodeExecPath, onProgress } = params;
  emitProgress(onProgress, {
    phase: "checking-local",
    progress: 8,
    message: process.platform === "darwin"
      ? "正在用户 HOME 目录搜索 OpenClaw runtime…"
      : "正在搜索当前用户可用的 OpenClaw 命令…",
  });

  const installed = await resolveExistingRuntime();
  if (installed) {
    emitProgress(onProgress, {
      phase: "ready",
      progress: 100,
      version: installed.version,
      message: `已找到 OpenClaw v${installed.version}。`,
      detail: installed.runtimeRoot,
    });
    return { ...installed, baseDir: userDataDir, latestVersion: null };
  }

  await runInstallCommand({ nodeExecPath, onProgress });

  const resolved = await resolveExistingRuntime();
  if (!resolved) {
    throw new Error(`OpenClaw installed, but no runnable command was found. Expected one of: ${homeCommandCandidates().join(", ")}`);
  }

  emitProgress(onProgress, {
    phase: "ready",
    progress: 100,
    version: resolved.version,
    message: `已安装 OpenClaw v${resolved.version}。`,
    detail: resolved.runtimeRoot,
  });
  return { ...resolved, baseDir: userDataDir, latestVersion: null };
}
