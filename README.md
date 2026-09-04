# @fullsend-ai/pi-anthropic-vertex

Anthropic **Claude** models on Google Cloud **Vertex AI**, as a
[pi](https://github.com/earendil-works/pi) provider.

Registers the provider `anthropic-vertex`, with pi's whole first-party Claude catalog behind it:
`anthropic-vertex/claude-sonnet-5`, `anthropic-vertex/claude-opus-5`, and so on.

## 1. Install

```bash
pi install git:github.com/fullsend-ai/pi-anthropic-vertex
```

## 2. Configure

Two things: a GCP project, and Application Default Credentials.

```bash
export GOOGLE_CLOUD_PROJECT=your-gcp-project
export CLOUD_ML_REGION=us-east5          # optional; us-east5 is the default
gcloud auth application-default login
```

No `ANTHROPIC_API_KEY`, and no `pi login`. Auth is ambient: the provider mints a short-lived Google
access token from ADC on each request, and `google-auth-library` caches it and re-mints it near
expiry — so a fresh machine or a CI sandbox needs nothing beyond ADC.

| | Variable | Default |
|---|---|---|
| Project | `GOOGLE_CLOUD_PROJECT`, then `GCLOUD_PROJECT`, then `ANTHROPIC_VERTEX_PROJECT_ID`, then `GOOGLE_CLOUD_PROJECT_ID` — first non-empty wins | none; without one the provider stays out of the model list |
| Region | `CLOUD_ML_REGION`, then `GOOGLE_CLOUD_LOCATION` | `us-east5` |
| Credentials | `GOOGLE_APPLICATION_CREDENTIALS`, or whatever else ADC discovers | ADC |

`region` also accepts Vertex's non-regional endpoints: `global`, `us`, and `eu` (the data-residency
endpoints) map to their own hostnames.

**No other `ANTHROPIC_*` variable is read anywhere** — not `ANTHROPIC_API_KEY`, not
`ANTHROPIC_VERTEX_BASE_URL`. If your launcher unsets `ANTHROPIC_*` before starting pi (fullsend
does), that changes nothing here.

## 3. Check that it loaded

A pi extension that fails to load is dropped **silently**, so confirm the provider is there before
debugging anything else:

```console
$ pi --list-models | grep -E 'provider|anthropic-vertex'
provider          model                       context  max-out  thinking  images
anthropic-vertex  claude-fable-5              1M       128K     yes       yes
anthropic-vertex  claude-fable-5-1            1M       128K     yes       yes
anthropic-vertex  claude-haiku-4-5            200K     64K      yes       yes
anthropic-vertex  claude-haiku-4-5-20251001   200K     64K      yes       yes
anthropic-vertex  claude-opus-4-5             200K     64K      yes       yes
anthropic-vertex  claude-opus-4-5-20251101    200K     64K      yes       yes
anthropic-vertex  claude-opus-4-6             1M       128K     yes       yes
anthropic-vertex  claude-opus-4-7             1M       128K     yes       yes
anthropic-vertex  claude-opus-4-8             1M       128K     yes       yes
anthropic-vertex  claude-opus-5               1M       128K     yes       yes
anthropic-vertex  claude-sonnet-4-5           1M       64K      yes       yes
anthropic-vertex  claude-sonnet-4-5-20250929  1M       64K      yes       yes
anthropic-vertex  claude-sonnet-4-6           1M       128K     yes       yes
anthropic-vertex  claude-sonnet-5             1M       128K     yes       yes
```

(That listing is pi 0.85.0's catalog; yours reflects whatever pi you are running — see
[Models](#models).)

## 4. Run it

```bash
pi --model anthropic-vertex/claude-sonnet-5 "explain this repo in three sentences"
```

Verified 2026-09-04 with pi 0.84.4, ADC from `gcloud auth application-default login`, and
`CLOUD_ML_REGION=global`, against a project where these models are enabled — the current default Sonnet, a `--thinking
medium` call on an adaptive model, and a dated id (rewritten to `claude-haiku-4-5@20251001` on the
wire):

```
$ pi -ne -e . --model anthropic-vertex/claude-sonnet-5 --thinking off --no-session -p "reply with just: ok"
ok
$ pi -ne -e . --model anthropic-vertex/claude-sonnet-4-6 --thinking medium --no-session -p "reply with just: ok"
ok
$ pi -ne -e . --model anthropic-vertex/claude-haiku-4-5-20251001 --thinking off --no-session -p "reply with just: ok"
ok
```

(`-ne -e .` loads only this extension from the current checkout, the way the CI smoke test and
fullsend's sandbox do; a normal `pi install` needs neither flag.)

Or set it as the default in `~/.pi/agent/settings.json`:

```json
{ "defaultProvider": "anthropic-vertex", "defaultModel": "claude-sonnet-5" }
```

**Use the fully qualified `anthropic-vertex/claude-sonnet-5` in scripts.** The bare id resolves to
pi's built-in `anthropic` provider, which wants an `ANTHROPIC_API_KEY` and bills through
api.anthropic.com.

## Models

The catalog is not maintained here. It is read at load time from pi's own first-party Anthropic
catalog, so:

- **Model ids are pi's ids** — `claude-sonnet-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-6`,
  `claude-fable-5-1`, `claude-haiku-4-5`. Your
  model specs and any alias table keep working across this extension and the built-in `anthropic`
  provider.
- **Pricing, context windows and thinking levels are pi's**, copied verbatim, so cost reporting
  matches the direct-Anthropic path exactly.
- **A pi upgrade brings new models with it.** Nothing to release here when Anthropic ships one.

Two details are handled on the wire and never appear in a model spec:

- Vertex names dated models with `@` — `claude-haiku-4-5-20251001` is
  `claude-haiku-4-5@20251001` in the URL. The rewrite does that; the id you type does not change.
- Anthropic capability flags that Vertex does not accept are filtered out (see
  [Troubleshooting](#troubleshooting) and CONTRIBUTING.md).

Whether a given model is *served* to your project is a Vertex question, not a pi one: a model can be
listed here and still 404 in your region.

## In fullsend

fullsend's pi runtime sets the project and region for you and expects this provider id. Per-agent
selection is an `agents:` entry in `.fullsend/config.yaml`:

```yaml
agents:
  - name: triage
    runtime: pi
    model: anthropic-vertex/claude-opus-5
```

or:

```bash
fullsend agent set triage --fullsend-dir .fullsend --runtime pi --model anthropic-vertex/claude-opus-5
```

The provider id, the environment contract and the disabled message below are all byte-compatible
with [twoGiants/pi-anthropic-vertex](https://github.com/twoGiants/pi-anthropic-vertex), so this is a
drop-in replacement for it in a sandbox image. See the
[pi runtime docs](https://github.com/fullsend-ai/fullsend/blob/main/docs/runtimes/pi.md) for the full
precedence rules.

For Grok on Vertex under the same ADC login, see the sibling extension
[fullsend-ai/pi-xai-vertex](https://github.com/fullsend-ai/pi-xai-vertex). One
`gcloud auth application-default login` covers every Vertex provider — it is the *project* that
differs between them, not the identity.

## Requirements

- pi ≥ 0.84.4 (tested against 0.84.4 and 0.85.0 on every commit)
- A GCP project with the Claude models enabled in Vertex AI Model Garden
- ADC credentials (`gcloud auth application-default login`, or `GOOGLE_APPLICATION_CREDENTIALS`)

## Troubleshooting

**`[pi-anthropic-vertex] disabled: set GOOGLE_CLOUD_PROJECT or ANTHROPIC_VERTEX_PROJECT_ID`.**
No project resolved, so nothing was registered. Set one of the four project variables above. This is
the only case where the extension deliberately does not register.

**The provider is missing from `--list-models` and there is no message.** pi drops a failed
extension without printing anything. Load it explicitly to see the real error:

```bash
pi -e ~/.pi/agent/git/github.com/fullsend-ai/pi-anthropic-vertex --list-models
```

**`[anthropic-vertex] Google ADC unavailable, ...`.** ADC could not be discovered, so the models are
registered but not offered. Run `gcloud auth application-default login`, or point
`GOOGLE_APPLICATION_CREDENTIALS` at a credential config. The message names the underlying cause and
is printed once per process.

**`No API key found for anthropic`.** You used a bare model id and reached pi's built-in provider.
Use the fully qualified `anthropic-vertex/<model>`.

**A 404 on a model that appears in `--list-models`.** Vertex does not serve that model to your
project in that region. Try another region (`CLOUD_ML_REGION=us-east5`, `europe-west1`, `global`) or
enable the model in Model Garden. The catalog comes from pi and cannot know your project's grants.

**A 400 naming a request field** — `fallbacks: Extra inputs are not permitted`, or an unrecognised
beta. pi has started sending a field Vertex does not accept. Anthropic capability flags reach Vertex
through an explicit allowlist (`VERTEX_COMPAT_KEYS` in `src/index.ts`) precisely so this stays rare;
the fix is to leave the new flag out of that list, with a note saying why. See CONTRIBUTING.md.

---

Contributing, architecture, and the pi-specific gotchas behind the design:
[CONTRIBUTING.md](CONTRIBUTING.md). Rules for AI agents working in this repo: [AGENTS.md](AGENTS.md).

MIT licensed.
