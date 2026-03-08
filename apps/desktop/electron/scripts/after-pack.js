const fs = require('node:fs/promises');
const path = require('node:path');

const { buildLinuxLauncherScript } = require('../src/main/linux-launcher');

async function restoreBundledRuntimeNodeModules(appOutDir) {
  const sourceNodeModules = path.join(__dirname, '..', 'openclaw-runtime', 'node_modules');
  const targetNodeModules = path.join(appOutDir, 'resources', 'openclaw-runtime', 'node_modules');

  await fs.rm(targetNodeModules, { recursive: true, force: true });
  await fs.cp(sourceNodeModules, targetNodeModules, {
    recursive: true,
    force: true,
    verbatimSymlinks: true,
  });
}

module.exports = async function afterPack(context) {
  await restoreBundledRuntimeNodeModules(context.appOutDir);

  if (context.electronPlatformName !== 'linux') {
    return;
  }

  const executableName = context.packager.executableName;
  const appOutDir = context.appOutDir;
  const launcherPath = path.join(appOutDir, executableName);
  const binaryName = `${executableName}-bin`;
  const binaryPath = path.join(appOutDir, binaryName);

  try {
    await fs.access(binaryPath);
  } catch {
    await fs.rename(launcherPath, binaryPath);
  }

  await fs.writeFile(launcherPath, buildLinuxLauncherScript(binaryName), 'utf8');
  await fs.chmod(launcherPath, 0o755);
};
