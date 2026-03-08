const { contextBridge, ipcRenderer } = require("electron");

const CHANNEL = "desktop-runtime:state-changed";
const OPEN_SETUP_CHANNEL = "desktop-setup:open";
const SESSION_SKIP_KEY = "openclaw.desktop.setup.skipped";
const TEST_MESSAGE = "你好，请回复“配置已成功”，并简要确认当前模型是否可用。";

function createApi() {
  return {
    getState: () => ipcRenderer.invoke("desktop-runtime:get-state"),
    start: () => ipcRenderer.invoke("desktop-runtime:start"),
    stop: () => ipcRenderer.invoke("desktop-runtime:stop"),
    restart: () => ipcRenderer.invoke("desktop-runtime:restart"),
    update: () => ipcRenderer.invoke("desktop-runtime:update"),
    getConnectionInfo: () => ipcRenderer.invoke("desktop-runtime:get-connection-info"),
    openHome: () => ipcRenderer.invoke("desktop-runtime:open-home"),
    openConfigDir: () => ipcRenderer.invoke("desktop-runtime:open-config-dir"),
    openLogsDir: () => ipcRenderer.invoke("desktop-runtime:open-logs-dir"),
    exportDiagnostics: () => ipcRenderer.invoke("desktop-runtime:export-diagnostics"),
    backupStart: () => ipcRenderer.invoke("desktop-backup:start"),
    backupStop: () => ipcRenderer.invoke("desktop-backup:stop"),
    backupRestart: () => ipcRenderer.invoke("desktop-backup:restart"),
    backupNow: () => ipcRenderer.invoke("desktop-backup:backup-now"),
    backupList: () => ipcRenderer.invoke("desktop-backup:list"),
    backupRestore: (payload) => ipcRenderer.invoke("desktop-backup:restore", payload),
    openBackupLogsDir: () => ipcRenderer.invoke("desktop-backup:open-logs-dir"),
    getSetupStatus: () => ipcRenderer.invoke("desktop-setup:get-status"),
    applyProviderSetup: (payload) => ipcRenderer.invoke("desktop-setup:apply-provider", payload),
    applyChannelSetup: (payload) => ipcRenderer.invoke("desktop-setup:apply-channel", payload),
    subscribe: (callback) => {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on(CHANNEL, handler);
      return () => ipcRenderer.removeListener(CHANNEL, handler);
    },
    onOpenSetup: (callback) => {
      const handler = () => callback();
      ipcRenderer.on(OPEN_SETUP_CHANNEL, handler);
      return () => ipcRenderer.removeListener(OPEN_SETUP_CHANNEL, handler);
    },
  };
}

function defaultChineseLocaleForControlUi() {
  try {
    if (!["127.0.0.1", "localhost"].includes(window.location.hostname)) {
      return;
    }
    if (!localStorage.getItem("openclaw.i18n.locale")) {
      localStorage.setItem("openclaw.i18n.locale", "zh-CN");
    }
  } catch {
    // ignore
  }
}

function modelOptions(providerId) {
  if (providerId === "minimax") {
    return [
      { value: "MiniMax-M2.5", label: "MiniMax M2.5（推荐）" },
      { value: "MiniMax-M2.5-highspeed", label: "MiniMax M2.5 Highspeed" },
    ];
  }
  if (providerId === "openai") {
    return [{ value: "openai/gpt-5.2", label: "GPT-5.2" }];
  }
  if (providerId === "anthropic") {
    return [
      { value: "anthropic/claude-opus-4-6", label: "Claude Opus 4.6（推荐）" },
      { value: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    ];
  }
  if (providerId === "google") {
    return [
      { value: "google/gemini-3-pro-preview", label: "Gemini 3 Pro Preview（推荐）" },
      { value: "google/gemini-3-flash-preview", label: "Gemini 3 Flash Preview" },
    ];
  }
  if (providerId === "zai") {
    return [{ value: "zai/glm-4.7", label: "GLM 4.7" }];
  }
  return [];
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderOptions(options, selected) {
  return options
    .map(
      (option) =>
        `<option value="${escapeHtml(option.value)}" ${option.value === selected ? "selected" : ""}>${escapeHtml(option.label)}</option>`,
    )
    .join("");
}

function isLocalControlUi() {
  return ["127.0.0.1", "localhost"].includes(window.location.hostname);
}

function requestOpenSetupWizardIfSupported(status) {
  return Boolean(status?.shouldOnboard) && sessionStorage.getItem(SESSION_SKIP_KEY) !== "1";
}

function navigateToChat(prefill) {
  const targetPath = "/chat";
  const needsNavigation = window.location.pathname !== targetPath;
  if (prefill) {
    sessionStorage.setItem("openclaw.desktop.test-message", TEST_MESSAGE);
  }
  if (needsNavigation) {
    window.location.assign(targetPath);
    return;
  }
  if (prefill) {
    queuePrefillTestMessage();
  }
}

function queuePrefillTestMessage() {
  const value = sessionStorage.getItem("openclaw.desktop.test-message");
  if (!value) {
    return;
  }

  const apply = () => {
    const textarea = document.querySelector(".chat-compose textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) {
      return false;
    }
    textarea.focus();
    textarea.value = value;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    sessionStorage.removeItem("openclaw.desktop.test-message");
    return true;
  };

  if (apply()) {
    return;
  }

  const observer = new MutationObserver(() => {
    if (apply()) {
      observer.disconnect();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.setTimeout(() => observer.disconnect(), 12_000);
}

function ensureSetupWizard(api) {
  if (!isLocalControlUi()) {
    return;
  }

  const wizardState = {
    open: false,
    dirty: false,
    loading: false,
    status: null,
    step: "welcome",
    error: "",
    pendingFinishAction: null,
    provider: {
      providerId: "minimax",
      apiKey: "",
      modelId: "MiniMax-M2.5",
      region: "global",
    },
    channel: {
      channelId: "telegram",
      mode: "socket",
      botToken: "",
      appToken: "",
      signingSecret: "",
      webhookPath: "/slack/events",
    },
  };

  const root = document.createElement("div");
  root.id = "openclaw-desktop-setup-root";
  root.style.display = "none";
  const shadow = root.attachShadow({ mode: "open" });

  function providerConfiguredLabel() {
    if (wizardState.status?.provider?.configured) {
      return `已配置：${wizardState.status.provider.primaryModel || wizardState.status.provider.selectedProvider || "可用模型"}`;
    }
    return "未配置";
  }

  function channelConfiguredLabel() {
    if (wizardState.status?.channel?.configured) {
      const names = (wizardState.status.channel.supported || [])
        .filter((entry) => entry.configured)
        .map((entry) => entry.label)
        .join("、");
      return `已配置：${names || "至少一个渠道"}`;
    }
    return "未配置";
  }

  function pickDefaultChannel(status) {
    const firstUnconfigured = status?.channel?.supported?.find((entry) => !entry.configured);
    if (firstUnconfigured) {
      return firstUnconfigured.id;
    }
    return "telegram";
  }

  function hydrateDefaultsFromStatus(status) {
    const providerId = status?.provider?.selectedProvider;
    if (["minimax", "openai", "anthropic", "google", "zai"].includes(providerId)) {
      wizardState.provider.providerId = providerId;
    }
    const options = modelOptions(wizardState.provider.providerId);
    if (options.length > 0 && !options.some((entry) => entry.value === wizardState.provider.modelId)) {
      wizardState.provider.modelId = options[0].value;
    }
    wizardState.channel.channelId = pickDefaultChannel(status);
  }

  function providerValidation() {
    const errors = [];
    if (!wizardState.provider.providerId) {
      errors.push("请选择一个模型 Provider。");
    }
    if (!wizardState.provider.modelId) {
      errors.push("请选择默认模型。");
    }
    if (!wizardState.provider.apiKey.trim()) {
      errors.push("请填写 API Key。");
    }
    return errors;
  }

  function channelValidation() {
    const errors = [];
    if (!wizardState.channel.channelId) {
      errors.push("请选择一个接入渠道。");
      return errors;
    }
    if (!wizardState.channel.botToken.trim()) {
      errors.push("请填写 Bot Token。");
    }
    if (wizardState.channel.channelId === "slack") {
      if (wizardState.channel.mode === "socket" && !wizardState.channel.appToken.trim()) {
        errors.push("Slack Socket Mode 需要 App Token。");
      }
      if (wizardState.channel.mode === "http" && !wizardState.channel.signingSecret.trim()) {
        errors.push("Slack HTTP 模式需要 Signing Secret。");
      }
    }
    return errors;
  }

  function openWizard(forceStep = "welcome") {
    sessionStorage.removeItem(SESSION_SKIP_KEY);
    wizardState.open = true;
    wizardState.error = "";
    wizardState.step = forceStep;
    render();
  }

  function closeWizard(markSkipped = false) {
    wizardState.open = false;
    wizardState.error = "";
    if (markSkipped) {
      sessionStorage.setItem(SESSION_SKIP_KEY, "1");
    }
    render();
  }

  async function refreshStatus({ forceOpen = false } = {}) {
    try {
      const status = await api.getSetupStatus();
      wizardState.status = status;
      hydrateDefaultsFromStatus(status);
      if (forceOpen) {
        openWizard("welcome");
        return;
      }
      if (requestOpenSetupWizardIfSupported(status)) {
        openWizard("welcome");
        return;
      }
      if (!status.shouldOnboard) {
        closeWizard(false);
        return;
      }
      render();
    } catch (error) {
      wizardState.error = error.message || String(error);
      wizardState.open = true;
      render();
    }
  }

  async function saveProvider() {
    const errors = providerValidation();
    if (errors.length > 0) {
      wizardState.error = errors.join("\n");
      render();
      return;
    }
    wizardState.loading = true;
    wizardState.error = "";
    render();
    try {
      const nextStatus = await api.applyProviderSetup(wizardState.provider);
      wizardState.status = nextStatus;
      wizardState.dirty = true;
      wizardState.step = "channel";
    } catch (error) {
      wizardState.error = error.message || String(error);
    } finally {
      wizardState.loading = false;
      render();
    }
  }

  async function saveChannel() {
    const errors = channelValidation();
    if (errors.length > 0) {
      wizardState.error = errors.join("\n");
      render();
      return;
    }
    wizardState.loading = true;
    wizardState.error = "";
    render();
    try {
      const nextStatus = await api.applyChannelSetup(wizardState.channel);
      wizardState.status = nextStatus;
      wizardState.dirty = true;
      wizardState.step = "done";
    } catch (error) {
      wizardState.error = error.message || String(error);
    } finally {
      wizardState.loading = false;
      render();
    }
  }

  async function finishWizard(action = "close") {
    wizardState.loading = true;
    wizardState.pendingFinishAction = action;
    wizardState.error = "";
    render();
    try {
      if (wizardState.dirty) {
        await api.restart();
        wizardState.dirty = false;
      }
      closeWizard(false);
      await refreshStatus();
      if (action === "chat") {
        navigateToChat(false);
      }
      if (action === "test") {
        navigateToChat(true);
      }
    } catch (error) {
      wizardState.error = error.message || String(error);
      wizardState.open = true;
    } finally {
      wizardState.pendingFinishAction = null;
      wizardState.loading = false;
      render();
    }
  }

  function bindInputValue(id, applyValue) {
    const node = shadow.getElementById(id);
    if (!node) {
      return;
    }
    node.addEventListener("input", (event) => {
      applyValue(event.target.value);
    });
  }

  function bindEvents() {
    shadow.getElementById("welcome-start")?.addEventListener("click", () => {
      wizardState.step = wizardState.status?.provider?.configured ? "channel" : "provider";
      render();
    });
    shadow.getElementById("welcome-skip")?.addEventListener("click", () => closeWizard(true));
    shadow.getElementById("provider-back")?.addEventListener("click", () => {
      wizardState.step = "welcome";
      render();
    });
    shadow.getElementById("provider-save")?.addEventListener("click", () => void saveProvider());
    shadow.getElementById("provider-skip")?.addEventListener("click", () => {
      wizardState.step = "channel";
      wizardState.error = "";
      render();
    });
    shadow.getElementById("channel-back")?.addEventListener("click", () => {
      wizardState.step = wizardState.status?.provider?.configured ? "welcome" : "provider";
      wizardState.error = "";
      render();
    });
    shadow.getElementById("channel-save")?.addEventListener("click", () => void saveChannel());
    shadow.getElementById("channel-skip")?.addEventListener("click", () => {
      wizardState.step = "done";
      wizardState.error = "";
      render();
    });
    shadow.getElementById("finish-close")?.addEventListener("click", () => void finishWizard("close"));
    shadow.getElementById("finish-chat")?.addEventListener("click", () => void finishWizard("chat"));
    shadow.getElementById("finish-test")?.addEventListener("click", () => void finishWizard("test"));
    shadow.getElementById("finish-later")?.addEventListener("click", () => closeWizard(true));
    shadow.getElementById("dismiss-button")?.addEventListener("click", () => closeWizard(true));

    const providerSelect = shadow.getElementById("provider-select");
    if (providerSelect) {
      providerSelect.addEventListener("change", (event) => {
        wizardState.provider.providerId = event.target.value;
        const options = modelOptions(wizardState.provider.providerId);
        wizardState.provider.modelId = options[0]?.value || "";
        wizardState.error = "";
        render();
      });
    }
    const providerModel = shadow.getElementById("provider-model");
    if (providerModel) {
      providerModel.addEventListener("change", (event) => {
        wizardState.provider.modelId = event.target.value;
      });
    }
    const providerRegion = shadow.getElementById("provider-region");
    if (providerRegion) {
      providerRegion.addEventListener("change", (event) => {
        wizardState.provider.region = event.target.value;
      });
    }
    bindInputValue("provider-key", (value) => {
      wizardState.provider.apiKey = value;
    });

    const channelSelect = shadow.getElementById("channel-select");
    if (channelSelect) {
      channelSelect.addEventListener("change", (event) => {
        wizardState.channel.channelId = event.target.value;
        wizardState.error = "";
        render();
      });
    }
    const channelMode = shadow.getElementById("channel-mode");
    if (channelMode) {
      channelMode.addEventListener("change", (event) => {
        wizardState.channel.mode = event.target.value;
        wizardState.error = "";
        render();
      });
    }
    bindInputValue("channel-bot-token", (value) => {
      wizardState.channel.botToken = value;
    });
    bindInputValue("channel-app-token", (value) => {
      wizardState.channel.appToken = value;
    });
    bindInputValue("channel-signing-secret", (value) => {
      wizardState.channel.signingSecret = value;
    });
    bindInputValue("channel-webhook-path", (value) => {
      wizardState.channel.webhookPath = value;
    });
  }

  function renderValidation(errors) {
    if (errors.length === 0) {
      return "";
    }
    return `<div class="hint-list">${errors.map((item) => `<div class="hint-item">• ${escapeHtml(item)}</div>`).join("")}</div>`;
  }

  function renderWelcomeStep() {
    return `
      <section class="step ${wizardState.step === "welcome" ? "active" : ""}">
        <h2>欢迎使用 OpenClaw Desktop</h2>
        <p class="copy">为了让你一打开就能开始聊天，建议先完成两项设置：一个模型 Provider，以及至少一个接入渠道。渠道可以稍后再配，但在未完成前，每次打开 App 都会自动进入这个向导。</p>
        <div class="summary-grid">
          <div class="summary-card">
            <div class="summary-label">模型 Provider</div>
            <div class="summary-value">${escapeHtml(providerConfiguredLabel())}</div>
            <div class="summary-copy">支持 MiniMax、OpenAI、Anthropic、Gemini、GLM。</div>
          </div>
          <div class="summary-card">
            <div class="summary-label">接入渠道</div>
            <div class="summary-value">${escapeHtml(channelConfiguredLabel())}</div>
            <div class="summary-copy">支持 Telegram、Discord、Slack。若暂不接入，也可先跳过。</div>
          </div>
        </div>
        <div class="feature-grid">
          <div class="feature-card"><strong>模型设置</strong><span>自动写入 openclaw.json，并在重启后立即生效。</span></div>
          <div class="feature-card"><strong>渠道接入</strong><span>按渠道收集最小必要字段，减少手改 JSON。</span></div>
          <div class="feature-card"><strong>可跳过</strong><span>本次可跳过，但缺配置时下次仍会再次提醒。</span></div>
        </div>
        <div class="actions-row">
          <button id="welcome-start" class="primary">开始配置</button>
          <button id="welcome-skip" class="secondary">本次跳过</button>
        </div>
      </section>
    `;
  }

  function renderProviderStep() {
    const options = modelOptions(wizardState.provider.providerId);
    const errors = providerValidation();
    const canSave = errors.length === 0 && !wizardState.loading;
    return `
      <section class="step ${wizardState.step === "provider" ? "active" : ""}">
        <h2>第 1 步：配置模型 Provider</h2>
        <p class="copy">先配置一个可用模型，聊天功能才能工作。推荐直接配置 MiniMax；如果你已经有 OpenAI、Anthropic、Gemini 或 GLM 的 key，也可以直接切过去。</p>
        <label>Provider</label>
        <select id="provider-select">
          <option value="minimax" ${wizardState.provider.providerId === "minimax" ? "selected" : ""}>MiniMax</option>
          <option value="openai" ${wizardState.provider.providerId === "openai" ? "selected" : ""}>OpenAI</option>
          <option value="anthropic" ${wizardState.provider.providerId === "anthropic" ? "selected" : ""}>Anthropic</option>
          <option value="google" ${wizardState.provider.providerId === "google" ? "selected" : ""}>Google Gemini</option>
          <option value="zai" ${wizardState.provider.providerId === "zai" ? "selected" : ""}>ZAI / GLM</option>
        </select>
        <label>默认模型</label>
        <select id="provider-model">${renderOptions(options, wizardState.provider.modelId)}</select>
        ${wizardState.provider.providerId === "minimax" ? `
          <label>区域端点</label>
          <select id="provider-region">
            <option value="global" ${wizardState.provider.region === "global" ? "selected" : ""}>Global / 国际站</option>
            <option value="cn" ${wizardState.provider.region === "cn" ? "selected" : ""}>CN / 中国站</option>
          </select>
        ` : ""}
        <label>API Key</label>
        <input id="provider-key" type="password" placeholder="粘贴 API Key" value="${escapeHtml(wizardState.provider.apiKey)}" />
        ${renderValidation(errors)}
        <div class="actions-row">
          <button id="provider-back" class="ghost">返回</button>
          <button id="provider-save" class="primary" ${canSave ? "" : "disabled"}>保存并继续</button>
          <button id="provider-skip" class="secondary" ${wizardState.loading ? "disabled" : ""}>先跳过</button>
        </div>
      </section>
    `;
  }

  function renderChannelFields() {
    if (wizardState.channel.channelId === "slack") {
      return `
        <label>模式</label>
        <select id="channel-mode">
          <option value="socket" ${wizardState.channel.mode === "socket" ? "selected" : ""}>Socket Mode（推荐）</option>
          <option value="http" ${wizardState.channel.mode === "http" ? "selected" : ""}>HTTP Events API</option>
        </select>
        <label>Bot Token</label>
        <input id="channel-bot-token" type="password" placeholder="xoxb-..." value="${escapeHtml(wizardState.channel.botToken)}" />
        ${wizardState.channel.mode === "socket" ? `
          <label>App Token</label>
          <input id="channel-app-token" type="password" placeholder="xapp-..." value="${escapeHtml(wizardState.channel.appToken)}" />
        ` : `
          <label>Signing Secret</label>
          <input id="channel-signing-secret" type="password" placeholder="Slack Signing Secret" value="${escapeHtml(wizardState.channel.signingSecret)}" />
          <label>Webhook Path</label>
          <input id="channel-webhook-path" type="text" value="${escapeHtml(wizardState.channel.webhookPath)}" />
        `}
      `;
    }

    const placeholder = wizardState.channel.channelId === "telegram" ? "123456:ABCDEF..." : "粘贴 Bot Token";
    return `
      <label>Bot Token</label>
      <input id="channel-bot-token" type="password" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(wizardState.channel.botToken)}" />
    `;
  }

  function renderChannelStep() {
    const channelOptions = (wizardState.status?.channel?.supported || [])
      .map(
        (entry) =>
          `<option value="${escapeHtml(entry.id)}" ${wizardState.channel.channelId === entry.id ? "selected" : ""}>${escapeHtml(entry.label)}</option>`,
      )
      .join("");
    const errors = channelValidation();
    const canSave = errors.length === 0 && !wizardState.loading;
    return `
      <section class="step ${wizardState.step === "channel" ? "active" : ""}">
        <h2>第 2 步：配置接入渠道</h2>
        <p class="copy">渠道不是聊天的硬前置，你可以现在接入，也可以先跳过。若只想先验证本地聊天是否可用，可以在下一步直接进入聊天页。</p>
        <label>渠道</label>
        <select id="channel-select">${channelOptions}</select>
        ${renderChannelFields()}
        ${renderValidation(errors)}
        <div class="actions-row">
          <button id="channel-back" class="ghost">返回</button>
          <button id="channel-save" class="primary" ${canSave ? "" : "disabled"}>保存并继续</button>
          <button id="channel-skip" class="secondary" ${wizardState.loading ? "disabled" : ""}>先跳过</button>
        </div>
      </section>
    `;
  }

  function renderDoneStep() {
    const providerDone = wizardState.status?.provider?.configured;
    const channelDone = wizardState.status?.channel?.configured;
    const finishLabel = wizardState.dirty ? "完成并重启" : "关闭向导";
    return `
      <section class="step ${wizardState.step === "done" ? "active" : ""}">
        <h2>第 3 步：完成设置</h2>
        <div class="summary-grid">
          <div class="summary-card">
            <div class="summary-label">模型 Provider</div>
            <div class="summary-value ${providerDone ? "ok" : "warn"}">${providerDone ? "已可用" : "仍未配置"}</div>
            <div class="summary-copy">${escapeHtml(providerConfiguredLabel())}</div>
          </div>
          <div class="summary-card">
            <div class="summary-label">接入渠道</div>
            <div class="summary-value ${channelDone ? "ok" : "warn"}">${channelDone ? "已可用" : "仍未配置"}</div>
            <div class="summary-copy">${escapeHtml(channelConfiguredLabel())}</div>
          </div>
        </div>
        <p class="copy">如果你刚保存过配置，先重启 OpenClaw 再进入聊天。你也可以直接跳到聊天页，或者预填一条测试消息进行验证。</p>
        <div class="actions-row wrap">
          <button id="finish-close" class="primary" ${wizardState.loading ? "disabled" : ""}>${finishLabel}</button>
          <button id="finish-chat" class="secondary" ${wizardState.loading ? "disabled" : ""}>完成并进入聊天</button>
          <button id="finish-test" class="secondary" ${wizardState.loading ? "disabled" : ""}>完成并填充测试消息</button>
          <button id="finish-later" class="ghost" ${wizardState.loading ? "disabled" : ""}>稍后再说</button>
        </div>
      </section>
    `;
  }

  function render() {
    root.style.display = wizardState.open ? "block" : "none";
    if (!wizardState.open) {
      return;
    }

    shadow.innerHTML = `
      <style>
        .backdrop {
          position: fixed;
          inset: 0;
          background: rgba(2, 6, 23, 0.66);
          backdrop-filter: blur(10px);
          z-index: 2147483647;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        .panel {
          width: min(820px, calc(100vw - 48px));
          max-height: calc(100vh - 48px);
          overflow: auto;
          border-radius: 24px;
          background: linear-gradient(180deg, rgba(15, 23, 42, 0.98), rgba(15, 23, 42, 0.94));
          color: #e2e8f0;
          border: 1px solid rgba(148, 163, 184, 0.18);
          box-shadow: 0 30px 80px rgba(2, 6, 23, 0.45);
        }
        .head {
          padding: 24px 24px 12px;
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 12px;
        }
        .title { font-size: 28px; font-weight: 700; margin: 0 0 6px; }
        .sub { margin: 0; color: #cbd5e1; line-height: 1.5; }
        .dismiss {
          border: 0;
          background: transparent;
          color: #94a3b8;
          font-size: 26px;
          cursor: pointer;
        }
        .progress {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 10px;
          padding: 0 24px 18px;
        }
        .progress-pill {
          border-radius: 999px;
          padding: 8px 12px;
          font-size: 12px;
          text-align: center;
          background: rgba(51, 65, 85, 0.72);
          color: #cbd5e1;
        }
        .progress-pill.active { background: rgba(37, 99, 235, 0.2); color: #bfdbfe; }
        .progress-pill.done { background: rgba(22, 163, 74, 0.18); color: #86efac; }
        .content { padding: 0 24px 24px; }
        .step { display: none; }
        .step.active { display: block; }
        h2 { margin: 0 0 10px; font-size: 20px; }
        .copy { margin: 0 0 18px; line-height: 1.6; color: #cbd5e1; }
        label { display: block; margin: 14px 0 8px; font-size: 13px; color: #bfdbfe; }
        input, select {
          width: 100%; box-sizing: border-box; border-radius: 14px; border: 1px solid rgba(148, 163, 184, 0.2);
          background: rgba(15, 23, 42, 0.86); color: #f8fafc; padding: 12px 14px; font-size: 14px;
        }
        .actions-row { display: flex; gap: 12px; margin-top: 22px; }
        .actions-row.wrap { flex-wrap: wrap; }
        button { border: 0; border-radius: 14px; padding: 12px 16px; font-size: 14px; cursor: pointer; }
        button.primary { background: #2563eb; color: white; }
        button.secondary { background: rgba(51, 65, 85, 0.92); color: #e2e8f0; }
        button.ghost { background: transparent; color: #cbd5e1; border: 1px solid rgba(148, 163, 184, 0.2); }
        button:disabled { opacity: 0.5; cursor: default; }
        .error {
          margin: 0 24px 18px; padding: 12px 14px; border-radius: 16px; background: rgba(127, 29, 29, 0.4); color: #fecaca;
          white-space: pre-wrap;
        }
        .summary-grid, .feature-grid {
          display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px;
        }
        .feature-grid { margin-top: 14px; grid-template-columns: repeat(3, minmax(0, 1fr)); }
        .summary-card, .feature-card {
          border-radius: 18px; background: rgba(30, 41, 59, 0.74); padding: 16px;
        }
        .summary-label { font-size: 12px; color: #93c5fd; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 10px; }
        .summary-value { font-size: 18px; font-weight: 700; margin-bottom: 8px; }
        .summary-value.ok { color: #86efac; }
        .summary-value.warn { color: #fcd34d; }
        .summary-copy, .feature-card span { color: #cbd5e1; line-height: 1.5; display: block; }
        .feature-card strong { display: block; margin-bottom: 8px; }
        .hint-list {
          margin-top: 12px; border-radius: 14px; background: rgba(51, 65, 85, 0.55); padding: 10px 12px; color: #e2e8f0;
        }
        .hint-item + .hint-item { margin-top: 6px; }
        @media (max-width: 820px) {
          .summary-grid, .feature-grid, .progress { grid-template-columns: 1fr; }
        }
      </style>
      <div class="backdrop">
        <div class="panel" role="dialog" aria-modal="true" aria-label="OpenClaw 配置向导">
          <div class="head">
            <div>
              <div class="title">OpenClaw 配置向导</div>
              <p class="sub">缺少模型 Provider 或渠道配置时，桌面端会自动引导你完成首次设置。渠道允许跳过，但未完成前下次启动还会再次提醒。</p>
            </div>
            <button id="dismiss-button" class="dismiss" title="本次先关闭">×</button>
          </div>
          <div class="progress">
            <div class="progress-pill ${wizardState.step === "welcome" ? "active" : "done"}">欢迎</div>
            <div class="progress-pill ${wizardState.step === "provider" ? "active" : wizardState.status?.provider?.configured ? "done" : ""}">模型 Provider</div>
            <div class="progress-pill ${wizardState.step === "channel" ? "active" : wizardState.status?.channel?.configured ? "done" : ""}">接入渠道</div>
            <div class="progress-pill ${wizardState.step === "done" ? "active" : ""}">完成</div>
          </div>
          ${wizardState.error ? `<div class="error">${escapeHtml(wizardState.error)}</div>` : ""}
          <div class="content">
            ${renderWelcomeStep()}
            ${renderProviderStep()}
            ${renderChannelStep()}
            ${renderDoneStep()}
          </div>
        </div>
      </div>
    `;
    bindEvents();
  }

  document.addEventListener(
    "DOMContentLoaded",
    () => {
      document.body.append(root);
      queuePrefillTestMessage();
      void refreshStatus();
      api.subscribe((state) => {
        if (state?.setup) {
          wizardState.status = state.setup;
          if (requestOpenSetupWizardIfSupported(state.setup) && !wizardState.open) {
            openWizard("welcome");
            return;
          }
          render();
        }
      });
      api.onOpenSetup(() => {
        void refreshStatus({ forceOpen: true });
      });
    },
    { once: true },
  );
}

const api = createApi();

contextBridge.exposeInMainWorld("desktopRuntime", api);
defaultChineseLocaleForControlUi();
ensureSetupWizard(api);
