const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { spawn } = require("node:child_process");

const {
  buildChannelPatch,
  buildProviderPatch,
  deepMerge,
  readConfig,
  summarizeSetupStatus,
  writeConfig,
} = require("./setup-config");
const {
  resolveDefaultStateDir,
  resolveRuntimeBuildProblems,
  resolveRuntimeEntry,
  resolveRuntimeLauncher,
  resolveRuntimeOverrideRoot,
  resolveRuntimeVersion,
} = require("./runtime-paths");
const { resolveElectronNodeExecPath } = require("./electron-node-exec");
const { ensureManagedRuntime } = require("./runtime-installer");

const DEFAULT_PORT = 18789;
const READY_TIMEOUT_MS = 45_000;
const RESTART_DELAYS_MS = [1_000, 3_000, 5_000, 10_000];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isWindowsCommandPath(filePath) {
  return Boolean(filePath) && /\.(cmd|bat)$/i.test(filePath);
}

function isNodeScriptPath(filePath) {
  return Boolean(filePath) && /\.(mjs|cjs|js)$/i.test(filePath);
}

function isOpenClawGatewayProcess(command) {
  return /(^|\/)openclaw-gateway(\s|$)/.test(command);
}

function isOpenClawCommandProcess(command) {
  return /(^|\/)openclaw(\s|$)/.test(command) && !command.includes("openclaw-desktop");
}

function shouldManageExistingOpenClawProcess(command) {
  if (!command) {
    return false;
  }

  if (command.includes("openclaw-desktop")) {
    return false;
  }

  return isOpenClawGatewayProcess(command) || isOpenClawCommandProcess(command);
}

async function collectCurrentUserProcesses() {
  if (process.platform === "win32") {
    return [];
  }

  return new Promise((resolve) => {
    const child = spawn("ps", ["-x", "-o", "pid=,command="], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.once("error", () => resolve([]));
    child.once("exit", (code) => {
      if (code !== 0) {
        resolve([]);
        return;
      }
      const rows = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const match = line.match(/^(\d+)\s+(.*)$/);
          if (!match) return null;
          return { pid: Number.parseInt(match[1], 10), command: match[2] };
        })
        .filter(Boolean);
      resolve(rows);
    });
  });
}

async function findAvailablePort(preferredPort) {
  const tryPort = (port) =>
    new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolve(true));
      });
    });

  if (await tryPort(preferredPort)) {
    return preferredPort;
  }

  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to determine ephemeral port")));
        return;
      }
      const nextPort = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(nextPort);
      });
    });
  });
}

class RuntimeManager extends EventEmitter {
  constructor({ app, shell, devAppRoot }) {
    super();
    this.app = app;
    this.shell = shell;
    this.devAppRoot = devAppRoot;
    this.runtimeOverrideRoot = resolveRuntimeOverrideRoot();
    this.runtimeRoot = this.runtimeOverrideRoot || null;
    this.runtimeSource = this.runtimeOverrideRoot ? "override" : "managed";
    this.runtimeLatestVersion = null;
    this.runtimeTask = null;
    this.runtimeCommand = null;
    this.stateDir = resolveDefaultStateDir();
    this.userDataDir = app.getPath("userData");
    this.logsDir = path.join(this.userDataDir, "logs");
    this.metaPath = path.join(this.userDataDir, "desktop-runtime.json");
    this.diagnosticsDir = path.join(this.userDataDir, "diagnostics");
    this.logPath = path.join(this.logsDir, "openclaw-gateway.log");
    this.child = null;
    this.state = "stopped";
    this.lastError = null;
    this.restartCount = 0;
    this.retryTimer = null;
    this.intentionalStop = false;
    this.updatePromise = null;
    this.meta = this.loadMeta();
    this.health = {
      connected: false,
      lastHelloAt: null,
      lastError: null,
      restartCount: 0,
      pid: null,
      port: this.meta.port || DEFAULT_PORT,
      version: this.runtimeRoot ? resolveRuntimeVersion(this.runtimeRoot) : "unknown",
    };
  }

  emitState() {
    const snapshot = this.getState();
    this.emit("state", snapshot);
    return snapshot;
  }

  setRuntimeTask(nextTask) {
    this.runtimeTask = nextTask ? { ...nextTask } : null;
    this.emitState();
  }

  clearRuntimeTask() {
    this.runtimeTask = null;
    this.emitState();
  }

  getConfigPath() {
    return path.join(this.stateDir, "openclaw.json");
  }

  readOpenClawConfig() {
    return readConfig(this.getConfigPath());
  }

  writeOpenClawConfig(config) {
    writeConfig(this.getConfigPath(), config);
    this.emit("setup-status", this.getSetupStatus());
  }

  getSetupStatus() {
    const config = this.readOpenClawConfig();
    return {
      ...summarizeSetupStatus(config, process.env),
      configPath: this.getConfigPath(),
      hasConfigFile: fs.existsSync(this.getConfigPath()),
    };
  }

  applyProviderSetup(payload) {
    const current = this.readOpenClawConfig();
    const next = deepMerge(current, buildProviderPatch(payload));
    this.writeOpenClawConfig(next);
    return this.getSetupStatus();
  }

  applyChannelSetup(payload) {
    const current = this.readOpenClawConfig();
    const next = deepMerge(current, buildChannelPatch(payload));
    this.writeOpenClawConfig(next);
    return this.getSetupStatus();
  }

  loadMeta() {
    try {
      fs.mkdirSync(this.userDataDir, { recursive: true });
      const raw = fs.readFileSync(this.metaPath, "utf8");
      const parsed = JSON.parse(raw);
      return {
        token: typeof parsed.token === "string" && parsed.token ? parsed.token : null,
        port: typeof parsed.port === "number" ? parsed.port : DEFAULT_PORT,
      };
    } catch {
      return { token: null, port: DEFAULT_PORT };
    }
  }

  saveMeta() {
    fs.mkdirSync(this.userDataDir, { recursive: true });
    fs.writeFileSync(
      this.metaPath,
      JSON.stringify({ token: this.meta.token, port: this.health.port }, null, 2),
      "utf8",
    );
  }

  ensureGatewayTokenConfig() {
    const envToken = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
    if (envToken) {
      this.meta.token = envToken;
      this.saveMeta();
      return envToken;
    }

    const config = this.readOpenClawConfig();
    const configuredToken = typeof config?.gateway?.auth?.token === "string" && config.gateway.auth.token.trim() && !config.gateway.auth.token.includes("${")
      ? config.gateway.auth.token.trim()
      : null;

    const token = configuredToken || this.meta.token || randomBytes(24).toString("base64url");
    this.meta.token = token;
    this.saveMeta();

    const nextConfig = {
      ...config,
      gateway: {
        ...(config.gateway || {}),
        auth: {
          ...((config.gateway && config.gateway.auth) || {}),
          mode: "token",
          token,
        },
      },
    };

    writeConfig(this.getConfigPath(), nextConfig);
    return token;
  }

  resolveGatewayAuth() {
    const token = this.ensureGatewayTokenConfig();
    return { mode: "token", token };
  }

  setState(nextState, extra = {}) {
    this.state = nextState;
    if (Object.prototype.hasOwnProperty.call(extra, "lastError")) {
      this.lastError = extra.lastError;
      this.health.lastError = extra.lastError;
    }
    this.health.connected = nextState === "running";
    this.health.restartCount = this.restartCount;
    return this.emitState();
  }

  getConnectionInfo() {
    const port = this.health.port;
    const auth = this.resolveGatewayAuth();
    return {
      wsUrl: `ws://127.0.0.1:${port}`,
      httpBaseUrl: `http://127.0.0.1:${port}`,
      token: auth.token || null,
      authMode: auth.mode || null,
      deviceReady: true,
      localeDefault: "zh-CN",
    };
  }

  getState() {
    return {
      state: this.state,
      lastError: this.lastError,
      runtimeRoot: this.runtimeRoot,
      runtimeCommand: this.runtimeCommand,
      runtimeSource: this.runtimeSource,
      runtimeLatestVersion: this.runtimeLatestVersion,
      runtimeTask: this.runtimeTask,
      stateDir: this.stateDir,
      configPath: this.getConfigPath(),
      logPath: this.logPath,
      diagnosticsDir: this.diagnosticsDir,
      health: { ...this.health },
      connection: this.getConnectionInfo(),
      setup: this.getSetupStatus(),
    };
  }

  async resolveRuntimeRoot(nodeExecPath, { forceLatest = false } = {}) {
    if (this.runtimeOverrideRoot) {
      this.runtimeRoot = this.runtimeOverrideRoot;
      this.runtimeSource = "override";
      this.runtimeCommand = null;
      this.runtimeLatestVersion = null;
      this.health.version = resolveRuntimeVersion(this.runtimeRoot);
      return this.runtimeRoot;
    }

    const resolved = await ensureManagedRuntime({
      userDataDir: this.userDataDir,
      nodeExecPath,
      forceLatest,
      onProgress: (task) => {
        this.runtimeLatestVersion = task.latestVersion ?? this.runtimeLatestVersion;
        this.health.version = task.version || this.health.version;
        this.setRuntimeTask(task);
      },
    });

    this.runtimeRoot = resolved.runtimeRoot;
    this.runtimeSource = resolved.source;
    this.runtimeCommand = resolved.runtimeCommand || null;
    this.runtimeLatestVersion = resolved.latestVersion || null;
    this.health.version = resolved.version || resolveRuntimeVersion(this.runtimeRoot);
    return this.runtimeRoot;
  }

  buildRuntimeNotReadyMessage(buildProblems) {
    if (this.runtimeOverrideRoot) {
      return (
        `OpenClaw runtime not ready: ${buildProblems.join("; ")}. ` +
        "Point OPENCLAW_DESKTOP_RUNTIME_DIR to a built runtime, or let the desktop app resolve the user-installed openclaw runtime."
      );
    }

    return (
      `OpenClaw runtime not ready: ${buildProblems.join("; ")}. ` +
      "Please keep the network available and let the desktop app download the managed OpenClaw runtime into its private data directory."
    );
  }

  async buildRuntimeCommandInvocation(args) {
    const nodeExecPath = resolveElectronNodeExecPath({ app: this.app });

    if (this.app?.isPackaged && this.runtimeCommand) {
      if (isWindowsCommandPath(this.runtimeCommand)) {
        return {
          command: process.env.ComSpec || process.env.COMSPEC || "cmd.exe",
          args: ["/d", "/s", "/c", this.runtimeCommand, ...args],
        };
      }
      if (isNodeScriptPath(this.runtimeCommand)) {
        return {
          command: nodeExecPath,
          args: [this.runtimeCommand, ...args],
        };
      }
      return { command: this.runtimeCommand, args };
    }

    return {
      command: nodeExecPath,
      args: [resolveRuntimeEntry(this.runtimeRoot), ...args],
    };
  }

  async stopExistingUserGateway() {

    this.setRuntimeTask({
      phase: "stopping-existing-runtime",
      progress: 18,
      version: this.health.version,
      latestVersion: this.runtimeLatestVersion,
      message: "正在停止当前用户已有的 OpenClaw Gateway…",
    });

    try {
      const invocation = await this.buildRuntimeCommandInvocation(["gateway", "stop", "--json"]);
      await new Promise((resolve) => {
        const child = spawn(invocation.command, invocation.args, {
          cwd: this.runtimeRoot || process.cwd(),
          env: { ...process.env, FORCE_COLOR: "0" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.once("error", () => resolve());
        child.once("exit", () => resolve());
      });
    } catch {
      // ignore and continue with best-effort process cleanup
    }

    if (process.platform === "win32") {
      return;
    }

    await sleep(1200);

    const processes = await collectCurrentUserProcesses();
    const managedProcesses = processes.filter((entry) => {
      if (!entry || !Number.isFinite(entry.pid) || entry.pid <= 0) {
        return false;
      }
      if (entry.pid === process.pid) {
        return false;
      }
      return shouldManageExistingOpenClawProcess(String(entry.command || ""));
    });

    const gatewayProcesses = managedProcesses.filter((entry) => isOpenClawGatewayProcess(String(entry.command || "")));
    const openclawProcesses = managedProcesses.filter((entry) => isOpenClawCommandProcess(String(entry.command || "")));
    const hasPair = gatewayProcesses.length > 0 && openclawProcesses.length > 0;
    const candidates = managedProcesses.filter((entry) => {
      const command = String(entry.command || "");
      if (isOpenClawGatewayProcess(command)) {
        return true;
      }
      return hasPair && isOpenClawCommandProcess(command);
    });

    if (candidates.length > 0) {
      this.setRuntimeTask({
        phase: "stopping-existing-runtime",
        progress: 22,
        version: this.health.version,
        latestVersion: this.runtimeLatestVersion,
        message: `检测到 ${candidates.length} 个旧的 OpenClaw 进程，正在清理…`,
        detail: candidates.map((entry) => `[${entry.pid}] ${String(entry.command || "")}`).join("\n"),
      });
    }

    for (const entry of candidates) {
      try {
        process.kill(entry.pid, "SIGTERM");
      } catch {
        // ignore
      }
    }

    if (candidates.length === 0) {
      return;
    }

    await sleep(1500);

    for (const entry of candidates) {
      try {
        process.kill(entry.pid, 0);
        process.kill(entry.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }

  async start({ reason = "manual-start", skipRuntimeResolve = false } = {}) {
    if (this.child || this.state === "starting" || this.state === "running") {
      return this.getState();
    }

    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.intentionalStop = false;

    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.mkdirSync(this.logsDir, { recursive: true });

    this.setState("starting", { lastError: null });

    const nodeExecPath = resolveElectronNodeExecPath({ app: this.app });

    try {
      const shouldResolveRuntime = !skipRuntimeResolve
        && !(reason === "auto-restart" && this.runtimeRoot);
      if (shouldResolveRuntime || !this.runtimeRoot) {
        await this.resolveRuntimeRoot(nodeExecPath);
      }
    } catch (error) {
      this.setState("crashed", {
        lastError: `Failed to prepare OpenClaw runtime: ${error.message}`,
      });
      return this.getState();
    }

    const buildProblems = resolveRuntimeBuildProblems(this.runtimeRoot);
    if (buildProblems.length > 0) {
      this.setState("crashed", {
        lastError: this.buildRuntimeNotReadyMessage(buildProblems),
      });
      return this.getState();
    }

    await this.stopExistingUserGateway();

    const preferredPort = this.meta.port || DEFAULT_PORT;
    const port = await findAvailablePort(preferredPort);
    this.health.port = port;
    this.meta.port = port;
    this.saveMeta();

    const gatewayAuth = this.resolveGatewayAuth();
    const runtimeEntry = resolveRuntimeEntry(this.runtimeRoot);
    const runtimeLauncher = resolveRuntimeLauncher(this.runtimeRoot);
    const runtimeArgs = [
      "gateway",
      "run",
      "--bind",
      "loopback",
      "--port",
      String(port),
      "--allow-unconfigured",
      "--force",
    ];
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      OPENCLAW_STATE_DIR: this.stateDir,
      OPENCLAW_CONFIG_PATH: this.getConfigPath(),
      OPENCLAW_DESKTOP_NODE_EXEC: nodeExecPath,
      FORCE_COLOR: "0",
    };
    if (gatewayAuth.token) {
      env.OPENCLAW_GATEWAY_TOKEN = gatewayAuth.token;
    }
    const out = fs.createWriteStream(this.logPath, { flags: "a" });

    this.setRuntimeTask({
      phase: "starting-runtime",
      progress: 96,
      version: this.health.version,
      latestVersion: this.runtimeLatestVersion,
      message: `正在启动 OpenClaw v${this.health.version}…`,
    });

    let runtimeCommand = nodeExecPath;
    let runtimeCommandArgs = [runtimeEntry, ...runtimeArgs];

    if (this.app?.isPackaged && this.runtimeCommand) {
      const invocation = await this.buildRuntimeCommandInvocation(runtimeArgs);
      runtimeCommand = invocation.command;
      runtimeCommandArgs = invocation.args;
    } else if (runtimeLauncher) {
      if (process.platform === "win32") {
        runtimeCommand = process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
        runtimeCommandArgs = ["/d", "/s", "/c", runtimeLauncher, ...runtimeArgs];
      } else {
        runtimeCommand = runtimeLauncher;
        runtimeCommandArgs = runtimeArgs;
      }
    }

    const child = spawn(runtimeCommand, runtimeCommandArgs, {
      cwd: this.runtimeRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.child = child;
    this.health.pid = child.pid ?? null;
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    child.stdout.on("data", (chunk) => this.emit("log", String(chunk)));
    child.stderr.on("data", (chunk) => this.emit("log", String(chunk)));

    child.once("exit", (code, signal) => {
      this.child = null;
      this.health.pid = null;
      out.end();

      if (this.intentionalStop) {
        this.setState("stopped", { lastError: null });
        return;
      }

      const reasonText = `OpenClaw runtime exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`;
      this.lastError = reasonText;
      this.health.lastError = reasonText;
      this.scheduleRestart(reasonText);
    });

    child.once("error", (error) => {
      this.child = null;
      this.health.pid = null;
      out.end();
      this.scheduleRestart(`Failed to spawn OpenClaw runtime: ${error.message}`);
    });

    try {
      await this.waitUntilReady();
      this.health.lastHelloAt = Date.now();
      this.restartCount = 0;
      this.clearRuntimeTask();
      this.setState("running", { lastError: null });
    } catch (error) {
      const failureMessage = `OpenClaw runtime failed to become ready after ${reason}: ${error.message}`;
      if (this.retryTimer || this.state === "crashed") {
        return this.getState();
      }
      if (this.child) {
        this.intentionalStop = true;
        await this.stop();
        this.intentionalStop = false;
      }
      this.scheduleRestart(failureMessage);
    }

    return this.getState();
  }

  async waitUntilReady() {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    const url = `${this.getConnectionInfo().httpBaseUrl}/`;

    while (Date.now() < deadline) {
      if (!this.child) {
        throw new Error("runtime process exited before gateway became ready");
      }
      try {
        const response = await fetch(url, { method: "GET" });
        if (response.ok) {
          return;
        }
      } catch {
        // keep polling
      }
      await sleep(1_000);
    }

    throw new Error("gateway HTTP endpoint not reachable");
  }

  scheduleRestart(message) {
    clearTimeout(this.retryTimer);
    const delay = RESTART_DELAYS_MS[Math.min(this.restartCount, RESTART_DELAYS_MS.length - 1)];
    this.restartCount += 1;
    this.setRuntimeTask({
      phase: "retrying",
      progress: 100,
      version: this.health.version,
      latestVersion: this.runtimeLatestVersion,
      message: `启动失败，${delay / 1000}s 后自动重试…`,
      detail: message,
    });
    this.setState("crashed", { lastError: `${message}; retrying in ${delay / 1000}s` });
    this.retryTimer = setTimeout(() => {
      void this.start({ reason: "auto-restart" });
    }, delay);
  }

  async stop() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;

    if (!this.child) {
      this.clearRuntimeTask();
      this.setState("stopped", { lastError: null });
      return this.getState();
    }

    this.intentionalStop = true;
    this.setRuntimeTask({
      phase: "stopping-runtime",
      progress: 100,
      version: this.health.version,
      latestVersion: this.runtimeLatestVersion,
      message: "正在停止 OpenClaw runtime…",
    });
    this.setState("stopping", { lastError: null });

    const child = this.child;
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 10_000);

      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });

      try {
        child.kill("SIGTERM");
      } catch {
        clearTimeout(timeout);
        resolve();
      }
    });

    this.clearRuntimeTask();
    return this.getState();
  }

  async restart() {
    await this.stop();
    return this.start({ reason: "manual-restart" });
  }

  supportsManagedRuntimeUpdates() {
    return Boolean(this.app?.isPackaged) && !this.runtimeOverrideRoot;
  }

  async updateRuntime() {
    if (!this.supportsManagedRuntimeUpdates()) {
      return this.getState();
    }

    if (this.state === "starting" || this.state === "stopping") {
      return this.getState();
    }

    if (this.updatePromise) {
      return this.updatePromise;
    }

    const task = (async () => {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;

      const wasRunning = this.state === "running";
      const nodeExecPath = resolveElectronNodeExecPath({ app: this.app });

      await this.stop();

      this.setRuntimeTask({
        phase: "updating-runtime",
        progress: 12,
        version: this.health.version,
        latestVersion: this.runtimeLatestVersion,
        message: "正在下载并更新 OpenClaw runtime…",
      });

      try {
        await this.resolveRuntimeRoot(nodeExecPath, { forceLatest: true });
      } catch (error) {
        if (wasRunning && this.runtimeRoot) {
          try {
            await this.start({ reason: "update-failed-restore", skipRuntimeResolve: true });
            return this.getState();
          } catch {
            // ignore restart failure and surface original update error below
          }
        }
        this.setState("crashed", {
          lastError: `Failed to update OpenClaw runtime: ${error.message}`,
        });
        return this.getState();
      }

      this.health.version = resolveRuntimeVersion(this.runtimeRoot) || this.health.version;
      this.setRuntimeTask({
        phase: "ready",
        progress: 100,
        version: this.health.version,
        latestVersion: this.runtimeLatestVersion,
        message: `OpenClaw runtime 已更新到 v${this.health.version}，正在重启…`,
        detail: this.runtimeRoot,
      });

      return this.start({ reason: "manual-update", skipRuntimeResolve: true });
    })();

    this.updatePromise = task.finally(() => {
      this.updatePromise = null;
    });

    return this.updatePromise;
  }

  async openConfigDir() {
    fs.mkdirSync(this.stateDir, { recursive: true });
    return this.shell.openPath(this.stateDir);
  }

  async openLogsDir() {
    fs.mkdirSync(this.logsDir, { recursive: true });
    return this.shell.openPath(this.logsDir);
  }

  async exportDiagnostics() {
    fs.mkdirSync(this.diagnosticsDir, { recursive: true });
    const filePath = path.join(this.diagnosticsDir, `diagnostics-${Date.now()}.json`);
    const payload = {
      exportedAt: new Date().toISOString(),
      state: this.getState(),
    };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
    return { filePath };
  }
}

module.exports = {
  DEFAULT_PORT,
  RuntimeManager,
  findAvailablePort,
};
