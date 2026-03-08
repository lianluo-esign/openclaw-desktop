const fs = require('node:fs');
const path = require('node:path');
const JSON5 = require('json5');

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, patch) {
  if (!isObject(base) || !isObject(patch)) {
    return patch;
  }
  const output = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      continue;
    }
    if (isObject(value) && isObject(output[key])) {
      output[key] = deepMerge(output[key], value);
      continue;
    }
    output[key] = value;
  }
  return output;
}

function getString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function getBoolean(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function readConfig(configPath) {
  try {
    if (!fs.existsSync(configPath)) {
      return {};
    }
    const raw = fs.readFileSync(configPath, 'utf8');
    if (!raw.trim()) {
      return {};
    }
    return JSON5.parse(raw);
  } catch {
    return {};
  }
}

function writeConfig(configPath, config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function hasEnv(config, name, processEnv = process.env) {
  const fromConfig = getString(config?.env?.[name]);
  if (fromConfig) {
    return true;
  }
  const fromProcess = getString(processEnv?.[name]);
  return Boolean(fromProcess);
}

function getPrimaryModel(config) {
  return getString(config?.agents?.defaults?.model?.primary);
}

function detectProviderStatus(config, processEnv = process.env) {
  const primaryModel = getPrimaryModel(config);
  if (!primaryModel) {
    return {
      configured: false,
      selectedProvider: null,
      primaryModel: '',
      reason: 'missing-primary-model',
    };
  }

  const provider = primaryModel.split('/')[0] || '';
  if (provider === 'minimax') {
    const hasProvider = isObject(config?.models?.providers?.minimax);
    const hasKey = hasEnv(config, 'MINIMAX_API_KEY', processEnv);
    return {
      configured: hasProvider && hasKey,
      selectedProvider: 'minimax',
      primaryModel,
      reason: hasProvider && hasKey ? 'ok' : 'missing-minimax-provider',
    };
  }

  if (provider === 'openai' || provider === 'openai-codex') {
    return {
      configured: hasEnv(config, 'OPENAI_API_KEY', processEnv),
      selectedProvider: 'openai',
      primaryModel,
      reason: hasEnv(config, 'OPENAI_API_KEY', processEnv) ? 'ok' : 'missing-openai-key',
    };
  }

  if (provider === 'anthropic') {
    return {
      configured: hasEnv(config, 'ANTHROPIC_API_KEY', processEnv),
      selectedProvider: 'anthropic',
      primaryModel,
      reason: hasEnv(config, 'ANTHROPIC_API_KEY', processEnv) ? 'ok' : 'missing-anthropic-key',
    };
  }

  if (provider === 'google' || provider === 'google-antigravity' || provider === 'google-gemini-cli') {
    return {
      configured: hasEnv(config, 'GOOGLE_API_KEY', processEnv),
      selectedProvider: 'google',
      primaryModel,
      reason: hasEnv(config, 'GOOGLE_API_KEY', processEnv) ? 'ok' : 'missing-google-key',
    };
  }

  if (provider === 'zai') {
    return {
      configured: hasEnv(config, 'ZAI_API_KEY', processEnv),
      selectedProvider: 'zai',
      primaryModel,
      reason: hasEnv(config, 'ZAI_API_KEY', processEnv) ? 'ok' : 'missing-zai-key',
    };
  }

  return {
    configured: true,
    selectedProvider: provider,
    primaryModel,
    reason: 'unknown-provider-assumed-configured',
  };
}

function detectTelegram(config, processEnv = process.env) {
  const channel = config?.channels?.telegram;
  const hasToken = getString(channel?.botToken) || (getBoolean(channel?.enabled, true) && getString(processEnv.TELEGRAM_BOT_TOKEN));
  return {
    id: 'telegram',
    configured: Boolean(channel && hasToken),
    label: 'Telegram',
  };
}

function detectDiscord(config, processEnv = process.env) {
  const channel = config?.channels?.discord;
  const hasToken = getString(channel?.token) || (getBoolean(channel?.enabled, true) && getString(processEnv.DISCORD_BOT_TOKEN));
  return {
    id: 'discord',
    configured: Boolean(channel && hasToken),
    label: 'Discord',
  };
}

function detectSlack(config, processEnv = process.env) {
  const channel = config?.channels?.slack;
  const mode = getString(channel?.mode) || 'socket';
  const botToken = getString(channel?.botToken) || getString(processEnv.SLACK_BOT_TOKEN);
  const appToken = getString(channel?.appToken) || getString(processEnv.SLACK_APP_TOKEN);
  const signingSecret = getString(channel?.signingSecret) || getString(processEnv.SLACK_SIGNING_SECRET);
  const configured = Boolean(
    channel &&
      botToken &&
      ((mode === 'http' && signingSecret) || (mode !== 'http' && appToken)),
  );
  return {
    id: 'slack',
    configured,
    label: 'Slack',
  };
}

function detectChannelStatus(config, processEnv = process.env) {
  const channels = [
    detectTelegram(config, processEnv),
    detectDiscord(config, processEnv),
    detectSlack(config, processEnv),
  ];
  return {
    configured: channels.some((entry) => entry.configured),
    supported: channels,
  };
}

function buildProviderPatch(payload) {
  const provider = getString(payload?.providerId);
  const apiKey = getString(payload?.apiKey);
  const modelId = getString(payload?.modelId);
  const region = getString(payload?.region) || 'global';

  if (!provider) {
    throw new Error('providerId is required');
  }

  if (!apiKey) {
    throw new Error('apiKey is required');
  }

  if (provider === 'minimax') {
    const minimaxModel = modelId || 'MiniMax-M2.5';
    const baseUrl = region === 'cn' ? 'https://api.minimaxi.com/anthropic' : 'https://api.minimax.io/anthropic';
    return {
      env: { MINIMAX_API_KEY: apiKey },
      agents: {
        defaults: {
          model: { primary: `minimax/${minimaxModel}` },
          models: {
            [`minimax/${minimaxModel}`]: { alias: 'minimax' },
            'minimax/MiniMax-M2.5-highspeed': { alias: 'minimax-fast' },
          },
        },
      },
      models: {
        mode: 'merge',
        providers: {
          minimax: {
            baseUrl,
            apiKey: '${MINIMAX_API_KEY}',
            api: 'anthropic-messages',
            models: [
              {
                id: 'MiniMax-M2.5',
                name: 'MiniMax M2.5',
                reasoning: true,
                input: ['text'],
                contextWindow: 200000,
                maxTokens: 8192,
              },
              {
                id: 'MiniMax-M2.5-highspeed',
                name: 'MiniMax M2.5 Highspeed',
                reasoning: true,
                input: ['text'],
                contextWindow: 200000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    };
  }

  if (provider === 'openai') {
    return {
      env: { OPENAI_API_KEY: apiKey },
      agents: {
        defaults: {
          model: { primary: modelId || 'openai/gpt-5.2' },
          models: { [modelId || 'openai/gpt-5.2']: { alias: 'openai' } },
        },
      },
    };
  }

  if (provider === 'anthropic') {
    return {
      env: { ANTHROPIC_API_KEY: apiKey },
      agents: {
        defaults: {
          model: { primary: modelId || 'anthropic/claude-opus-4-6' },
          models: { [modelId || 'anthropic/claude-opus-4-6']: { alias: 'anthropic' } },
        },
      },
    };
  }

  if (provider === 'google') {
    return {
      env: { GOOGLE_API_KEY: apiKey },
      agents: {
        defaults: {
          model: { primary: modelId || 'google/gemini-3-pro-preview' },
          models: { [modelId || 'google/gemini-3-pro-preview']: { alias: 'gemini' } },
        },
      },
    };
  }

  if (provider === 'zai') {
    return {
      env: { ZAI_API_KEY: apiKey },
      agents: {
        defaults: {
          model: { primary: modelId || 'zai/glm-4.7' },
          models: { [modelId || 'zai/glm-4.7']: { alias: 'glm' } },
        },
      },
    };
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

function buildChannelPatch(payload) {
  const channelId = getString(payload?.channelId);
  if (!channelId) {
    throw new Error('channelId is required');
  }

  if (channelId === 'telegram') {
    const botToken = getString(payload?.botToken);
    if (!botToken) {
      throw new Error('Telegram botToken is required');
    }
    return {
      channels: {
        telegram: {
          enabled: true,
          botToken,
          dmPolicy: 'pairing',
          groups: { '*': { requireMention: true } },
        },
      },
    };
  }

  if (channelId === 'discord') {
    const token = getString(payload?.botToken);
    if (!token) {
      throw new Error('Discord botToken is required');
    }
    return {
      channels: {
        discord: {
          enabled: true,
          token,
          dmPolicy: 'pairing',
        },
      },
    };
  }

  if (channelId === 'slack') {
    const mode = getString(payload?.mode) || 'socket';
    const botToken = getString(payload?.botToken);
    if (!botToken) {
      throw new Error('Slack botToken is required');
    }
    if (mode === 'http') {
      const signingSecret = getString(payload?.signingSecret);
      if (!signingSecret) {
        throw new Error('Slack signingSecret is required in HTTP mode');
      }
      return {
        channels: {
          slack: {
            enabled: true,
            mode: 'http',
            botToken,
            signingSecret,
            webhookPath: getString(payload?.webhookPath) || '/slack/events',
          },
        },
      };
    }
    const appToken = getString(payload?.appToken);
    if (!appToken) {
      throw new Error('Slack appToken is required in socket mode');
    }
    return {
      channels: {
        slack: {
          enabled: true,
          mode: 'socket',
          botToken,
          appToken,
          dmPolicy: 'pairing',
        },
      },
    };
  }

  throw new Error(`Unsupported channel: ${channelId}`);
}

function summarizeSetupStatus(config, processEnv = process.env) {
  const provider = detectProviderStatus(config, processEnv);
  const channel = detectChannelStatus(config, processEnv);
  return {
    provider,
    channel,
    shouldOnboard: !provider.configured || !channel.configured,
  };
}

module.exports = {
  buildChannelPatch,
  buildProviderPatch,
  deepMerge,
  detectChannelStatus,
  detectProviderStatus,
  readConfig,
  summarizeSetupStatus,
  writeConfig,
};
