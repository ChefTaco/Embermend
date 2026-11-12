# Inference providers

Embermend supports a configured llama.cpp server, an OpenAI-compatible HTTPS
endpoint, Codex CLI through its app-server protocol, and Claude CLI in print
mode. Providers have explicit names, exact model identifiers, deadlines and
version pins for CLI protocol compatibility. There is no automatic model or
provider fallback. A failed, truncated, rerouted or malformed result leaves
assessment coverage incomplete; a model opinion remains a candidate.

The inference broker runs outside repository execution and exposes only its
inference endpoint. It has no product approval, standing-policy, provider-write,
node-management or deployment authority. Repository containers receive neither
its token nor CLI login material. Magnus forwards bounded text through the
broker using context from the admitted operation. Magnus remains the owner of
worker isolation and execution receipts; it does not embed another CLI runtime.

## Configure and run

Build with `npm run build`, provision a protected provider configuration, and
supply `EMBERMEND_INFERENCE_CONFIG` and a dedicated random
`EMBERMEND_INFERENCE_TOKEN` of at least 32 characters. Run `npm run inference`.
This process refuses inherited product database, provider-write, identity-client
and management credentials or host-control socket environment variables. Supply
a dedicated environment containing only inference configuration and necessary
model credentials; API/worker environment files are unsuitable.
It binds only to loopback, at port 4181 by default. A remote Magnus worker must
use an independently configured, authenticated, verified HTTPS ingress to it.
Do not expose the loopback HTTP listener directly to a network.

Example configuration (replace every model, executable and credential path
with an explicitly approved value):

```json
{
  "maxConcurrent": 1,
  "providers": [
    {
      "kind": "llamacpp",
      "ref": "approved-local-model",
      "model": "exact-model-id-from-models",
      "baseUrl": "http://model.example.com:8000/v1",
      "localNetworkApproved": true,
      "timeoutMs": 120000,
      "maxOutputTokens": 8192
    },
    {
      "kind": "codex-cli",
      "ref": "approved-codex",
      "model": "exact-configured-model-id",
      "command": "/opt/cli/codex",
      "expectedVersion": "exact-output-of-codex-version",
      "credentialHome": "/opt/embermend/codex-auth",
      "effort": "medium",
      "timeoutMs": 120000
    },
    {
      "kind": "claude-cli",
      "ref": "approved-claude",
      "model": "exact-configured-model-id",
      "command": "/opt/cli/claude",
      "expectedVersion": "exact-output-of-claude-version",
      "credentialHome": "/opt/embermend/claude-auth",
      "timeoutMs": 120000
    }
  ]
}
```

An OpenAI-compatible provider uses `kind: "openai-compatible"`, verified HTTPS,
and a required `tokenEnv` naming its credential environment variable. llama.cpp
can omit `tokenEnv` when its approved local network server requires no token.
URLs cannot contain credentials, queries or fragments. Discovery must list the
exact configured model; completion metadata must agree with it. Network
responses use a constrained JSON Schema and refuse tool calls or truncation.
`maxOutputTokens` bounds network requests. CLI output is bounded by byte limits,
structured schema and deadline rather than a provider token-limit option.

### Emberpath

`kind: "emberpath"` is an opt-in preset of the OpenAI-compatible provider for an
Emberpath model router. It takes the Emberpath root as an HTTPS `url` (no
credentials, query or fragment) and calls its OpenAI-compatible API at
`<url>/v1`. `ref` defaults to `emberpath`, `tokenEnv` to `EMBERPATH_API_KEY`,
and the network defaults (`timeoutMs`, `maxOutputTokens`) are the same as
`openai-compatible`. `model` stays required and must be an exact model ID that
Emberpath lists at `/v1/models`. An Emberpath route can reach cloud models, so
it is a **remote** model route: it requires `sourcePolicy.allowRemoteModel: true`.

```json
{ "kind": "emberpath", "model": "exact-model-id-from-emberpath-models", "url": "https://emberpath.example.com" }
```

Emberpath forwards the request body of `/v1/chat/completions` unchanged to an
OpenAI-compatible upstream, so the strict `json_schema` `response_format` that
Embermend sends reaches the model. A request with `response_format` is routed
only to upstreams marked as JSON-schema capable; an Ollama upstream receives it
as its native `format`. `/v1/models` aggregates the upstreams' live model IDs.
Embermend still checks that the completion names the configured model, so an
Emberpath alias or failover to a differently named model fails closed with
`MODEL_IDENTITY_CHANGED` rather than being accepted.

Create a dedicated Emberpath client key for the inference broker, with an
`actorId` in its metadata so Emberpath attributes the traffic to that actor
(2 to 32 characters of `a-z`, `0-9`, `_` or `-`):

```bash
hive-router create-key --name "embermend-inference" --metadata '{"actorId":"embermend-inference"}'
```

Run it where Emberpath's server configuration is available (from a source
checkout, `npm run cli -- create-key ...`; pass `--token` when Emberpath sets
`HIVE_ROUTER_CLI_TOKEN`). The plaintext key is printed once. Put it only in the
broker's dedicated environment as `EMBERPATH_API_KEY` (or the variable named by
`tokenEnv`); never in the API or worker environment.

CLI binaries must already be installed and authenticated by the broker's owner.
Embermend does not install them, initiate interactive login, copy credentials,
or alter their persistent configuration. Authentication files (`auth.json` for
Codex, `.credentials.json` for Claude) must be canonical, singly linked regular
files owned by the broker account with no group or other access. An upgrade
requires a reviewed version-pin update and renewed protocol/isolation checks.
The reference protocol checks were exercised with Codex CLI 0.166.0 and Claude
Code 2.1.301. Other versions are not implicitly accepted.

Each CLI gets an empty temporary working directory and HOME, a minimal process
environment, no source checkout, and only its explicitly configured login home.
Codex disables shell, execution, browser, apps, plugins, hooks, memories and
other tool features. It discovers inherited MCP configuration without creating
a thread, restarts with each server disabled, and verifies the effective state
before source disclosure. Threads are ephemeral, read only, require no loaded
instruction files and refuse server tool/approval requests and model reroutes.
Claude uses safe and restricted mode, no tools, empty strict MCP configuration,
no setting sources, no slash commands and no session persistence. A cancellation
or deadline kills and reaps the CLI process group before cleanup. CLI or provider
stderr is never returned to callers.

Both CLI routes are **remote model routes** for source-disclosure policy.
A local process does not make its cloud inference local. They require
`sourcePolicy.allowRemoteModel: true`; the approved llama.cpp network provider
is a local route. Do not route a cloud proxy through a provider marked local.

## Managed scanner wiring

In the root-controlled Magnus worker configuration, set `model.embermendBroker`
to `true`, `model.baseUrl` to the broker's `/v1` base, and both `model.model` and
`model.ref` to the approved provider reference, such as `approved-codex`.
`model.local` describes the **backend source policy**, independently of whether
the broker transport is loopback. The protected `model.caFile` can name a canonical root-controlled CA file for private HTTPS.
`worker.nodeExecutable` must match the immutable image (the suite image uses
`/usr/bin/node`), and validation profiles name that reviewed path.
`model.tokenFile` contains only
the dedicated broker token. Transport to a remote broker requires HTTPS;
loopback HTTP is permitted without treating the backend as local.

The broker accepts authenticated `GET /v1/models` and `POST
/v1/chat/completions`. Requests contain exactly a system and user message,
`response_format: {"type":"json_object"}`, and `embermend_context` containing
the admitted operation's `providerRef`, `operationId` and `allowRemoteModel`.
Repository stdout cannot set those fields. Provider selection must agree with
the configured model reference. Unknown providers, missing disclosure grants,
extra tool fields and capacity overflow fail before inference. Health at
`/health/live` establishes only process availability. Listed providers are
configuration, not proof that authentication or inference is currently ready.

Keep endpoint, credential-path, configuration and evidence references in private
operator records. Retain actual model and CLI versions, immutable source
revision, source-policy grant and coverage with acceptance evidence. Direct
scanner/provider proof does not establish the complete managed rootless
worker, recommendation, approval, patch and deployment acceptance journey.

Protocol references: [Codex app server](https://developers.openai.com/codex/app-server/),
[Codex configuration](https://developers.openai.com/codex/config-reference/),
[Claude CLI reference](https://code.claude.com/docs/en/cli-reference), and
[llama.cpp server](https://github.com/ggml-org/llama.cpp/tree/master/tools/server).

Scanner stdio failures use the bounded `MODEL_BROKER_UNAVAILABLE` error frame,
bound to the original request ID. Compatible scanner images record failed file
analysis and partial coverage instead of treating missing output as a clean
result. The container CI gate exercises this frame and the actual source-reader
and preparation entry commands using fake data and no network.
