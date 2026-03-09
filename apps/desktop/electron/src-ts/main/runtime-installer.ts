import * as fsSync from "node:fs";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as tar from "tar";

const PACKAGE_NAME = "openclaw";
const REGISTRY_LATEST_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const MANAGED_RUNTIME_DIRNAME = "runtime";
const MANAGED_CURRENT_DIRNAME = "current";
const MANAGED_CACHE_DIRNAME = "cache";

type RuntimeSource = "managed-download";

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

type LatestManifest = {
  version: string;
  dist: {
    tarball: string;
  };
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

function formatBytes(value: number | null | undefined): string {
  const size = Number(value);
  if (!Number.isFinite(size) || size <= 0) {
    return "未知大小";
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  if (size < 1024 * 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
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

export function resolveManagedRuntimeDir(userDataDir: string): string {
  return path.join(userDataDir, MANAGED_RUNTIME_DIRNAME, PACKAGE_NAME);
}

function resolveManagedCurrentRuntimeRoot(userDataDir: string): string {
  return path.join(resolveManagedRuntimeDir(userDataDir), MANAGED_CURRENT_DIRNAME);
}

function resolveManagedCacheDir(userDataDir: string): string {
  return path.join(resolveManagedRuntimeDir(userDataDir), MANAGED_CACHE_DIRNAME);
}

function resolveManagedTarballPath(userDataDir: string, version: string): string {
  return path.join(resolveManagedCacheDir(userDataDir), `${PACKAGE_NAME}-${version}.tgz`);
}

function resolveManagedStagingRoot(userDataDir: string, version: string): string {
  return path.join(resolveManagedRuntimeDir(userDataDir), `.staging-${version}-${process.pid}-${Date.now()}`);
}

function runtimeCommandNames(): string[] {
  if (process.platform === "win32") {
    return ["openclaw.cmd", "openclaw.exe", "openclaw.bat", "openclaw.mjs", "openclaw.js", "openclaw"];
  }
  return ["openclaw.mjs", "openclaw", "openclaw.js", "openclaw.cjs"];
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

function resolveRuntimeCommand(runtimeRoot: string): string {
  const candidates = uniqPaths([
    ...resolvePackageJsonBinCandidates(runtimeRoot),
    ...runtimeCommandNames().map((name) => path.join(runtimeRoot, name)),
    ...runtimeCommandNames().map((name) => path.join(runtimeRoot, "bin", name)),
    ...runtimeCommandNames().map((name) => path.join(runtimeRoot, "dist", name)),
  ]);

  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
  }

  return path.join(runtimeRoot, "openclaw.mjs");
}

function inspectManagedRuntime(userDataDir: string): RuntimeInfo | null {
  const runtimeRoot = resolveManagedCurrentRuntimeRoot(userDataDir);
  const version = readRuntimeVersion(runtimeRoot);
  if (!version) {
    return null;
  }

  const runtimeCommand = resolveRuntimeCommand(runtimeRoot);
  if (!fsSync.existsSync(runtimeCommand)) {
    return null;
  }

  return {
    version,
    runtimeRoot,
    source: "managed-download",
    runtimeCommand,
  };
}

async function fetchLatestManifest(onProgress?: ProgressHandler): Promise<LatestManifest> {
  emitProgress(onProgress, {
    phase: "checking-latest",
    progress: 18,
    message: "正在检查 OpenClaw 最新发布版本…",
    detail: REGISTRY_LATEST_URL,
  });

  const response = await fetch(REGISTRY_LATEST_URL, {
    headers: {
      accept: "application/json",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`failed to fetch npm metadata (${response.status} ${response.statusText})`);
  }

  const payload = await response.json() as Partial<LatestManifest>;
  const version = typeof payload?.version === "string" ? payload.version.trim() : "";
  const tarball = typeof payload?.dist?.tarball === "string" ? payload.dist.tarball.trim() : "";

  if (!version || !tarball) {
    throw new Error("npm metadata missing version or tarball URL");
  }

  return {
    version,
    dist: {
      tarball,
    },
  };
}

async function downloadTarball(params: {
  userDataDir: string;
  manifest: LatestManifest;
  onProgress?: ProgressHandler;
}): Promise<string> {
  const { userDataDir, manifest, onProgress } = params;
  const cacheDir = resolveManagedCacheDir(userDataDir);
  const tarballPath = resolveManagedTarballPath(userDataDir, manifest.version);
  const tempPath = `${tarballPath}.download`;

  await fs.mkdir(cacheDir, { recursive: true });

  try {
    const stats = await fs.stat(tarballPath);
    if (stats.size > 0) {
      emitProgress(onProgress, {
        phase: "using-cached",
        progress: 30,
        version: manifest.version,
        latestVersion: manifest.version,
        message: `复用已下载的 OpenClaw v${manifest.version} 安装包…`,
        detail: tarballPath,
      });
      return tarballPath;
    }
  } catch {
    // ignore
  }

  emitProgress(onProgress, {
    phase: "downloading-runtime",
    progress: 26,
    version: manifest.version,
    latestVersion: manifest.version,
    message: `正在下载 OpenClaw v${manifest.version}…`,
    detail: manifest.dist.tarball,
  });

  const response = await fetch(manifest.dist.tarball, {
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`failed to download runtime tarball (${response.status} ${response.statusText})`);
  }

  const totalBytes = Number.parseInt(response.headers.get("content-length") || "", 10);
  const body = response.body;
  if (!body) {
    throw new Error("runtime download response body is empty");
  }

  await fs.rm(tempPath, { force: true });

  const writer = fsSync.createWriteStream(tempPath, { flags: "w" });
  const reader = body.getReader();
  let writtenBytes = 0;

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      const buffer = Buffer.from(chunk.value);
      writtenBytes += buffer.length;

      await new Promise<void>((resolve, reject) => {
        writer.write(buffer, (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });

      const progress = Number.isFinite(totalBytes) && totalBytes > 0
        ? 26 + Math.min(40, Math.round((writtenBytes / totalBytes) * 40))
        : null;
      emitProgress(onProgress, {
        phase: "downloading-runtime",
        progress,
        version: manifest.version,
        latestVersion: manifest.version,
        message: `正在下载 OpenClaw v${manifest.version}…`,
        detail: `${formatBytes(writtenBytes)} / ${formatBytes(Number.isFinite(totalBytes) ? totalBytes : null)}`,
      });
    }

    await new Promise<void>((resolve, reject) => {
      writer.end((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    await fs.rename(tempPath, tarballPath);
    return tarballPath;
  } catch (error) {
    try {
      writer.destroy();
    } catch {
      // ignore
    }
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

async function extractTarball(params: {
  userDataDir: string;
  manifest: LatestManifest;
  tarballPath: string;
  onProgress?: ProgressHandler;
}): Promise<string> {
  const { userDataDir, manifest, tarballPath, onProgress } = params;
  const stagingRoot = resolveManagedStagingRoot(userDataDir, manifest.version);

  emitProgress(onProgress, {
    phase: "extracting-runtime",
    progress: 70,
    version: manifest.version,
    latestVersion: manifest.version,
    message: `正在解压 OpenClaw v${manifest.version}…`,
    detail: tarballPath,
  });

  await fs.rm(stagingRoot, { recursive: true, force: true });
  await fs.mkdir(stagingRoot, { recursive: true });

  try {
    await tar.x({
      cwd: stagingRoot,
      file: tarballPath,
      strip: 1,
    });
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }

  const version = readRuntimeVersion(stagingRoot);
  if (!version) {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    throw new Error("downloaded runtime is missing package.json version");
  }

  const runtimeCommand = resolveRuntimeCommand(stagingRoot);
  if (!fsSync.existsSync(runtimeCommand)) {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    throw new Error(`downloaded runtime entry not found: ${runtimeCommand}`);
  }

  return stagingRoot;
}

async function activateStagedRuntime(params: {
  userDataDir: string;
  manifest: LatestManifest;
  stagingRoot: string;
  onProgress?: ProgressHandler;
}): Promise<RuntimeInfo> {
  const { userDataDir, manifest, stagingRoot, onProgress } = params;
  const runtimeBaseDir = resolveManagedRuntimeDir(userDataDir);
  const currentRoot = resolveManagedCurrentRuntimeRoot(userDataDir);

  emitProgress(onProgress, {
    phase: "finalizing",
    progress: 88,
    version: manifest.version,
    latestVersion: manifest.version,
    message: `正在激活 OpenClaw v${manifest.version}…`,
    detail: currentRoot,
  });

  await fs.mkdir(runtimeBaseDir, { recursive: true });
  await fs.rm(currentRoot, { recursive: true, force: true });
  await fs.rename(stagingRoot, currentRoot);

  const resolved = inspectManagedRuntime(userDataDir);
  if (!resolved) {
    throw new Error("managed runtime activation succeeded but runtime entry is still missing");
  }

  return resolved;
}

export async function ensureManagedRuntime(params: {
  userDataDir: string;
  nodeExecPath: string;
  forceLatest?: boolean;
  onProgress?: ProgressHandler;
}): Promise<ManagedRuntimeResult> {
  const { userDataDir, forceLatest = false, onProgress } = params;
  const runtimeBaseDir = resolveManagedRuntimeDir(userDataDir);

  emitProgress(onProgress, {
    phase: "checking-local",
    progress: 8,
    message: "正在检查应用私有 OpenClaw runtime…",
    detail: runtimeBaseDir,
  });

  await fs.mkdir(runtimeBaseDir, { recursive: true });

  const installed = inspectManagedRuntime(userDataDir);
  if (installed && !forceLatest) {
    emitProgress(onProgress, {
      phase: "ready",
      progress: 100,
      version: installed.version,
      latestVersion: installed.version,
      message: `已找到本地 OpenClaw v${installed.version}。`,
      detail: installed.runtimeRoot,
    });
    return { ...installed, baseDir: runtimeBaseDir, latestVersion: installed.version };
  }

  const manifest = await fetchLatestManifest(onProgress);

  if (installed && installed.version === manifest.version) {
    emitProgress(onProgress, {
      phase: "ready",
      progress: 100,
      version: installed.version,
      latestVersion: manifest.version,
      message: `OpenClaw v${installed.version} 已是最新版本。`,
      detail: installed.runtimeRoot,
    });
    return { ...installed, baseDir: runtimeBaseDir, latestVersion: manifest.version };
  }

  const tarballPath = await downloadTarball({ userDataDir, manifest, onProgress });
  const stagingRoot = await extractTarball({ userDataDir, manifest, tarballPath, onProgress });
  const resolved = await activateStagedRuntime({ userDataDir, manifest, stagingRoot, onProgress });

  emitProgress(onProgress, {
    phase: "ready",
    progress: 100,
    version: resolved.version,
    latestVersion: manifest.version,
    message: `已准备 OpenClaw v${resolved.version}。`,
    detail: resolved.runtimeRoot,
  });

  return { ...resolved, baseDir: runtimeBaseDir, latestVersion: manifest.version };
}
