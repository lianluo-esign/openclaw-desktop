function buildLinuxLauncherScript(binaryName) {
  return `#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TARGET="\${SCRIPT_DIR}/${binaryName}"

case "\${XDG_CURRENT_DESKTOP:-}:\${XDG_SESSION_DESKTOP:-}:\${HYPRLAND_INSTANCE_SIGNATURE:+set}" in
  *[Hh]yprland*|*:*:set)
    export ELECTRON_OZONE_PLATFORM_HINT=x11
    ;;
esac

exec "$TARGET" "$@"
`;
}

module.exports = {
  buildLinuxLauncherScript,
};
