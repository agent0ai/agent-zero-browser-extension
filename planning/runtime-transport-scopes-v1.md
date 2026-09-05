# Runtime transport and capability scopes v1

Status: implemented and reviewed in isolated source, 2026-09-05. This is a
non-activating prerequisite for separate limited development browser control.
The [signed development session](development-session-v1.md) remains hello-only;
there is no live deployment, selection change or production trust change here.

## Fixed internal transport profiles

Use exactly two immutable server/native-owned profiles. Do not accept profile
names, handler IDs, namespace values or arbitrary profile objects from protocol
messages, extension options, environment flags or user configuration.

| Profile | Principal | Handler path | Handler ID |
|---|---|---|---|
| production | `browser_bridge` | `plugins/_a0_connector/ws_connector` | `ws_connector.WsConnector` |
| local-development | `browser_bridge_development` | `plugins/_a0_connector/ws_browser_development` | `ws_browser_development.WsBrowserDevelopment` |

Both use `/ws`. Core admits only the two constant object identities. Native
selects its fixed profile at compile time; no public string constructor exists.
Transport profile is identity/routing, never runtime admission or scope grant.

Core composition passes its selected constant explicitly through registry,
broker, context/event/artifact controllers, policy/approval authorities and
extension routes/services. Defaults remain production. Structural bindings may
recognize only the two fixed identities; composed entry points, settlements and
emitters require the exact configured profile. Emission uses profile-owned
handler/namespace constants, never caller strings. Preserve all existing scope
and immutable-event checks, including full production runtime requirements.
Keep fixed identity recognition separate from full-runtime admission checks:
do not impose the complete runtime event set on structural helpers that
previously required only their own scoped lane. The registry/admission gate
continues to require full production sets; identity recognition grants nothing.

Keep production activation attestation, `CompleteRuntimeAdmission`, bootstrap,
inventory and the signed development hello handler exclusive to their existing
contracts. In particular, a development principal must never be accepted by
`CompleteRuntimeAdmission` matching or production activation serialization.
Today's hello-only development principal must fail runtime admission.

Development application construction remains denied in this refactor. A later
explicit development owner must supply a distinct admission type and distinct
development persistence adapters for lifecycle, messages, critical events and
site policy; production defaults cannot be borrowed implicitly. Do not relax
full-runtime event sets here or advertise unimplemented lanes.

Native operation/control and critical-event codecs retain the compiled profile
and match every inbound handler to it. A queued Core command carries its trusted
worker profile and RelaySession rejects profile mismatch. Output artifact codecs
must use that same identity when constructed for an admitted lane. ContextCodec
stays production-only until an actual development context contract is composed.
None of this creates a dev route, drains a dev command queue, enables spooling,
or changes `AuthenticatedDevelopmentPairingOnly` / readiness behavior.

## Extension capability fence

Runtime dispatch captures a worker-owned connection/install/load/boot/browser
identity before its first await. Entry, queued continuation and effect boundaries
require the same current identity, activation and negotiated action/features.
The live connection check must read the native manager synchronously, not only
the persisted RuntimeStore projection: storage writes can delay its revocation
update. Require agreement between the live manager and lifecycle projection.
Content host bind/command helpers must repeat the worker-owned authority check
after their internal awaits and immediately before injection/message effects;
a check only at the outer method call is insufficient. Owned teardown remains
separate and must be able to run after admission loss.
Do not trust request-supplied identity or allow global implementation lists to
substitute for negotiation. Include the inherent dependencies of each existing
action and request-dependent cursor/artifact requirements.

Status/ensure report the current negotiated intersection with implemented
capabilities, not all globally implemented features. Cancellation/finalization
and owned cleanup retain their independent authority and must not be disabled
merely because a new operation is inadmissible. This does not enable a
development admission or change UI readiness labels.

## Proportionate verification

Use focused profile/cross-profile validation, exact emitter/codec binding,
production admission rejection of development, source-only development owner
denial, stale/queued operation fencing and negotiated status tests. Run only
relevant regression groups/type or compile checks; no repeated broad suite and
no installed extension rebuild/reload in this slice.

## Publication evidence boundary

Local implementation, test, deployment, and acceptance evidence is
intentionally not included in this repository. Fixed transport profiles alone
do not prove runtime admission or production activation.
