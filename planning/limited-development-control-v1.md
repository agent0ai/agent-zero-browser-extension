# Limited development browser control v1

Status: frozen limited-development source contract snapshot. Local deployment
and rollback evidence is not included in this repository and is not release or
production-acceptance evidence.

## Intended bounded result

Allow the separate source-built development companion to execute useful,
owned-tab browser actions through Agent Zero after an explicit authenticated
selection. Preserve all existing site/turn/document/lease, cancellation,
finalization and current-connection checks. Do not construct production
activation or claim production release/profile/cutover readiness.

Frozen first subset:

- Actions: `open`, `list`, `state`, `navigate`, `content`, `scroll`, `status`, `ensure`.
- Features: `tab_leases_v1`, `tab_groups_v1`, `semantic_dom_v1`, `cursor_v1`.
- Transports: operation, control, critical events with acknowledgements.
- Unavailable: context/chat relay, queues, artifacts/screenshots, click/type and
  credential-control lanes. Existing Core WebUI remains the task surface.

## Boundaries to freeze before implementation

- Separate typed development admission and exact native/Core/extension wire
  decoder, never a `CompleteRuntimeAdmission` with fabricated true flags.
- Exact credential, server/base URL, principal, SID, install/load generation,
  selected bridge and composed capability/transport binding.
- Server-owned composition/liveness checks, with no claimed independent
  production profile attestation or invented heartbeat evidence.
- Dedicated development owner and persistence adapters. Production defaults
  for lifecycle, critical events or site policy cannot be borrowed.
- Explicit protected “Use this development browser” selection, with a reserved
  development selector that fails before legacy/container fallback when absent
  or unavailable. Pairing alone never changes Browser location.
- Complete site-approval/control path plus exact owned-tab cancellation and
  finalization before any actual control readiness.
- Pairing-only ports cannot silently acquire stronger admission. A fresh
  signed native hello/reconnect follows selection; Options needs an honest
  user action if the existing status-only retry cannot initiate it.
- Preserve the working live pairing until a scoped native update/install path
  and Core deployment are ready. No manual Chrome profile edits or automation
  workaround for blocked extension settings pages.

## Frozen reconciliation prerequisite

The existing extension already requires a Core-issued `browser.reconcile`
before operational readiness. Core must add its producer and strict result
receiver; a successful hello alone must never create a usable Browser route.

- Add a process-owned reconciliation binding for the exact transport profile,
  principal object, SID, load generation and control ID. Only the provisional
  route's reconciliation control/result is allowed before promotion.
- Preserve the existing native/extension request and full result schema in
  `chrome-extension/src/protocol/native.ts`; no new readiness packet is needed.
  Check every bounded result field, exact control/install/load, and current
  authority again after waiting. Failure, timeout or loss cannot promote.
- Reconciliation retains only a redacted summary. Peer-reported lease/provider
  identities never create Core lease authority. Embedded pending critical
  events are not applied or acknowledged: the normal durable event lane owns
  replay and exact contiguous ACKs after promotion.
- The native relay must preserve control-result-before-event ordering. Normal
  operations, event receivers, site requests, finalization replay and Browser
  factories cannot resolve a provisional route.
- Extension connection initialization must be serialized with reconciliation;
  a late connection callback cannot regress READY to RECONCILING or disconnect
  a newer native connection.

This prerequisite is complete in isolated source and peer-reviewed. Core has a
profile-explicit broker binding and full parser/controller; promotion runs
synchronously during matching result acceptance before future delivery. Core
reconciliation plus affected operations passed 18 cases. Extension lifecycle,
post-response delivery and stale-request fences passed 10 focused regressions
and typecheck. The identical synthetic `browser-reconcile-v1.json` fixture
passes the Core receiver, native command/result codec and actual extension
parser; its SHA-256 is
`12dad7626555a49b82ecdbc153d7aeed2c12d84caee26a1a690551891c475634`.
None of these changes alone enables runtime authentication or browser control.

## Frozen limited-runtime wire contract

The future separate admission contract is
`a0.browser-bridge.development-runtime.v1`, channel `local-development`, mode
`limited_runtime`. Native hello variants must be mutually exclusive: the old
pairing-only `development` or `development_admission`, never production
`activation`. Use the existing negotiated `max_json_frame_bytes: 786432`;
the existing 524288-byte non-artifact packet cap is a different bound.

Core's development ACK admits the connector/control transport before
reconciliation; it does not mark the Core Browser route ready. Extension UI keeps
full `activationReady` and chat readiness false and exposes a separate
limited-control state only after reconciliation.

The separately compiled development native build sends an exact candidate hello:
`{protocol,features,development,host_browser}`. `development` is exactly
`{contract,channel,mode}` with the values above. Outer features are sorted
`browser_extension_bridge_v1`, `connector_browser_control`,
`connector_browser_event`. `host_browser` uses the existing runtime hello shape,
but its browser ID is `development-extension:<bridge_id>`, actions/features are
exactly the fixed subset above, and its capabilities limits contain only
`{max_json_frame_bytes:786432}`. Existing extension/companion identity fields and
Chrome 120+ / companion 2.12.0+ checks remain required. Its `status:ready` is an
untrusted host transport claim, not Core route readiness.

A successful limited Core hello ACK has exactly:
`protocol,principal_type,features,connector_session_ready,browser_control_ready,
development_admission,connector_binding,host_browser`.
The principal is `browser_bridge_development`; both readiness flags are true
only for this separately tagged limited transport admission. The existing exact
five-field connector binding still includes the authenticated namespace SID.
The host projection echoes the exact validated candidate identity/capabilities.
No production activation, release, heartbeat, artifact, context or cutover fields
are permitted.

`development_admission` is exact, in both Core ACK and native hello:

```json
{
  "contract": "a0.browser-bridge.development-runtime.v1",
  "channel": "local-development",
  "mode": "limited_runtime",
  "transports": ["control", "critical_event", "operation"],
  "selection_scope": "explicit_context_bridge",
  "server_instance_id": "<signed server identity>",
  "bridge_id": "<active development credential>",
  "key_generation": 1,
  "extension_id": "paoagmddepkmonpeboobaijlenlcokpc",
  "install_instance_id": "<signed installation claim>",
  "load_generation_id": "<signed load generation>"
}
```

The placeholder values above are not fixture authority. Every identity must
equal the authenticated credential/proof/namespace/hello binding; key generation
is the actual positive integer, not a literal v1 claim. Native retains SID
privately and never includes it in its extension/UI projection. Native hello
retains the existing physical frame-limit fields, but absent artifact lanes
cannot be authorized by those limits. Negotiated actions/features equal the
fixed subset, not all locally implemented actions.

Updated native builds can propose limited control while unselected. Core must
strictly validate the candidate identity but return the existing exact signed
pairing-only ACK when there is no installed owner/current explicit selection.
The native worker accepts that exact inactive variant without creating a route;
it may never promote the port later. Old pairing-only hello requests stay valid
and cannot create a runtime route even when a bridge is selected.

## Frozen server-owned composition boundary

The signed auth path may create a distinct immutable development runtime
principal only when the dedicated owner is installed and the exact bridge is
selected by a live context. Effective scopes are exactly `bridge.connect`,
`browser.operate`, `browser.control`, `browser.approval`. Inbound events are hello,
operation result, control result, and critical browser event only; outbound are
operation, control, and critical-event ACK only. Record scopes do not become
session scopes by copying a broader production set.

Use distinct development admission/route/registry/application types, never a
production activation object or a forged complete-admission flag. The owner
composes only operations, controls, site authority, lifecycle, lease index,
critical receiver and reconciliation with the fixed development transport.
Persistence keys and Browser runtime factory ownership are separate from
production. Current credential, canonical policy URL, exact manager SID and
principal identity, owner, install/load and context selection are rechecked
before use. Reconciliation gets a provisional route; everything else requires
the same route to be ready. Synchronous result acceptance promotes before the
next critical-event handler can use that route.

Install the owner only through explicit server startup composition when
`A0_BROWSER_BRIDGE_DEVELOPMENT_RUNTIME=limited-v1` and the canonical development
pairing policy are configured. Invalid explicit configuration aborts startup.
Import, hello and config save cannot install an owner. Shutdown/selection loss/
revocation first withdraw routing, settle pending work conservatively and close
the exact affected SID so native port loss immediately withdraws extension
authority. Do not invent a heartbeat protocol or expiry without real renewal.

Reserve `development-extension:<bridge_id>` before legacy/container selection;
it must fail closed without fallback. A protected dedicated context selection
API is the only writer of a new/changed development selection. Generic config
save may preserve an unchanged selection or switch to the container, and must
notify the owner when a development selection is withdrawn. Site policy and
site decisions use dedicated protected development APIs and persistence, never
production singleton bindings.

Extension Options offers a parameterless, worker-validated “Reconnect after
selection” action only for a paired inactive development port. Automatic status
refresh never reconnects or selects a Core browser. A fresh signed handshake is
required; context/chat, artifacts/screenshots and trusted input stay unavailable.

## Delivery prerequisite

Protected WebUI selection uses exact `status` plus `context_id`, `use` plus
`context_id,bridge_id`, and `clear` plus `context_id,expected_bridge_id` bodies.
The expected bridge on clear is only a compare-before-withdraw precondition;
Core derives the current selection itself. Policy allow/revoke similarly
requires `context_id,expected_bridge_id,origin`; every policy response echoes
the server-selected `bridge_id`. Selection status never reports
`reconnect_required` while the runtime owner is disabled. These conditions keep
stale confirmations and delayed site writes from affecting a replacement
selection without creating caller-supplied authority.

The native `development update` and matching A0 CLI route must preserve pairing
credentials, installation identity, and existing browser targets; stage
immutable binaries; switch only exact-owned manifests/state transactionally;
and recover interrupted updates. They must never overwrite an executing binary,
uninstall a paired setup, or infer production trust. Source checks or a
successful build alone do not authorize a live update.

Local staging, deployment, rollback, and acceptance evidence is intentionally
not included in this repository. It is not release evidence.
