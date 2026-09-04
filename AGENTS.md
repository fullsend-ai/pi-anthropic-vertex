# AGENTS.md

A [pi](https://github.com/earendil-works/pi) provider extension: Anthropic Claude on Google Cloud
Vertex AI. Registers provider `anthropic-vertex`, with pi's own Claude catalog behind it.
**This repo is public.**

Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing anything — it covers the layout, how the
request rewrite works, and the pi-specific gotchas behind each decision. The rules below are the
short form.

## Commands

```bash
npm ci          # installs pi as a peer; tsc and the tests need its types
npm run ci      # lint + test — must pass before any commit
```

Then the same against the other supported pi version, because that is what CI does and 0.84.4 is
what production runs:

```bash
npm install --no-save --ignore-scripts @earendil-works/pi-ai@0.84.4 @earendil-works/pi-coding-agent@0.84.4
npm run ci
npm install --no-save --ignore-scripts @earendil-works/pi-ai@0.85.0 @earendil-works/pi-coding-agent@0.85.0
```

## Rules

- **Never add an `@anthropic-ai/*` dependency.** The whole design is pi's own Anthropic transport
  plus a request-rewriting `fetch`. `google-auth-library` is the only runtime dependency; do not add
  more, and do not mint tokens by shelling out to a CLI or interpreter.
- **Never mirror pi internals.** If a change starts requiring a copy of pi's source, stop and
  reconsider — that is the property that makes the CI matrix a sufficient compatibility check.
- **Never cast at `createProvider()`.** `Model`, `AuthResult`, `ProviderStreams` and
  `AnthropicMessagesCompat` come from `@earendil-works/pi-ai`. Fix type errors; never silence them
  with `as never`, `as any` or `@ts-ignore`.
- **Import only from pi's allowlisted specifiers**: `@earendil-works/pi-ai`, `.../compat`,
  `.../oauth`, `.../providers/all`, `@earendil-works/pi-coding-agent`. Any other subpath fails to
  load — silently, since pi drops a failed extension from `--list-models` without printing anything.
  Use `import type` for `ExtensionAPI`, or the side-effect import pulls in `@earendil-works/pi-server`.
- **Trust `node_modules/@earendil-works/pi-ai/dist/**/*.d.ts`, not pi's prose docs**, including for
  which entry point declares a name.
- **`compat` is an allowlist, never a blocklist.** A compat key pi adds becomes a request field, and
  an unknown request field is a 400 from Vertex. New keys stay out of `VERTEX_COMPAT_KEYS` until
  someone has verified them with a live call, and each exclusion keeps its reason in a comment.
- **Auth is ambient: `auth.apiKey` with no `login`, never `auth.oauth`.** ADC comes from the
  environment; `oauth` makes pi wait for a persisted interactive credential and fails on any fresh
  machine. Verify with `pi -ne -e . --list-models` on a machine with no `auth.json` entry.
- **Never read an `ANTHROPIC_*` environment variable** except `ANTHROPIC_VERTEX_PROJECT_ID`, and
  only as the third project fallback. Not `ANTHROPIC_API_KEY`, not `ANTHROPIC_VERTEX_BASE_URL`.
- **Never hardcode a GCP project.** No project ids, host names, or employer-internal names in code,
  tests or docs — tests use `proj`.
- **Model ids stay pi's ids.** Vertex's `@`-dated form is applied to the URL only.
- **The disabled message is an API.** fullsend's `docs/runtimes/pi.md` greps for
  `[pi-anthropic-vertex] disabled: set GOOGLE_CLOUD_PROJECT or ANTHROPIC_VERTEX_PROJECT_ID`
  verbatim. Change it there in the same breath, or not at all.
- **Re-test other providers after any provider/model change** with `pi --list-models`: one bad entry
  breaks every registered provider, not just this one.
- **Erasable TypeScript only** (pi uses Node strip-only mode): no `enum`, `namespace`, or parameter
  properties. Top-level imports only. No `any`.
- **Direct dependencies are pinned to exact versions.** Refresh the lockfile with
  `npm install --package-lock-only --ignore-scripts`.

## Before you commit

- `npm run ci` passes on both pi versions, plus `pi -ne -e . --list-models`.
- Changes to the rewrite, the endpoint or auth also need one real call against Vertex.
- Verify claims about Vertex, Anthropic or pi against the `.d.ts`, a live call, or vendor docs.
- Commit format `{feat,fix,docs}: <message>`, no emojis, and `Signed-off-by: <name> <email>`.
