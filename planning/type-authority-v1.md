# Semantic type authority — v1 implementation refinement

This document narrows the frozen protocol v1 and pairing-trust v1 section 11
for the first semantic-ref type implementation. It grants no production
activation, release trust, broader input authority, or non-empty-field
replacement behavior. Existing site/navigation and click challenge behavior is
unchanged.

## Request and result

`browser.perform` retains its exact common envelope. For `action: "type"`,
`target` is `{tab_handle}` and `args` is exactly `{ref, text, text_sha256,
expected_action_class: "sensitive_input"}`. `text_sha256` is the lowercase,
64-character SHA-256 hex digest of the exact UTF-8 bytes of `text`; every hop
recomputes it and rejects a mismatch. No Unicode normalization, trimming, or
newline conversion is allowed. Text must be valid Unicode scalar data, contain
1 through 32,768 UTF-8 bytes, and contain neither NUL nor carriage return. A
line feed is accepted only for a textarea.

The canonical operation parameter hash retains the existing recipe over
`{action,target,context_id,browser_session_id,turn_id,args,display}`, so it binds
the full exact args, including both text and its checked digest. Only the
canonical hash is durable; raw text is never copied into an event, WAL,
challenge, receipt, result, diagnostic, or new log.

The selected extension Browser tool also projects input text as a fixed
withheld marker in its structured log, console output, and tool-output
callbacks. Execution arguments are not mutated. This does not erase the
model's existing conversation/tool-call history or change other browser modes.

Success is exactly `{lease_id, browser_id, tab_handle, document_epoch, ref,
action_class: "sensitive_input"}` with the existing empty `receipts` and
`artifacts` arrays. No text digest, field content, geometry, provider identity,
or selector crosses the result boundary.

## Target and effect boundary

Resolve only a current top-frame document-bound semantic ref. The first slice
accepts a visible, enabled, unobscured, writable, empty `textarea` or `input`
whose normalized type is `text`, `search`, `email`, `tel`, `url`, or `password`.
It rejects contenteditable elements, non-text controls, hidden/file controls,
readonly or disabled fields, occupied fields, navigation/form controls, and
line feeds for single-line inputs. Empty-field-only behavior is intentional:
CDP `Input.insertText` inserts at the current selection, while Agent Zero's
existing type action means replacement. V1 never silently appends and has no
select-all, key-chord, DOM-value, clipboard, selector, coordinate, click-focus,
or submit fallback.

The extension alone derives an integer hit point and hashes a target
fingerprint from stable JSON containing the action, current document epoch and
opaque ref, local semantic tag/type/role/name digest, bounded autocomplete,
input-mode, form-method and state fields, the empty-value precondition, clipped
viewport geometry, hit point, and viewport. Page-derived strings exist only
inside this one-way fingerprint. The proposed text is excluded from the target
fingerprint and is bound separately by the data classification and canonical
parameter hash.

After cursor travel and approval, the worker repeatedly rechecks the exact
generation, lease, origin, document, ref, fingerprint, geometry, and empty
value. It uses `DOM.getNodeForLocation` only at the internally derived point,
then journals `effect_started` immediately before `DOM.focus`, because focus is
page-observable. The content runtime must confirm that `activeElement` is the
same exact ref and still empty before one `Input.insertText` command. It then
checks the resulting value digest internally and returns only a boolean state.
No field value or resulting digest is returned to the operation result.

Failure before `DOM.focus` is not applied. Any error, cancellation, deadline,
authority loss, document change, digest mismatch, or uncertain debugger detach
after focus is `OUTCOME_UNKNOWN`; the runtime never claims the input was undone.
Failed detach retains debugger cleanup debt. Cancel, disconnect, finalization,
takeover, navigation, or challenge expiry removes the cursor and discards the
transient raw request without closing or releasing the tab.

## Data classification and approval

The action authority field is an exact tagged union. Click retains
`data_classification: "none"`. Type uses exactly:

```json
{
  "kind": "text",
  "sensitivity": "sensitive",
  "text_sha256": "64 lowercase hex characters"
}
```

The expected class is always `sensitive_input` and may never be downgraded by
page semantics or caller kwargs. Every TYPE operation enters
`waiting_approval` before focus and emits the existing durable redacted
`challenge.required` action event with the exact route, operation, lease,
document, origin, canonical hash, target fingerprint, tagged classification,
generic summary `Allow Agent Zero to type into the highlighted field?`, ordered
options `["decline", "approve_once"]`, and bounded expiry. It contains no text,
ref, label, placeholder, value, or length.

`browser.resolve_challenge` and its once-only operation grant reuse the exact
click control fields while carrying the same tagged classification. The server
must bind and compare the complete object, consume the approval immediately
before sending the control, and cap expiry to the operation, challenge, or two
minutes. Different text changes both `text_sha256` and the canonical parameter
hash. Same-control replay cannot create another grant or dispatch another
input.

## Capability boundary

Do not advertise `type` until the extension, native codec, Core adapter and
action authority, and protected approval UI are composed and changed-path
checks pass. `trusted_input_v1` remains a coarse local capability; only explicit
advertised actions are available. This refinement does not authorize submit,
type-submit, key events, contenteditable input, replacement of existing values,
or arbitrary CDP.

Composition status (2026-09-04): the exact extension/native/Core codecs,
document-bound once authority, and server-selected chat-composer approval UI
are now composed and the bounded action is advertised by all three peers.
Focused changed-path tests and a disposable network-blocked Chrome primitive
check passed. That check proved node lookup, exact focus, and text insertion on
a synthetic empty field, not a paired production end-to-end session. Release
trust, installer admission, and production runtime gates remain closed.

## Core authority binding

Core represents the action data classification as an immutable exact union:
click is `none`; TYPE is the complete sensitive-text record above. Receipt
equality and consumption compare that complete value alongside the route,
canonical parameter hash, target fingerprint, origin, and action class. The
operation broker retains only action, semantic ref, expected action class,
canonical parameter hash, and verified text digest; it recomputes the text
digest and canonical parameter hash immediately before transport dispatch.
The protected pending projection adds only the server-owned action discriminator
`click` or `type`, never text, digest, ref, context/bridge authority fields, or a
container Browser viewer ID. These bindings do not advertise TYPE.
