# scripts

Run the TypeScript ones with `npx tsx <path>`. Nothing here has a default deployment: scripts that talk to a gateway
take its URL as the first argument or from `IMESSAGE_MCP_URL`, and the owner password from `IMESSAGE_MCP_PASSWORD`.
They exit with a usage line when either is missing.

## Setup

| Script | What it touches | Sends messages |
| --- | --- | --- |
| `install-bridge.sh` | Builds `dist/`, copies node into `~/Library/Application Support/imessage-mcp/runtime`, writes and loads the LaunchAgent. Creates `~/.config/imessage-mcp/bridge.env` from `bridge.env.example` (mode 600) if it is missing, then stops so you can fill it in. | No |
| `uninstall-bridge.sh` | Stops and removes the LaunchAgent. Leaves config, logs and the sidecar database. | No |
| `install-cli.sh` | Builds `dist/` and writes the `imessage` wrapper to `~/.local/bin`. | No |
| `hash-password.ts` | Nothing. Asks for a password twice (hidden) or reads one from stdin, and prints the hash for `OWNER_PASSWORD_HASH`. | No |

## dev/: mock data only, safe anywhere

| Script | What it touches | Sends messages |
| --- | --- | --- |
| `dev/peek.ts` (`npm run peek`) | The mock store, in-process. Prints a few tool outputs. | No |
| `dev/journey.ts` (`npm run describe`) | The mock store, in-process. Runs a multi-step journey, or prints every tool as an agent sees it with `--describe`. | No |
| `dev/tools-table.ts` (`npm run tools-table`) | Mock config, in-process. Prints the README's Tools table from `tools/list`; `--write` updates README.md, `--check` fails when it is out of date (CI). | No |

## maintainer/: real data, only against your own Mac or deployment

| Script | What it touches | Sends messages | Prints |
| --- | --- | --- | --- |
| `maintainer/live-probe.ts` | Your real `chat.db` and contacts (needs Full Disk Access). Calls every read tool. | No | Timings, sizes and counts |
| `maintainer/attachment-probe.ts` | Your real `chat.db` and contacts, plus the newest PDF and photo. | No | Sizes and timings |
| `maintainer/time-store.ts` | Your real `chat.db` and contacts. | No | Timings and counts |
| `maintainer/oauth-check.ts` | Your gateway: discovery, sign-in, token refresh, one `get_status` call. | No | Pass/fail per step |
| `maintainer/list-tools.ts` | Your gateway. | No | Tool names |
| `maintainer/probe-send.ts` | Your gateway and Mac. Needs `--yes`. | **Yes**, one iMessage to the person you name | Match count and send result |
| `maintainer/probe-react.ts` | Your gateway and Mac (Private API tier). Needs `--yes`. | **Yes**, one tapback on that person's latest message | Whether the reaction landed |

The three `chat.db` probes keep their own sidecar in `DATA_DIR` (default
`~/Library/Application Support/imessage-mcp-probe`), so they never share state with a running bridge.
