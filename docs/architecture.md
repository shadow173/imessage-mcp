# Architecture

How imessage-mcp is put together: the three processes, the path one tool call takes, where each safety rule is
enforced, and the macOS details the bridge depends on. For setup, see the [README](../README.md); for the threat
model, see [SECURITY.md](../SECURITY.md).

## Processes

| Process | Where it runs | Code | Job |
|---|---|---|---|
| **Gateway** | Any Node host (Railway, Fly.io, a VPS) | `src/gateway.ts`, `src/app.ts`, `src/backend.ts`, `src/auth/`, `src/relay/hub.ts`, `src/relay/upgrade.ts` | OAuth 2.1 authorization server, bearer checks, and a relay to the bridge. In `MODE=mock` it runs the tools itself against seeded fake data (`src/mock/`). Stores nothing on disk. |
| **Bridge** | The Mac, as a LaunchAgent | `src/bridge.ts`, `src/bridge/`, `src/live/`, `src/local/`, `src/tools/`, `src/policy/`, `src/services/`, `src/mcpHandler.ts`, `src/server.ts` | The MCP server and every tool. Reads `chat.db` and Contacts, keeps `sidecar.db`, sends through Messages.app, and serves the local socket. Connects out to the gateway when `GATEWAY_URL` is set. |
| **CLI** | The Mac, in any shell | `src/cli.ts` (entry point), `src/cli/` | `imessage <command>` for people and scripts; `imessage mcp` is a stdio MCP server for Claude Code. Both talk to the bridge over its Unix socket. |

Mock and live share one interface, `MessageStore` (`src/store/ports.ts`): paged, query-level reads plus the write
operations, made of one interface per role (people and chats, message reads, stats, attachments, the update feed,
sending, Private API actions, the organizer). `MockStore` keeps everything in memory; `LiveStore` answers from
`chat.db`, the Contacts databases and the sidecar.

The rules both follow are written once: the update feed (`src/store/eventLog.ts`), the organizer's rules for aliases,
labels, reminders and drafts (`src/store/organizer.ts`), and names and needs-reply (`src/domain/`).
`test/store.contract.ts` runs one behavior suite against both stores.

`LiveStore` itself only wires together the modules in `src/live/`, which share one context (`context.ts`: `chat.db`,
the sidecar, the config and the directory):

| Module | Owns |
|---|---|
| `directory.ts` | People, handles and chats from Contacts and `chat.db`, and what `HIDE` removes |
| `sql.ts`, `tapbacks.ts` | The `chat.db` columns, the shared where clauses (including the hidden-chat clause) and how tapbacks are stored |
| `hydrate.ts` | Message rows to messages: text, edits, replies, link previews, attachments, bubbles, tapbacks |
| `messages.ts`, `summaries.ts`, `analytics.ts` | Reads: by id, per chat and across chats; one summary per chat; activity and stats |
| `searchIndex.ts` | The full-text index in the sidecar |
| `changeFeed.ts` | Polling `chat.db` for new rows, edits and receipts, behind `get_updates` |
| `attachmentCatalog.ts`, `attachments.ts` | Attachment lookups and lists; previews, extracted text and download bytes |
| `privateActions.ts` | Tapbacks, edit, unsend, read receipts, typing and group changes through imsg |
| `organizer.ts`, `storedSends.ts` | Aliases, notes, labels, reminders and drafts; replaying an earlier send with the same key |
| `sender.ts` | Sending through Messages.app and confirming each send in `chat.db`; the bridge passes it to `LiveStore`'s constructor, with imsg for the Private API |
| `download.ts` | Fetching `url` attachments: public https only, with every DNS answer and redirect checked against the blocklist in `src/lib/net.ts` |

## One tool call, end to end

### Remote (ChatGPT, Claude)

1. The client sends JSON-RPC to `POST /mcp` on the gateway with a bearer token.
2. The gateway verifies the token: signature, audience (`<PUBLIC_URL>/mcp`), expiry and `TOKEN_VERSION`. It takes
   the granted scopes and client id from it.
3. If the bridge is offline, the gateway answers `initialize` and `tools/list` itself, from the instructions and tool
   list the bridge sent when it last connected (or, after a fresh deploy, from its own `REDACT_CODES` and `TIERS`).
   `tools/call` returns `mac_offline`, or `outcome_unknown` for a write that may already have reached the Mac.
4. Otherwise it sends an `mcp` frame (body, scopes, client id, public origin) over the bridge's WebSocket and waits up
   to 110 seconds for the matching `mcp_result`.
5. The bridge builds a fresh, stateless MCP server for the request (`handleMcp`) from the tool definitions in
   `src/tools/`. The wrapper in `registerTools` (`src/tools/registry.ts`) registers only the tiers that are on, checks
   the scope, requires `intent`, rejects unknown arguments on tools that change something, runs the tool, turns any
   `ToolError` into an `Error <code>: … Fix: …` result the model can act on, and writes the call to the journal.
6. The gateway returns the bridge's reply unchanged.

### Local (CLI, Claude Code)

The CLI sends the same JSON-RPC over HTTP on the Unix socket (`IMESSAGE_SOCKET`, by default `$DATA_DIR/bridge.sock`).
The bridge runs it through the same `handleMcp` with every scope granted and a `local-*` client label in the journal.
There is no OAuth: the socket's file permissions (`0600`, in a `0700` directory) are the only check, so any process
running as the same macOS user can use it.

When `GATEWAY_URL` is not set, the bridge runs local only: it serves the socket and never connects out. Signed file
and citation links are served by the gateway, so they need one; locally, use attachment previews and text instead.

## Where each rule is enforced

| Rule | Enforced by | Notes |
|---|---|---|
| Authentication | Gateway | OAuth bearer tokens on `/mcp`; the bridge's WebSocket needs `BRIDGE_SECRET`. |
| Scopes (`messages.read` / `organize` / `send`) | Bridge, in `registerTools` | The gateway forwards the token's scopes with each call. |
| Tiers (`TIERS`) | Bridge, in `registerTools` | A tool from a disabled tier returns `tool_not_enabled` with the reason, and `get_status` lists what is off. |
| Kill switch, allowlist, rate limit | Bridge, one send policy in `src/policy/sendPolicy.ts` | Covers `send_message`, drafts sent now, scheduled drafts, tapbacks, edits, typing, read receipts and group changes. |
| `HIDE` | Bridge, in `src/live/directory.ts` and `sql.ts` | Hidden people and chats never enter the directory, and every query leaves out hidden chats' rows. |
| Code redaction | Bridge (and the mock store) | Message text, extracted attachment text and the search index. |
| Signed links | Minted on the bridge, checked on the gateway | `LINK_SECRET` on both sides. |

The gateway has no rate limit or audit log of its own and never inspects tool arguments; everything that depends on
your messages happens on the Mac. A compromised gateway still cannot read hidden chats, send while sending is off, or
reach anyone outside an explicit allowlist; it can claim any scopes, though, since it states them on each call (see
[SECURITY.md](../SECURITY.md#controls-what-they-do-and-dont-do)).

## The relay protocol

The bridge opens a WebSocket to `<GATEWAY_URL>/bridge` with `Authorization: Bearer <BRIDGE_SECRET>`. Frames are JSON
(`src/relay/protocol.ts`):

| Direction | Frame | Purpose |
|---|---|---|
| Bridge → gateway | `hello` | Sent on connect: bridge version, the full `tools/list` result, the owner's name, the bridge's tiers, and its `initialize` instructions. |
| Gateway → bridge | `mcp` | One `/mcp` request body, with the caller's scopes, client id and the public origin. |
| Bridge → gateway | `mcp_result` | Status, headers and body to return to the client. |
| Gateway → bridge | `file` | Fetch an attachment for a signed `/files` link. |
| Bridge → gateway | `file_result` | The file as base64, or a status (404, 413). |
| Gateway → bridge | `view` | Render a signed `/view` citation page, showing nothing newer than the link's snapshot time. |
| Bridge → gateway | `view_result` | The transcript text. |

- Frames are capped at 24 MB, so a file link carries at most about 18 MB. The gateway refuses `/mcp` requests over
  15 MB with 413 before they reach the bridge, and the bridge replaces a reply that would not fit with a small error.
- The gateway pings every 20 seconds. The bridge reconnects with backoff (up to 30 seconds) and treats 70 seconds
  without a ping as a dead connection.
- Only one bridge is kept. When a second connects, the gateway closes the older socket with code 4000 and that bridge
  exits rather than fight for the connection.

## OAuth

The gateway is a minimal single-user OAuth 2.1 authorization server (`src/auth/`), with no database:

| Endpoint | What it does |
|---|---|
| `/.well-known/oauth-protected-resource[/mcp]` | Names the resource (`…/mcp`) and its authorization server. |
| `/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration` | Endpoints, S256 PKCE, client ID metadata documents (CIMD) and dynamic registration. |
| `/register` | Dynamic client registration. The client id is itself a signed token, so registrations survive restarts with no storage. |
| `/authorize` | The consent page: owner password plus scope checkboxes. Redirects only to ChatGPT, Claude, loopback addresses or `ALLOWED_REDIRECT_URIS`. |
| `/token` | Authorization code exchange (PKCE required) and refresh. Tokens are audience-bound to `…/mcp`. |
| `/revoke` | Revokes a refresh token family until the gateway restarts. |

With CIMD, the `client_id` is an HTTPS URL on a host in `CIMD_HOSTS`, and ChatGPT's `private_key_jwt` assertions are
verified against its published keys. A tool call without the scope it needs returns the `mcp/www_authenticate`
challenge ChatGPT uses to ask for more access.

## Inside the bridge

### Reading

- `chat.db` is opened read-only (`query_only`, with a busy timeout). The bridge watches `chat.db-wal` and re-reads a
  recent date window, so new messages, edits, unsends and read receipts all show up, not just new rows.
- Contacts come straight from the AddressBook databases (`AddressBook-v22.abcddb` and its `Sources/*` copies). That
  works headless under Full Disk Access, with no Contacts prompt. Phone numbers are normalized before matching, and
  each person merges every phone, email and per-service handle on their card.
- Message text is decoded from `attributedBody` (`src/live/typedstream.ts`); edit history, unsend markers and rich
  link previews from binary plists (`src/live/bplist.ts`).

### The sidecar

`sidecar.db` lives in `DATA_DIR` (a `0700` directory) next to the socket, never inside `~/Library/Messages`:

| Table | Holds |
|---|---|
| `msg_fts`, `msg_meta` | A contentless FTS5 index of message text, link titles and attachment names, plus the metadata search filters on. Built in the background on first start, then kept current. |
| `person_meta`, `chat_labels`, `reminders`, `reminder_dismissals` | Aliases, notes, labels and reminders you or the agent create. |
| `drafts` | Drafts and scheduled messages. |
| `idempotency` | Results of sends by idempotency key, so a retry returns the first result. A send in progress is recorded before Messages is asked, so a retry after a crash reports `outcome_unknown` instead of sending again. Kept 7 days. |
| `audit` | Outbound actions. Kept 30 days. |
| `tool_calls` | The journal: every tool call with client, intent, sanitized arguments, outcome and timing (`imessage journal`). Kept 30 days. |
| `kv` | Internal state such as the index version. |

Schema changes run as numbered migrations counted by `PRAGMA user_version`, so an older sidecar upgrades in place. A
daily sweep prunes the tables above and removes staged outgoing files older than 7 days that `chat.db` no longer
points to.

### Sending

- AppleScript, with every value passed through `on run argv` so nothing is interpolated into the script. 1:1 chats
  are addressed by participant (macOS 26 rejects `chat id` for `any;-;` DM chats); groups by chat id.
- Files are staged under `~/Library/Messages/Attachments/imessage-mcp/` first, since Messages' sandbox can't always
  read files from elsewhere.
- AppleScript returns no message id, so the bridge watches `chat.db` for the new row (matching handle, text and time)
  for several seconds, and reports a typed outcome: `sent`, `delivered`, `failed`, `may_have_completed` or
  `still_in_flight`. It skips the empty, unjoined "ghost" rows macOS 26 sometimes writes.
- Scheduled drafts are sent by a 15-second scheduler on the bridge, through the same policy as `send_message`. A
  draft that comes due while the Mac is asleep, offline or has sending off waits up to an hour, then is marked failed
  (`missed_window` or `send_disabled`) rather than sent late.
- The Private API tier (`src/live/imsgRpc.ts`) runs `imsg rpc` as a child process and speaks JSON-RPC over stdio.
  Each call waits for `chat.db` to show the change; anything uncertain is reported as `outcome_unknown`.

### Attachments

Image previews use `sips` (HEIC to JPEG, downscaled); video and PDF thumbnails use Quick Look (`qlmanage`). Text comes
from a small Swift program (`src/live/extract.swift`, PDFKit plus Vision OCR) compiled on first use if the Xcode
Command Line Tools are installed, and from `textutil` for Word, RTF and HTML. Files that Messages in iCloud has
offloaded from the Mac are reported as "in iCloud".

## chat.db notes

Facts the live store relies on. They hold on macOS 26; older versions differ in places.

- Most modern rows have `text` NULL; the text is in `attributedBody`, an `NSAttributedString` in NeXT typedstream
  form. Length tags: `0x81` means a 2-byte little-endian length follows, `0x82` a 4-byte one, otherwise the byte is
  the length.
- Dates are nanoseconds since 2001-01-01 UTC (`unix_ms = date / 1e6 + 978307200000`). Old rows store seconds, so
  values below 1e12 are treated as seconds; 0 means unset.
- `chat.style` 43 is a group and 45 is a 1:1. Chat GUIDs look like `any;-;+15555550123` (1:1) and `any;+;chat…`
  (group). One message can belong to more than one chat, and the same address has one `handle` row per service.
- Tapbacks are rows of their own: `associated_message_type` 2000–2005 adds one (2006 is an emoji tapback), 3000–3006
  removes it, and `associated_message_guid` carries a `p:N/` or `bp:` prefix to strip.
- Unsends and edit history are recorded in `message_summary_info`, a binary plist.
- Opening with `immutable=1` would miss everything still in the WAL, so the bridge never does.

## Running on a Mac

- **A LaunchAgent, not a LaunchDaemon.** Sending through Messages needs the logged-in GUI session. A locked screen
  is fine; logging out stops the bridge.
- **PATH and HOME in the plist.** launchd starts agents with a minimal environment, so the installer sets both.
- **Full Disk Access is per executable.** Granting it to your everyday `node` would grant it to every script that node
  runs, so the installer copies node to a dedicated binary and you grant access to that copy only.
- **The Automation prompt** for Messages appears once and needs someone at the screen (or screen sharing).
- **FileVault reboots.** After an update reboot the Mac waits at the FileVault unlock screen, and the bridge is down
  until someone logs in. Either schedule updates for when you can unlock it, or accept the downtime.
- **Sleep.** The Mac must not sleep, or the WebSocket drops.

[docs/operations.md](operations.md) has the matching setup steps.
