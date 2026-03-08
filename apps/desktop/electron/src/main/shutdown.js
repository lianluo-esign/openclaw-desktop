function createShutdownController({ onStart, stopRuntime, destroyTray, appQuit, logError = console.error } = {}) {
  let exitAllowed = false;
  let shutdownPromise = null;

  async function runShutdown() {
    if (typeof onStart === 'function') {
      onStart();
    }

    try {
      await stopRuntime?.();
    } catch (error) {
      logError('[desktop] Failed to stop runtime during shutdown:', error);
    }

    try {
      destroyTray?.();
    } catch (error) {
      logError('[desktop] Failed to destroy tray during shutdown:', error);
    }

    exitAllowed = true;
    appQuit?.();
  }

  return {
    requestShutdown() {
      if (!shutdownPromise) {
        shutdownPromise = runShutdown();
      }
      return shutdownPromise;
    },
    handleBeforeQuit(event) {
      if (exitAllowed) {
        return false;
      }
      event?.preventDefault?.();
      void this.requestShutdown();
      return true;
    },
    isExitAllowed() {
      return exitAllowed;
    },
  };
}

module.exports = {
  createShutdownController,
};
