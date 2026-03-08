const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildChannelPatch,
  buildProviderPatch,
  deepMerge,
  summarizeSetupStatus,
} = require('../src/main/setup-config');

test('summarizeSetupStatus marks empty config as missing provider and channel', () => {
  const status = summarizeSetupStatus({}, {});
  assert.equal(status.provider.configured, false);
  assert.equal(status.channel.configured, false);
  assert.equal(status.shouldOnboard, true);
});

test('buildProviderPatch for minimax creates provider block and primary model', () => {
  const patch = buildProviderPatch({
    providerId: 'minimax',
    apiKey: 'sk-test',
    modelId: 'MiniMax-M2.5',
    region: 'global',
  });
  assert.equal(patch.env.MINIMAX_API_KEY, 'sk-test');
  assert.equal(patch.agents.defaults.model.primary, 'minimax/MiniMax-M2.5');
  assert.equal(patch.models.providers.minimax.baseUrl, 'https://api.minimax.io/anthropic');
});

test('deepMerge keeps previous channels while adding provider config', () => {
  const merged = deepMerge(
    { channels: { telegram: { enabled: true, botToken: '123:abc' } } },
    buildProviderPatch({ providerId: 'openai', apiKey: 'sk-openai', modelId: 'openai/gpt-5.2' }),
  );
  assert.equal(merged.channels.telegram.botToken, '123:abc');
  assert.equal(merged.agents.defaults.model.primary, 'openai/gpt-5.2');
});

test('buildChannelPatch for slack socket mode requires bot and app tokens', () => {
  const patch = buildChannelPatch({
    channelId: 'slack',
    mode: 'socket',
    botToken: 'xoxb-123',
    appToken: 'xapp-123',
  });
  assert.equal(patch.channels.slack.mode, 'socket');
  assert.equal(patch.channels.slack.botToken, 'xoxb-123');
  assert.equal(patch.channels.slack.appToken, 'xapp-123');
});
