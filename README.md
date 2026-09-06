# Agent Zero Chrome Extension

This Manifest V3 extension is the host-browser half of the frozen
`a0.browser-bridge.v1` design. Its service worker owns native messaging, exact
tab leases, task tab groups, mutation recovery, and dynamically injected page
helpers. The options page and side panel display pairing/setup state; neither is
an execution authority.

## Install without the Web Store

[Download the ready-to-load ZIP](https://github.com/agent0ai/agent-zero-browser-extension/releases/download/extension-v0.1.1-prestore/agent-zero-browser-0.1.1-unpacked.zip)
and open **START-HERE.html** after extracting it.
No Node, Rust, or source build is needed to load the extension. See the
[setup guide](docs/INSTALL.md) for macOS, Windows, Linux, and Docker instructions.

The extension folder is cross-platform. The native companion is separate:
macOS 13+ has a released installer; Windows and Linux production installers are
still incomplete. Do not mistake an installed extension for working native
browser control. Pair once and choose it as Agent Zero's default across chats.

## Development

Repository and coordinated delivery status: [RELEASING.md](RELEASING.md).
The extension is not a standalone installation. Production-channel control has
been exercised with the matching macOS companion and Core integration; that
does not establish Windows/Linux acceptance or Chrome Web Store publication.

```sh
npm ci
npm test
npm run build
npx tsc --noEmit
```

Load `dist/` as an unpacked extension after building. The native companion and
Agent Zero installation paths are documented by the surrounding project; this
package does not store an Agent Zero API key.

### Historical development channel

`build:development` retains a separate identity for historical protocol work.
The current Core integration retires its server endpoints: it is not a supported
installation or a fallback for production. Use the production package above;
never copy development credentials into it.

## Implemented safety boundary

The worker currently has tested implementations for bounded semantic `content`,
challenge-gated `navigate`, opaque-reference `scroll`, ref-targeted trusted
`hover`, and viewport-only
`screenshot`, connected to exact
document bindings, lease state, the non-intercepting cursor, and the durable
write-ahead journal. Every lease has a distinct `lease_id`; the agent-facing
`browser_id` remains its generation-bound `tab_handle`. Durable storage keeps
only digests of those identities and redacted URL identity.

The tested local operation slice is advertised in native hello negotiation, but
that does not make the end-to-end bridge production-ready. Cross-origin
navigation pauses in `waiting_approval`, durably emits a redacted
`challenge.required`, and accepts only an exact, current-generation
`browser.resolve_challenge` control carrying a live operation/turn-scoped site
grant. Deny, expiry, disconnect, cancellation, and turn finalization settle the
operation without a Chrome effect. The negotiated semantic click authority lane
rejects navigation/form/file
targets, requires an exact one-action server grant whenever the effective risk
is consequential, and revalidates its extension-owned target fingerprint
before each trusted mouse phase. Native/Core codecs, current-document authority,
and the protected once-only decision UI are composed. A bounded empty-field
TYPE lane is implemented behind the same action authority, exact UTF-8 digest,
document/ref fingerprint, and debugger cleanup rules. Native/Core authority and
the chat-composer approval UI are composed, and this bounded action is negotiated.
Replacement typing, submit, and
production release/activation gates remain fail-closed.

Hover accepts only a semantic document-bound `ref`. The isolated content
runtime proves current visible, unobscured geometry while animating the
illuminated cursor, but geometry never crosses the native boundary. The worker
then rechecks the exact lease/document and uses only CDP
`Input.dispatchMouseEvent` with `type: mouseMoved`. `trusted_input_v1` therefore
means trusted hover is locally implemented; supported actions remain explicit
and it does not imply click, type, coordinate input, selectors, or arbitrary
CDP support.

Screenshot capture attaches Chrome DevTools Protocol only to the exact
agent-owned lease, removes the page overlay, captures a viewport PNG or bounded
quality JPEG, and confirms debugger detach before transfer. Bytes remain in
worker memory only while they are sent through ordered 192 KiB artifact frames;
the operation returns only after the paired route confirms the exact artifact
descriptor. Cancellation, disconnect, finalization, and user takeover abort
the bound transfer. An unconfirmed debugger detach is retained as cleanup debt
and never represented as detached.

The side panel now projects only contexts advertised by the paired Agent Zero
route. `context.list`, subscribe/unsubscribe, and bounded text updates travel
through the worker-owned native port only while the current generation is
READY and activation-attested. Snapshot/event/completion frames are strictly
validated and held in bounded worker memory; conversation bodies are never
written to extension storage. Closing the panel releases only that panel's
presentation subscription and never cancels a task, finalizes a turn, releases
a lease, or closes a tab.

Critical lease, turn-finalization, site-challenge, and action-challenge events now use the frozen
generation-qualified delivery contract. The worker writes a redacted event to
the bounded local ledger before emitting a native JSON-RPC notification,
replays current-generation pending events after same-load reconnect, and
removes them only after a matching highest-contiguous `browser.ack_events`
cursor. Event metadata contains identity digests and bounded lifecycle enums,
not URLs, page content, Chrome provider IDs, or cursor frames. This completed
transport slice still does not change the production activation gate.
