# Development signed session v1

Status: implemented in isolated source, 2026-09-05. This extends the approved separate
local-development delivery channel. It does not activate browser control or
change the installed companion, live Docker code, pairing state, or selection.

## Boundary

Prove possession of the separate development credential over a fresh one-use
challenge and establish an isolated hello-only Socket.IO principal. Production
proof domains, handlers, stores, admission, and release trust remain unchanged.
Reuse shared Origin-first restricted-principal plumbing and native socket/TLS
transport, not production runtime admission. No context, operation, artifact,
approval, credential-control, or unsolicited application event is admitted.

Constants:

- Contract: `a0.browser-bridge.development-session.v1`
- Channel: `local-development`; trust version: integer `1`
- Protocol: `a0-connector.v1`; namespace: `/ws`
- Handler path: `plugins/_a0_connector/ws_browser_development`
- Handler ID: `ws_browser_development.WsBrowserDevelopment`
- Principal type: `browser_bridge_development`
- Challenge endpoint: `/api/plugins/_a0_connector/browser_bridge_development_challenge`
- Fixed extension ID: `paoagmddepkmonpeboobaijlenlcokpc`

Only the exact configured canonical explicit-port HTTP loopback development
pairing URL is eligible. An active separate development record must match the
server instance/base URL, extension and companion instance. Production records
must never be accepted as development credentials, or conversely.

## Exact challenge and proof schemas

Challenge request keys (no additions): `contract`, `trust_version`, `channel`,
`bridge_id`, `client_nonce`, `extension_id`, `install_instance_id`,
`load_generation_id`, `companion_instance_id`.

Challenge response keys: `contract`, `trust_version`, `channel`, `challenge_id`,
`server_nonce`, `server_instance_id`, `server_base_url`, `expires_at_ms`.

Use the existing production challenge's nonce, identifier, expiry (60 seconds),
rate/capacity and strict JSON conventions, in a separate development store.
Every first proof attempt consumes its challenge, including invalid signatures.
Failures are generic and no-store; public challenge HTTP bodies are bounded and
duplicate keys are rejected. No new ambient authentication fallback exists.

Signed proof keys: `aud`, `bridge_id`, `challenge_id`, `client_nonce`,
`companion_instance_id`, `contract`, `channel`, `extension_id`, `handler`,
`install_instance_id`, `load_generation_id`, `protocol`, `server_base_url`,
`server_nonce`, `trust_version`. `aud` is the challenge's server instance;
`handler` is the path above. Ed25519 signs canonical sorted scalar JSON using
the existing ASCII/JCS-compatible encoding. Nonces are canonical unpadded
base64url for 32 bytes; signatures are canonical unpadded base64url for 64 bytes.
Proof values must exactly match the stored challenge and current credential.

Socket auth remains exactly `{handlers: [handler_path], principal:
{type: principal_type, proof: proof_object, signature: signature_string}}`.
Shared Origin validation runs before proof consumption.

The signed install/load identifiers are immutable *session claims*. Existing
pairing records independently bind extension, companion, and public key, but
not install identity. Do not label this production profile attestation or set
`subject_profile_bound`. Native's credential slot remains install-scoped.

## Exact hello and acknowledgement

`connector_hello` uses the existing request envelope/correlation convention.
Its data has exactly these fields:

```json
{
  "protocol": "a0-connector.v1",
  "features": [],
  "development": {
    "contract": "a0.browser-bridge.development-session.v1",
    "channel": "local-development",
    "mode": "pairing_only"
  },
  "extension": {
    "id": "paoagmddepkmonpeboobaijlenlcokpc",
    "version": "<validated extension version>",
    "manifest_version": 3,
    "install_instance_id": "<signed install ID>",
    "load_generation_id": "<signed load generation>"
  },
  "companion": {
    "instance_id": "<record-bound companion ID>",
    "version": "<validated companion version>",
    "platform": "<existing platform enum>",
    "arch": "<existing architecture enum>"
  }
}
```

The exact success ACK data has `protocol`, `principal_type`, `features: []`,
`connector_session_ready: false`, `browser_control_ready: false`,
`reason_code: development_runtime_not_available`, the exact `development`
object above, and `connector_binding` with exactly `server_instance_id`,
`bridge_id`, `connector_sid`, `key_generation`, `load_generation_id`.
SID is server-owned, never a hello claim. Hello identity must equal the retained
proof binding; active credential/policy must be rechecked before reply.

Native validates every field and authenticated namespace SID, enters a distinct
`AuthenticatedDevelopmentPairingOnly` state, and answers native hello with the
existing inactive development shape (empty negotiation, no activation).
`SessionState::Ready`, result sending, operation queues, artifact spooling and
context relay stay unavailable. Engine.IO heartbeat may continue; post-hello
application event/ACK packets close the hello-only development worker.
The development native relay falls back by 8 seconds from its original start,
leaving delivery margin before the extension's strict 10-second hello deadline;
fallback cancels/drops the worker and cannot be promoted by a late reply.
Disconnect, expiry, cancellation, revocation, malformed replies and unavailable
Core remain paired-but-inactive, without later promotion on the same native
port or automatic reconnect.

## Verification and subsequent boundary

Use synthetic keys/records and focused proof, handler, native codec/session
checks. Test replay, wrong channel/domain/handler/profile/generation, revocation,
true readiness and unexpected operational packets. Preserve production decoder
and namespace regressions. No live installation/deployment in this frontier.

Both source repositories carry the same `tests/fixtures/development-session-v1.json`
(under `native/browser-bridge/` for Rust). It contains the public RFC 8032 first
test-vector public key, a synthetic deterministic signed proof and canonical
bytes, request/response and hello/ACK data. It contains no live credentials and
is not a production trust root. Tests must consume these bytes rather than
independently recreating two potentially incompatible schemas. The existing
wire platform spelling is `darwin`, not the installer target spelling `macos`.

Useful development browser control is subsequent work: a distinct admission
type with exact composed capabilities/transports, explicit browser selection,
current route/policy/lease checks, cancellation/finalization and critical-event
acknowledgement. It must not fabricate full-production readiness. Pairing and
this signed session alone are not completion of the overhaul.

## Publication evidence boundary

Local implementation, fixture execution, deployment, and acceptance evidence is
intentionally not included in this repository. This snapshot does not prove a
live signed session, browser-control readiness, or production release trust.
