import * as fsSync from "node:fs";
import { promises as fs } from "node:fs";
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

export function readRuntimeVersion(runtimeRoot: string | null | undefined): string | null {
  if (!runtimeRoot) return null;
  try {
    const pkg = JSON.parse(fsSync.readFileSync(path.join(runtimeRoot, "package.json"), "utf8"));
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

function homeCommandCandidates(): string[] {
  const binDir = path.join(homeDir(), "node_modules", ".bin");
  if (process.platform === "win32") {
    return [
      path.join(binDir, "openclaw.cmd"),
      path.join(binDir, "openclaw.exe"),
      path.join(binDir, "openclaw.bat"),
    ];
  }
  return [path.join(binDir, "openclaw")];
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
    const candidates = [
      path.dirname(realCommand),
      path.resolve(path.dirname(realCommand), "..", PACKAGE_NAME),
      path.resolve(path.dirname(realCommand), "..", "lib", "node_modules", PACKAGE_NAME),
      homeInstallRoot(),
    ];
    for (const candidate of candidates) {
      const pkgPath = path.join(candidate, "package.json");
      if (!fsSync.existsSync(pkgPath)) {
        continue;
      }
      const pkg = JSON.parse(fsSync.readFileSync(pkgPath, "utf8"));
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
    PACKAGE_NAME,
    "--no-fund",
    "--no-audit",
    "--loglevel",
    "info",
  ];

  emitProgress(onProgress, {
    phase: "installing",
    progress: 24,
    message: `正在用户目录 ${cwd} 安装 OpenClaw…`,
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

async function resolveExistingRuntime(): Promise<RuntimeInfo | null> {
  const pathCommand = findCommandOnPath();
  if (pathCommand) {
    const inspected = inspectRuntimeFromCommand(pathCommand, "path");
    if (inspected) {
      return inspected;
    }
  }

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

export async function ensureManagedRuntime(params: { userDataDir: string; nodeExecPath: string; onProgress?: ProgressHandler }): Promise<ManagedRuntimeResult> {
  const { userDataDir, nodeExecPath, onProgress } = params;
  emitProgress(onProgress, {
    phase: "checking-local",
    progress: 8,
    message: "正在搜索当前用户可用的 OpenClaw 命令…",
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
