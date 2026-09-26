# Contributing

## Setup

```bash
npm ci          # installs pi as a peer — tsc and the tests need its types
npm run ci      # lint + test; must pass before any commit
```

Point your local pi at a checkout while developing:

```bash
ln -s "$PWD" ~/.pi/agent/extensions/pi-anthropic-vertex
```

Symlink the **directory**, not the file: pi resolves an extension's imports from the path it loaded
it by, so a lone `.ts` linked into `extensions/` cannot see this repo's `node_modules/`.

To load a checkout without installing it at all:

```bash
GOOGLE_CLOUD_PROJECT=proj CLOUD_ML_REGION=us-east5 pi -ne -e . --list-models | grep anthropic-vertex
```

## Layout

pi documents three extension styles — a single `.ts` file, a directory with `index.ts`, and, for
extensions with npm dependencies, a package with its entry point under `src/`. This is the third,
because it depends on `google-auth-library`.

```
├── package.json          # "pi": { "extensions": ["./src/index.ts"] } — how pi finds the entry point
├── src/
│   ├── index.ts          # the whole extension
│   └── index.test.ts     # node --test, co-located
└── .github/workflows/ci.yml
```

`src/index.ts` keeps all logic in pure exports — `resolveProject`, `resolveRegion`, `buildBaseUrl`,
`vertexModelId`, `rewriteVertexRequest`, `isStructuredOutputsPolicyRefusal`, `withoutStrictTools`,
`createVertexFetch`, `toVertexModel`, `withVertexFetch`,
`anthropicVertexProviderConfig` — with a thin `default` that registers them. The suite therefore
runs with no pi process, no network, and no GCP credentials.

## How it works

Vertex serves Claude over **Anthropic's own Messages protocol** — the same protocol pi already
speaks. What differs is the envelope: a different URL, a Google OAuth2 access token instead of an
API key, and the model id moved out of the body and into the path.

So this extension implements no protocol. It takes pi's own `anthropicMessagesApi()` and injects a
`fetch` that rewrites the request on the way out:

```
POST https://{host}/v1/messages[?beta=true]
  -> POST https://{host}/v1/projects/{project}/locations/{region}
           /publishers/anthropic/models/{model}:{streamRawPredict|rawPredict}

body  : `model` removed, `anthropic_version: "vertex-2023-10-16"` added
header: the token moves from `x-api-key` to `authorization: Bearer ...`
query : `beta` dropped (the `anthropic-beta` header is what carries the betas)
```

`:streamRawPredict` when the body says `stream: true`, `:rawPredict` otherwise. Every other path and
method passes through with the auth-header swap only — pi's Anthropic transport never calls
count_tokens or the models endpoints, so there is nothing else to map.

That is exactly what `@anthropic-ai/vertex-sdk` does on the request path
(`_AnthropicVertex_adaptRequest`, 0.19.6) and nothing more, which is why it is not a dependency.

### Why no SDK, and no mirrored internals

- **No `@anthropic-ai/*` dependency.** The Anthropic SDK is already inside pi. A second copy here
  can disagree with it about protocol details and has to be bumped in lockstep forever. The only
  runtime dependency is `google-auth-library`.
- **No copied pi source.** Streaming, tool calls, thinking blocks, cache control and usage
  accounting all stay in pi. A pi release can therefore only break this through the public
  `anthropicMessagesApi()` / `createProvider` / `getBuiltinModels` surface — which the tests exercise
  directly. If a change starts requiring a copy of pi's source, stop and reconsider.
- **No hand-maintained catalog.** Models come from `getBuiltinModels("anthropic")`, so a pi upgrade brings
  new Claude models, current pricing and current thinking levels with it.

### The two pi request shapes

pi has built the request two ways. The CI matrix now covers only 0.87.1, which uses the 0.85.0
shape, but the rewrite still accepts both, so the table stays as the reason for each step:

| | pi 0.84.x | pi 0.85.0 and later (0.87.1 included) |
|---|---|---|
| Call | `client.messages.create({ ...params, stream: true })` | `client.beta.messages.create(params)` |
| Path | `/v1/messages` | `/v1/messages?beta=true` |
| Betas | already flattened into the `anthropic-beta` header by `createClient` | `params.betas`, which the SDK lifts into the same header and strips from the body |

Both arrive at the wrapper as a POST whose path ends in `/v1/messages` and whose body is a JSON
string, so one rewrite covers both. The only step the newer shape needs is dropping the `beta` query
parameter. `src/index.test.ts` drives pi's real `streamSimple` against a mocked transport, so both
shapes are checked for real rather than described.

### The fetch wrapper, in detail

`createVertexFetch()` normalises its input through `new Request(input, init)`. The two callers
disagree about shape: the Anthropic SDK inside pi passes a URL string with a `Headers` instance and
a serialised string body, while direct callers and tests pass plain records. The original `init` is
spread back into the outgoing call so transport options the rewrite has no opinion about (`duplex`,
an undici `dispatcher`, `keepalive`) survive, and `content-length` is dropped because the rewritten
body has a different length.

`baseFetch` is resolved **inside** the returned function, not captured at creation: `globalThis.fetch`
is routinely replaced after module load by proxy agents, test doubles and pi's own instrumentation.

`withVertexFetch()` builds the Vertex fetch **per call**, so a caller-supplied `options.fetch` can be
composed underneath it — the caller's fetch stays the transport that actually dials, and the rewrite
runs first. pi forwards `options.fetch` through `Provider.stream()`, so without this composition a
caller-supplied transport would silently replace the rewrite, and the request would go to
`/v1/messages` on a Vertex host. That is what the end-to-end test pins.

### The compat allowlist

`Model.compat` is how pi decides which optional Anthropic request fields to send. Vertex rejects
request fields it does not know, so `VERTEX_COMPAT_KEYS` is an **allowlist**: a compat key that a
future pi adds is dropped until somebody has tried it against Vertex.

Currently excluded, with the reason next to each key in the source:

- `allowedFallbackModels` — pi turns it into a `fallbacks` request field, which Vertex answers with
  `400 fallbacks: Extra inputs are not permitted` (twoGiants/pi-anthropic-vertex#27, `claude-opus-5`
  on pi 0.84.x). pi 0.85.0 still sets it on `claude-fable-5`.
- `supportsMidConvoEffort` — pi 0.85.0 sends the `mid-conversation-output-config` and
  `thinking-binding-controls-2026-08-01` betas plus `output_config` / `block_binding` fields.
  Unverified on Vertex, and the key does not exist at all in pi 0.84.4.
- `sendSessionAffinityHeaders` — a Fireworks cache-routing header, meaningless here.
- `sessionAffinityFormat` — picks the name of that header (pi 0.87), meaningless here.
- `supportsMidConvoSystemMessages` — pi 0.87 sends later system messages as system-role messages
  inside `messages`. Unverified on Vertex.
- `supportsMidConvoToolChanges` — pi 0.87 sends the `mid-conversation-tool-changes-2026-07-01` beta,
  `tool_addition` / `tool_removal` blocks and `defer_loading` tools. Unverified on Vertex.

`supportsToolReferences` was forwarded until pi 0.87 removed it from the compat type.

Turning one of these on is a real change: verify it with a live call against Vertex, in the same
commit as the test that covers it.

## The CI matrix replaces a compat file

`.github/workflows/ci.yml` runs the whole suite against **each** supported pi version (currently
`0.87.1`) by installing that version over the lockfile's peers:

```bash
npm install --no-save --ignore-scripts @earendil-works/pi-ai@$V @earendil-works/pi-coding-agent@$V
npm run ci
```

That matrix *is* the compatibility statement. Because the extension mirrors no pi internals, there is
nothing to keep in sync by hand — no `sync/compat.json`, no vendored snapshot, no "supported
versions" table that drifts from reality. A pi release can only break this through the public
surface the tests already call, and the matrix says which versions currently pass.

When pi releases: add the new version, run it, and drop the old one when fullsend moves its sandbox
pin (`images/sandbox/Containerfile`, `ARG PI_VERSION`). Run the same two commands locally before
pushing, for each version in the matrix.

## Gotchas

Each of these cost real debugging time. They are not obvious from pi's docs.

**Import only from pi's allowlisted specifiers.** The extension loader maps a fixed list to bundled
virtual modules: `@earendil-works/pi-ai` (aliased to compat), `.../compat`, `.../oauth`,
`.../providers/all`, and `@earendil-works/pi-coding-agent`. Anything else — including a *real*
subpath like `.../api/anthropic-messages.lazy` — falls through to filesystem resolution, where the
loader appends it to the alias **file** path and dies with `Cannot find module
.../dist/compat.js/api/anthropic-messages.lazy`.

**Check which entry point declares a name, in the `.d.ts`.** `anthropicMessagesApi` and `getBuiltinModels`
are declared on `/compat` only; `createProvider` and the types are on the root. The prose docs are
stale in both directions — `docs/custom-provider.md` still describes a top-level `oauth` with
`refreshToken`/`getApiKey`, which the shipped types do not accept.

**Use `import type` for `ExtensionAPI`.** `import { type ExtensionAPI } from ...` still emits a
side-effect import, which drags in pi-coding-agent's `experimental/server.js` and fails with
`Cannot find package '@earendil-works/pi-server'` outside a full pi install — including under
`node --test`. Nothing here needs a runtime value from the coding agent.

**A failed extension is silent.** pi omits it from `--list-models` and prints nothing. Load it with
`-e <path>` to see the actual error. This is also why `npm run ci` passing is not enough on its own:
finish with `pi -ne -e . --list-models`.

**Use `auth.apiKey` with no `login`, never `auth.oauth`.** `auth.oauth` means "an interactive login
mints a credential pi persists to `~/.pi/agent/auth.json`", so pi refuses the provider until such a
credential exists. ADC is not interactive — it is *ambient*, discovered from the environment — and
pi's `ApiKeyAuth` documents an absent `login` as exactly that ("Absent = ambient-only"), calling
`resolve()` per request instead. Getting this wrong is nearly invisible: on a machine that once ran
`pi login` it works perfectly, and on every fresh one it fails with
`No API key found for anthropic-vertex`. The sibling extension shipped that bug in its v0.1.0 and it
was caught only inside a clean CI sandbox.

**One malformed entry breaks every provider.** pi's model resolution iterates *all* registered
providers' models before picking one, so a bad model here takes down `anthropic`, `google-vertex`,
everything. After any provider or model change, run `pi --list-models` and confirm the *others*
still resolve.

This is also why `Model`, `AuthResult`, `ProviderStreams` and `AnthropicMessagesCompat` are imported
from pi rather than re-declared, and why there are no casts: a hand-rolled equivalent is subtly
non-assignable, and `as never` would silence exactly the check that catches a schema break before
production.

**`Model.id` stays pi's id.** Vertex's `@`-dated naming is applied to the URL only
(`claude-haiku-4-5-20251001` → `claude-haiku-4-5@20251001`), so alias tables and user-typed specs do
not have to know about it. Do not "fix" the ids in the catalog.

**No `/v1` in `buildBaseUrl`.** pi hands the base URL to the Anthropic SDK, which appends
`/v1/messages` itself. A `/v1` here would produce `/v1/v1/messages`, and the rewrite — which anchors
on a trailing `/v1/messages` — would happily build `/v1/v1/projects/...` and 404.

**Never read an `ANTHROPIC_*` variable** except `ANTHROPIC_VERTEX_PROJECT_ID` as the third project
fallback. Hosts routinely unset `ANTHROPIC_*` before launching pi; that has to stay belt-and-braces
rather than load-bearing.

**Peer deps are inert at runtime.** pi loads `@earendil-works/*` from bundled virtual modules, so a
copy inside the extension's `node_modules/` is never used. Deployments still use `--omit=peer`, but
for install size and supply-chain surface, not correctness.

## Testing

The suite is `node --test src/index.test.ts`. Three groups are worth more than the rest, because
they check this code against **pi's** expectations rather than ours:

1. `createProvider integration` runs pi's real `createProvider` over the config. If it fails after a
   pi bump, the provider or model schema moved — read the `.d.ts`, do not loosen the test.
2. `cost through pi's own engine` asserts a Vertex model bills *identically* to the same model on
   the direct Anthropic path, for every model in pi's catalog.
3. `end to end through pi's Anthropic transport` drives the real provider — `createProvider` over
   `anthropicVertexProviderConfig` — with a mocked transport and canned Anthropic SSE. pi builds the
   request, the SDK serialises it, the rewrite fires, and pi parses the response back into an
   assistant message.

That last one goes through the provider on purpose: it is the test that fails if `api:` is ever
reverted to a bare `anthropicMessagesApi()`. If you change the wiring, verify the test still bites
by making that revert and watching it fail.

The model-mapping tests run against the **real** `getBuiltinModels("anthropic")` output rather than a
fixture, so they keep asserting something true after a pi bump instead of asserting a snapshot of a
catalog that has moved.

## Before you commit

- `npm run ci` passes on **every** matrix version (see above), and
  `pi -ne -e . --list-models` still lists the provider.
- Changes to the rewrite, the endpoint or auth also need one real call against a project with Claude
  enabled — the suite deliberately does not cover the network.
- Claims about Vertex, Anthropic or pi behaviour need a source: the shipped `.d.ts`, a live call, or
  vendor docs.
- Commit format `{feat,fix,docs}: <concise message>`, no emojis, and sign off:
  `Signed-off-by: <name> <email>`.

## Releasing

Set `version` in `package.json` in a PR (refresh the lockfile as above), merge it, then tag that
merge commit with the same version and push the tag; `.github/workflows/release.yml` does the rest.

```bash
git switch main && git pull
VERSION="v$(node -p 'require("./package.json").version')"
git tag -a "$VERSION" -m "$VERSION"
git push origin "$VERSION"
```

It re-runs lint and tests (never cut a release from a tree that does not pass), computes the SHA256
of the tag tarball, and publishes a release whose notes carry the tarball URL and digest — the pair
pinned consumers need. fullsend's sandbox Containerfile fetches that tarball and verifies the digest,
so it is published rather than left for each consumer to derive.

There is no npm publish step: the package is consumed with `pi install git:...`, so the git tag is
the artifact.

## Prior art

[twoGiants/pi-anthropic-vertex](https://github.com/twoGiants/pi-anthropic-vertex) is the extension
this replaces — same provider id, same environment contract, same model ids, same disabled message,
so it is a drop-in swap. It takes the other approach, building on `@anthropic-ai/vertex-sdk`.

[fullsend-ai/pi-xai-vertex](https://github.com/fullsend-ai/pi-xai-vertex) is the sibling for Grok on
Vertex: a different protocol (OpenAI-completions), the same ADC auth shape, and the source of most
of the gotchas above.
