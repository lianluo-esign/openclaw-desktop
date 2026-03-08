const test = require("node:test");
const assert = require("node:assert/strict");

const { buildTrayMenuTemplate } = require("../src/main/tray");

test("buildTrayMenuTemplate shows hidden-state label and disabled start while running", () => {
  const template = buildTrayMenuTemplate({ isWindowVisible: false, runtimeState: "running" });

  assert.equal(template[0].label, "显示 OpenClaw Desktop");
  assert.equal(template.find((item) => item.id === "start-runtime").enabled, false);
  assert.equal(template.find((item) => item.id === "stop-runtime").enabled, true);
});

test("buildTrayMenuTemplate enables start when runtime is stopped", () => {
  const template = buildTrayMenuTemplate({ isWindowVisible: true, runtimeState: "stopped" });

  assert.equal(template[0].label, "隐藏窗口");
  assert.equal(template.find((item) => item.id === "start-runtime").enabled, true);
  assert.equal(template.find((item) => item.id === "stop-runtime").enabled, false);
});
