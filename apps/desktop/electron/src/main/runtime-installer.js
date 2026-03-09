"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.readRuntimeVersion = readRuntimeVersion;
exports.resolveManagedRuntimeDir = resolveManagedRuntimeDir;
exports.ensureManagedRuntime = ensureManagedRuntime;
const fsSync = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const PACKAGE_NAME = "openclaw";
const BUNDLED_RUNTIME_DIRNAME = "runtime";
const BUNDLED_RUNTIME_SUBDIR = "openclaw";
const BUNDLED_RUNTIME_MANIFEST = "manifest.json";
function emitProgress(onProgress, next) {
    if (typeof onProgress === "function") {
        onProgress({ progress: null, detail: null, version: null, latestVersion: null, ...next });
    }
}
function readJson(filePath) {
    try {
        return JSON.parse(fsSync.readFileSync(filePath, "utf8"));
    }
    catch {
        return null;
    }
}
function readBundleManifest(runtimeBaseDir) {
    return readJson(path.join(runtimeBaseDir, BUNDLED_RUNTIME_MANIFEST));
}
function getElectronResourcesPath() {
    const candidate = process.resourcesPath;
    return typeof candidate === "string" && candidate.trim() ? candidate : null;
}
function readRuntimeVersion(runtimeRoot) {
    if (!runtimeRoot)
        return null;
    try {
        const pkg = readJson(path.join(runtimeRoot, "package.json"));
        return typeof pkg?.version === "string" && pkg.version.trim() ? pkg.version.trim() : null;
    }
    catch {
        return null;
    }
}
function resolveManagedRuntimeDir(_userDataDir) {
    const resourcesPath = getElectronResourcesPath();
    if (resourcesPath) {
        return path.join(resourcesPath, BUNDLED_RUNTIME_DIRNAME);
    }
    return path.join(process.cwd(), BUNDLED_RUNTIME_DIRNAME);
}
function resolveBundledRuntimeBaseDir(devAppRoot) {
    const resourcesPath = getElectronResourcesPath();
    if (resourcesPath && !devAppRoot) {
        return path.join(resourcesPath, BUNDLED_RUNTIME_DIRNAME);
    }
    const root = devAppRoot ? path.resolve(devAppRoot) : process.cwd();
    return path.join(root, BUNDLED_RUNTIME_DIRNAME);
}
function resolveBundledRuntimeRoot(devAppRoot) {
    return path.join(resolveBundledRuntimeBaseDir(devAppRoot), BUNDLED_RUNTIME_SUBDIR);
}
function runtimeCommandNames() {
    if (process.platform === "win32") {
        return ["openclaw.cmd", "openclaw.exe", "openclaw.bat", "openclaw.mjs", "openclaw.js", "openclaw"];
    }
    return ["openclaw.mjs", "openclaw", "openclaw.js", "openclaw.cjs"];
}
function resolvePackageJsonBinCandidates(packageRoot) {
    const pkg = readJson(path.join(packageRoot, "package.json"));
    if (!pkg) {
        return [];
    }
    const candidates = [];
    const appendCandidate = (value) => {
        if (typeof value !== "string" || !value.trim()) {
            return;
        }
        candidates.push(path.resolve(packageRoot, value.trim()));
    };
    if (typeof pkg.bin === "string") {
        appendCandidate(pkg.bin);
    }
    else if (pkg.bin && typeof pkg.bin === "object") {
        const bin = pkg.bin;
        appendCandidate(bin[PACKAGE_NAME]);
        for (const value of Object.values(bin)) {
            appendCandidate(value);
        }
    }
    return [...new Set(candidates)];
}
function resolveRuntimeCommand(runtimeRoot) {
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
async function ensureManagedRuntime(params) {
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
        throw new Error(`bundled runtime not found at ${runtimeRoot}. Expected runtime/openclaw prepared from runtime-bundles/${bundleId}/openclaw`);
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
