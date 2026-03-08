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
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const node_child_process_1 = require("node:child_process");
const PACKAGE_NAME = "openclaw";
function emitProgress(onProgress, next) {
    if (typeof onProgress === "function") {
        onProgress({ progress: null, detail: null, version: null, latestVersion: null, ...next });
    }
}
function readRuntimeVersion(runtimeRoot) {
    if (!runtimeRoot)
        return null;
    try {
        const pkg = JSON.parse(fsSync.readFileSync(path.join(runtimeRoot, "package.json"), "utf8"));
        return typeof pkg?.version === "string" && pkg.version.trim() ? pkg.version.trim() : null;
    }
    catch {
        return null;
    }
}
function resolveManagedRuntimeDir(_userDataDir) {
    return os.homedir();
}
function homeDir() {
    return os.homedir();
}
function homeInstallRoot() {
    return path.join(homeDir(), "node_modules", PACKAGE_NAME);
}
function homeCommandCandidates() {
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
function pathCommandNames() {
    if (process.platform === "win32") {
        return ["openclaw.cmd", "openclaw.exe", "openclaw.bat", "openclaw"];
    }
    return ["openclaw"];
}
function splitPathEnv(value) {
    return String(value || "")
        .split(path.delimiter)
        .map((entry) => entry.trim())
        .filter(Boolean);
}
function findCommandOnPath() {
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
function resolvePackageRootFromCommand(commandPath) {
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
    }
    catch {
        return null;
    }
}
function inspectRuntimeFromCommand(commandPath, source) {
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
function resolveNpmCliInvocation(nodeExecPath) {
    try {
        const npmCliPath = require.resolve("npm/bin/npm-cli.js");
        return { command: nodeExecPath, argsPrefix: [npmCliPath], env: { ELECTRON_RUN_AS_NODE: "1" } };
    }
    catch {
        return { command: "npm", argsPrefix: [], env: {} };
    }
}
async function runInstallCommand(params) {
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
    await new Promise((resolve, reject) => {
        const child = (0, node_child_process_1.spawn)(invocation.command, args, {
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
        const recentLines = [];
        const pushLine = (value) => {
            const text = String(value || "").trim();
            if (!text)
                return;
            recentLines.push(text);
            while (recentLines.length > 20)
                recentLines.shift();
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
async function resolveExistingRuntime() {
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
async function ensureManagedRuntime(params) {
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
