#!/bin/zsh
# Stops and removes the bridge LaunchAgent. Leaves config, logs and the sidecar database in place.
set -euo pipefail
LABEL=com.imessage-mcp.bridge
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "Removed $LABEL. Revoke Full Disk Access for imessage-bridge-node in System Settings if you won't reinstall."
