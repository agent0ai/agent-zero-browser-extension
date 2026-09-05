# Chrome Web Store and permission record

Last updated: 2026-09-05. Private source repository:
[agent-zero-browser-extension](https://github.com/TerminallyLazy/agent-zero-browser-extension).
No store submission or production publication has occurred.

Status: implementation-stage inventory for `a0.browser-bridge.v1`. This is not
a statement that the extension is ready for publication.

## Local-development installation

`npm run build:development` produces `dist-development` for an explicit Chrome
Developer mode / Load unpacked installation. Its name is `Agent Zero Chrome
Bridge (Development)`, its pinned ID is `paoagmddepkmonpeboobaijlenlcokpc`, and it
connects only to the separately installed `io.agentzero.browser_bridge.dev`
native host. The manifest public key fixes this development identity; it is not
a signing credential or production approval. The options page and side panel
identify the development channel.

`npm run build` continues to produce `dist` without the development key and uses
the production native-host name. No stored preference or runtime environment
switches channels. The development build retains all activation gates; local
installation, hello negotiation, and pairing alone do not mean browser control
or complete runtime activation is available. See
[`local-development-delivery-v1.md`](planning/local-development-delivery-v1.md).

The pairing-only development native hello and pairing responses carry an exact
`development` object naming `a0.browser-bridge.development-trust.v1` and
`local-development`, with `connector_session_ready:false`,
`browser_control_ready:false`, and
`reason_code:"development_runtime_not_available"`. Missing or contradictory
profiles are rejected. Production rejects this development profile. The native
pairing request retains its existing three fields; the compiled native host
selects the separate development Core exchange. Create development pairing codes
in Agent Zero Browser settings → Development browser companion. The server must
enable source-build setup for its exact loopback URL; the development card is
visible when that setup is enabled or a development identity already exists.
The UI labels successful pairing without claiming task transport or browser
control.

The limited-development source slice accepts a separate exact
`a0.browser-bridge.development-runtime.v1` admission only after explicit Core
selection and a fresh native hello. Worker-owned reconciliation and matching
live/persisted admission gate the eight owned-tab actions; production activation
and extension chat remain false. Context relay, screenshots/artifacts and
click/type are unavailable. Options offers **Reconnect after selection** only
for a paired inactive development port; **Check again** reads status only.
The separate local development build has completed a live signed handshake and
reconciliation. That is not full operation acceptance or production release
evidence. See [`limited-development-control-v1.md`](planning/limited-development-control-v1.md).

Connection settings observes worker status while the page is open, including
native hello and the reconnect after pairing. New status updates supersede
older request snapshots. Closing the page removes this presentation subscription
without changing pairing or browser-task lifetime; no polling or permanent
keepalive is added.

## Single purpose

The extension lets an explicitly paired Agent Zero instance operate leased
HTTP(S) tabs in the user's Chrome profile while showing the work, preserving
user control, and conservatively retaining any tab whose ownership or outcome
is uncertain.

## Permission justifications

| Permission | Purpose and boundary |
|---|---|
| `nativeMessaging` | Connect to the locally installed Agent Zero browser companion. No page or side-panel context can open this channel. |
| `storage` | Keep current-generation runtime state and a bounded, redacted safety ledger. Credentials and raw page content are excluded. |
| `alarms` | Recover a suspended worker and retry an unavailable native host with bounded backoff. It is not a tracking heartbeat. |
| `tabs` | Create and operate exact leased tabs, observe user takeover, and close only eligible agent-created ephemeral tabs. |
| `tabGroups` | Put agent-created task tabs into one labeled group per window. Claimed user tabs are not regrouped. |
| `scripting` | Dynamically inject the isolated semantic/cursor runtime into a validated leased HTTP(S) document. There is no static content script. |
| `sidePanel` | Present the task, current action, approvals, owned tabs, and diagnostics without owning task lifetime. |
| `debugger` | Provide narrowly allowlisted trusted pointer/keyboard input and background capture when negotiated and policy-approved. Arbitrary CDP and `Runtime.evaluate` are not baseline capabilities. |
| `contextMenus` | Let the user explicitly stage a page, selection, or image candidate for the side panel. Staging does not transmit or grant agent control. |
| `http://*/*`, `https://*/*` | Permit server-initiated work on a policy-approved leased site when no browser user gesture exists. Agent Zero policy may still deny or challenge every action. |

The extension does not request browser history, bookmarks, downloads,
notifications, clipboard, file URL, incognito, or unlimited-storage access.

## Data handling

- The paired host companion holds the Agent Zero connection credential; the
  extension does not request or store an Agent Zero API key.
- A user-entered pairing code remains only in the onboarding page long enough
  to send one bounded `pairing.exchange` request to the local companion. The
  input is cleared before the response and is never written to extension
  storage, logs, URLs, diagnostics, or native command arguments.
- Normal agent messages use opaque tab handles. Raw Chrome tab, window, and
  group identifiers remain local to the service worker.
- The durable ledger stores redacted origins/identity digests and operation
  safety receipts, not page text, titles, URL queries/fragments, typed values,
  screenshots, or conversation transcripts.
- Page-derived values are untrusted and leave the browser only for an explicit,
  validated, bounded operation. Binary data uses bounded artifact framing.
- A panel close only removes that viewer. It does not cancel work or trigger tab
  cleanup.

## User control and cleanup

Agent-created tabs are visibly grouped. Claimed user tabs stay in their current
location. Moving, pinning, ungrouping, regrouping, sharing, or taking over a tab
releases agent control. At turn finalization, only an exact current-generation
agent-created tab marked ephemeral may close automatically. All claimed,
deliverable, handoff, taken-over, ambiguous, and orphan tabs remain open.

## Accessibility and visible behavior

The agent cursor is a non-interactive, accessibility-hidden visual layer in an
isolated shadow root. It does not modify target semantics or steal focus, honors
reduced motion, has a forced-colors outline, and is removed on cancel,
navigation, release, takeover, disconnect, or finalization. Equivalent textual
status is provided in the side panel.

## Release evidence still required

- Signed extension identity and native-host allowlist verification.
- Clean A0 CLI and Docker/WebUI install, pair, repair, and uninstall tests.
- Headed persistent-Chrome tests for restart, native-host loss, worker
  suspension, user takeover, cursor isolation, and conservative finalization.
- Store screenshots and copy reviewed against the implemented UI.
- Readback of the packaged manifest, native companion identity, deployed Agent
  Zero source, and negotiated capabilities.

## Unreleased changes

- 2026-09-05: Options and side panel now follow Agent Zero's neutral-dark Rubik
  UI, compact blue controls, connection status rows and saved-pairing guidance.
  Installation and diagnostics use disclosures. Store screenshots must be
  refreshed after the production runtime and release scope are approved;
  synthetic development previews are not store evidence.
