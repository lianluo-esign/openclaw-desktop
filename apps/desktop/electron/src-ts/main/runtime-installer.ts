import * as fsSync from "node:fs";
import * as path from "node:path";

const PACKAGE_NAME = "openclaw";
const BUNDLED_RUNTIME_DIRNAME = "runtime";
const BUNDLED_RUNTIME_SUBDIR = "openclaw";
const BUNDLED_RUNTIME_MANIFEST = "manifest.json";

type RuntimeSource = "bundled-runtime";

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

type BundleManifest = {
  bundleId?: string;
  platform?: string;
  arch?: string;
  version?: string;
  preparedAt?: string;
};

function emitProgress(onProgress: ProgressHandler | undefined, next: RuntimeInstallProgress): void {
  if (typeof onProgress === "function") {
    onProgress({ progress: null, detail: null, version: null, latestVersion: null, ...next });
  }
}

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fsSync.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readBundleManifest(runtimeBaseDir: string): BundleManifest | null {
  return readJson(path.join(runtimeBaseDir, BUNDLED_RUNTIME_MANIFEST)) as BundleManifest | null;
}

function getElectronResourcesPath(): string | null {
  const candidate = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return typeof candidate === "string" && candidate.trim() ? candidate : null;
}

export function readRuntimeVersion(runtimeRoot: string | null | undefined): string | null {
  if (!runtimeRoot) return null;
  try {
    const pkg = readJson(path.join(runtimeRoot, "package.json"));
    return typeof pkg?.version === "string" && pkg.version.trim() ? pkg.version.trim() : null;
  } catch {
    return null;
  }
}

export function resolveManagedRuntimeDir(_userDataDir: string): string {
  const resourcesPath = getElectronResourcesPath();
  if (resourcesPath) {
    return path.join(resourcesPath, BUNDLED_RUNTIME_DIRNAME);
  }
  return path.join(process.cwd(), BUNDLED_RUNTIME_DIRNAME);
}

function resolveBundledRuntimeBaseDir(devAppRoot: string | null | undefined): string {
  const resourcesPath = getElectronResourcesPath();
  if (resourcesPath && !devAppRoot) {
    return path.join(resourcesPath, BUNDLED_RUNTIME_DIRNAME);
  }
  const root = devAppRoot ? path.resolve(devAppRoot) : process.cwd();
  return path.join(root, BUNDLED_RUNTIME_DIRNAME);
}

function resolveBundledRuntimeRoot(devAppRoot: string | null | undefined): string {
  return path.join(resolveBundledRuntimeBaseDir(devAppRoot), BUNDLED_RUNTIME_SUBDIR);
}

function runtimeCommandNames(): string[] {
  if (process.platform === "win32") {
    return ["openclaw.cmd", "openclaw.exe", "openclaw.bat", "openclaw.mjs", "openclaw.js", "openclaw"];
  }
  return ["openclaw.mjs", "openclaw", "openclaw.js", "openclaw.cjs"];
}

function resolvePackageJsonBinCandidates(packageRoot: string): string[] {
  const pkg = readJson(path.join(packageRoot, "package.json"));
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

  return [...new Set(candidates)];
}

function resolveRuntimeCommand(runtimeRoot: string): string {
  const candidates = [
    ...resolvePackageJsonBinCandidates(runtimeRoot),
    ...runtimeCommandNames().map((name) => path.join(runtimeRoot, name)),
    ...runtimeCommandNames().map((name) => path.join(runtimeRoot, "bin", name)),
    ...runtimeCommandNames().map((name) => path.join(runtimeRoot, "dist", name)),
  ];

  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
  }

  return path.join(runtimeRoot, "openclaw.mjs");
}

export async function ensureManagedRuntime(params: {
  userDataDir: string;
  nodeExecPath: string;
  forceLatest?: boolean;
  onProgress?: ProgressHandler;
  devAppRoot?: string;
}): Promise<ManagedRuntimeResult> {
  const { onProgress, devAppRoot } = params;
  const runtimeBaseDir = resolveBundledRuntimeBaseDir(devAppRoot);
  const runtimeRoot = resolveBundledRuntimeRoot(devAppRoot);
  const manifest = readBundleManifest(runtimeBaseDir);

  emitProgress(onProgress, {
    phase: "checking-local",
    progress: 10,
    message: "正在检查内置 OpenClaw runtime bundle…",
    detail: runtimeRoot,
    latestVersion: typeof manifest?.version === "string" ? manifest.version : null,
  });

  if (!fsSync.existsSync(runtimeRoot)) {
    const bundleId = manifest?.bundleId || `${process.platform}-${process.arch}`;
    throw new Error(
      `bundled runtime not found at ${runtimeRoot}. Expected runtime/openclaw prepared from runtime-bundles/${bundleId}/openclaw`,
    );
  }

  const version = readRuntimeVersion(runtimeRoot);
  if (!version) {
    throw new Error(`bundled runtime is missing package.json version: ${runtimeRoot}`);
  }

  const runtimeCommand = resolveRuntimeCommand(runtimeRoot);
  if (!fsSync.existsSync(runtimeCommand)) {
    throw new Error(`bundled runtime command not found: ${runtimeCommand}`);
  }

  emitProgress(onProgress, {
    phase: "ready",
    progress: 100,
    version,
    latestVersion: version,
    message: `已找到内置 OpenClaw v${version}。`,
    detail: runtimeRoot,
  });

  return {
    version,
    runtimeRoot,
    source: "bundled-runtime",
    runtimeCommand,
    baseDir: runtimeBaseDir,
    latestVersion: version,
  };
}
