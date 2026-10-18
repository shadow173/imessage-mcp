# Operations

Day-to-day running of the bridge and the gateway: macOS setup, changing secrets, upgrading, troubleshooting and
uninstalling. Paths below are the defaults; see the configuration tables in the [README](../README.md#configuration)
to change them.

## macOS setup

| Setting | Why | How |
|---|---|---|
| **Full Disk Access** | The bridge reads `~/Library/Messages/chat.db` and the Contacts databases straight from disk. | `npm run install:bridge` copies node to `~/Library/Application Support/imessage-mcp/runtime/imessage-bridge-node` and opens System Settings → Privacy & Security → Full Disk Access. Add that file with **+** (Cmd-Shift-G pastes the path), then restart the bridge. Remove it from the list to revoke access. |
| **Automation (Messages)** | Sending goes through Messages.app via AppleScript. | The bridge asks once at startup, so macOS shows the prompt early. Approve it at the Mac or over screen sharing. If you clicked "Don't Allow", reset the decision with `tccutil reset AppleEvents` (this resets it for every app) and restart the bridge. `get_status` reports `automation_messages`. |
| **Stay awake** | The WebSocket to the gateway drops when the Mac sleeps. | Turn off automatic sleep: System Settings → Energy (or Battery → Options on a laptop, which should stay plugged in). The display can still sleep, and a locked screen is fine. |
| **Stay logged in** | The bridge is a LaunchAgent; it runs only while your user session is open. | Don't log out. Fast user switching is fine. |
| **FileVault and updates** | After an update reboot the Mac waits at the FileVault unlock screen, and the bridge stays down until someone logs in. | Install macOS updates when you can unlock the Mac afterwards, or accept the downtime. Keep FileVault on. |
| **SMS** (optional) | Sending SMS goes through a paired iPhone. | On the iPhone, open the Messages settings → Text Message Forwarding and turn on this Mac. |
| **Attachment text** (optional) | PDF text and OCR use a small Swift program compiled on first use. | `xcode-select --install`. Without it, previews still work and text extraction says it isn't set up. |

## Running the bridge

`npm run install:bridge` builds the project, installs the LaunchAgent `com.imessage-mcp.bridge` (starts at login,
restarts if it stops), and points it at `~/.config/imessage-mcp/bridge.env`. If that file doesn't exist yet, the
installer creates it from `bridge.env.example` (mode `600`) and stops so you can review it; run it again afterwards.

```bash
launchctl kickstart -k gui/$(id -u)/com.imessage-mcp.bridge   # restart, e.g. after editing bridge.env
launchctl print gui/$(id -u)/com.imessage-mcp.bridge | head    # is it loaded and running?
tail -f ~/Library/Logs/imessage-mcp/bridge.log                  # logs
imessage status --intent "Checking the bridge after a restart"  # health, tiers, send policy
```

- **Re-run `npm run install:bridge`** after upgrading Node, after moving the repository, and after pulling new code.
  The LaunchAgent runs `dist/bridge.js` from the checkout with the copied node binary, so both must still exist.
  A fresh node copy needs Full Disk Access granted again (the installer says so).
- A node installed by Homebrew links to other Homebrew libraries, so a `brew upgrade` can break the copy until you
  re-run the installer. The nodejs.org installer or nvm avoids that.
- The LaunchAgent's `PATH` covers the system directories, `/opt/homebrew/bin`, `/usr/local/bin` and `~/.local/bin`.
  If `imsg` lives anywhere else, set `IMSG_PATH` in `bridge.env`.
- Only one bridge may run. A bridge started by hand keeps running until another connects; the gateway keeps the newest
  connection and the older bridge exits.

## Gateway tasks

**Change the owner password.** Run `npm run hash-password`, set the new `OWNER_PASSWORD_HASH` on the gateway, and
redeploy. Clients that already signed in stay signed in (their refresh tokens still work); bump `TOKEN_VERSION` as
well to sign them out.

**Sign everyone out.** Bump `TOKEN_VERSION` and redeploy. Every access and refresh token stops working; connectors
sign in again with the password. Registered clients stay registered.

**Rotate secrets.**

| Secret | Where | What rotating it does |
|---|---|---|
| `AUTH_SIGNING_SECRET` | Gateway | Invalidates every token and every registered client id. ChatGPT and Claude need the connector added again. |
| `BRIDGE_SECRET` | Gateway and bridge | The bridge can't connect until both match. Update the bridge first, then the gateway. |
| `LINK_SECRET` | Gateway and bridge | Invalidates every outstanding file and citation link. |

**Check health.** `GET /healthz` answers when the gateway is up; point your host's health check at it. To see
whether the Mac is connected, look for `connected to …` in the bridge log, or call `get_status` from a client.

## Upgrading

1. Read [CHANGELOG.md](../CHANGELOG.md) for anything that needs a manual step.
2. Pull the new version and run `npm ci`.
3. Deploy the gateway and re-run `npm run install:bridge` on the Mac at about the same time. The two speak a small
   frame protocol, and a release may change it.
4. If a release changes the search index, the bridge rebuilds it on first start; `search_messages` returns
   `index_building` for a short while.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Gateway exits with "Missing required environment variables" | A required variable is unset, or still empty from `.env.example`. | Set it. For a throwaway server on your own machine, use `DEV=1` instead. |
| CLI exits 5: "The iMessage bridge isn't running" | The LaunchAgent is stopped, or the socket path differs. | `launchctl kickstart -k gui/$(id -u)/com.imessage-mcp.bridge`, then read the log. If the bridge config sets `DATA_DIR` or `IMESSAGE_SOCKET`, set the same value in your shell. |
| Log: "Can't see chat.db" or "Grant Full Disk Access" | The node copy lacks Full Disk Access (or it was re-copied). | Grant it as above, then restart the bridge. |
| Log: "gateway refused the bridge: HTTP 401 (BRIDGE_SECRET mismatch)" | `BRIDGE_SECRET` differs between gateway and bridge. | Make them identical and restart both. |
| Log: "another bridge took over this connection; exiting" | A second bridge connected (often one started by hand). | Run only the LaunchAgent. |
| Tools return `mac_offline` | The bridge is not connected to the gateway. | Check that the Mac is awake and logged in, and read the bridge log. |
| Tools return `outcome_unknown` | The Mac stopped answering in the middle of a write. | Check `read_conversation` before retrying. Retry `send_message` only with the same `idempotency_key`. |
| Tools return `send_disabled` | `SEND_ENABLED=false` on the bridge. | Set it to `true` in `bridge.env` when you're ready, and restart. |
| Tools return `confirmation_required` | With `SEND_ALLOWLIST=known`, the recipient isn't in Contacts. | Confirm with the agent in the conversation if you meant it. |
| Tools return `not_allowlisted` | `SEND_ALLOWLIST` is an explicit list without this recipient. | Add them to the list in `bridge.env` and restart the bridge. |
| `search_messages` returns `index_building` | The search index is being built (first start, or after a change). | Wait a few seconds and retry. |
| Sends fail with an Automation error | Messages automation was denied. | `tccutil reset AppleEvents`, restart the bridge, and approve the prompt. |
| SMS sends fail | Text Message Forwarding is off for this Mac. | Turn it on in the iPhone's Messages settings, or send with `service=imessage`. |
| Attachment text says extraction isn't set up | No Swift compiler. | `xcode-select --install`, then restart the bridge. |
| `get_status` shows `private_api` not ready | The imsg helper is not loaded in Messages. | See [private-api.md](private-api.md#troubleshooting). |
| A connector won't finish signing in | `PUBLIC_URL` doesn't match the address the client uses, or the redirect isn't allowed. | Set `PUBLIC_URL` to the exact public origin; add custom redirect URIs to `ALLOWED_REDIRECT_URIS`. |

## Uninstalling

```bash
npm run uninstall:bridge     # stops and removes the LaunchAgent
rm -f ~/.local/bin/imessage
rm -rf "$HOME/Library/Application Support/imessage-mcp" \
       "$HOME/Library/Logs/imessage-mcp" \
       "$HOME/Library/Messages/Attachments/imessage-mcp" \
       "$HOME/.config/imessage-mcp"
```

Then remove `imessage-bridge-node` from System Settings → Privacy & Security → Full Disk Access, remove the
connector from ChatGPT or Claude (and `claude mcp remove imessage` in Claude Code), and delete the gateway service.
The uninstaller leaves config, logs and the sidecar database in place, which is why the `rm` lines are separate.
