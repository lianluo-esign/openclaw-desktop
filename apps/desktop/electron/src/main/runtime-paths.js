const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REQUIRED_WORKSPACE_TEMPLATES = [
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
];

function resolveDefaultStateDir() {
  return process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
}

function resolveRuntimeOverrideRoot() {
  const envOverride = process.env.OPENCLAW_DESKTOP_RUNTIME_DIR?.trim();
  return envOverride ? path.resolve(envOverride) : null;
}

function resolveDevRuntimeRoot() {
  return resolveRuntimeOverrideRoot();
}

function resolveRuntimeRoot() {
  return resolveRuntimeOverrideRoot();
}

function resolveRuntimeLauncher(runtimeRoot) {
  const winLauncher = path.join(runtimeRoot, "bin", "openclaw-gateway.cmd");
  if (process.platform === "win32" && fs.existsSync(winLauncher)) {
    return winLauncher;
  }

  const launcher = path.join(runtimeRoot, "bin", "openclaw-gateway");
  if (fs.existsSync(launcher)) {
    return launcher;
  }

  return null;
}

function resolveRuntimeEntry(runtimeRoot) {
  return path.join(runtimeRoot, "openclaw.mjs");
}

function resolveRuntimeVersion(runtimeRoot) {
  try {
    const packagePath = path.join(runtimeRoot, "package.json");
    const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

function resolveRuntimeNodeModulesDir(runtimeRoot) {
  const direct = path.join(runtimeRoot, "node_modules");
  if (fs.existsSync(direct)) {
    return direct;
  }

  const parent = path.dirname(runtimeRoot);
  if (path.basename(parent) === "node_modules" && fs.existsSync(parent)) {
    return parent;
  }

  return direct;
}

function resolveRuntimeBuildProblems(runtimeRoot) {
  const problems = [];
  const nodeModulesDir = resolveRuntimeNodeModulesDir(runtimeRoot);
  const entry = resolveRuntimeEntry(runtimeRoot);
  if (!fs.existsSync(entry)) {
    problems.push(`missing runtime entry: ${entry}`);
  }
  if (!fs.existsSync(nodeModulesDir)) {
    problems.push("missing OpenClaw runtime dependencies (node_modules)");
  }
  const distEntryJs = path.join(runtimeRoot, "dist", "entry.js");
  const distEntryMjs = path.join(runtimeRoot, "dist", "entry.mjs");
  if (!fs.existsSync(distEntryJs) && !fs.existsSync(distEntryMjs)) {
    problems.push("missing OpenClaw dist/entry build output");
  }
  const controlUiIndex = path.join(runtimeRoot, "dist", "control-ui", "index.html");
  if (!fs.existsSync(controlUiIndex)) {
    problems.push("missing OpenClaw Control UI build output (dist/control-ui/index.html)");
  }

  const workspaceTemplatesDir = path.join(runtimeRoot, "docs", "reference", "templates");
  const missingTemplates = REQUIRED_WORKSPACE_TEMPLATES.filter(
    (name) => !fs.existsSync(path.join(workspaceTemplatesDir, name)),
  );
  if (missingTemplates.length > 0) {
    problems.push(
      `missing workspace templates (docs/reference/templates): ${missingTemplates.join(", ")}`,
    );
  }

  return problems;
}

module.exports = {
  resolveDefaultStateDir,
  resolveDevRuntimeRoot,
  resolveRuntimeBuildProblems,
  resolveRuntimeEntry,
  resolveRuntimeLauncher,
  resolveRuntimeOverrideRoot,
  resolveRuntimeRoot,
  resolveRuntimeVersion,
};
