# Agent Zero Chrome Extension

This Manifest V3 extension is the host-browser half of the frozen
`a0.browser-bridge.v1` design. Its service worker owns native messaging, exact
tab leases, task tab groups, mutation recovery, and dynamically injected page
helpers. The options page and side panel display pairing/setup state; neither is
an execution authority.

## Install without the Web Store

Use the supplied unpacked ZIP and open **START-HERE.html** after extracting it.
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

### Separate local-development channel

Use `npm run build:development` and load `dist-development/` for the separate
**Agent Zero Chrome Bridge (Development)** identity. It connects only to the
source-built `io.agentzero.browser_bridge.dev` native companion. The default
`dist/` output remains a production build with independent release/activation
requirements; it cannot substitute for the development identity.

With matching Core and companion builds, Core's explicit
`A0_BROWSER_BRIDGE_DEVELOPMENT_RUNTIME=limited-v1` opt-in adds limited control.
Pairing alone does not enable it. In Agent Zero Browser settings, select the
paired development browser for the intended chat and allow the exact site
origins it may open. Then choose **Reconnect after selection** in extension
Options. Readiness follows a fresh signed handshake and tab reconciliation;
Refresh only reads status and cannot grant control.

This mode supports owned tabs, tab groups, page reading, navigation, scrolling,
and the illuminated cursor. Extension chat relay, screenshots, clicking and
typing are unavailable in this mode even though their separately gated source
implementations are described below. Use the Agent Zero WebUI for tasks. The
native companion belongs on the computer running Chrome, including when Agent
Zero itself runs in Docker. A0 CLI can install/update it but need not stay open.
After updating companion/extension files, reload the extension in Chrome; do
not uninstall an existing paired companion to update its binary.

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
