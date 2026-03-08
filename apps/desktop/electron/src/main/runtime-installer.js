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
function uniqPaths(candidates) {
    return [...new Set(candidates.filter(Boolean).map((value) => path.resolve(value)))];
}
function readPackageJson(packageRoot) {
    try {
        return JSON.parse(fsSync.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    }
    catch {
        return null;
    }
}
function readRuntimeVersion(runtimeRoot) {
    if (!runtimeRoot)
        return null;
    try {
        const pkg = readPackageJson(runtimeRoot);
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
function runtimeCommandNames() {
    if (process.platform === "win32") {
        return ["openclaw.cmd", "openclaw.exe", "openclaw.bat", "openclaw.mjs", "openclaw.js", "openclaw"];
    }
    if (process.platform === "darwin") {
        return ["openclaw.mjs", "openclaw", "openclaw.js", "openclaw.cjs"];
    }
    return ["openclaw", "openclaw.mjs", "openclaw.js", "openclaw.cjs"];
}
function resolvePackageJsonBinCandidates(packageRoot) {
    const pkg = readPackageJson(packageRoot);
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
    return uniqPaths(candidates);
}
function resolveHomePackageCommandCandidates() {
    const runtimeRoot = homeInstallRoot();
    return uniqPaths([
        ...resolvePackageJsonBinCandidates(runtimeRoot),
        ...runtimeCommandNames().map((name) => path.join(runtimeRoot, name)),
        ...runtimeCommandNames().map((name) => path.join(runtimeRoot, "bin", name)),
        ...runtimeCommandNames().map((name) => path.join(runtimeRoot, "dist", name)),
    ]);
}
function homeCommandCandidates() {
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
function quotePosixShellArg(value) {
    return "'" + String(value).replace(/'/g, "'\"'\"'") + "'";
}
function resolveUserShell() {
    const envShell = String(process.env.SHELL || "").trim();
    if (envShell && fsSync.existsSync(envShell)) {
        return envShell;
    }
    if (process.platform === "darwin" && fsSync.existsSync("/bin/zsh")) {
        return "/bin/zsh";
    }
    if (fsSync.existsSync("/bin/bash")) {
        return "/bin/bash";
    }
    return "/bin/sh";
}
function resolveNpmBinaryCandidates() {
    const home = homeDir();
    const pathCandidates = splitPathEnv(process.env.PATH).map((dir) => path.join(dir, process.platform === "win32" ? "npm.cmd" : "npm"));
    const commonCandidates = process.platform === "win32"
        ? []
        : [
            "/opt/homebrew/bin/npm",
            "/usr/local/bin/npm",
            "/opt/local/bin/npm",
            path.join(home, ".volta", "bin", "npm"),
            path.join(home, ".fnm", "current", "bin", "npm"),
            path.join(home, ".asdf", "shims", "npm"),
            path.join(home, "node_modules", ".bin", "npm"),
        ];
    return uniqPaths([...pathCandidates, ...commonCandidates]);
}
function findNpmBinaryOnDisk() {
    for (const candidate of resolveNpmBinaryCandidates()) {
        if (fsSync.existsSync(candidate)) {
            return candidate;
        }
    }
    return null;
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
        const stats = fsSync.statSync(realCommand);
        let current = stats.isDirectory() ? realCommand : path.dirname(realCommand);
        const candidates = [current];
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
        const npmBinary = findNpmBinaryOnDisk();
        if (npmBinary) {
            return { command: npmBinary, argsPrefix: [], env: {} };
        }
        return {
            command: resolveUserShell(),
            argsPrefix: ["-lc"],
            env: {},
            useLoginShell: true,
        };
    }
}
function describeNpmInvocation(invocation, cwd, npmArgs) {
    if (invocation.useLoginShell) {
        const shellCommand = `cd ${quotePosixShellArg(cwd)} && npm ${npmArgs.map((value) => quotePosixShellArg(value)).join(" ")}`;
        return `shell login fallback: ${invocation.command} ${invocation.argsPrefix.join(" ")} ${shellCommand}`;
    }
    const rendered = [invocation.command, ...invocation.argsPrefix, ...npmArgs].join(" ").trim();
    return `direct npm invocation: ${rendered}`;
}
async function runInstallCommand(params) {
    const { nodeExecPath, onProgress } = params;
    const invocation = resolveNpmCliInvocation(nodeExecPath);
    const cwd = homeDir();
    const npmArgs = [
        "install",
        `${PACKAGE_NAME}@latest`,
        "--no-fund",
        "--no-audit",
        "--loglevel",
        "info",
    ];
    const args = invocation.useLoginShell
        ? [
            ...invocation.argsPrefix,
            `cd ${quotePosixShellArg(cwd)} && npm ${npmArgs.map((value) => quotePosixShellArg(value)).join(" ")}`,
        ]
        : [...invocation.argsPrefix, ...npmArgs];
    emitProgress(onProgress, {
        phase: "installing",
        progress: 24,
        message: `正在用户目录 ${cwd} 安装 OpenClaw 最新版…`,
        detail: describeNpmInvocation(invocation, cwd, npmArgs),
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
function resolveHomeInstalledRuntime() {
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
async function resolveExistingRuntime() {
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
async function ensureManagedRuntime(params) {
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
