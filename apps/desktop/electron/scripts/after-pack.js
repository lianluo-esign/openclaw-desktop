const fs = require('node:fs/promises');
const path = require('node:path');

const { buildLinuxLauncherScript } = require('../src/main/linux-launcher');

function resolveBundledRuntimeRoot(context) {
  if (context.electronPlatformName === 'darwin') {
    return path.join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      'Contents',
      'Resources',
      'openclaw-runtime',
    );
  }

  return path.join(context.appOutDir, 'resources', 'openclaw-runtime');
}

async function restoreBundledRuntimeNodeModules(context) {
  const sourceNodeModules = path.join(__dirname, '..', 'openclaw-runtime', 'node_modules');
  const targetNodeModules = path.join(resolveBundledRuntimeRoot(context), 'node_modules');

  await fs.rm(targetNodeModules, { recursive: true, force: true });
  await fs.cp(sourceNodeModules, targetNodeModules, {
    recursive: true,
    force: true,
    verbatimSymlinks: true,
  });
}

async function chmodExecutable(filePath) {
  try {
    await fs.chmod(filePath, 0o755);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTSUP')) {
      return;
    }
    throw error;
  }
}

async function chmodPlatformExecutable(context) {
  if (context.electronPlatformName === 'win32') {
    return;
  }

  const fallbackExecutableName = context.packager.appInfo.productFilename;
  const executableName = context.packager.executableName || fallbackExecutableName;

  if (context.electronPlatformName === 'darwin') {
    const appBundlePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    const binaryPath = path.join(appBundlePath, 'Contents', 'MacOS', executableName);
    await chmodExecutable(binaryPath);
    return;
  }

  const launcherPath = path.join(context.appOutDir, executableName);
  await chmodExecutable(launcherPath);

  const binaryPath = path.join(context.appOutDir, `${executableName}-bin`);
  await chmodExecutable(binaryPath);
}

async function prepareLinuxLauncher(context) {
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
  await fs.chmod(binaryPath, 0o755);
}

module.exports = async function afterPack(context) {
  await restoreBundledRuntimeNodeModules(context);

  if (context.electronPlatformName === 'linux') {
    await prepareLinuxLauncher(context);
  }

  await chmodPlatformExecutable(context);
};
