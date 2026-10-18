# Security

imessage-mcp gives an AI agent read access to your Messages history and, if you allow it, the ability to send as
you. Treat connecting it like handing someone your unlocked phone with a few guard rails attached. This page covers
what it trusts, what each guard rail does and does not promise, and how to report a problem.

## Reporting a vulnerability

Report privately through GitHub: open the repository's **Security** tab and choose
[**Report a vulnerability**](https://github.com/shadow173/imessage-mcp/security/advisories/new). Please don't open a
public issue for security problems, and never include real message content, phone numbers or tokens in a report;
describe the steps and use made-up data.

This is a volunteer-maintained project. Reports are acknowledged as soon as possible, normally within a week. Fixes go
to the latest release on `main`; older versions are not patched.

In scope: the gateway, the bridge, the CLI, the install scripts and the docs' advice. Out of scope: bugs in macOS,
Messages, imsg, ChatGPT or Claude themselves, and attacks that already need code running as your macOS user (that
user is trusted; see below).

## What you are trusting

| Party | Why it matters |
|---|---|
| **The gateway host** | TLS ends at the gateway, so every tool call and its result, including message text, passes through that host's memory. It holds the signing secret and your password hash. It stores no message content. |
| **The clients you approve** (ChatGPT, Claude, Claude Code) | They receive whatever the tools return, and the model behind them decides which tools to call. Their own retention policies apply to that data. |
| **Every process running as your macOS user** | The bridge's local socket gives full access (read, organize, send) with no login: the only check is Unix file permissions (a `0600` socket in a `0700` directory). The `imessage` CLI and `imessage mcp` use this socket. |
| **The bridge's node binary** | Full Disk Access goes to a dedicated copy of node rather than your everyday `node`. It is not a sandbox: any script that binary runs, including a modified `dist/`, can read your messages. The CLI only needs the socket, not Full Disk Access. |
| **imsg, if you enable the Private API tier** | A separate third-party tool whose helper runs inside Messages.app. See [docs/private-api.md](docs/private-api.md). |
| **macOS's file parsers** | `get_attachment` previews and text extraction run `sips`, Quick Look, PDFKit, Vision and `textutil` on files anyone can text you. Messages opens incoming files inside its BlastDoor sandbox; these run as children of the bridge, with its Full Disk Access and its socket (Quick Look's generators are sandboxed). It takes a tool call to reach them, so it isn't zero-click, but one prompt-injected request ("read the attached PDF") is enough. |

If System Integrity Protection is disabled on your Mac, macOS no longer reliably enforces Full Disk Access: other
processes may read `chat.db` without being granted access, and the dedicated node copy adds little isolation.

## Prompt injection

Anyone can text you. Message text, contact and group names, link titles and text pulled out of attachments (OCR, PDF
text) all reach the model. The server marks message text as untrusted data, and its instructions tell the model never
to follow instructions found in messages. That lowers the risk; it does not remove it. A model can still be talked into
calling a tool it shouldn't.

So the controls that matter most are the ones that don't depend on the model behaving: `SEND_ENABLED`, an explicit
`SEND_ALLOWLIST`, the rate limit, `HIDE`, `REDACT_CODES`, and which OAuth scopes you grant.

## Controls: what they do and don't do

`HIDE`, `SEND_ENABLED`, an explicit `SEND_ALLOWLIST` and the rate limit are enforced by the bridge on your Mac, so a
compromised gateway still cannot read hidden chats, send while sending is off, or message anyone outside an explicit
list. OAuth scopes and `user_confirmed` are not: the gateway states the granted scopes on every call it relays, and
`user_confirmed` is just an argument. With the default `SEND_ALLOWLIST=known`, a compromised gateway can read every chat
not in `HIDE` and text any number, up to the hourly limit. If you don't fully trust the gateway host, run with
`SEND_ENABLED=false` or an explicit list.

| Control | What it does | What it does not do |
|---|---|---|
| `SEND_ENABLED=false` | Blocks everything a recipient can see: sends, scheduled drafts, tapbacks, edits, typing indicators, read receipts and group changes. | It does not block `unsend_message` (kept so a mistake can be pulled back), reading, saving drafts, or organizing. |
| `SEND_ALLOWLIST=known` (default) | Anyone with a name in Contacts can be messaged. Anyone else returns `confirmation_required`, and the model is told to ask you first. | The confirmation is a flag (`user_confirmed`) **the model sets itself**. It makes a well-behaved model ask you; it is not human approval. "Anyone in Contacts" also includes businesses and people you rarely talk to. |
| `SEND_ALLOWLIST=<list>` | Only the listed person_ids, numbers, emails and chat_ids can be messaged; a group passes only if its chat_id or every member is listed. The same check covers scheduled drafts, tapbacks, edits, and adding, renaming or changing the photo of a group. Anyone else gets `not_allowlisted`, and `user_confirmed` cannot override it. | Only you can extend it, on the Mac. Typing indicators, read receipts, unsend, removing a member and leaving a group still work in any chat; none of them carries text the model chose. |
| `SEND_ALLOWLIST=all` | No recipient check. | Not recommended. |
| `SEND_RATE_LIMIT_PER_HOUR` (default 30) | Caps outbound actions (sends, scheduled sends, tapbacks, edits, group create/add/rename/photo). | The count is kept in memory and resets when the bridge restarts. |
| `HIDE` | Removes the listed people and chats from every tool result: their 1:1 chats and every group they are in. | It is a filter applied on the Mac, not encryption. The data stays in `chat.db`, and the sidecar search index on disk may still cover those messages. |
| `REDACT_CODES=true` (default) | Replaces likely one-time codes with `[verification code hidden]` in message text, extracted attachment text and the search index, so search can't confirm a code's digits either. | It is a heuristic (digits near words like "code" or "verify"). It can miss unusually worded codes, and it does not hide sign-in or password-reset links. Turning it off shows codes to the agent, which also means a prompt-injected agent can read them. |
| OAuth scopes | `messages.read` is always granted; `messages.organize` and `messages.send` are checkboxes on the consent page. A tool outside the granted scopes is refused. | Scopes are per connection: leave **Send** unticked for clients that only need to read. |
| `TIERS` on the bridge | Decides which tool groups exist at all. | The gateway's own `TIERS` only shapes the tool list shown while the bridge is offline. |

Idempotency keys and send confirmation (every send is checked against `chat.db`) protect against double sends after a
timeout. They are reliability features, not security controls.

## Links are bearer URLs

Two kinds of signed link can be read by anyone who has the URL, with no login:

- **File links** (`/files/<id>`) from `get_attachment` with `mode=link`. They expire after 15 minutes. Because the
  files come from whoever texted you, only images, audio, video and plain text display in the browser (sandboxed,
  with no scripts); everything else, including HTML, SVG and PDF, downloads instead.
- **Citation links** (`/view/...`) returned by the ChatGPT `search` and `fetch` tools, so ChatGPT can cite a
  conversation. They last **30 days** and show the transcript as it was when it was fetched, never anything newer.
  ChatGPT keeps them in its conversation history.

Rotating `LINK_SECRET` (on both the gateway and the bridge) invalidates every outstanding link. If you don't use
ChatGPT's search and fetch, remove `gpt` from `TIERS` and no citation links are made.

## Sessions and revocation

The gateway keeps no database. Access tokens, refresh tokens, authorization codes and registered client ids are all
signed tokens, which is what lets it run on a host with no disk. The tradeoffs:

- **Revoking a single token is best effort.** Refresh tokens rotate on every use, and presenting an old one ends that
  sign-in's whole token family. That tracking, and `/revoke`, live in memory and are forgotten when the gateway
  restarts or redeploys.
- **`TOKEN_VERSION` is the durable kill switch.** Bump it to sign out every client at once.
- Rotating `AUTH_SIGNING_SECRET` also invalidates every registered client id, so each connector has to be added again.
- Access tokens last one hour (`ACCESS_TOKEN_TTL_S`). A refresh token expires once it goes unused for
  `REFRESH_TOKEN_TTL_S` (30 days by default).
- There is one owner password, stored only as an scrypt hash. Failed sign-ins are throttled in memory: after a few
  wrong tries from one address each further try waits longer, and tries from all addresses together are spaced out.
  Someone hammering the sign-in page can slow your own sign-in down while they do, so use a long random password from a
  password manager.
- OAuth redirects go only to ChatGPT, Claude, loopback addresses (Claude Code), and anything you add to
  `ALLOWED_REDIRECT_URIS`. Client metadata documents (CIMD) are fetched only from hosts in `CIMD_HOSTS`.

## Data kept on the Mac

- `chat.db` and the Contacts databases are opened **read-only** and never written. Sends go through Messages.app.
- `~/Library/Application Support/imessage-mcp/` (a `0700` directory) holds `sidecar.db`:
  - a contentless FTS5 search index. It does not store message text verbatim, but it records which words appear in
    which message, so treat it as sensitive as `chat.db`;
  - aliases, notes, labels, reminders, and the full text of drafts and scheduled messages, kept until you delete
    them;
  - the **tool-call journal**: every call's arguments (message text you sent, search queries, recipients; long
    strings cut at 500 characters) and its stated intent, plus an audit log of outbound actions. A daily sweep
    deletes both after 30 days;
  - stored send results for idempotency keys, deleted after 7 days.
- Outgoing attachments are staged under `~/Library/Messages/Attachments/imessage-mcp/`.
- Logs go to `~/Library/Logs/imessage-mcp/bridge.log`.

To remove everything: run `npm run uninstall:bridge`, delete those three directories and
`~/.config/imessage-mcp/`, and revoke Full Disk Access for `imessage-bridge-node` in System Settings.

## One person per instance

A gateway and bridge serve one person's messages. Never share an instance: anyone who knows the owner password gets
your messages with whichever scopes they tick.

## The Private API tier

The optional Private API tier needs System Integrity Protection off and library validation off for the whole Mac, and
it loads third-party code into Messages. That weakens the security of everything on the machine, not just this project.
It is off unless you set `PRIVATE_API=imsg`. Read [docs/private-api.md](docs/private-api.md) before turning it on.

## Hardening checklist

- A long, random owner password, kept in a password manager.
- `SEND_ENABLED=false` until you have watched the agent work; then an explicit `SEND_ALLOWLIST`.
- On the consent page, leave **Send** unticked for clients that only read.
- Keep `REDACT_CODES=true`.
- `HIDE` anything that should never reach a model.
- `bridge.env` at `0600`; never commit `.env` files.
- Never set `DEV=1` on a public host. Without it the gateway refuses to start until every secret is set.
- FileVault on, and Node and the dependencies kept up to date.
- Run local only (no gateway) if you only need Claude Code on the same Mac. Nothing is exposed to the internet then.
