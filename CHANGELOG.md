# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-10-18

The first public release.

### Added

- A remote MCP server for Messages on macOS: an OAuth 2.1 gateway (PKCE, client ID metadata documents, dynamic client
  registration, audience-bound tokens) that relays tool calls to a bridge on the Mac over a WebSocket the Mac opens.
- A local-only mode: without `GATEWAY_URL` the bridge serves just its local socket, for the `imessage` CLI and
  `imessage mcp` in Claude Code. No gateway or internet exposure needed.
- 30 tools in five tiers: reading and search, sending and drafts, organizing (labels, aliases, notes, reminders),
  ChatGPT `search`/`fetch`, and the optional Private API tier through imsg.
- The `imessage` CLI, with a required `--intent`, documented exit codes and `imessage watch`, plus a Claude Code skill
  in `skills/imessage`.
- A tool-call journal on the Mac (`imessage journal`) recording each call's intent and outcome.
- Mock mode with seeded fake data, for trying the tools without a Mac.
- `SECURITY.md` with the threat model, docs for architecture, operations and the Private API tier, and
  `.env.example` / `bridge.env.example`.

### Security

- Fails closed: the gateway refuses to start until every required secret is set, on any host, and a configuration
  value that doesn't parse stops the gateway or the bridge at startup. `DEV=1` is the only way to run without
  secrets, and it prints a random one-time password.
- `HIDE`, `SEND_ENABLED`, an explicit `SEND_ALLOWLIST` and the hourly rate limit are enforced on the Mac. An explicit
  list is a hard boundary the model-set `user_confirmed` flag can't override, and it covers sends, scheduled drafts,
  tapbacks, edits and group changes.
- Every send is confirmed in `chat.db`, idempotency keys stop double sends, and a send interrupted by a crash is
  never sent again. Parallel sends reserve their rate-limit slot before they start.
- Refresh tokens rotate on every use, and presenting a rotated-out one ends that sign-in; so does reusing an
  authorization code. Clients that declare `private_key_jwt` must sign their token requests. Failed sign-ins are
  throttled per address and overall, and every gateway response carries security headers.
- File links expire after 15 minutes and display only images, audio, video and plain text inline, sandboxed; anything
  else downloads. ChatGPT citation links last 30 days and never show messages newer than the link.
- Message text is marked as untrusted data, every kind of line break is folded so a message can't fake a transcript
  line, and extracted attachment text is fenced with markers that change on every response.
- Paging values reach SQL only as bound parameters, cursors are validated, and attachment URLs are checked against an
  SSRF blocklist that includes the IPv6 ranges wrapping IPv4 addresses.
- The bridge passes none of its secrets to the processes it starts, and `textutil` never loads remote resources.
- The bridge deletes tool-call journal and audit rows after 30 days and stored send results after 7.

[Unreleased]: https://github.com/shadow173/imessage-mcp/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/shadow173/imessage-mcp/releases/tag/v0.2.0
