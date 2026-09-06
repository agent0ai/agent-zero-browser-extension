# Agent Zero Chrome Extension

This package implements the host-Chrome half of `a0.browser-bridge.v1`.
Treat the versioned snapshots in [`planning/`](planning/) as the authoritative
design and DOX boundary for this repository. Their source hashes and
normalization boundary are recorded in
[`docs/PROTOCOL-COMPATIBILITY.md`](docs/PROTOCOL-COMPATIBILITY.md). Historical
product-reference material is not included and is not repository instruction.

## Non-negotiable runtime boundaries

- The Manifest V3 service worker owns native messaging, Chrome API authority,
  task leases, tab groups, durable mutation records, and recovery.
- Agent Zero owns task intent, site/action policy, approvals, and final tab
  disposition. The native companion transports those decisions and holds the
  server credential; the extension never stores an Agent Zero API key.
- The side panel and options page are replaceable viewers. Closing either must
  not stop work, disconnect the native port, cancel an operation, or finalize a
  tab.
- Content code is dynamically injected only after the worker validates a
  current lease and HTTP(S) site grant. It never receives raw Chrome tab IDs or
  owns cross-tab state.
  Inject the compile-generated content module path through an exact-document
  ISOLATED async function that awaits import before binding; CRXJS's detached
  file loader is not installation readiness. Bound the wait to the earlier of
  five seconds and the operation deadline, checking cancellation and authority
  while waiting and after completion. Failed or late installation never sends
  a bind/command, retries an effect or accepts a caller-provided module path.
- Agent-facing tab identifiers are opaque, current-generation handles. Never
  infer ownership from URL, title, group, index, opener, or the active tab.
- A `lease_id` is a distinct ownership identity, never an alias for the
  agent-facing `tab_handle`/`browser_id`. Turn-finalization dispositions and
  outcome lists are keyed by lease ID. Persist only its digest durably.
- Automatic finalization may close only an exact, current-generation,
  agent-created, ephemeral lease. Claimed, retained, deliverable, handoff,
  user-taken-over, ambiguous, and orphan tabs remain open.
- Browser work must continue with zero connected side-panel ports.
- Agent-created working tabs use a real blue Chrome tab group per browser
  session, joining only the exact worker-owned group in that window. Never
  group unrelated user tabs or use the WebUI internal-browser tabs as a substitute.
  Withdraw only the exact cached window/group binding on Chrome group removal.
  Before reusing a cached group, a successful authoritative window-group query
  must still contain it; absence clears that exact binding so a fresh group is
  created. Read failures abort, and failed grouping mutations are never retried.
  Recheck connection authority and group identity/revision after awaits; delayed
  removal of an old group cannot erase a different replacement binding.

## Security and privacy

- Reject unknown protocol versions, methods, action enums, stale generations,
  malformed envelopes, oversized frames, restricted URLs, and ambiguous
  ownership before browser effects.
- Do not log, persist, broadcast, or transmit credentials, page text, full URLs,
  query strings, fragments, typed values, screenshots, or artifacts unless a
  validated operation explicitly requires a bounded value at that layer.
- Mutation journal transitions are persisted before effects; uncertain effects
  become `outcome_unknown` and are never replayed by guessing.
- Critical `lease.changed`, `turn.finalized`, and `challenge.required` events are redacted, written to
  the local ledger before notification, and retained until an exact-generation
  highest-contiguous acknowledgement. Never acknowledge a naked sequence or
  include URLs, page data, provider tab IDs, or cursor frames in this stream.
- Storage is restricted to trusted extension contexts before hydration. Migrate
  legacy configuration by deleting API-key and draft fields without reading
  them into UI state.
- Browser/page data is untrusted. Keep page execution in an isolated world and
  bind every command to generation, lease, sender, document, action, and
  deadline.
- Recheck the exact top-level document and leased HTTP(S) origin immediately
  before injection/effects and again before returning page content. Navigation,
  user takeover, or lost authority must invalidate content bindings and cursor
  state.

## Current bounded operation slice

- Worker-owned `content` returns a bounded semantic snapshot with opaque,
  document-bound references. It never returns selectors or form-control values.
- Worker-owned `navigate` applies same-origin changes directly. A cross-origin
  request must enter the durable `waiting_approval` stage and receive an exact
  current-generation server control bound to the operation, turn, lease,
  document epoch, canonical parameter hash, target fingerprint, origin, and a
  live operation/turn-scoped site grant. Local UI choices and natural-language
  strings are never grant authority.
- Worker-owned `scroll` accepts only a current opaque reference and journals the
  effect. Cursor display is optional and becomes attached state only after the
  page confirms the operation.
- Worker-owned `hover` accepts only a current semantic ref. Content resolves a
  stable, visible, unobscured point and animates the cursor locally; geometry
  remains internal. The worker rechecks the exact lease/document immediately
  before the sole trusted input command, CDP `Input.dispatchMouseEvent` with
  `type: mouseMoved`. Advertising `trusted_input_v1` means this explicit hover
  action is implemented, never that click, type, selectors, caller coordinates,
  scripts, or arbitrary CDP are available.
- The semantic `click` lane is negotiated only with its exact native/Core
  authority path and protected decision UI. It accepts only exact
  `{ref, expected_action_class}` args, rejects opaque preauthorization and
  navigation/form/file targets, and keeps geometry/content local. Consequential
  classifications require the exact once-only action challenge/control grant;
  the target fingerprint and document must be unchanged before both the CDP
  press and release phases. Advertising this implemented subset does not imply
  production release trust, full activation, typing or form submission.
- Worker-owned `screenshot` may use `Page.captureScreenshot` only through an
  exact extension-owned debugger attachment for the current lease. It supports
  viewport PNG and JPEG quality 20 through 95, hides the overlay before
  capture, restores the same cursor after exact-authority capture/detach,
  detaches before transfer, and returns only a descriptor after exact
  ordered artifact acknowledgements. Never use the active user tab as an
  implicit capture target, persist screenshot bytes, or clear debugger state
  after an unconfirmed detach.
- The extension may advertise this tested local slice in hello negotiation, but
  must not mark the operational method surface ready until the companion/Core
  decoders, receipt cache, cancellation, and approval/revocation paths pass
  their frozen acceptance gates.
  The local operational-surface check is direction-specific: the combined
  protocol method inventory is not an inbound-handler requirement. Output
  `artifact.begin/chunk/end/abort` are extension-to-companion requests, and
  input uploads use the private native handoff; neither grants an inbound
  worker artifact handler. Missing actual inbound handlers still fail closed.
- Runtime operations require both the synchronous worker-owned native
  connection and its persisted lifecycle projection to remain identically
  admitted (full production activation or the exact separate limited
  development admission). Capture connection, admission, installation, load/worker generation,
  and browser-instance identity before queueing; never let a replacement
  connection authorize old work. Enforce negotiated actions, their inherent
  feature dependencies, and caller requirements again after waits and before
  effects. `status`/`ensure` expose only the supported negotiated intersection.
- Native state projection and reconciliation share one worker-local,
  connection-scoped initialization queue. Reconcile must wait for persisted
  negotiation and RECONCILING; fence every async continuation so a replaced
  handler cannot regress READY, reconnect, or disconnect the new port. This
  queue never replaces the synchronous live authority getter.
- Start critical-event replay only after the native controller validates and
  posts the correlated reconcile response on the still-current original port.
  Core must settle that response before processing following FIFO events.
  Reconcile snapshots do not grant leases, settle unknown effects, or ACK
  embedded events; old-generation retained events are not current-stream ACKs.
- Pass the worker's authority callback into content bind/command operations so
  internal tab/document awaits cannot bypass revocation before injection or
  dispatch. The callback is never serialized. Negative cleanup remains
  independent, and finalization may still wait for an already-invoked open to
  establish its lease under the original authority. Production full activation
  requirements remain independent of limited development admission.
- A bounded semantic `type` lane is negotiated after native/Core and protected
  approval UI composition. It requires exact `{ref,text,text_sha256,expected_action_class:
  sensitive_input}` args, an empty writable top-frame text field, and a
  once-only action grant before CDP focus/insert. It never replaces existing
  values or falls back to keys, selectors, DOM mutation, click-focus, or submit.

## Manifest and UX

- Both header surfaces use `src/ui/AgentZeroLogo.tsx`, with unchanged symbol
  geometry from Agent Zero Core's `webui/public/icon.svg`. Render monochrome
  using the text color, as Core's sidebar does; no placeholder initials or
  remote asset request. The 34px decorative SVG sits beside the visible name,
  is hidden from assistive technology, and adds no focus target. This visual
  reuse does not establish trademark/license clearance for public releases.

- Options and sidepanel share the Native Agent Zero visual language in
  `src/ui/theme.css`: local Rubik/Roboto Mono fonts with their bundled OFL
  licenses, neutral dark surfaces, compact blue-accented controls and reduced-
  motion-safe status feedback. Keep connection rows and the next available
  action primary; pairing is saved per Chrome profile, while browser selection
  and site approvals remain separate. Installation and diagnostics belong in
  disclosures, and presentation changes never alter worker authority.
  Packaged host installation is the first setup instruction; source-build CLI
  commands belong in a secondary disclosure, not the primary onboarding path.
  Production setup directs the user to choose this browser once as Agent Zero's
  default in protected Browser settings, even without an open chat. Existing
  explicit project choices remain unchanged. Saved pairing alone never proves
  that the default was saved or that browser control is ready; if already
  selected, describe the existing automatic admission retry instead of asking
  for a new code or repeated per-chat setup. Development instructions stay separate.

- Local development is selected only by `vite build --mode local-development`
  (`npm run build:development`). It uses `dist-development`, the pinned public
  manifest key/ID in `src/build-channel.ts`, and native host
  `io.agentzero.browser_bridge.dev`. Keep its visible Development label and
  separate identity. No runtime preference may change the build channel.
- The default production build pins the owner-supplied store public key in
  `src/production-identity.json`, deriving `nhliclifilepdkoolioacpjpijomfplj`, and
  uses `io.agentzero.browser_bridge`. The store item is a draft. Key and ID
  recognition do not imply publication, signed companion trust or runtime
  admission. Development retains its separate key/ID and is never accepted by
  the production identity check. Package inspectors require the exact reviewed
  public key and verify its SHA-256/derived ID; never accept an arbitrary key.
- Pairing-only development hello and pairing responses require the exact
  `a0.browser-bridge.development-trust.v1` / `local-development` profile, with
  connector-session and browser-control readiness both false. Its native RPC
  pairing request remains unchanged; the compiled development native host owns
  the separate Core exchange route. Never accept an activation attestation or
  infer operational readiness from this pairing-only profile.
- A separately admitted development hello instead carries the exact eleven-field
  `development_admission` from [`planning/limited-development-control-v1.md`](planning/limited-development-control-v1.md),
  never both hello profiles or production activation. The worker validates
  signed install/load/server identity, fixed extension ID, Chrome/companion
  floors, storage and permissions. `limitedTransportReady` admits only the
  frozen eight actions, four features and operation/control/critical-event lanes;
  `limitedBrowserReady` additionally requires completed reconciliation and
  matching live/persisted authority. Keep `activationReady` and extension chat
  false. Context, artifacts, screenshots and trusted input never use this gate.
- Only the parameterless `reconnect_development_browser` user action may request
  a fresh handshake after Core selection, and only for a paired inactive dev
  port. Status refresh remains read-only. Options and sidepanel present limited
  control separately, send no selection authority, and expose no admission
  identity/credential projection. No build or source test establishes live
  limited-control acceptance.

- Production paired-but-inactive hello responses use the worker's existing
  persisted reconnect deadline/attempt count and bounded 30/60/120-second then
  under-five-minute backoff. Keep the old port non-operational until its alarm
  requests a fresh native hello; never promote it or replay requests. Alarm
  handling requires the exact current/persisted connection and deadline, and
  pending user requests win over retries. Healthy unpaired, fully admitted,
  blocked, revoked, user-disconnected and development-inactive states cannot
  request production admission retries. Fresh admission clears the alarm and
  resets backoff. Options/panel describe automatic checks but transmit no Core
  selection authority and are never keepalive owners. Actual development builds
  keep their truthful badge and limited instructions; production copy must not
  advertise those restrictions. Mac packaged setup is primary; CLI instructions
  stay in an optional disclosure. Changing build-channel text never migrates
  development credentials or authorizes production control.
  The side panel is conversation-first: Agent Zero branding stays primary,
  chats precede optional tasks in the switcher, and completed replies do not
  replace the conversation with a task-completion dashboard. Browser access is
  a secondary disclosure; its count is explicitly agent-controlled tabs across
  chats, never an inventory of the user's open Chrome tabs. Empty queues stay
  hidden. The bounded auto-growing composer and independently scrolling message
  area must fit narrow panels without horizontal overflow. This presentation
  changes no context selection, tab ownership, sharing, or approval authority.
  Routine activity uses at most one transient row and disappears after five
  seconds; historical timestamps do not restart that lifetime. Keep messages,
  failed activity and pending approvals visible. Only presentation is compacted;
  do not delete context history or cancel underlying work.
  A global side-panel viewer uses a stable browser-profile presentation anchor,
  not a new document ID on each open. The worker retains bounded per-anchor/chat
  unsent user drafts across viewer closure; these are never auto-sent, logged,
  written to disk or included in native RPC. Clear only the exact accepted send
  version; later edits and unconfirmed sends stay intact. Drafts and selection
  remain connection-scoped and are cleared on native identity/connection reset,
  not panel close. This is not browser-restart durability. A visible mounted
  panel refreshes the authorized WebUI chat list every 15 seconds and on focus,
  with no overlapping refresh or work while sending/switching. Existing protocol
  limits (64 advertised contexts) remain; refreshing never selects a new chat or
  grants access. Closing the viewer removes its timer and presentation reference
  only; it never cancels agent work or disconnects the companion.
  The explicit @ picker lists at most 200 non-incognito HTTP(S) tabs only after
  the user asks. Provider tab IDs stay inside the worker behind expiring,
  panel/context/connection-bound choices. Re-read the selected tab and reject
  changed URL/title, pending navigation, expiry or lost selection. Adding a tab
  inserts an editable Markdown title/link reference into the user's draft;
  only Send shares that text. The picker warns that full links can contain
  private information. It does not attach DOM/page contents, claim a lease,
  grant site/action permission, or mutate/close the user's tab. No tab metadata
  goes to disk, logs, or automatic network requests.
  Viewer ports require an extension-page sender, not merely the extension ID
  that content-script senders also carry. Content scripts cannot open a viewer
  session to enumerate chats/tabs or access drafts.
  Chat text uses a bounded inert Markdown subset: formatting never executes
  HTML or fetches images/resources. Only explicit HTTP(S) links are clickable;
  parser budget exhaustion preserves the remaining text as plain text.
  Native-port disconnect callbacks synchronously consume Chrome's lastError
  even for obsolete or intentionally closed ports; generation checks still
  prevent those callbacks from changing replacement/user-disconnected/blocked
  state. Classify only fixed Chrome messages into pathless reason codes, never
  persist or project raw error text. Host exit, missing installation and start
  failure retain bounded reconnect; forbidden host, invalid name and protocol
  errors block rather than retry. This handles Chrome's unchecked-error warning,
  not the underlying native process failure, and grants no runtime authority.

- Keep `minimum_chrome_version` at 120 or newer and preserve only the
  permissions frozen in [`planning/mv3-runtime-v1.md`](planning/mv3-runtime-v1.md).
- Do not add a static all-sites content script or `activeTab`.
- The page cursor must be non-intercepting, isolated in a shadow root,
  accessibility-hidden, bounded to 600 ms of animation, removable on every
  terminal/loss path, and usable with reduced motion and forced colors.
  Private screenshot cursor.suspend/resume hide the existing overlay without
  losing its point or favicon. Resume requires the same content binding and
  suspended operation/action IDs; cancellation, release, navigation or newer
  movement prevents stale restoration. No cursor is created by either command.
  Its high-visibility 42x51 arrow keeps the scaled tip exactly at the input
  point. Near bottom/right viewport edges, mirror only the visual around that
  tip and place its label inward; never adjust operation coordinates to fit
  decoration. Short real movements use at least 240 ms (still capped at 600);
  first positioning and reduced-motion positioning remain immediate.
  A production worker may request the fixed Agent Zero favicon only on a
  successful exact content binding for an active agent-created, non-taken-over
  lease. The optional internal boolean is derived from the worker lease, never
  caller arguments. Claimed/user tabs remain unchanged. Preserve all original
  favicon nodes; remove only the owned, unchanged link on cancel, release or
  navigation. Do not fight site updates or add open-time binding effects. This
  uses the supplied lightSymbol.svg geometry and may be limited by site CSP or
  Chrome caching; it is not a configurable protected tab-strip system badge.
- Remote events may update status/badge state but must never force UI open or
  steal focus. Action, command, and context-menu handlers are user-gesture
  entry points for a tab-specific side panel.
  An authorized open/hover/click/type/scroll/upload operation may follow its
  exact leased tab only when Core projects `display.foreground: true`. Existing
  tabs are activated in their current window before cursor movement, with exact
  lease, document, origin, cancellation and authority checks around awaits.
  Never raise a window, infer ownership from focus, override user takeover,
  focus during passive events, or repeat focus for a replayed completed action.
- Side-panel context data is a bounded, memory-only projection of contexts the
  current paired route already advertised. Context UI requests must cross the
  worker-owned native port under the current READY, activation-attested
  connection; panel close/unsubscribe is presentation teardown only.
- The options page also observes the existing worker presentation port while
  mounted. Pushes supersede earlier request snapshots; closing the page removes
  listeners and disconnects only that viewer. Never add polling, permanent
  keepalive, or UI-derived control readiness to this status subscription.
- A live context item's stable sequence may be delivered repeatedly while text
  streams. Upsert that item and advance only from the separate `last_sequence`
  source cursor; paged history must not overwrite a newer live projection.
- Queue UI commands are explicit current-selected-panel requests through the
  existing admitted production connection. Only bounded owned queue previews
  enter memory-only projections; never send host attachment paths or synthesize
  chat-log cursors. Local approval commands require `confirmed: true`, the
  current selected context and a matching still-live worker-owned challenge.
  Native and Core independently correlate that challenge before returning an
  accepted control receipt; no local UI input is a grant. These methods remain
  unavailable in limited development and cannot establish activation readiness.

## Validation

Connection security controls stay under Options advanced settings and require
an admitted production connection and explicit user initiation. Chrome sends
only a fixed action/version; the native OS credential store owns all private
keys and rotation IDs. A pending rotation reconnects through a fresh native
hello, never promotes authority on the old port. Revoke needs a separate
confirmation and a definitive Core receipt; unknown outcomes preserve keys.
`credential-control-v1.json` is the shared strict wire fixture. These controls
are unavailable in limited development and never imply release readiness.

`scripts/build-local-delivery.mjs` is the CI-independent, host-local source
packager. It requires explicit connector/output paths, never overwrites an
existing output, uses locked offline Cargo dependencies, fingerprints exact
inputs before/after building, and excludes user state and credentials. Its
installer preserves pairing by choosing update for an installed companion and
fresh install only for native status exit 3. A local checksum is not release
trust; this package may not enable production or widen development admission.

`scripts/export-source-handoff.mjs` exports the isolated Core/CLI task scopes
as exact-base binary Git patches and hashed new files without commits, index
changes or publication. It excludes ignored state, hidden files and symlinks,
requires a fresh output directory, and never applies patches automatically.

`scripts/package-store-candidate.mjs` builds only the production channel into a
fresh explicit output, inventories an exact allowlist of regular package files,
checks manifest references/permissions, bundled licenses and PNG dimensions,
then creates and reads back a ZIP with its per-file and archive hashes. It never
uploads, signs, chooses a publisher identity, or changes runtime admission.
The candidate receipt explicitly remains unsubmitted/not production-ready.

Run from this directory:

The upload lane accepts only a Core-registered bounded artifact descriptor and
an opaque semantic ref. All file selections require an exact one-use
external-side-effect approval because a page may upload on file selection.
Never accept model paths or caller coordinates. Native artifact.input_path is
an operation-only, production-only private handoff: keep its path in the
input-artifact WeakMap, consume it once solely through the owned debugger's
DOM.setFileInputFiles, and never project it to storage, results or UI. Verify
the native path as an absolute Unix path or ordinary local Windows drive path;
reject traversal, Windows network/device namespaces and alternate streams. Verify
the visible empty single-file target before and after approval, descriptor,
document/lease ownership, current route and grant expiry before the effect.

```sh
npm test
npm run build
npx tsc --noEmit
```

Inspect `dist/manifest.json` after every manifest or build-pipeline change.
For local-development changes also build and inspect
`dist-development/manifest.json`; verify the public key derives the pinned ID
and production output derives the separate recorded store identity.
Tests must cover worker restart/session loss, forged and stale messages, exact
lease finalization, two-context isolation, user takeover, cursor teardown,
side-panel churn, native-host loss, and fail-closed restricted targets.
