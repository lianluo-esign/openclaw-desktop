const fs = require('node:fs');
const path = require('node:path');

const PACKAGED_LINUX_BINARY_NAME = 'openclaw-desktop-bin';

function resolveElectronNodeExecPath({ app }) {
  if (process.platform === 'linux' && app?.isPackaged) {
    const candidate = path.join(process.resourcesPath, '..', PACKAGED_LINUX_BINARY_NAME);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return process.execPath;
}

module.exports = {
  resolveElectronNodeExecPath,
};
