#!/bin/bash
# after-install.tpl — the .deb's post-install script (electron-builder fills in
# the ${...} values). It starts as electron-builder's own after-install.tpl and
# replaces that script's sandbox setup, which does not work on Ubuntu 23.10+.
#
# Chromium's sandbox needs unprivileged user namespaces. Ubuntu 23.10 and later
# restrict those through AppArmor unless a profile grants them to the program,
# and the stock script cannot tell: it tests `unshare --user` as root, which the
# restriction does not apply to, so it leaves chrome-sandbox unprivileged and
# the app fails to start for every user. This script, in order:
#   1. On AppArmor 4 (Ubuntu 24.04 and later), installs a profile that grants
#      the app user namespaces, the way Ubuntu ships one for Chrome and VS Code.
#   2. Otherwise, tests user namespaces as an unprivileged user.
#   3. Only if neither works, makes chrome-sandbox setuid root, Chromium's own
#      fallback for systems without user namespaces.

APP_DIR='/opt/${sanitizedProductName}'
APP_BIN="$APP_DIR/${executable}"
SANDBOX="$APP_DIR/chrome-sandbox"
PROFILE='/etc/apparmor.d/${executable}'

if type update-alternatives 2>/dev/null >&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' "$APP_BIN" 100 || ln -sf "$APP_BIN" '/usr/bin/${executable}'
else
    ln -sf "$APP_BIN" '/usr/bin/${executable}'
fi

# 1. AppArmor profile. abi/4.0 is where AppArmor can mediate user namespaces;
#    older AppArmor has no restriction to lift, so there is nothing to grant.
apparmor_ok=false
if [ -e /etc/apparmor.d/abi/4.0 ] && command -v apparmor_parser >/dev/null 2>&1; then
    cat > "$PROFILE" <<EOF
# Installed by the ${sanitizedProductName} package: lets the app create the user
# namespaces its sandbox needs. Removed when the package is removed.
abi <abi/4.0>,
include <tunables/global>

profile ${executable} "$APP_BIN" flags=(unconfined) {
  userns,

  include if exists <local/${executable}>
}
EOF
    # Fails when AppArmor is not running, for example on a kernel without it.
    if apparmor_parser --replace --write-cache --skip-read-cache "$PROFILE" >/dev/null 2>&1; then
        apparmor_ok=true
    fi
fi

# 2. Can an ordinary user create a user namespace? Asked as nobody, not root,
#    because root is exempt from every restriction worth testing for.
userns_ok=false
if [ "$apparmor_ok" = false ] && command -v runuser >/dev/null 2>&1; then
    restricted=$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)
    # Under the AppArmor restriction unshare itself succeeds and only what runs
    # inside is denied, so the test proves nothing there: treat it as failed.
    if [ "$restricted" != 1 ] && runuser -u nobody -- unshare --user --map-root-user true >/dev/null 2>&1; then
        userns_ok=true
    fi
fi

# 3. setuid chrome-sandbox only when user namespaces are out of reach.
if [ "$apparmor_ok" = true ] || [ "$userns_ok" = true ]; then
    chmod 0755 "$SANDBOX" || true
else
    chmod 4755 "$SANDBOX" || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
