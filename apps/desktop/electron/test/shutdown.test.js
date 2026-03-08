const test = require('node:test');
const assert = require('node:assert/strict');

const { createShutdownController } = require('../src/main/shutdown');

test('shutdown controller stops runtime before quitting and only once', async () => {
  const calls = [];
  const controller = createShutdownController({
    onStart: () => calls.push('start'),
    stopRuntime: async () => {
      calls.push('stop');
      await Promise.resolve();
    },
    destroyTray: () => calls.push('tray'),
    appQuit: () => calls.push('quit'),
  });

  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  const intercepted = controller.handleBeforeQuit(event);
  await controller.requestShutdown();
  await controller.requestShutdown();

  assert.equal(intercepted, true);
  assert.equal(event.prevented, true);
  assert.deepEqual(calls, ['start', 'stop', 'tray', 'quit']);
  assert.equal(controller.isExitAllowed(), true);
  assert.equal(controller.handleBeforeQuit({ preventDefault() {} }), false);
});

test('shutdown controller still quits when stopping runtime fails', async () => {
  const calls = [];
  const errors = [];
  const controller = createShutdownController({
    stopRuntime: async () => {
      calls.push('stop');
      throw new Error('boom');
    },
    destroyTray: () => calls.push('tray'),
    appQuit: () => calls.push('quit'),
    logError: (...args) => errors.push(args.join(' ')),
  });

  await controller.requestShutdown();

  assert.deepEqual(calls, ['stop', 'tray', 'quit']);
  assert.equal(errors.length, 1);
});
