#!/bin/bash
# after-remove.tpl — the .deb's post-remove script (electron-builder fills in
# the ${...} values). electron-builder's own after-remove.tpl, plus removing
# the AppArmor profile after-install.tpl installed.

# Delete the link to the binary
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/usr/bin/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

# An upgrade runs this too, then the new version's after-install puts the
# profile back; only a real removal takes it away.
case "$1" in
    upgrade|failed-upgrade) ;;
    *)
        PROFILE='/etc/apparmor.d/${executable}'
        if [ -e "$PROFILE" ]; then
            if command -v apparmor_parser >/dev/null 2>&1; then
                apparmor_parser --remove "$PROFILE" >/dev/null 2>&1 || true
            fi
            rm -f "$PROFILE"
        fi
        ;;
esac
