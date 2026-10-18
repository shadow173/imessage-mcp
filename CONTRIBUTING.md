# Contributing

Thanks for helping. This project reads people's private messages, so the bar for privacy is higher than usual:
please read the privacy rules below before you write a test or a bug report.

## Setup

You need Node.js 22.13 or later (`.nvmrc` pins the major version). Running the bridge against real messages needs
macOS; mock mode and the tests don't touch Messages at all.

```bash
git clone https://github.com/shadow173/imessage-mcp.git
cd imessage-mcp
npm ci
npm run check
```

| Command | What it does |
|---|---|
| `npm run check` | Typecheck, lint, tests, and a check that the README's Tools table matches the tools. CI runs the same on macOS and Linux, plus the build on macOS. Run it before every pull request. |
| `npm run typecheck` | `tsc --noEmit` over `src/`, `test/` and `scripts/`. |
| `npm run lint` / `npm run format` | Biome: check, or format and apply safe fixes. |
| `npm test` | The test suite (Node's test runner through tsx). |
| `DEV=1 npm run dev` | A mock gateway on `http://localhost:3000/mcp` with live reload. It prints a one-time password. |
| `npm run peek` | Sample output of a few tools on mock data, with no server or sign-in. |
| `npm run describe` | The server instructions and every tool exactly as an agent sees them. |
| `npm run tools-table -- --write` | Regenerates the README's Tools table from the tools' descriptions. |
| `npm run build` | Compiles to `dist/`. |

[scripts/README.md](scripts/README.md) lists every script, what it touches and whether it sends anything. Only the
ones under `scripts/dev/` are safe to run anywhere; `scripts/maintainer/` touches a real `chat.db` or a real
deployment.

## Mock data

Mock mode (the gateway with `MODE=mock`, `scripts/dev/peek.ts`, `scripts/dev/journey.ts` and most tests) serves a
seeded, fictional history built to exercise the hard cases:

- two people named Sam (ambiguity), one of them reachable by phone, email and SMS (merging a person across handles);
- a 400+ message chat (paging), an unnamed group, tapbacks, an edit, an unsent message, inline replies, a PDF, a voice
  memo, photos and links;
- an unknown number sending a prompt-injection text, and a bank short code sending a verification code (hidden);
- sends to any number ending in `0000` fail, and an attachment URL containing `fail` makes a partial send (text out,
  file failed), to test failure handling;
- named contacts reply 15 to 30 seconds after you message them (`MOCK_AUTO_REPLY`), and scheduled drafts fire from the
  same scheduler as the live bridge.

Timestamps are relative to when the store starts, and everything resets on restart.

## Tests

- The suite runs on macOS and Linux. Tests run against the mock store and against **synthetic** databases: `test/fixtures/*.sql` holds table definitions
  only, and each test writes made-up rows into a fresh database under the system temp directory. Nothing reads your
  real Messages or Contacts.
- The binary fixtures (plists and `attributedBody` blobs) are committed in `test/fixtures/blobs.ts`, so the suite
  calls no macOS tools. `test/fixtures/generate-blobs.ts` regenerates them on a Mac with `plutil` and Foundation;
  run it only when you need a new kind of blob, and commit its output.
- Shared setup lives in `test/helpers/`. `test/store.contract.ts` is one behavior suite that both stores must pass;
  add to it when you change something both stores implement.
- Pin the mock store's clock (`new MockStore({ now })`) instead of relying on the real time, so tests don't depend
  on when they run, and set the time zone explicitly where times matter. CI runs in UTC.
- A bug fix comes with a test that fails without it.

## Privacy rules

- **Never commit real data**: no real messages, names, phone numbers, emails, `chat.db` or Contacts rows, sidecar
  databases, screenshots of conversations, or logs that contain any of these. `.gitignore` blocks the common database
  files, but check your diff.
- Use fictional data: phone numbers in the `555-01xx` range (for example `+15555550123`), and `example.com` or
  `.example` domains.
- Scripts and probes that read a real `chat.db` print aggregates only (counts, sizes, timings), never content.
- In issues and pull requests, describe problems with made-up examples. Never paste message text or tool output from
  your own messages.

## Code style

- TypeScript in strict mode, ES modules, formatted by Biome (120 columns, single quotes). Run `npm run format`.
- No new runtime dependencies without discussing it in an issue first. Dev tooling is easier to add.
- Tool errors are `ToolError(code, message, fix)`. The model sees `Error <code>: <message>` followed by `Fix: <what to
  do next>`, so write the fix as an instruction it can follow.
- Tool descriptions are plain sentences that say when to use the tool, what comes back, and what to call next. Every
  tool takes the required `intent` argument, and every call is written to the journal; keep both.
- Changes to the send policy (kill switch, allowlist, rate limit) or to code redaction need tests for the new
  behavior and a note in [SECURITY.md](SECURITY.md) if what the control promises changes.
- The gateway and the bridge can be deployed at different times. Keep the relay frames in `src/relay/protocol.ts`
  backward compatible: add optional fields, don't rename or remove them.
- Times shown to users or models go through the helpers in `src/lib/time.ts`, in the owner's time zone.
- Each tool has its own file, `src/tools/<group>/<tool>.ts`. The group's `index.ts` lists its tools in the order
  `tools/list` shows them, `common.ts` holds what they share, and `src/tools/catalog.ts` names every tool and its tier.
- Facts about Messages itself (chat_id parsing, effects, attachment kinds) live in `src/domain`, and policy shared by
  the stores and the tools (the send policy, code redaction, edit windows) in `src/policy`. The stores, `src/relay`,
  `src/auth`, `src/domain` and `src/policy` never import the tool layer (`src/tools`, `server.ts`, `mcpHandler.ts`,
  `lib/format.ts`, `lib/resolve.ts`), and `src/lib` never imports `src/tools`, `server.ts` or `mcpHandler.ts`.
  `npm run lint` enforces both.

## Pull requests

- Keep each one focused on one change, and describe what changes for someone using the server.
- `npm run check` passes.
- Update the README, the docs and the `Unreleased` section of [CHANGELOG.md](CHANGELOG.md) when behavior,
  configuration or a tool's interface changes. When you add a tool or change the first sentence of its description,
  regenerate the README's Tools table with `npm run tools-table -- --write`; `npm run check` fails until you do.
- Security problems go through private reporting, not a pull request or issue: see [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
