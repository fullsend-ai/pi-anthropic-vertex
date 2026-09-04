import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calculateCost, createProvider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { Context, FetchFunction, Model, Provider, Usage } from "@earendil-works/pi-ai";
import {
  ANTHROPIC_VERSION,
  DEFAULT_REGION,
  DISABLED_MESSAGE,
  PROJECT_ENV_VARS,
  PROVIDER_ID,
  REGION_ENV_VARS,
  VERTEX_COMPAT_KEYS,
  anthropicVertexProviderConfig,
  authResultFrom,
  buildBaseUrl,
  registerAnthropicVertex,
  resolveProject,
  resolveRegion,
  rewriteVertexRequest,
  toVertexModel,
  vertexModelId,
  withVertexFetch,
} from "./index.ts";

const TARGET = { project: "proj", region: "us-east5" };

describe("resolveProject", () => {
  it("documents its precedence order in one place", () => {
    // Verbatim parity with twoGiants/pi-anthropic-vertex v0.1.13 and fullsend's
    // internal/runtime/pi.go. A reorder here silently changes which project a deployment bills.
    assert.deepEqual(PROJECT_ENV_VARS, [
      "GOOGLE_CLOUD_PROJECT",
      "GCLOUD_PROJECT",
      "ANTHROPIC_VERTEX_PROJECT_ID",
      "GOOGLE_CLOUD_PROJECT_ID",
    ]);
  });

  it("falls back through the chain in order", () => {
    assert.equal(
      resolveProject({
        GOOGLE_CLOUD_PROJECT: "ambient",
        GCLOUD_PROJECT: "gcloud",
        ANTHROPIC_VERTEX_PROJECT_ID: "claude",
        GOOGLE_CLOUD_PROJECT_ID: "suffixed",
      }),
      "ambient",
    );
    assert.equal(
      resolveProject({ GCLOUD_PROJECT: "gcloud", ANTHROPIC_VERTEX_PROJECT_ID: "claude" }),
      "gcloud",
    );
    assert.equal(
      resolveProject({ ANTHROPIC_VERTEX_PROJECT_ID: "claude", GOOGLE_CLOUD_PROJECT_ID: "suffixed" }),
      "claude",
    );
    assert.equal(resolveProject({ GOOGLE_CLOUD_PROJECT_ID: "suffixed" }), "suffixed");
  });

  it("returns undefined when nothing is set, so the extension can print the disabled message", () => {
    assert.equal(resolveProject({}), undefined);
  });

  it("treats blank and whitespace-only values as unset, and trims the rest", () => {
    assert.equal(resolveProject({ GOOGLE_CLOUD_PROJECT: "   ", GCLOUD_PROJECT: "real" }), "real");
    assert.equal(resolveProject({ GOOGLE_CLOUD_PROJECT: "" }), undefined);
    assert.equal(resolveProject({ GOOGLE_CLOUD_PROJECT: " padded \n" }), "padded");
  });

  it("reads no other ANTHROPIC_* variable", () => {
    // fullsend unsets ANTHROPIC_* before launching pi; that must stay belt-and-braces rather than
    // load-bearing. ANTHROPIC_VERTEX_PROJECT_ID is the single exception, asserted above.
    assert.equal(
      resolveProject({ ANTHROPIC_API_KEY: "sk-ant-oops", ANTHROPIC_VERTEX_BASE_URL: "https://nope" }),
      undefined,
    );
  });
});

describe("resolveRegion", () => {
  it("documents its precedence order in one place", () => {
    assert.deepEqual(REGION_ENV_VARS, ["CLOUD_ML_REGION", "GOOGLE_CLOUD_LOCATION"]);
  });

  it("prefers CLOUD_ML_REGION, then GOOGLE_CLOUD_LOCATION", () => {
    assert.equal(resolveRegion({ CLOUD_ML_REGION: "europe-west1", GOOGLE_CLOUD_LOCATION: "us-east5" }), "europe-west1");
    assert.equal(resolveRegion({ GOOGLE_CLOUD_LOCATION: "us-central1" }), "us-central1");
  });

  it("defaults to us-east5, where Claude is served", () => {
    assert.equal(resolveRegion({}), DEFAULT_REGION);
    assert.equal(DEFAULT_REGION, "us-east5");
  });

  it("treats blank values as unset, and trims the rest", () => {
    assert.equal(resolveRegion({ CLOUD_ML_REGION: "  " }), DEFAULT_REGION);
    assert.equal(resolveRegion({ CLOUD_ML_REGION: " us-east5 \n" }), "us-east5");
  });
});

describe("buildBaseUrl", () => {
  it("maps the endpoint families Vertex actually has", () => {
    assert.equal(buildBaseUrl("global"), "https://aiplatform.googleapis.com");
    assert.equal(buildBaseUrl("us"), "https://aiplatform.us.rep.googleapis.com");
    assert.equal(buildBaseUrl("eu"), "https://aiplatform.eu.rep.googleapis.com");
    assert.equal(buildBaseUrl("us-east5"), "https://us-east5-aiplatform.googleapis.com");
  });

  it("carries no /v1 suffix — the Anthropic SDK appends /v1/messages itself", () => {
    // With a /v1 here the SDK would POST /v1/v1/messages, and the rewrite (which anchors on a
    // trailing /v1/messages) would happily build /v1/v1/projects/... and 404 on Vertex.
    for (const region of ["global", "us", "eu", "us-east5"]) {
      assert.ok(!buildBaseUrl(region).includes("/v1"), `${region} must not end in /v1`);
      assert.equal(new URL(buildBaseUrl(region)).pathname, "/");
    }
  });
});

describe("vertexModelId", () => {
  it("rewrites a trailing date to Vertex's @ form", () => {
    assert.equal(vertexModelId("claude-haiku-4-5-20251001"), "claude-haiku-4-5@20251001");
    assert.equal(vertexModelId("claude-sonnet-4-5-20250929"), "claude-sonnet-4-5@20250929");
  });

  it("leaves undated ids alone", () => {
    for (const id of ["claude-opus-4-6", "claude-sonnet-4-6", "claude-opus-5"]) {
      assert.equal(vertexModelId(id), id);
    }
  });

  it("does not mistake a version suffix for a date", () => {
    // The trailing -1 of claude-fable-5-1 is a point release, not 1 October.
    assert.equal(vertexModelId("claude-fable-5-1"), "claude-fable-5-1");
    assert.equal(vertexModelId("claude-fable-5"), "claude-fable-5");
  });

  it("only rewrites at the end of the id", () => {
    assert.equal(vertexModelId("claude-20251001-preview"), "claude-20251001-preview");
  });
});

describe("rewriteVertexRequest", () => {
  const streamingRequest = () => ({
    url: "https://us-east5-aiplatform.googleapis.com/v1/messages?beta=true",
    method: "POST",
    headers: { "x-api-key": "tok", "anthropic-beta": "x" },
    body: JSON.stringify({ model: "claude-haiku-4-5-20251001", stream: true, messages: [] }),
  });

  it("routes a streaming request to the Vertex model path", () => {
    const out = rewriteVertexRequest(streamingRequest(), TARGET);
    assert.equal(
      out.url,
      "https://us-east5-aiplatform.googleapis.com/v1/projects/proj/locations/us-east5/publishers/anthropic/models/claude-haiku-4-5@20251001:streamRawPredict",
    );
  });

  it("drops the beta query parameter pi 0.85.0 adds, and keeps the anthropic-beta header", () => {
    const out = rewriteVertexRequest(streamingRequest(), TARGET);
    assert.equal(new URL(out.url).searchParams.has("beta"), false);
    assert.equal(new URL(out.url).search, "");
    assert.equal(out.headers.get("anthropic-beta"), "x");
  });

  it("moves the token from x-api-key to a bearer authorization header", () => {
    const out = rewriteVertexRequest(streamingRequest(), TARGET);
    assert.equal(out.headers.get("authorization"), "Bearer tok");
    assert.equal(out.headers.has("x-api-key"), false);
  });

  it("moves the model out of the body and stamps the Vertex API version", () => {
    const out = rewriteVertexRequest(streamingRequest(), TARGET);
    const body = JSON.parse(out.body ?? "");
    assert.equal("model" in body, false, "Vertex rejects a model field; it lives in the path");
    assert.equal(body.anthropic_version, ANTHROPIC_VERSION);
    assert.equal(body.anthropic_version, "vertex-2023-10-16");
    assert.deepEqual(body.messages, []);
    assert.equal(body.stream, true);
  });

  it("keeps an anthropic_version the caller already set", () => {
    const out = rewriteVertexRequest(
      {
        ...streamingRequest(),
        body: JSON.stringify({ model: "claude-opus-4-6", stream: true, anthropic_version: "vertex-2099-01-01" }),
      },
      TARGET,
    );
    assert.equal(JSON.parse(out.body ?? "").anthropic_version, "vertex-2099-01-01");
  });

  it("uses rawPredict for a non-streaming request", () => {
    const out = rewriteVertexRequest(
      {
        url: "https://us-east5-aiplatform.googleapis.com/v1/messages",
        method: "POST",
        headers: { "x-api-key": "tok" },
        body: JSON.stringify({ model: "claude-opus-4-6", messages: [] }),
      },
      TARGET,
    );
    assert.ok(out.url.endsWith("/models/claude-opus-4-6:rawPredict"), out.url);
  });

  it("threads the project and region through the path", () => {
    const out = rewriteVertexRequest(streamingRequest(), { project: "other-proj", region: "europe-west1" });
    assert.ok(out.url.includes("/projects/other-proj/locations/europe-west1/"), out.url);
  });

  it("preserves whatever prefix the base URL contributed", () => {
    const out = rewriteVertexRequest(
      {
        url: "https://proxy.internal/anthropic/v1/messages",
        method: "POST",
        headers: { "x-api-key": "tok" },
        body: JSON.stringify({ model: "claude-opus-4-6", stream: true }),
      },
      TARGET,
    );
    assert.ok(out.url.startsWith("https://proxy.internal/anthropic/v1/projects/proj/"), out.url);
  });

  it("passes another path through with the auth swap only", () => {
    const out = rewriteVertexRequest(
      {
        url: "https://us-east5-aiplatform.googleapis.com/v1/messages/count_tokens",
        method: "POST",
        headers: { "x-api-key": "tok" },
        body: JSON.stringify({ model: "claude-opus-4-6" }),
      },
      TARGET,
    );
    assert.equal(out.url, "https://us-east5-aiplatform.googleapis.com/v1/messages/count_tokens");
    assert.equal(out.headers.get("authorization"), "Bearer tok");
    assert.equal(JSON.parse(out.body ?? "").model, "claude-opus-4-6", "body is untouched off the messages path");
  });

  it("passes a GET through with the auth swap only", () => {
    const out = rewriteVertexRequest(
      { url: "https://us-east5-aiplatform.googleapis.com/v1/messages", method: "GET", headers: { "x-api-key": "tok" } },
      TARGET,
    );
    assert.equal(out.url, "https://us-east5-aiplatform.googleapis.com/v1/messages");
    assert.equal(out.method, "GET");
    assert.equal(out.headers.get("authorization"), "Bearer tok");
    assert.equal(out.body, undefined);
  });

  it("leaves a caller-owned authorization header alone when there is no x-api-key", () => {
    const out = rewriteVertexRequest(
      {
        url: "https://us-east5-aiplatform.googleapis.com/v1/messages",
        method: "POST",
        headers: { authorization: "Bearer caller-owned" },
        body: JSON.stringify({ model: "claude-opus-4-6", stream: true }),
      },
      TARGET,
    );
    assert.equal(out.headers.get("authorization"), "Bearer caller-owned");
  });

  it("accepts a Headers instance as well as a plain record", () => {
    // The Anthropic SDK inside pi passes a Headers; tests and direct callers pass records.
    const out = rewriteVertexRequest(
      { ...streamingRequest(), headers: new Headers({ "x-api-key": "tok", "anthropic-beta": "x" }) },
      TARGET,
    );
    assert.equal(out.headers.get("authorization"), "Bearer tok");
    assert.equal(out.headers.get("anthropic-beta"), "x");
  });

  it("drops a stale content-length, which the rewritten body would invalidate", () => {
    const out = rewriteVertexRequest(
      { ...streamingRequest(), headers: { "x-api-key": "tok", "content-length": "999" } },
      TARGET,
    );
    assert.equal(out.headers.has("content-length"), false);
  });

  it("does not mutate the request it was given", () => {
    const request = streamingRequest();
    const before = JSON.stringify(request);
    rewriteVertexRequest(request, TARGET);
    assert.equal(JSON.stringify(request), before);
  });

  it("fails loudly rather than sending a request Vertex cannot route", () => {
    // Silently passing through would produce a 404 from Vertex with nothing naming the cause.
    const base = { url: "https://us-east5-aiplatform.googleapis.com/v1/messages", method: "POST" };
    assert.throws(() => rewriteVertexRequest(base, TARGET), /JSON object body/);
    assert.throws(() => rewriteVertexRequest({ ...base, body: "not json" }, TARGET), /JSON object body/);
    assert.throws(() => rewriteVertexRequest({ ...base, body: "[]" }, TARGET), /JSON object body/);
    assert.throws(() => rewriteVertexRequest({ ...base, body: "{}" }, TARGET), /no `model`/);
    assert.throws(() => rewriteVertexRequest({ ...base, body: '{"model":""}' }, TARGET), /no `model`/);
  });
});

describe("toVertexModel", () => {
  // Run against pi's REAL catalog: the point is that this keeps working across a pi bump, and a
  // hand-written fixture would keep passing while the catalog moved underneath it.
  const catalog = getBuiltinModels("anthropic");
  const mapped = catalog.map((model) => toVertexModel(model, "us-east5"));

  it("finds pi's first-party Anthropic catalog without an API key", () => {
    assert.ok(catalog.length > 0, "getBuiltinModels('anthropic') is a static read and must not be empty");
  });

  it("re-points every model at this provider and this endpoint", () => {
    for (const model of mapped) {
      assert.equal(model.provider, PROVIDER_ID);
      assert.equal(model.api, "anthropic-messages");
      assert.equal(model.baseUrl, buildBaseUrl("us-east5"));
    }
  });

  it("keeps pi's ids, so specs and alias tables do not have to change", () => {
    assert.deepEqual(
      mapped.map((model) => model.id),
      catalog.map((model) => model.id),
    );
  });

  it("copies the model metadata verbatim", () => {
    for (const [index, model] of mapped.entries()) {
      const source = catalog[index];
      assert.equal(model.name, source.name);
      assert.equal(model.reasoning, source.reasoning);
      assert.equal(model.contextWindow, source.contextWindow);
      assert.equal(model.maxTokens, source.maxTokens);
      assert.deepEqual(model.input, source.input);
      assert.deepEqual(model.cost, source.cost);
      assert.deepEqual(model.thinkingLevelMap, source.thinkingLevelMap);
    }
  });

  it("passes compat through an allowlist, never a blocklist", () => {
    // A new pi release that adds a compat key adds a request field, and an unknown request field
    // is a 400 from Vertex. Anything not named here must be dropped by construction.
    for (const model of mapped) {
      for (const key of Object.keys(model.compat ?? {})) {
        assert.ok(
          (VERTEX_COMPAT_KEYS as readonly string[]).includes(key),
          `${model.id}: compat.${key} reached Vertex without being vetted`,
        );
      }
    }
  });

  it("drops allowedFallbackModels, which Vertex rejects with a 400", () => {
    // pi turns it into a `fallbacks` request field: "fallbacks: Extra inputs are not permitted".
    assert.ok(
      catalog.some((model) => (model.compat?.allowedFallbackModels?.length ?? 0) > 0),
      "pi's catalog no longer sets allowedFallbackModels anywhere — re-check whether this filter is still needed",
    );
    for (const model of mapped) {
      assert.equal("allowedFallbackModels" in (model.compat ?? {}), false, model.id);
    }
  });

  it("drops the mid-conversation-effort betas, which are unverified on Vertex", () => {
    for (const model of mapped) {
      assert.equal("supportsMidConvoEffort" in (model.compat ?? {}), false, model.id);
    }
  });

  it("keeps the flags that only change how pi shapes a request it already sends", () => {
    const opus46 = mapped.find((model) => model.id === "claude-opus-4-6");
    assert.ok(opus46, "claude-opus-4-6 is expected in pi's catalog on both supported versions");
    assert.equal(opus46.compat?.forceAdaptiveThinking, true);
    assert.equal(opus46.compat?.supportsStrictTools, true);

    const opus5 = mapped.find((model) => model.id === "claude-opus-5");
    assert.ok(opus5, "claude-opus-5 is expected in pi's catalog on both supported versions");
    assert.equal(opus5.compat?.forceAdaptiveThinking, true);
    assert.equal(opus5.compat?.supportsTemperature, false, "false must survive; only undefined is dropped");
  });
});

describe("anthropicVertexProviderConfig", () => {
  const config = anthropicVertexProviderConfig("proj", "us-east5");

  it("registers under the provider id the docs and fullsend's runtime flags use", () => {
    assert.equal(config.id, PROVIDER_ID);
    assert.equal(PROVIDER_ID, "anthropic-vertex");
  });

  it("points the models at the same endpoint as the provider", () => {
    assert.equal(config.baseUrl, buildBaseUrl("us-east5"));
    for (const model of config.models) assert.equal(model.baseUrl, config.baseUrl);
  });

  it("threads the region through to the endpoint", () => {
    const european = anthropicVertexProviderConfig("proj", "europe-west1");
    assert.equal(european.baseUrl, "https://europe-west1-aiplatform.googleapis.com");
  });

  it("accepts an injected catalog, so a caller can pin the model list", () => {
    const [first] = getBuiltinModels("anthropic");
    assert.equal(anthropicVertexProviderConfig("proj", "us-east5", [first]).models.length, 1);
  });

  // Auth must be AMBIENT, not interactive. pi treats `auth.oauth` as "an interactive login mints a
  // credential I persist to auth.json", and refuses the provider until one exists — which passes
  // on a machine that logged in once and fails on every fresh one, sandboxes included, with
  // "No API key found for anthropic-vertex".
  it("uses ambient apiKey auth, never the interactive oauth flow", () => {
    assert.ok(config.auth.apiKey, "auth must be apiKey-shaped");
    assert.ok(!("oauth" in config.auth), "oauth would require an interactive login first");
  });

  it("declares no login handler, which is what marks it ambient-only", () => {
    assert.ok(
      !("login" in config.auth.apiKey) || config.auth.apiKey.login === undefined,
      "a login handler makes pi wait for an interactive credential",
    );
  });

  it("exposes resolve and a side-effect-free check", () => {
    assert.equal(typeof config.auth.apiKey.resolve, "function");
    assert.equal(typeof config.auth.apiKey.check, "function", "check lets pi test availability without minting");
  });

  it("does not pin a static key on the provider", () => {
    assert.ok(!("apiKey" in config), "a static top-level apiKey would defeat per-request token minting");
  });
});

describe("authResultFrom", () => {
  it("hands pi the access token as the request apiKey", () => {
    assert.deepEqual(authResultFrom("tok"), { auth: { apiKey: "tok" }, source: "Google ADC" });
  });

  it("labels the source so pi's status UI names ADC rather than a key", () => {
    assert.equal(authResultFrom("tok").source, "Google ADC");
  });

  it("throws an actionable error instead of returning an empty token", () => {
    for (const empty of [undefined, null, ""]) {
      assert.throws(() => authResultFrom(empty), /no access token/i);
    }
  });
});

describe("auth availability check", () => {
  const config = anthropicVertexProviderConfig("proj", "us-east5");

  it("reports availability when ADC resolves, without minting a token", async () => {
    // Whether this machine has ADC is not the test's business — either answer is valid. What is
    // not valid is an exception escaping into pi's model-availability path.
    const result = await config.auth.apiKey.check();
    if (result !== undefined) {
      assert.equal(result.type, "api_key");
      assert.equal(result.source, "Google ADC");
    }
  });

  it("never throws, so a broken credential cannot break model listing", async () => {
    await assert.doesNotReject(() => config.auth.apiKey.check());
  });
});

describe("createProvider integration", () => {
  // The assertions above check the config against *our* expectations. This one checks it against
  // pi's, by running it through the real createProvider from the installed peer — no network, no
  // credentials, no registration. It is the test that catches a pi release changing the provider
  // or model schema, which is the failure that takes down every registered provider at once. If
  // this breaks after a pi bump, the schema moved; read pi-ai/dist/*.d.ts, not the docs.
  it("is accepted by pi's own createProvider", () => {
    assert.doesNotThrow(() => createProvider(anthropicVertexProviderConfig("proj", "us-east5")));
  });

  it("round-trips the provider id and the whole model list through pi", () => {
    const provider = createProvider(anthropicVertexProviderConfig("proj", "us-east5"));
    assert.equal(provider.id, PROVIDER_ID);
    assert.equal(provider.name, "Anthropic Claude (Vertex)");
    const models = provider.getModels();
    assert.equal(models.length, getBuiltinModels("anthropic").length);
    assert.ok(models.some((model) => model.id === "claude-opus-4-6"));
    for (const model of models) assert.equal(model.provider, PROVIDER_ID);
  });
});

describe("cost through pi's own engine", () => {
  // Pricing is copied from pi's catalog rather than re-typed, so the guarantee worth testing is
  // that a Vertex model bills identically to the same model on the direct Anthropic path.
  const usage = (input: number, output = 0, cacheRead = 0, cacheWrite = 0): Usage => ({
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });

  it("bills exactly what the direct Anthropic model would", () => {
    for (const source of getBuiltinModels("anthropic")) {
      const vertex = toVertexModel(source, "us-east5");
      for (const sample of [usage(1_000, 100), usage(0, 0, 10_000), usage(250_000, 1_000, 10_000, 5_000)]) {
        assert.deepEqual(
          calculateCost(vertex, { ...sample }),
          calculateCost(source, { ...sample }),
          `${source.id} prices differently on Vertex`,
        );
      }
    }
  });

  it("charges something for a real request, so a zeroed cost table would be caught", () => {
    const opus = getBuiltinModels("anthropic").find((model) => model.id === "claude-opus-4-6");
    assert.ok(opus);
    assert.ok(calculateCost(toVertexModel(opus, "us-east5"), usage(1_000, 100)).total > 0);
  });
});

// --- End to end, through pi's real Anthropic transport -------------------------------------
//
// Everything above tests parts. This drives the provider pi's own `createProvider` built from
// `anthropicVertexProviderConfig`, with a mocked transport: pi builds the request, the Anthropic
// SDK inside pi serialises it, the Vertex fetch rewrites it, the mock answers with canned
// Anthropic SSE, and pi parses it back into an assistant message.
//
// It goes through the real provider — not through `withVertexFetch(...)` assembled here — on
// purpose: that is what makes it fail if `api:` is ever reverted to a bare
// `anthropicMessagesApi()`. The last case pins what that reverted behaviour looks like.

function sseResponse(): Response {
  const frames: Array<[string, unknown]> = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: "claude-haiku-4-5-20251001",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 7, output_tokens: 0 },
        },
      },
    ],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { input_tokens: 7, output_tokens: 2 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
  const body = frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  // A fresh Response per call: pi retries through retryProviderRequest, and a body that has
  // already been consumed fails in a way that looks nothing like its cause.
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function recorder(): { calls: RecordedRequest[]; fetch: FetchFunction } {
  const calls: RecordedRequest[] = [];
  const fetch: FetchFunction = async (input, init) => {
    const request = new Request(input, init);
    const text = await request.text();
    calls.push({
      url: request.url,
      method: request.method,
      headers: new Headers(request.headers),
      body: text ? JSON.parse(text) : {},
    });
    return sseResponse();
  };
  return { calls, fetch };
}

function vertexModel(id: string): Model<"anthropic-messages"> {
  const source = getBuiltinModels("anthropic").find((model) => model.id === id);
  assert.ok(source, `${id} is expected in pi's catalog`);
  return toVertexModel(source, "us-east5");
}

/** The provider exactly as the extension registers it, models included. */
function vertexProvider() {
  const provider = createProvider(anthropicVertexProviderConfig(TARGET.project, TARGET.region));
  const model = (id: string) => {
    const found = provider.getModels().find((entry) => entry.id === id);
    assert.ok(found, `${id} is expected in pi's catalog`);
    return found;
  };
  return { provider, model };
}

const CONTEXT: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

describe("end to end through pi's Anthropic transport", () => {
  it("rewrites the request pi actually builds and parses the response pi expects", async () => {
    const { calls, fetch } = recorder();
    const { provider, model } = vertexProvider();
    // apiKey is what pi's assertRequestAuth needs, and what the rewrite turns into a bearer token.
    const message = await provider
      .streamSimple(model("claude-haiku-4-5-20251001"), CONTEXT, { apiKey: "tok", fetch })
      .result();

    assert.equal(message.stopReason, "stop", `stream failed: ${message.errorMessage ?? "no reason given"}`);
    assert.equal(message.content.length, 1);
    assert.deepEqual(message.content[0], { type: "text", text: "ok" });
    assert.equal(message.usage.output, 2);

    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.method, "POST");
    assert.equal(
      call.url,
      "https://us-east5-aiplatform.googleapis.com/v1/projects/proj/locations/us-east5/publishers/anthropic/models/claude-haiku-4-5@20251001:streamRawPredict",
    );
    assert.equal(new URL(call.url).searchParams.has("beta"), false);
    assert.equal(call.headers.get("authorization"), "Bearer tok");
    assert.equal(call.headers.has("x-api-key"), false);
    assert.equal("model" in call.body, false);
    assert.equal(call.body.anthropic_version, ANTHROPIC_VERSION);
    assert.equal(call.body.stream, true, "the path specifier is derived from this");
    assert.ok(Array.isArray(call.body.messages));
  });

  it("carries adaptive thinking through unchanged", async () => {
    const { calls, fetch } = recorder();
    const { provider, model } = vertexProvider();
    const message = await provider
      .streamSimple(model("claude-opus-4-6"), CONTEXT, { apiKey: "tok", fetch, reasoning: "medium" })
      .result();

    assert.equal(message.stopReason, "stop", `stream failed: ${message.errorMessage ?? "no reason given"}`);
    // Read back what pi sent rather than asserting a guessed field name: forceAdaptiveThinking
    // survives the compat allowlist precisely so this shape reaches Vertex.
    const thinking = calls[0].body.thinking;
    assert.ok(thinking && typeof thinking === "object", "pi must still send a thinking block");
    assert.equal((thinking as Record<string, unknown>).type, "adaptive");
    const outputConfig = calls[0].body.output_config;
    assert.ok(outputConfig && typeof outputConfig === "object");
    assert.equal((outputConfig as Record<string, unknown>).effort, "medium");
    assert.ok(calls[0].url.endsWith("/models/claude-opus-4-6:streamRawPredict"), calls[0].url);
  });

  it("is `withVertexFetch` and nothing else that does the rewriting", async () => {
    // The control for the two cases above: the same model and the same mock through a *bare*
    // anthropicMessagesApi() — i.e. what `api:` reverted to a plain transport would do. pi posts
    // straight to the Anthropic path with the token still an API key, which Vertex answers with a
    // 404. Wrapping the same transport is the entire difference.
    const model = vertexModel("claude-haiku-4-5-20251001");

    const bareCalls = recorder();
    await anthropicMessagesApi()
      .streamSimple(model, CONTEXT, { apiKey: "tok", fetch: bareCalls.fetch })
      .result();
    assert.equal(new URL(bareCalls.calls[0].url).pathname, "/v1/messages", bareCalls.calls[0].url);
    assert.equal(bareCalls.calls[0].headers.get("x-api-key"), "tok");
    assert.equal(bareCalls.calls[0].body.model, model.id, "the model is still in the body");

    // pi forwards options.fetch, so the wrapper has to compose *over* the caller's transport
    // rather than replace it — otherwise the mock below would never be reached.
    const wrappedCalls = recorder();
    await withVertexFetch(anthropicMessagesApi(), TARGET)
      .streamSimple(model, CONTEXT, { apiKey: "tok", fetch: wrappedCalls.fetch })
      .result();
    assert.ok(
      wrappedCalls.calls[0].url.endsWith("/models/claude-haiku-4-5@20251001:streamRawPredict"),
      wrappedCalls.calls[0].url,
    );
    assert.equal(wrappedCalls.calls[0].headers.get("authorization"), "Bearer tok");
  });

  it("sends no `fallbacks` field for a model whose catalog entry allows fallbacks", async () => {
    // The request-level form of the compat test above, and the regression guard for
    // twoGiants/pi-anthropic-vertex#27: an extension that copies pi's `allowedFallbackModels`
    // makes pi add `fallbacks` to the body, and Vertex answers 400 "fallbacks: Extra inputs are
    // not permitted". Both supported pi versions set the key on at least one model (claude-fable-5),
    // so this runs on the real catalog rather than a synthetic one.
    const source = getBuiltinModels("anthropic").find(
      (model) => (model.compat?.allowedFallbackModels?.length ?? 0) > 0,
    );
    assert.ok(source, "pi's catalog no longer sets allowedFallbackModels anywhere — re-check whether the filter is still needed");

    // Control: through the bare transport with the unmapped model, pi does put `fallbacks` in
    // the body. That is the mechanism the allowlist exists to stop.
    const bare = recorder();
    await anthropicMessagesApi().streamSimple(source, CONTEXT, { apiKey: "tok", fetch: bare.fetch }).result();
    assert.ok("fallbacks" in bare.calls[0].body, "expected pi to send `fallbacks` for the unmapped model");

    const { calls, fetch } = recorder();
    const { provider, model } = vertexProvider();
    const message = await provider.streamSimple(model(source.id), CONTEXT, { apiKey: "tok", fetch }).result();
    assert.equal(message.stopReason, "stop", `stream failed: ${message.errorMessage ?? "no reason given"}`);
    assert.equal("fallbacks" in calls[0].body, false, `fallbacks reached Vertex for ${source.id}`);
  });
});

describe("extension registration", () => {
  function stubPi() {
    const registered: Provider[] = [];
    return {
      registered,
      pi: {
        registerProvider(provider: Provider) {
          registered.push(provider);
        },
      },
    };
  }

  function captureWarnings(run: () => void): string[] {
    const original = console.warn;
    const lines: string[] = [];
    console.warn = (...args: unknown[]) => void lines.push(args.join(" "));
    try {
      run();
    } finally {
      console.warn = original;
    }
    return lines;
  }

  it("registers the provider once a project is configured", () => {
    const { pi, registered } = stubPi();
    const warnings = captureWarnings(() => {
      assert.equal(registerAnthropicVertex(pi, { GOOGLE_CLOUD_PROJECT: "proj", CLOUD_ML_REGION: "europe-west1" }), true);
    });
    assert.deepEqual(warnings, []);
    assert.equal(registered.length, 1);
    assert.equal(registered[0].id, PROVIDER_ID);
    assert.equal(registered[0].getModels()[0].baseUrl, "https://europe-west1-aiplatform.googleapis.com");
  });

  it("prints the exact disabled message and registers nothing when no project resolves", () => {
    // fullsend's docs/runtimes/pi.md troubleshooting matches on this string verbatim.
    const { pi, registered } = stubPi();
    const warnings = captureWarnings(() => {
      assert.equal(registerAnthropicVertex(pi, {}), false);
    });
    assert.deepEqual(warnings, [DISABLED_MESSAGE]);
    assert.equal(
      DISABLED_MESSAGE,
      "[pi-anthropic-vertex] disabled: set GOOGLE_CLOUD_PROJECT or ANTHROPIC_VERTEX_PROJECT_ID",
    );
    assert.equal(registered.length, 0);
  });
});
