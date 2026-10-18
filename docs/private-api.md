# Private API tier (optional)

> [!CAUTION]
> This tier is **off by default**, and most people should leave it off. Enabling it means turning off System Integrity
> Protection and library validation **for the whole Mac**, and loading a third-party helper into Messages.app. That
> lowers the security of everything on the machine, not just this project. It can stop working with any macOS update,
> and it may conflict with Apple's terms. Use it at your own risk.

## What it adds

Without this tier you can already read and search everything, send text and files, use drafts and scheduled
messages, and organize chats. The tier adds what AppleScript can't do:

- tapbacks on any message (`react`), and taking them back
- editing (within 15 minutes) and unsending (within 2 minutes) your own iMessages
- marking chats read or unread, and typing indicators
- inline replies and message effects on `send_message`
- creating group chats, renaming them, adding and removing members, setting the photo, and leaving

These come from [imsg](https://github.com/openclaw/imsg) (MIT), a separate third-party project that you install
yourself. imessage-mcp does not bundle or modify it, and its authors are not affiliated with this project. imsg's own
documentation is the authority on its setup.

## Who should not enable it

- Anyone on a work, school or otherwise managed Mac.
- Anyone whose Mac holds sensitive data beyond messages (work files, keys, password vaults).
- Anyone who can't get to the Mac in person. Turning SIP off, and back on, needs Recovery Mode at the machine.
- Anyone who needs the setup to keep working unattended through macOS updates.

## What gets weakened

| Protection | What it normally does | With it off |
|---|---|---|
| **System Integrity Protection (SIP)** | Stops even root from modifying system files and protected processes, and backs the privacy protections behind Full Disk Access. | Software running as an administrator can modify the system, and macOS no longer reliably enforces Full Disk Access: other programs may read `chat.db` without being granted access. |
| **Library validation** (the machine-wide preference) | Apps load only code signed by Apple or by their own developer. | Any app can load unsigned or foreign code. That is how the imsg helper gets into Messages, and it is also how malware injects itself into other apps. |
| **Messages.app integrity** | Messages runs only Apple's code. | The helper runs inside Messages with everything Messages can reach: your Apple account's messaging and your whole history. |

## Undo it (read this first)

1. Turn the tier off in the bridge. Remove `PRIVATE_API` and `IMSG_AUTO_LAUNCH` from
   `~/.config/imessage-mcp/bridge.env`, then restart the bridge and quit Messages so the helper unloads:

   ```bash
   launchctl kickstart -k gui/$(id -u)/com.imessage-mcp.bridge
   osascript -e 'quit app "Messages"'
   ```

2. Turn library validation back on, and optionally remove imsg:

   ```bash
   sudo defaults delete /Library/Preferences/com.apple.security.libraryvalidation.plist DisableLibraryValidation
   brew uninstall imsg
   ```

3. Turn SIP back on: start up in Recovery Mode (see below), open **Utilities → Terminal**, run `csrutil enable`, and
   restart. `csrutil status` should then say `enabled`.
4. With SIP on, macOS enforces Full Disk Access again. If the bridge log says it can't read `chat.db`, grant Full
   Disk Access to `~/Library/Application Support/imessage-mcp/runtime/imessage-bridge-node` and restart the bridge.

## Enable it

Tested on macOS 26. Check imsg's documentation for anything that has changed since.

1. **Turn off SIP.** Start up in Recovery Mode:
   - Apple silicon: shut down, then press and hold the power button until "Loading startup options" appears. Choose
     **Options**, then **Continue**.
   - Intel: restart while holding Command-R.

   Open **Utilities → Terminal**, run `csrutil disable`, and restart.
2. **Turn off library validation:**

   ```bash
   sudo defaults write /Library/Preferences/com.apple.security.libraryvalidation.plist DisableLibraryValidation -bool true
   ```

3. **Install imsg and load its helper:**

   imsg lives at `openclaw/imsg`; its Homebrew tap keeps the original `steipete/tap` name.

   ```bash
   brew install steipete/tap/imsg
   imsg --version
   imsg launch     # quits and reopens Messages with the helper loaded
   imsg status     # shows what loaded
   ```

4. **Turn the tier on in the bridge.** In `~/.config/imessage-mcp/bridge.env`:

   ```bash
   PRIVATE_API=imsg
   # The absolute path is safer than relying on PATH (Intel Homebrew: /usr/local/bin/imsg).
   IMSG_PATH=/opt/homebrew/bin/imsg
   # Optional: reload the helper when Messages restarts without it (quits Messages, at most every 10 minutes).
   IMSG_AUTO_LAUNCH=true
   ```

   If you set `TIERS` yourself, add `pa` to it; it is only added for you when `TIERS` is unset. Add `pa` to the
   gateway's `TIERS` too, so the tool list it serves while the Mac is offline matches.
5. **Restart and check:**

   ```bash
   launchctl kickstart -k gui/$(id -u)/com.imessage-mcp.bridge
   grep "private API" ~/Library/Logs/imessage-mcp/bridge.log | tail -1    # "ready · N methods"
   imessage status --intent "Checking the Private API tier after setup"   # private_api: ready
   ```

## How it behaves

- The bridge runs `imsg rpc` as a child process and talks JSON-RPC to it over stdio.
- Each call checks that the helper is loaded, makes the change, and waits for `chat.db` to show it. If the result
  can't be confirmed, the tool returns `outcome_unknown` instead of guessing, and the model is told to check before
  retrying.
- These tools go through the same send policy as everything else: the kill switch, the allowlist (tapbacks, edits,
  and creating, adding to, renaming or changing the photo of a group) and the hourly rate limit. Unsend stays
  available when sending is off.
- When the helper isn't ready, the tools return `requires_private_api` with the reason, and `get_status` shows it.
  Everything else keeps working.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `get_status` shows `private_api` not ready | Run `imsg status`. If the helper isn't loaded, run `imsg launch`. Check `csrutil status` (must be disabled) and that the library validation preference is set. |
| It stopped working after a macOS update | Updates can re-enable protections or change Messages internals. Re-run `imsg launch`, check imsg's issue tracker, and turn the tier off until imsg supports the new version. |
| Tools return `requires_private_api` even though imsg works | `PRIVATE_API=imsg` is missing from `bridge.env`, `TIERS` lacks `pa`, or the bridge can't find imsg (set `IMSG_PATH`). Restart the bridge after changing it. |
| Messages keeps quitting | `IMSG_AUTO_LAUNCH=true` relaunches Messages when the helper isn't loaded. Turn it off while you investigate. |
