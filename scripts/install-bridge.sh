#!/bin/zsh
# Installs the iMessage bridge as a LaunchAgent that starts at login and restarts if it stops.
# Full Disk Access goes to a dedicated copy of node rather than the node in your shell. That keeps it off your
# everyday node, but it is not a sandbox: any code that copy runs, including a modified dist/, has Full Disk Access.
# Any process running as you can also read and send through the bridge's local socket (src/local/socketServer.ts).
# The LaunchAgent points at this checkout and that node copy, so re-run this after moving the repo or upgrading node.
set -euo pipefail
REPO=${0:A:h:h}
LABEL=com.imessage-mcp.bridge
RUNTIME="$HOME/Library/Application Support/imessage-mcp/runtime"
NODE_COPY="$RUNTIME/imessage-bridge-node"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGS="$HOME/Library/Logs/imessage-mcp"
ENV_FILE="$HOME/.config/imessage-mcp/bridge.env"
EXAMPLE="$REPO/bridge.env.example"
DOMAIN="gui/$(id -u)"

if [[ ! -f "$ENV_FILE" ]]; then
  mkdir -p -m 700 "${ENV_FILE:h}"
  if [[ -f "$EXAMPLE" ]]; then
    install -m 600 "$EXAMPLE" "$ENV_FILE"
    echo "Created $ENV_FILE from bridge.env.example (mode 600). Fill it in, then run this again."
    exit 2
  fi
  echo "Missing $ENV_FILE. See the bridge setup in README.md."
  exit 1
fi
mkdir -p "$RUNTIME" "$LOGS" "$HOME/Library/LaunchAgents"

echo "Building…"
(cd "$REPO" && npm run build >/dev/null)

NODE_REAL=$(realpath "$(command -v node)")
if [[ ! -x "$NODE_COPY" ]] || ! cmp -s "$NODE_REAL" "$NODE_COPY"; then
  cp "$NODE_REAL" "$NODE_COPY"
  chmod 755 "$NODE_COPY"
  echo "Copied node to $NODE_COPY (a new copy needs Full Disk Access granted again)."
fi
if [[ "$NODE_REAL" == */Cellar/* ]]; then
  echo "Note: this node is from Homebrew and links to Homebrew's libraries, so a brew upgrade can break the copy."
  echo "      Re-run this after upgrading, or install node from nodejs.org or nvm."
fi

# A bridge started by hand keeps running until this one connects; the gateway keeps the newest
# connection and the older bridge exits by itself, so there's no gap. The local socket moves over once it exits.

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_COPY</string>
    <string>--disable-warning=ExperimentalWarning</string>
    <string>$REPO/dist/bridge.js</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$HOME</string>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin</string>
    <key>BRIDGE_ENV_FILE</key><string>$ENV_FILE</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>$LOGS/bridge.log</string>
  <key>StandardErrorPath</key><string>$LOGS/bridge.log</string>
</dict>
</plist>
PLIST

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl enable "$DOMAIN/$LABEL"
launchctl kickstart -k "$DOMAIN/$LABEL"
echo "Started $LABEL. Waiting for it to connect…"
sleep 8

if tail -n 20 "$LOGS/bridge.log" | grep -q "Full Disk Access"; then
  echo
  echo "One more step: give Full Disk Access to the bridge's node copy."
  echo "  1. System Settings opens to Privacy & Security > Full Disk Access."
  echo "  2. Click +, press Cmd-Shift-G, paste the path below, and add it:"
  echo "     $NODE_COPY"
  echo "  3. Then run:  launchctl kickstart -k $DOMAIN/$LABEL"
  open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles" || true
  printf '%s' "$NODE_COPY" | pbcopy && echo "  (The path is on your clipboard.)"
  exit 2
fi
tail -n 3 "$LOGS/bridge.log" | sed -E 's/[0-9]+ people · [0-9]+ chats/N people · N chats/'
echo
echo "The first message it sends will ask to control Messages. Approve that prompt on this Mac."
