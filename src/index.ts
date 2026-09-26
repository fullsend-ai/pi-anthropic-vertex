// pi provider extension: Anthropic Claude models on Google Cloud Vertex AI.
//
// Registers the provider `anthropic-vertex`, so a model spec reads
// `anthropic-vertex/claude-sonnet-5`.
//
// ## How this differs from every other way of doing it
//
// pi already speaks Anthropic's Messages protocol: `anthropicMessagesApi()` is the transport
// behind the built-in `anthropic` provider. Vertex serves the *same* protocol at a different URL,
// with a Google OAuth token instead of an API key, and with the model id moved out of the body and
// into the path. That is a request rewrite, not a protocol — so this extension does not
// re-implement streaming, tool calls, thinking blocks, cache control or usage accounting. It wraps
// pi's own transport with a `fetch` that rewrites the request on its way out.
//
// Consequences worth keeping:
//   - No `@anthropic-ai/*` dependency. The Anthropic SDK is already inside pi; a second copy here
//     (the shape `@anthropic-ai/vertex-sdk` would force) can disagree with it on protocol details
//     and would need bumping in lockstep forever. The only runtime dependency is
//     google-auth-library, same as the sibling extension fullsend-ai/pi-xai-vertex.
//   - No mirrored pi internals. Everything protocol-shaped stays in pi, so a pi release can only
//     break this through the public `anthropicMessagesApi()` / `createProvider` / `getModels`
//     surface — which is exactly what the tests and the CI matrix exercise.
//
// ## The rewrite
//
// `@anthropic-ai/vertex-sdk` (0.19.6, `_AnthropicVertex_adaptRequest`) does nothing else on the
// request path, and this reproduces it:
//
//   POST https://{host}/v1/messages[?beta=true]
//     -> POST https://{host}/v1/projects/{project}/locations/{region}
//              /publishers/anthropic/models/{model}:{streamRawPredict|rawPredict}
//
//   body  : `model` removed (it is in the path now), `anthropic_version` added
//   header: the token moves from `x-api-key` to `authorization: Bearer ...`
//
// Both pi request shapes go through the same rewrite:
//   - pi 0.84.4 posts `client.messages.create({ ...params, stream: true })` -> `/v1/messages`,
//     with betas already flattened into the `anthropic-beta` *header*;
//   - pi 0.85.0 posts `client.beta.messages.create(params)` -> `/v1/messages?beta=true`, and the
//     SDK lifts `params.betas` into the same header before the body is serialised.
// So the only 0.85.0-specific step is dropping the `beta` query parameter (the header stays).
//
// Any other path or method passes through with the auth-header swap only: pi's Anthropic transport
// never calls count_tokens or the models endpoints, so there is nothing else to map.
//
// ## Auth
//
// Vertex wants a short-lived (~1h) OAuth2 access token minted from Application Default
// Credentials, not a static key. ADC is *ambient* — discovered from the environment, with nothing
// for a user to type — so this registers `auth.apiKey` with **no `login` handler**, which is how
// pi spells "ambient-only", and pi calls `resolve()` per request. Do NOT switch this to
// `auth.oauth`: that shape means "an interactive login mints a credential pi persists to
// ~/.pi/agent/auth.json", so pi refuses the provider until one exists. It looks fine on a machine
// that has logged in once and fails on every fresh environment, sandboxes included, with
// "No API key found for anthropic-vertex".
//
// google-auth-library does its own token caching and renewal, which is why there is no expiry
// arithmetic anywhere below.
//
// ## Configuration
//
// The GCP project and region come from the environment and are never hardcoded: they are
// deployment-specific config and this source is public. No `ANTHROPIC_*` variable is read except
// `ANTHROPIC_VERTEX_PROJECT_ID`, kept as the third project fallback for parity with
// twoGiants/pi-anthropic-vertex. In particular `ANTHROPIC_API_KEY` and `ANTHROPIC_VERTEX_BASE_URL`
// are ignored, so a host that unsets `ANTHROPIC_*` before launching pi changes nothing here.

// pi's extension loader resolves a fixed allowlist of specifiers to bundled virtual modules
// (core/extensions/loader.ts): "@earendil-works/pi-ai" (aliased to the compat entrypoint),
// ".../compat", ".../oauth", ".../providers/all", and "@earendil-works/pi-coding-agent". Anything
// else — including a real subpath like ".../api/anthropic-messages.lazy" — falls through to
// filesystem resolution, where the loader appends it to the alias *file* path and fails with
// "Cannot find module .../dist/compat.js/api/anthropic-messages.lazy". Import only from the
// allowlisted specifiers, and check `node_modules/@earendil-works/pi-ai/dist/*.d.ts` for which
// entrypoint actually declares a name: `anthropicMessagesApi` (api/anthropic-messages.lazy.ts) is
// declared on "/compat" only, `getBuiltinModels` on "/providers/all" (the "/compat" `getModels` is
// the same function behind a deprecation notice), while `createProvider` (models.ts) and the types
// (types.ts, auth/types.ts) are declared on the root.
import { createProvider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type {
  AnthropicMessagesCompat,
  AuthResult,
  FetchFunction,
  Model,
  Provider,
  ProviderStreams,
} from "@earendil-works/pi-ai";
// `import type`, not `import { type ExtensionAPI }`: the latter still emits a side-effect import,
// which drags in pi-coding-agent's `experimental/server.js` and fails with
// "Cannot find package '@earendil-works/pi-server'" outside a full pi install — including under
// `node --test`. Nothing here needs a value from the coding agent, so erase the import entirely.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GoogleAuth } from "google-auth-library";

export const PROVIDER_ID = "anthropic-vertex";

/**
 * Env vars consulted for the GCP project, in precedence order.
 *
 * Verbatim parity with twoGiants/pi-anthropic-vertex v0.1.13 and fullsend's
 * `internal/runtime/pi.go`, so this extension is a drop-in replacement for either.
 */
export const PROJECT_ENV_VARS = [
  "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "GOOGLE_CLOUD_PROJECT_ID",
] as const;

/** Env vars consulted for the Vertex region, in precedence order. */
export const REGION_ENV_VARS = ["CLOUD_ML_REGION", "GOOGLE_CLOUD_LOCATION"] as const;

/** Where Anthropic models are served when nothing says otherwise. */
export const DEFAULT_REGION = "us-east5";

/** The API version Vertex requires in the body, in place of the `anthropic-version` header. */
export const ANTHROPIC_VERSION = "vertex-2023-10-16";

/**
 * Printed to stderr when no project resolves. fullsend's `docs/runtimes/pi.md` troubleshooting
 * matches on this exact string — change it there too, or not at all.
 */
export const DISABLED_MESSAGE =
  "[pi-anthropic-vertex] disabled: set GOOGLE_CLOUD_PROJECT or ANTHROPIC_VERTEX_PROJECT_ID";

/** First non-empty project id in PROJECT_ENV_VARS order, or undefined if none is set. */
export function resolveProject(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const name of PROJECT_ENV_VARS) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** First non-empty region in REGION_ENV_VARS order, falling back to DEFAULT_REGION. */
export function resolveRegion(env: NodeJS.ProcessEnv = process.env): string {
  for (const name of REGION_ENV_VARS) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return DEFAULT_REGION;
}

/**
 * The Vertex host for a region.
 *
 * `global` has its own hostname, and `us`/`eu` are the data-residency multi-region endpoints;
 * everything else is `{region}-aiplatform`.
 *
 * NOTE: no `/v1` suffix. pi hands this to the Anthropic SDK as `baseURL`, and the SDK appends
 * `/v1/messages` itself; the rewrite below keeps that `/v1` and replaces only `messages`.
 */
export function buildBaseUrl(region: string): string {
  if (region === "global") return "https://aiplatform.googleapis.com";
  if (region === "us") return "https://aiplatform.us.rep.googleapis.com";
  if (region === "eu") return "https://aiplatform.eu.rep.googleapis.com";
  return `https://${region}-aiplatform.googleapis.com`;
}

/**
 * pi's catalog ids are Anthropic-API ids; Vertex names dated models with `@`
 * (`claude-haiku-4-5-20251001` -> `claude-haiku-4-5@20251001`). Undated ids — including
 * `claude-fable-5-1`, whose trailing `-1` is a version, not a date — pass through unchanged.
 *
 * This is applied to the URL only. `Model.id` stays pi's id, so fullsend's alias table and any
 * `--model anthropic-vertex/...` a user has typed keep working.
 */
export function vertexModelId(id: string): string {
  return id.replace(/-(\d{8})$/, "@$1");
}

/**
 * The compat keys that survive the trip to Vertex. An **allowlist**, not a blocklist: a new pi
 * release that adds a compat key adds a new request field, and an unknown field is a 400 from
 * Vertex — so the default for anything new must be "dropped until someone has tried it".
 *
 * Every key here is a plain capability flag that changes how pi shapes a request it was already
 * going to send. Deliberately absent:
 *
 *   - `allowedFallbackModels` — pi turns it into a `fallbacks` request field, which Vertex rejects
 *     with 400 `fallbacks: Extra inputs are not permitted`. It broke `claude-opus-5` on pi 0.84.x
 *     (twoGiants/pi-anthropic-vertex#27), and pi 0.85.0 still sets it on `claude-fable-5`.
 *   - `supportsMidConvoEffort` — pi 0.85.0 sends the `mid-conversation-output-config` and
 *     `thinking-binding-controls-2026-08-01` betas plus `output_config` / `block_binding` fields.
 *     Unverified on Vertex, and the key does not exist at all in pi 0.84.4.
 *   - `sendSessionAffinityHeaders` — a Fireworks cache-routing header; meaningless here.
 *   - `sessionAffinityFormat` — picks the name of that same header (pi 0.87); meaningless here.
 *   - `supportsMidConvoSystemMessages` — pi 0.87 sends later system messages as system-role messages
 *     inside `messages` instead of folding them into the top-level system prompt. Unverified on
 *     Vertex.
 *   - `supportsMidConvoToolChanges` — pi 0.87 sends the `mid-conversation-tool-changes-2026-07-01`
 *     beta, `tool_addition` / `tool_removal` blocks and `defer_loading` tools. Unverified on Vertex,
 *     and it requires `supportsMidConvoSystemMessages`.
 *
 * `supportsToolReferences` was forwarded until pi 0.87 removed it from the compat type.
 */
export const VERTEX_COMPAT_KEYS = [
  "forceAdaptiveThinking",
  "supportsStrictTools",
  "supportsTemperature",
  "supportsEagerToolInputStreaming",
  "supportsLongCacheRetention",
  "supportsCacheControlOnTools",
  "allowEmptySignature",
] as const satisfies readonly (keyof AnthropicMessagesCompat)[];

/** The compat keys deliberately NOT forwarded (reasons above). */
export const VERTEX_COMPAT_DROPPED = [
  "allowedFallbackModels", // becomes a `fallbacks` field; Vertex answers 400
  "supportsMidConvoEffort", // mid-conversation-output-config betas; unverified on Vertex
  "sendSessionAffinityHeaders", // Fireworks cache-routing header; meaningless on Vertex
  "sessionAffinityFormat", // names that same header; meaningless on Vertex
  "supportsMidConvoSystemMessages", // system-role messages inside `messages`; unverified on Vertex
  "supportsMidConvoToolChanges", // tool_addition/tool_removal blocks and their beta; unverified on Vertex
] as const satisfies readonly (keyof AnthropicMessagesCompat)[];

/**
 * Exhaustiveness witness. `satisfies (keyof T)[]` only checks that every listed key exists — it
 * says nothing about keys that are *not* listed, so a compat key pi adds in a future release would
 * be silently dropped by the allowlist and no test would notice. This type is `never` exactly when
 * every key of pi's `AnthropicMessagesCompat` appears in VERTEX_COMPAT_KEYS or
 * VERTEX_COMPAT_DROPPED; otherwise the assignment below fails to compile and names the key.
 *
 * When `npm run lint` fails here after a pi bump: pi added a compat key. Decide whether Vertex
 * accepts what it makes pi send (try it), then add the key to one of the two lists.
 */
type VertexCompatUnhandled = Exclude<
  keyof AnthropicMessagesCompat,
  (typeof VERTEX_COMPAT_KEYS)[number] | (typeof VERTEX_COMPAT_DROPPED)[number]
>;
const vertexCompatIsExhaustive: [VertexCompatUnhandled] extends [never] ? true : VertexCompatUnhandled = true;
void vertexCompatIsExhaustive;

function toVertexCompat(compat: AnthropicMessagesCompat | undefined): AnthropicMessagesCompat {
  const filtered: AnthropicMessagesCompat = {};
  if (!compat) return filtered;
  for (const key of VERTEX_COMPAT_KEYS) {
    const value = compat[key];
    if (value !== undefined) filtered[key] = value;
  }
  return filtered;
}

/**
 * One of pi's own first-party Anthropic models, re-pointed at Vertex.
 *
 * Everything that describes the *model* — pricing, context window, thinking levels — is copied
 * verbatim from pi's catalog, so a pi bump keeps this catalog current for free and cost reporting
 * matches the direct-Anthropic path exactly. Only the routing fields and the compat allowlist
 * differ.
 */
export function toVertexModel(
  model: Model<"anthropic-messages">,
  region: string,
): Model<"anthropic-messages"> {
  return {
    id: model.id,
    name: model.name,
    api: "anthropic-messages",
    provider: PROVIDER_ID,
    baseUrl: buildBaseUrl(region),
    reasoning: model.reasoning,
    input: [...model.input],
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    compat: toVertexCompat(model.compat),
  };
}

/** Where a rewritten request is going. */
export interface VertexTarget {
  project: string;
  region: string;
}

/** A request on its way to Vertex, in the shape the rewrite needs and tests can build by hand. */
export interface VertexRequestInput {
  url: string;
  method: string;
  headers?: HeadersInit;
  body?: string;
}

export interface VertexRequestOutput {
  url: string;
  method: string;
  headers: Headers;
  body?: string;
}

/** The Anthropic Messages endpoint, relative to whatever prefix the base URL contributed. */
const MESSAGES_PATH_SUFFIX = "/v1/messages";

function parseMessagesBody(body: string | undefined): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = body === undefined ? undefined : JSON.parse(body);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `[${PROVIDER_ID}] POST ${MESSAGES_PATH_SUFFIX} without a JSON object body; cannot build the Vertex model path.`,
    );
  }
  return parsed as Record<string, unknown>;
}

/**
 * The whole Vertex adaptation, as a pure function so it can be tested without a fetch. Returns a
 * new request; the input is not mutated.
 */
export function rewriteVertexRequest(
  request: VertexRequestInput,
  { project, region }: VertexTarget,
): VertexRequestOutput {
  const headers = new Headers(request.headers);

  // pi hands the Google access token to the transport as an API key, because that is the only
  // credential channel `auth.apiKey` has; the SDK then sends it as `x-api-key`. Vertex wants a
  // bearer token. A request carrying no `x-api-key` (a caller-owned `authorization`, say) is left
  // alone.
  const apiKey = headers.get("x-api-key");
  if (apiKey) {
    headers.delete("x-api-key");
    headers.set("authorization", `Bearer ${apiKey}`);
  }

  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const isMessagesPost = method === "POST" && url.pathname.endsWith(MESSAGES_PATH_SUFFIX);
  if (!isMessagesPost) {
    return {
      url: url.toString(),
      method: request.method,
      headers,
      ...(request.body === undefined ? {} : { body: request.body }),
    };
  }

  const payload = parseMessagesBody(request.body);
  const modelId = payload.model;
  if (typeof modelId !== "string" || modelId.length === 0) {
    throw new Error(
      `[${PROVIDER_ID}] request body has no \`model\`; Vertex takes the model in the URL, so there is nothing to route.`,
    );
  }
  // `model` moves into the path. `anthropic_version` replaces the `anthropic-version` header,
  // which Vertex does not read — but never clobber a caller that already set it.
  const { model: _routedInPath, ...rest } = payload;
  const body: Record<string, unknown> = {
    ...rest,
    anthropic_version: rest.anthropic_version ?? ANTHROPIC_VERSION,
  };

  const specifier = payload.stream === true ? "streamRawPredict" : "rawPredict";
  const prefix = url.pathname.slice(0, url.pathname.length - MESSAGES_PATH_SUFFIX.length);
  url.pathname = `${prefix}/v1/projects/${project}/locations/${region}/publishers/anthropic/models/${vertexModelId(modelId)}:${specifier}`;
  // pi 0.85.0's `client.beta.messages.create()` posts to `/v1/messages?beta=true`. The betas
  // themselves are already in the `anthropic-beta` header by this point (the SDK lifts them out of
  // the body), and Vertex has no `beta` query parameter, so only the parameter is dropped.
  url.searchParams.delete("beta");

  // The body length changed. Nothing on pi's path sets content-length, but a caller-supplied one
  // would now be wrong, and a wrong content-length truncates the request.
  headers.delete("content-length");

  return { url: url.toString(), method, headers, body: JSON.stringify(body) };
}

// ## Strict tools refused by organization policy
//
// pi sends `"strict": true` on a tool definition when the tool asks for JSON-schema constrained
// sampling and the model's compat has `supportsStrictTools` (pi-ai `convertTools`). From pi 0.86.0
// the built-in `read`, `bash`, `edit` and `write` tools always ask, with `strict: "prefer"`, so
// nearly every agent turn carries strict tools. Vertex counts strict tool use as the
// `structured_outputs` partner-model feature, and a Google Cloud organization policy
// (`constraints/vertexai.allowedPartnerModelFeatures`) can disallow it per model. The refusal is a
// 400 before any output streams, naming the constraint and the feature.
//
// `strict: "prefer"` means pi itself would send the tool without `strict` on a model that lacks
// support, so the fetch below does the same thing one step later: on that exact refusal it drops
// `strict` from every tool and resends once, then keeps dropping it for that model for as long as
// the provider is loaded (in pi, the rest of the process). Models the policy allows keep strict tools, and nothing changes once the policy
// does. A tool declared with `strict: "require"` cannot be told apart on the wire; pi's built-in
// tools never use it.

/** The organization-policy constraint Vertex names when it refuses a partner-model feature. */
export const PARTNER_FEATURE_POLICY_CONSTRAINT = "constraints/vertexai.allowedPartnerModelFeatures";

/** The partner-model feature that strict tool use counts as. */
export const STRUCTURED_OUTPUTS_FEATURE = "structured_outputs";

/**
 * True when a Vertex response body is the organization-policy refusal of strict tool use: a 400
 * naming the constraint and, as the disallowed feature itself, `structured_outputs`. A refusal of
 * another feature that merely mentions `structured_outputs` elsewhere does not match.
 */
export function isStructuredOutputsPolicyRefusal(status: number, body: string): boolean {
  return (
    status === 400 &&
    body.includes(PARTNER_FEATURE_POLICY_CONSTRAINT) &&
    new RegExp(`disallowed feature ${STRUCTURED_OUTPUTS_FEATURE}\\b`).test(body)
  );
}

/**
 * The request body with `strict` removed from every tool, or `undefined` when no tool carried
 * `strict: true` — in which case a refusal cannot be about tools and resending would not help.
 */
export function withoutStrictTools(body: string): string | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const { tools } = payload as { tools?: unknown };
  if (!Array.isArray(tools)) return undefined;
  let stripped = false;
  const nextTools = tools.map((tool: unknown) => {
    if (typeof tool !== "object" || tool === null || (tool as { strict?: unknown }).strict !== true) return tool;
    stripped = true;
    const { strict: _strict, ...rest } = tool as Record<string, unknown>;
    return rest;
  });
  return stripped ? JSON.stringify({ ...payload, tools: nextTools }) : undefined;
}

/** The Vertex model segment of a rewritten Messages URL (`claude-sonnet-4-6`, `claude-haiku-4-5@20251001`). */
function vertexModelFromUrl(url: string): string | undefined {
  return /\/publishers\/anthropic\/models\/([^/:]+):/.exec(new URL(url).pathname)?.[1];
}

/** Models whose strict tools were refused, shared by every fetch one provider builds. */
export type StrictToolsRefusals = Set<string>;

function warnStrictToolsRefused(model: string): void {
  console.warn(
    `[${PROVIDER_ID}] ${model}: Vertex refused strict tool use (${STRUCTURED_OUTPUTS_FEATURE}) by organization policy ` +
      `${PARTNER_FEATURE_POLICY_CONSTRAINT}; retrying without strict, and sending this model's tools without strict from now on.`,
  );
}

/**
 * A `fetch` that applies {@link rewriteVertexRequest} and then delegates.
 *
 * `baseFetch` is resolved lazily, per call: `globalThis.fetch` is routinely replaced after module
 * load (proxy agents, test doubles, pi's own instrumentation), and capturing it at creation time
 * would pin whatever happened to be installed when the extension loaded.
 *
 * The input is normalised through `new Request(input, init)` because the two callers disagree
 * about shape: the Anthropic SDK inside pi passes a URL string with a `Headers` instance and a
 * serialised string body, while direct callers (and tests) pass plain records. The original `init`
 * is spread back into the outgoing call so transport-level options the rewrite has no opinion
 * about — `duplex`, an undici `dispatcher`, `keepalive` — survive.
 *
 * `strictToolsRefused` remembers models whose strict tools Vertex refused by policy (see "Strict
 * tools refused by organization policy" above); pass one set per provider so the fallback costs
 * one extra round trip per model, not one per request.
 */
export function createVertexFetch({
  project,
  region,
  baseFetch,
  strictToolsRefused = new Set(),
  onStrictToolsRefused = warnStrictToolsRefused,
}: VertexTarget & {
  baseFetch?: FetchFunction;
  strictToolsRefused?: StrictToolsRefusals;
  onStrictToolsRefused?: (model: string) => void;
}): FetchFunction {
  return async (input, init) => {
    const transport = baseFetch ?? globalThis.fetch;
    const request = new Request(input, init);
    const needsBody =
      request.method.toUpperCase() === "POST" &&
      new URL(request.url).pathname.endsWith(MESSAGES_PATH_SUFFIX);
    const rewritten = rewriteVertexRequest(
      {
        url: request.url,
        method: request.method,
        headers: request.headers,
        ...(needsBody ? { body: await request.text() } : {}),
      },
      { project, region },
    );
    const send = (body: string | undefined) =>
      transport(rewritten.url, {
        ...init,
        method: rewritten.method,
        headers: rewritten.headers,
        signal: request.signal,
        ...(body === undefined ? {} : { body }),
      });

    const model = needsBody ? vertexModelFromUrl(rewritten.url) : undefined;
    if (model === undefined || rewritten.body === undefined) return send(rewritten.body);
    if (strictToolsRefused.has(model)) return send(withoutStrictTools(rewritten.body) ?? rewritten.body);

    const response = await send(rewritten.body);
    if (response.status !== 400) return response;
    const fallback = withoutStrictTools(rewritten.body);
    if (fallback === undefined) return response;
    // Read a copy, so the caller still gets an unread body when this is some other 400.
    if (!isStructuredOutputsPolicyRefusal(response.status, await response.clone().text())) return response;
    // Turns already in flight for this model can each hit the refusal before any of them records
    // it; each still resends, but only the first reports.
    if (!strictToolsRefused.has(model)) {
      strictToolsRefused.add(model);
      onStrictToolsRefused(model);
    }
    return send(fallback);
  };
}

/**
 * pi's Anthropic transport, with every request routed through the Vertex rewrite.
 *
 * The Vertex fetch is built per call rather than once, so a caller-supplied `options.fetch` can be
 * composed *underneath* it: the caller's fetch stays the transport that actually dials, and the
 * rewrite runs first. pi does exactly this — `Provider.stream()` forwards the options it was given
 * — and it is what makes the extension testable without a network.
 *
 * `lazyApi()` returns a plain object, so the spread carries optional members (`fetchDeferred`,
 * `cancelDeferred`) that a future pi release may add.
 */
export function withVertexFetch(base: ProviderStreams, target: VertexTarget): ProviderStreams {
  const strictToolsRefused: StrictToolsRefusals = new Set();
  return {
    ...base,
    stream: (model, context, options) =>
      base.stream(model, context, {
        ...options,
        fetch: createVertexFetch({ ...target, baseFetch: options?.fetch, strictToolsRefused }),
      }),
    streamSimple: (model, context, options) =>
      base.streamSimple(model, context, {
        ...options,
        fetch: createVertexFetch({ ...target, baseFetch: options?.fetch, strictToolsRefused }),
      }),
  };
}

/**
 * Turn what google-auth-library returned into pi's request auth. Vertex takes the access token as
 * a bearer token, which pi carries as the `apiKey` and the rewrite moves into `authorization`.
 */
export function authResultFrom(token: string | null | undefined): AuthResult {
  if (!token) {
    throw new Error(
      `${PROVIDER_ID}: Google ADC returned no access token. Run \`gcloud auth application-default login\`, ` +
        "or point GOOGLE_APPLICATION_CREDENTIALS at a credential config.",
    );
  }
  return { auth: { apiKey: token }, source: "Google ADC" };
}

// One GoogleAuth per process: it caches the resolved client and the underlying credential, so
// repeated getAccessToken() calls only hit the network once the token has actually aged out.
let auth: GoogleAuth | undefined;

function googleAuth(): GoogleAuth {
  auth ??= new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  return auth;
}

async function mintAccessToken(): Promise<string | null | undefined> {
  const client = await googleAuth().getClient();
  const { token } = await client.getAccessToken();
  return token;
}

/**
 * Whether ADC can be discovered at all, without minting a token.
 *
 * pi's `AuthCheck` can only say available/unavailable — there is no field for a reason — so an
 * unavailable provider otherwise surfaces as a bare "model not found", with nothing pointing at
 * the credentials. The discovery failure is written to stderr before returning false; pi captures
 * extension stderr (fullsend tees it to pi-debug.log), and this only fires when ADC is genuinely
 * broken.
 *
 * Warned once per process: pi calls check() for each model-availability query, and repeating an
 * identical multi-line credential error turns a useful hint into noise.
 */
let warnedAdcUnavailable = false;

async function hasAdcCredentials(): Promise<boolean> {
  try {
    await googleAuth().getClient();
    return true;
  } catch (error) {
    if (!warnedAdcUnavailable) {
      warnedAdcUnavailable = true;
      const reason = error instanceof Error ? error.message : String(error);
      console.error(
        `[${PROVIDER_ID}] Google ADC unavailable, so the provider will not be offered: ${reason}. ` +
          "Run `gcloud auth application-default login`, or point GOOGLE_APPLICATION_CREDENTIALS at a credential config.",
      );
    }
    return false;
  }
}

/**
 * The provider config pi registers. Built separately from the extension entry point so it can be
 * asserted without a live pi — every field is required by pi's model resolution, and omitting any
 * one of them throws inside that resolution, which iterates *all* registered providers.
 *
 * `models` defaults to pi's own first-party Anthropic catalog. `getBuiltinModels("anthropic")` is a
 * static read of generated metadata: it needs no `ANTHROPIC_API_KEY`, makes no request, and is
 * injectable here so a test can pin a catalog.
 */
export function anthropicVertexProviderConfig(
  project: string,
  region: string,
  models: readonly Model<"anthropic-messages">[] = getBuiltinModels("anthropic"),
) {
  const baseUrl = buildBaseUrl(region);
  return {
    id: PROVIDER_ID,
    name: "Anthropic Claude (Vertex)",
    baseUrl,
    auth: {
      // Ambient-only auth: no `login`, because there is nothing interactive to do — the credential
      // is Application Default Credentials, discovered from the environment. pi's ApiKeyAuth
      // documents an absent `login` as exactly this ("Absent = ambient-only") and calls `resolve`
      // per request, so google-auth-library's own caching and renewal stay in charge of expiry.
      apiKey: {
        name: "Google Cloud ADC (Anthropic Vertex)",
        async check() {
          // Side-effect-free relative to resolve(), which performs request-time credential
          // discovery — so pi asks this first to decide whether the models are available. (Note
          // this can still touch the network: with no other ADC source configured,
          // google-auth-library probes the GCE metadata server.)
          return (await hasAdcCredentials())
            ? { type: "api_key" as const, source: "Google ADC" }
            : undefined;
        },
        async resolve() {
          return authResultFrom(await mintAccessToken());
        },
      },
    },
    models: models.map((model) => toVertexModel(model, region)),
    api: withVertexFetch(anthropicMessagesApi(), { project, region }),
  };
}

/**
 * The one thing this extension asks of pi. `ExtensionAPI.registerProvider` is overloaded — it also
 * accepts `(name, config)` — and an overloaded method is not satisfiable by a test double without
 * a cast, so the seam below takes this single-signature view instead. The default export still
 * passes a real `ExtensionAPI` to it, which is what keeps the two in step at compile time.
 */
export interface ProviderRegistry {
  registerProvider(provider: Provider): void;
}

/**
 * Everything the extension entry point does, with its two ambient inputs — the registry and the
 * environment — passed in, so the disabled path can be asserted without a live pi. Returns whether
 * a provider was registered.
 */
export function registerAnthropicVertex(
  pi: ProviderRegistry,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const project = resolveProject(env);
  if (!project) {
    // Registering a provider that cannot build a URL would turn a missing env var into a confusing
    // per-request failure much later. Say what to set, once, and stay out of the model list.
    console.warn(DISABLED_MESSAGE);
    return false;
  }
  pi.registerProvider(createProvider(anthropicVertexProviderConfig(project, resolveRegion(env))));
  return true;
}

export default function (pi: ExtensionAPI) {
  registerAnthropicVertex(pi);
}
