# Semantic click authority — v1 implementation refinement

This document narrows the frozen protocol v1 and pairing-trust v1 section 11
for the first semantic-ref click implementation. It grants no production
activation, user approval, release trust, or live-browser authority. Existing
site/navigation challenge shapes are unchanged.

## Request and result

`browser.perform` retains its exact common envelope. For `action: "click"`,
`target` is `{tab_handle}` and `args` is exactly
`{ref, expected_action_class}`. The expected class is one of
`reversible_input`, `sensitive_input`, `external_side_effect`, or `unknown`.
Core's initial Browser-tool adapter always supplies `unknown`; model kwargs
cannot downgrade it. Non-null preauthorization IDs are unsupported until their
full binding is independently verifiable by the extension.

Success is exactly `{lease_id, browser_id, tab_handle, document_epoch, ref,
action_class}` with the existing empty `receipts` and `artifacts` arrays.
`browser_id` equals the opaque tab handle. No geometry or provider IDs cross
the result boundary.

## Local checks

Resolve only a current document-bound semantic ref. Require a connected,
visible, enabled, pointer-targetable element with finite clipped viewport
geometry and an unobstructed hit target. Re-resolve after cursor animation,
after approval, and immediately before trusted input. The higher of Core's
expected class and local classification applies; ambiguity is consequential.
This slice rejects navigation, form submission, and file-picker targets.
Trusted input is restricted to exact-owned CDP mouse phases; no DOM `.click()`,
script evaluation, CSS selector, or arbitrary coordinates are accepted.
Uncertain dispatch or debugger detachment cannot report success and retains
cleanup debt. Cancellation, finalization, takeover, and document change revoke
pending authority.

## Action challenge

The existing critical event envelope carries exact route, operation, and action
identity. `challenge.required` action data contains exactly:

```text
challenge_id
kind = "action"
origin
action_class = sensitive_input | external_side_effect | unknown
canonical_parameter_hash
target_fingerprint
lease_id_digest
browser_id_digest
document_id (non-null)
document_epoch
summary (bounded generic text, never page or proposed input content)
options = ["decline", "approve_once"]
data_classification = "none"
expires_at_ms
```

Hashes are lowercase SHA-256 hex. The parameter hash uses the same canonical
operation recipe as navigation, including these exact click args. Core binds
the event to its still-pending operation and exact owned lease; received DOM
fingerprints are evidence to bind, not permission or page-derived instructions.

## Resolution and consumption

`browser.resolve_challenge` uses the existing common route/control/op/action
envelope plus exactly `challenge_id`, `tab_handle`, `document_id`,
`document_epoch`, `canonical_parameter_hash`, `target_fingerprint`, `origin`,
`action_class`, `data_classification: "none"`, `decision`, and `grant`.
`decision` is `decline` or `approve_once`. A decline has `grant: null`.
An approval grant contains exactly:

```text
action_grant_id
scope = "operation"
origin
action_class
canonical_parameter_hash
target_fingerprint
data_classification = "none"
expires_at_ms
```

Core's authenticated, CSRF-protected UI receives only a challenge identifier
and explicit choice; it derives all authority from server state. It consumes
the exact once-only receipt before sending the matching control, with a
current-operation/route preflight. Receipt/control expiry is no later than
the pending operation, challenge, or two minutes. Identical decision replay
must not create a second grant or dispatch a second input. An uncertain control
is not automatically retried as a new decision.

The exact control result is `{contract_version, control_id, challenge_id,
status: "resolved", decision}`. This means the resolution was received, not
that the click succeeded. The extension must independently revalidate and
consume this exact grant before dispatch. The later operation result alone
reports the click outcome.

## Capability boundary

Do not advertise `click` until extension, native codec, Core authority/control,
and protected decision UI are composed and focused changed-path checks pass.
`trusted_input_v1` already covers the independently implemented hover subset;
it never implies click, type, submit, or full runtime readiness.
