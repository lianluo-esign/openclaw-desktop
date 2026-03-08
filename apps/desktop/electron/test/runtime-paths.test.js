const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveDefaultStateDir,
  resolveRuntimeBuildProblems,
  resolveRuntimeRoot,
} = require("../src/main/runtime-paths");

const REQUIRED_WORKSPACE_TEMPLATES = [
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
];

function seedRuntimeRoot(runtimeRoot) {
  fs.writeFileSync(path.join(runtimeRoot, "openclaw.mjs"), "", "utf8");
  fs.mkdirSync(path.join(runtimeRoot, "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(runtimeRoot, "dist"), { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, "dist", "entry.js"), "", "utf8");
  fs.mkdirSync(path.join(runtimeRoot, "dist", "control-ui"), { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, "dist", "control-ui", "index.html"), "", "utf8");
  fs.mkdirSync(path.join(runtimeRoot, "docs", "reference", "templates"), { recursive: true });
  for (const name of REQUIRED_WORKSPACE_TEMPLATES) {
    fs.writeFileSync(path.join(runtimeRoot, "docs", "reference", "templates", name), "", "utf8");
  }
}

test("resolveDefaultStateDir prefers OPENCLAW_STATE_DIR", () => {
  const previous = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = "/tmp/openclaw-state";
  assert.equal(resolveDefaultStateDir(), "/tmp/openclaw-state");
  if (previous === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previous;
  }
});

test("resolveRuntimeRoot prefers environment override", () => {
  const previous = process.env.OPENCLAW_DESKTOP_RUNTIME_DIR;
  process.env.OPENCLAW_DESKTOP_RUNTIME_DIR = "/tmp/runtime-override";
  assert.equal(
    resolveRuntimeRoot({ app: { isPackaged: false }, devAppRoot: "/workspace/apps/desktop/electron" }),
    "/tmp/runtime-override",
  );
  if (previous === undefined) {
    delete process.env.OPENCLAW_DESKTOP_RUNTIME_DIR;
  } else {
    process.env.OPENCLAW_DESKTOP_RUNTIME_DIR = previous;
  }
});

test("resolveRuntimeRoot returns null without override", () => {
  const result = resolveRuntimeRoot({
    app: { isPackaged: false },
    devAppRoot: "/repo/apps/desktop/electron",
  });
  assert.equal(result, null);
});

test("resolveRuntimeBuildProblems reports missing root node_modules", () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-"));

  seedRuntimeRoot(runtimeRoot);
  fs.rmSync(path.join(runtimeRoot, "node_modules"), { recursive: true, force: true });

  const problems = resolveRuntimeBuildProblems(runtimeRoot);

  assert.deepEqual(problems, ["missing OpenClaw runtime dependencies (node_modules)"]);

  fs.rmSync(runtimeRoot, { recursive: true, force: true });
});

test("resolveRuntimeBuildProblems reports missing workspace templates", () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-"));

  seedRuntimeRoot(runtimeRoot);
  fs.rmSync(path.join(runtimeRoot, "docs", "reference", "templates", "AGENTS.md"), { force: true });

  const problems = resolveRuntimeBuildProblems(runtimeRoot);

  assert.deepEqual(problems, ["missing workspace templates (docs/reference/templates): AGENTS.md"]);

  fs.rmSync(runtimeRoot, { recursive: true, force: true });
});
