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
  resolveRuntimeRoot,
  resolveRuntimeVersion,
} = require("./runtime-paths");
const { resolveElectronNodeExecPath } = require("./electron-node-exec");

const DEFAULT_PORT = 18789;
const READY_TIMEOUT_MS = 45_000;
const RESTART_DELAYS_MS = [1_000, 3_000, 5_000, 10_000];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    this.runtimeRoot = resolveRuntimeRoot({ app, devAppRoot });
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
    this.meta = this.loadMeta();
    this.health = {
      connected: false,
      lastHelloAt: null,
      lastError: null,
      restartCount: 0,
      pid: null,
      port: this.meta.port || DEFAULT_PORT,
      version: resolveRuntimeVersion(this.runtimeRoot),
    };
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

  ensureToken() {
    const envToken = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
    if (envToken) {
      this.meta.token = envToken;
      this.saveMeta();
      return envToken;
    }

    if (!this.meta.token) {
      this.meta.token = randomBytes(24).toString("base64url");
      this.saveMeta();
    }
    return this.meta.token;
  }

  setState(nextState, extra = {}) {
    this.state = nextState;
    if (Object.prototype.hasOwnProperty.call(extra, "lastError")) {
      this.lastError = extra.lastError;
      this.health.lastError = extra.lastError;
    }
    this.health.connected = nextState === "running";
    this.health.restartCount = this.restartCount;
    const snapshot = this.getState();
    this.emit("state", snapshot);
  }

  getConnectionInfo() {
    const port = this.health.port;
    const token = this.ensureToken();
    return {
      wsUrl: `ws://127.0.0.1:${port}`,
      httpBaseUrl: `http://127.0.0.1:${port}`,
      token,
      deviceReady: true,
      localeDefault: "zh-CN",
    };
  }

  getState() {
    return {
      state: this.state,
      lastError: this.lastError,
      runtimeRoot: this.runtimeRoot,
      stateDir: this.stateDir,
      configPath: this.getConfigPath(),
      logPath: this.logPath,
      diagnosticsDir: this.diagnosticsDir,
      health: { ...this.health },
      connection: this.getConnectionInfo(),
      setup: this.getSetupStatus(),
    };
  }

  async start({ reason = "manual-start" } = {}) {
    if (this.child || this.state === "starting" || this.state === "running") {
      return this.getState();
    }

    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.intentionalStop = false;

    const buildProblems = resolveRuntimeBuildProblems(this.runtimeRoot);
    if (buildProblems.length > 0) {
      this.setState("crashed", {
        lastError:
          `OpenClaw runtime not ready: ${buildProblems.join("; ")}. ` +
          "Run `npm run prepare:runtime` in the desktop app or point OPENCLAW_DESKTOP_RUNTIME_DIR to a built runtime.",
      });
      return this.getState();
    }

    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.mkdirSync(this.logsDir, { recursive: true });

    const preferredPort = this.meta.port || DEFAULT_PORT;
    const port = await findAvailablePort(preferredPort);
    this.health.port = port;
    this.meta.port = port;
    this.saveMeta();

    const token = this.ensureToken();
    const runtimeEntry = resolveRuntimeEntry(this.runtimeRoot);
    const runtimeLauncher = resolveRuntimeLauncher(this.runtimeRoot);
    const nodeExecPath = resolveElectronNodeExecPath({ app: this.app });
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
      OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_STATE_DIR: this.stateDir,
      OPENCLAW_CONFIG_PATH: this.getConfigPath(),
      OPENCLAW_DESKTOP_NODE_EXEC: nodeExecPath,
      FORCE_COLOR: "0",
    };
    const out = fs.createWriteStream(this.logPath, { flags: "a" });

    this.setState("starting", { lastError: null });

    let runtimeCommand = nodeExecPath;
    let runtimeCommandArgs = [runtimeEntry, ...runtimeArgs];

    if (runtimeLauncher) {
      if (process.platform === "win32") {
        runtimeCommand = process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
        runtimeCommandArgs = ["/d", "/s", "/c", runtimeLauncher, ...runtimeArgs];
      } else {
        runtimeCommand = runtimeLauncher;
        runtimeCommandArgs = runtimeArgs;
      }
    }

    const child = spawn(
      runtimeCommand,
      runtimeCommandArgs,
      {
        cwd: this.runtimeRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

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
      this.setState("running", { lastError: null });
    } catch (error) {
      this.scheduleRestart(`OpenClaw runtime failed to become ready after ${reason}: ${error.message}`);
    }

    return this.getState();
  }

  async waitUntilReady() {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    const url = `${this.getConnectionInfo().httpBaseUrl}/`;

    while (Date.now() < deadline) {
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
    this.setState("crashed", { lastError: `${message}; retrying in ${delay / 1000}s` });
    this.retryTimer = setTimeout(() => {
      void this.start({ reason: "auto-restart" });
    }, delay);
  }

  async stop() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;

    if (!this.child) {
      this.setState("stopped", { lastError: null });
      return this.getState();
    }

    this.intentionalStop = true;
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

    return this.getState();
  }

  async restart() {
    await this.stop();
    return this.start({ reason: "manual-restart" });
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
