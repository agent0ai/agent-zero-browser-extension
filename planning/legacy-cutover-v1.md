# Agent Zero Browser Bridge Legacy Cutover v1

Status: **Frozen architecture decision**  
Contract: `a0.browser-bridge.cutover.v1`  
Canonical map: https://github.com/TerminallyLazy/agent-zero/issues/13  
Decision ticket: https://github.com/TerminallyLazy/agent-zero/issues/20  
Depends on: `a0.browser-bridge.v1`, `a0.browser-bridge.trust.v1`,
`a0.browser-bridge.install.v1`, `a0.browser-bridge.adapter.v1`,
`a0.browser-bridge.mv3-runtime.v1`, and
`a0.browser-bridge.visible-ux.v1`

## 1. Verdict

The prototype Chrome bridge is a legacy product, not a wire-compatible draft of
the v1 bridge. Agent Zero must identify it by multiple structural fingerprints,
quarantine it from v1 authority, and never import its API key, browser/session
identifiers, raw tab metadata, queued commands, screenshots, drafts, or page
context into v1.

The v1 extension uses a reserved stable Chrome Web Store production identity and
a separately labeled beta identity. No published identity is evidenced in the
current repository, so an arbitrary unpacked prototype ID is not treated as the
production identity. An in-place same-ID update purges the exact legacy storage
key before any network, native, UI-state, or browser-mutation path can run. A
new-ID install cannot read another extension's storage; it requires the user to
remove the legacy extension and records that cleanup as user/operator attested,
not machine verified.

Agent Zero ships the new server schema, principal, status, typed selector, and
cutover detector additively behind an instance-level gate that initially
defaults to `disabled`. Pairing does not select the extension. Activation is an
explicit transaction that preserves the top-level `container` and
`host_required` modes and selects only
`host_browser_selection=extension:<bridge_id>`. Any missing, stale, mismatched,
or unauthorized explicitly selected extension fails visibly without falling
back to the internal browser, an A0 CLI CDP target, another extension, or a
different socket.

Docker/WebUI-first and A0 CLI-first setup install the same signed native
companion on the computer running Chrome, create the same durable bridge record,
and use the same pairing and capability contracts. A Docker container does not
install into host Chrome directories. Neither the WebUI, side panel, nor A0 CLI
must stay open for an active browser task.

Legacy support is migration-only for at least 90 days and two consecutive stable
Agent Zero releases after v1 general availability. Retirement removes only the
prototype plugin routes, prompt/tool, and UI. Core messaging APIs, the internal
Docker browser, and explicit legacy A0 CLI CDP browsing remain supported and are
not coupled to the extension rollout.

## 2. Scope and evidence boundary

This contract freezes:

- production and beta identity, release channels, and permission-transition
  behavior;
- detection, quarantine, draining, purge, activation, retirement, and rollback;
- compatibility across the prototype, v1 extension/companion, Agent Zero,
  Docker, and A0 CLI;
- user-visible repair and migration language;
- safe telemetry and release gates;
- exact implementation, test, documentation, and packaging anchors.

It does not implement production code, register a Chrome Web Store item, install
a native host, change Agent Zero configuration, or mutate the running Docker
instance.

The current extension and plugin were audited from source and built output.
Machine-local inspection evidence is intentionally omitted from this repository
and is not evidence that any v1 component is deployed or accepted.

An earlier product-reference brief, not included in this repository, is
reference material only. It was not an authoritative source of instructions.

Chrome platform and store behavior used by this decision is documented at:

- https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings
- https://developer.chrome.com/docs/extensions/reference/api/permissions
- https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
- https://developer.chrome.com/docs/extensions/develop/concepts/extensions-update-lifecycle
- https://developer.chrome.com/docs/webstore/update
- https://developer.chrome.com/docs/webstore/rollback

## 3. Non-negotiable cutover invariants

1. **No implicit authority migration.** A legacy raw tab ID, session ID, context
   ID, socket, API key, or queued command never becomes a v1 identity, lease,
   credential, selection, or receipt.
2. **No automatic backend change.** Detection, install, pairing, update,
   reconnect, or plugin disablement never changes the effective browser backend.
3. **Explicit selection fails closed.** `extension:<bridge_id>` resolves only
   that authenticated compatible bridge and never falls back.
4. **Existing modes remain exact.** `container`, empty `host_required`, and an
   explicitly selected legacy CDP target retain their current behavior and
   codec.
5. **One context, one control plane.** A context cannot dispatch through legacy
   polling and bridge v1 at the same time.
6. **Secrets are purged, not converted.** The browser-stored reusable API key is
   irrecoverably removed; the user pairs again through the trust-v1 flow.
7. **Unknown mutations are honest.** A dispatched legacy command without a
   verified terminal result becomes `OUTCOME_UNKNOWN`; it is never replayed.
8. **Legacy tabs stay open.** Prototype tab IDs establish no ownership. Cutover
   does not close, regroup, claim, or navigate any pre-v1 tab.
9. **Storage proof precedes effects.** A same-ID upgrade performs a read-back
   proof that the legacy key is absent before exposing UI state, connecting to a
   native host or server, or invoking a Chrome mutation.
10. **Host installation stays on the host.** Docker never receives host Chrome
    profiles, browser registration directories, or the Docker socket as a
    shortcut.
11. **Removal is narrow.** Only the prototype bridge is retired. Agent Zero core
    APIs used by other clients and legacy A0 CLI CDP remain intact.
12. **Rollback never recreates a secret.** No rollback package or server version
    can restore the deleted API key, draft, queue, screenshot, or raw authority.

## 4. Legacy inventory and fingerprint

Detection is conservative. A display name or a single filename is insufficient
to disable, migrate, or remove anything. A legacy installation is confirmed only
when its version plus at least two independent structural fingerprints match.

### 4.1 Chrome package and runtime

| Surface | Exact prototype fingerprint | Cutover treatment |
|---|---|---|
| Package | `agent-zero-chrome-extension` version `0.1.0` | Classify as legacy; do not negotiate v1 |
| Manifest | MV3 `Agent Zero Chrome Bridge`; `activeTab`, `contextMenus`, `scripting`, `sidePanel`, `storage`, `tabs`; `<all_urls>` | Never infer v1 capability from name or MV3 |
| Content runtime | Static HTTP/S content script at `document_idle` | Remove from v1 manifest; reject messages from old document generations |
| Local state | One versionless `chrome.storage.local` key, `agent-zero-chrome-background` | Same-ID migration removes the whole exact key |
| Local fields | `browserSessionId`, `composeDraft`, `contextId`, `activeTabId`, `config`, `pendingPresetName` | Purge; import none |
| Config fields | `baseUrl`, raw `apiKey`, `defaultProject`, `chatPollMs`, `commandPollMs`, `sessionPollMs` | Purge; never log, transmit, back up, or transform |
| Background transport | `X-API-KEY` REST calls and worker-global `setInterval` loops | Forbidden in v1 production paths |
| Panel coupling | Command polling runs only while `panelConnected` | Retire; v1 task lifetime is panel-independent |
| Browser authority | All-window tab inventory, mutable numeric tab IDs, active-tab fallback | No v1 lease or ownership conversion |
| Extension port | `agent-zero-sidepanel` | Legacy-only fingerprint |
| Content messages | `GET_PAGE_CONTEXT`, `EXECUTE_BRIDGE_COMMAND` | Legacy-only; old-generation messages rejected |

The legacy local blob may contain a reusable Agent Zero token, server location,
context-menu selection or image URL in the draft, raw active-tab identity, and
conversation defaults. The background also broadcasts a full state projection,
including the token, to panels. Component memory can hold full tab URLs and
titles, DOM selectors/text, screenshots, and attachments. None of it is trusted
migration input.

The clean package gate scans source and a fresh build. Removing source without
rebuilding is insufficient because the present `dist/` independently contains
the raw-key client, polling worker, static content runtime, options UI, unsafe
HTML renderer, and remote font reference.

### 4.2 Agent Zero prototype plugin

The confirmed plugin fingerprint is:

- slug/name `chrome_extension`, version `1.0.0`;
- tool `tools/chrome_bridge.py`;
- routes
  `/api/plugins/chrome_extension/session_upsert`, `command_pull`,
  `command_result`, `chat_bootstrap`, `model_state`, `projects`, and `status`;
- context keys `source=chrome_extension`, `chrome_browser_session_id`, and
  `chrome_extension_capabilities`;
- config keys `command_timeout_seconds`, `redelivery_seconds`,
  `stale_session_seconds`, `max_inspect_nodes`, and `prompt_guidance`;
- prompts `agent.system.tool.chrome_bridge.md` and
  `fw.chrome.system_context.md`.

The plugin accepts a reusable global API key, keeps sessions, raw tab metadata,
commands, payloads, results, attempts, and screenshots in a process-global
registry, redelivers dispatched commands after a short interval, and waits by
polling. Process or panel loss can make a mutation outcome unknowable.

An inline `image_data_url` returned by `capture_visible_tab` is added to the
`chrome_bridge` tool-result history and can be serialized with a saved chat. It
is not merely ephemeral queue state. The retirement migration removes only the
`image_data_url` member of history entries that structurally identify the
`chrome_bridge` tool result, preserving dimensions, safe outcome metadata, and
explicit user-attached chat artifacts.

### 4.3 Core APIs that are not legacy plugin surfaces

`/api/api_message`, `/api/api_log_get`, `/api/api_reset_chat`, and
`/api/api_terminate_chat` remain core APIs because other clients use them. The
v1 extension does not call them directly, but legacy-bridge retirement must not
remove or redefine them.

## 5. Production identity and release channels

### 5.1 Identity decision

1. Reserve one production Chrome Web Store item and one clearly labeled beta
   item before signing native-host manifests.
2. Record the exact production and beta extension origins in native-messaging
   `allowed_origins`; wildcards are forbidden.
3. Preserve stable IDs in reproducible development packages with the relevant
   public manifest key. Never commit a private signing key.
4. Unpacked development uses an explicit development channel, credential,
   storage namespace, and native-host name. It cannot impersonate production.
5. The beta listing, description, bridge record, native host, and diagnostics
   remain visibly distinguishable from production.

There is no repository evidence of an existing official store item or signing
identity. Therefore the `0.1.0` source package and arbitrary unpacked IDs are not
grandfathered as production. If a release owner later proves that a particular
published item is official, using that item requires the same compatibility
and purge gates below; the proof and resulting exact ID must be added to the
release record before submission.

### 5.2 Package phases

| Phase | Purpose | Permission posture | Legacy transport |
|---|---|---|---|
| Prototype `0.1.x` | Existing unsupported prototype | Current broad required set | Raw-key HTTP polling |
| v1 baseline/compatibility package | Establish production identity, pairing, new schema, cleanup and rollback floor | `nativeMessaging` and `tabGroups` may be optional and user-granted; no `debugger` | Never introduced into a new identity; same-ID proven legacy item may retain a bounded unpaired lane only |
| Final bridge-v1 package | Full frozen runtime | Frozen required permissions; Chrome 120+; scoped CDP policy | Native messaging only |

`debugger` cannot be requested as an optional permission. Adding it introduces a
warning-bearing permission, so Chrome may disable an updated extension until the
user accepts the new permissions. `nativeMessaging` and `tabGroups` also carry
warnings. The v1 baseline package must reach 100% and soak as the schema-compatible
rollback target before the final permission-adding release.

If the chosen production item is new, the baseline package contains no raw-key
UI or legacy polling. If an official same-ID legacy item is proven, its baseline
package may keep legacy polling only for users who have not started v1 pairing,
must purge legacy secrets immediately after successful pairing, and must never
dispatch through both transports.

The final package sets `minimum_chrome_version` to `120`. A preceding baseline
must warn older-browser users because adding that floor causes their browsers to
remain on the older package.

## 6. Compatibility and activation matrix

| Agent Zero/runtime | Browser-side state | Required result |
|---|---|---|
| `container` | Any extension, companion, or A0 CLI state | Existing Patchright/Xpra path only; host selection ignored |
| `host_required`, empty selection | Legacy A0 CLI candidates and/or paired v1 bridge | Preserve current legacy candidate precedence; v1 appears in setup/status but is excluded from dispatch |
| `host_required`, explicit legacy ID/endpoint | Matching legacy CDP candidate | Existing flat codec only; exact miss fails visibly |
| `host_required`, `extension:<bridge_id>` | Exact compatible authenticated bridge | Nested bridge-v1 codec only; exact miss/mismatch fails visibly |
| New server | Paired v1 bridge, not selected | Idle/status only; no browser effects and no config rewrite |
| Old A0 CLI | New additive server | Existing `/browser`, CDP, profile, and connector behavior unchanged; unknown capability ignored |
| New installer CLI | Old server without bridge capability | Stop before install/pair with `server_upgrade_required`; no raw-key fallback |
| New server | Prototype extension plus plugin | Explicit bounded compatibility and warning only; never call it v1 |
| New server | Prototype extension without plugin | `legacy_plugin_missing`; update required; no mutation |
| Old server | v1 extension/companion | `server_upgrade_required`; no legacy REST fallback |
| New server | v1 extension without companion | `native_host_not_found`; setup required |
| New server | New companion plus prototype extension | `extension_update_required`; no command dispatch |
| Exact v1 versions | Gate `disabled` | Pairing record may exist; activation unavailable |
| Exact v1 versions | Gate `preview`, subject/bridge not allowlisted | Paired inactive; preview unavailable |
| Exact v1 versions | Gate `available`, not selected | Ready to select; inactive |
| Exact v1 versions | Explicit selection and capability-ready | Active after atomic selection and read-only smoke |
| Any server | Malformed/reserved `extension:` selection | Typed configuration error; never normalize to container or legacy |
| Old and new extensions in one or more profiles | Same Agent Zero context | Display both; block dual binding; require explicit legacy disconnect/removal |

The selector branches on the typed selection before the current generic host
candidate resolver. A reserved `extension:` value must never reach legacy
candidate inference or the unknown-backend-to-container normalization path.

### 6.1 Version and capability gate

Before pairing can become capability-ready, all of these must succeed:

- exact extension ID matches its bridge record and native allowed origin;
- the connector authenticates as the fixed-scope `browser_bridge` principal;
- server, companion, and extension share bridge contract major `v1` and an
  overlapping supported minor/feature range;
- the server advertises the additive bridge, pairing, and cutover capability;
- required limits and action capabilities are accepted explicitly;
- the bridge heartbeat is fresh and bound to the correct subject/profile;
- extension storage migration is terminal `v1_ready`;
- no legacy cutover lock, live legacy session, or in-flight command can race the
  context being activated.

Every action also checks its negotiated per-action capability and the current
context/session/turn/lease bindings. A green server record never implies that the
native host, extension, permissions, or browser are healthy.

## 7. Feature gate and explicit selection transaction

The instance-level `browser_bridge_rollout` has exactly three states:

- `disabled`: additive schema/status/detection is available, but creating new
  pairing offers or selecting an extension is unavailable;
- `preview`: pairing and selection require an explicit subject/bridge allowlist;
- `available`: setup is visible to authenticated users and may be explicitly
  selected.

The first compatible Agent Zero release defaults to `disabled`. General
availability may change a fresh-install default to `available`, but existing
runtime and selection values remain untouched.

`Use this browser` performs one atomic activation transaction:

1. verify every readiness layer and no dual-control conflict;
2. store a sanitized, schema-versioned pre-activation snapshot of
   `runtime_backend`, exact prior legacy selection, profile mode, and privacy
   policy—never credentials, endpoints containing secrets, or raw host paths;
3. persist `runtime_backend=host_required` and
   `host_browser_selection=extension:<bridge_id>` together;
4. create a fresh browser session and run a harmless read-only bridge self-test;
5. expose success only after the selection reads back and the exact bridge
   answers with the negotiated contract.

The self-test does not click, type, submit, navigate an existing tab, or close
anything. The first owned-tab lifecycle test belongs to explicit acceptance,
not silent settings activation.

On failure, the transaction restores the exact prior selection from its safe
snapshot, records a reason code, and performs no browser action. This is the only
automatic restoration permitted; generic runtime fallback is not.

## 8. Two coordinated migration journals

The server and extension have different evidence and therefore keep separate,
idempotent journals. They converge on the same cutover receipt but never infer
one another's success.

### 8.1 Server/operator cutover state

```text
NOT_DETECTED
  -> LEGACY_DETECTED
  -> V1_PAIRED_INACTIVE
  -> DRAINING_LEGACY
  -> LEGACY_DISABLED
  -> LEGACY_LOCAL_PURGE_REQUIRED
  -> READY_TO_ACTIVATE
  -> VERIFYING
  -> COMPLETE
```

Every nonterminal step may enter `BLOCKED` or `CANCELED`. `ROLLBACK_AVAILABLE`
is a derived flag, not authority to recreate removed legacy state. Transitions
use a unique `migration_id`, expected prior state, and idempotency key. Repeating
a completed step returns its stored safe receipt.

`LEGACY_LOCAL_PURGE_REQUIRED` is skipped only when the current exact extension
identity supplies read-back proof of same-ID local purge. For cross-ID/unpacked
legacy installations, a user must uninstall or explicitly clear the old
extension. The receipt records `operator_attested`; it must not say `verified`.

### 8.2 Extension-local migration journal

The non-secret v1 durable ledger contains:

```text
not_checked
  -> detected
  -> quarantined
  -> secret_purge_pending
  -> secret_purged
  -> ephemeral_purged
  -> pairing_required
  -> v1_ready
```

Any write/read-back failure enters `blocked_purge_failed`. The journal contains
only schema version, migration ID, previous package version, booleans, bounded
counts, timestamps, and a one-way structural digest. It contains no URL, token,
draft, title, text, screenshot, raw browser/session/tab/context ID, path, command,
or configuration value.

On every eligible startup, before any effect-capable path:

1. restrict storage access to trusted extension contexts and hydrate behind one
   barrier;
2. detect an in-place legacy shape using `runtime.onInstalled.previousVersion`,
   manifest/package lineage, the exact key, and strict field types; never execute
   or project stored values;
3. durably write `secret_purge_pending`;
4. remove the exact `agent-zero-chrome-background` key, read back, and prove it
   absent;
5. clear pre-v1 `storage.session`, extension-owned alarms, dynamic content
   registrations, ports, and current-generation projections; the final manifest
   contains no static legacy content script;
6. generate fresh install, schema, and extension-load generation identities;
7. publish only the redacted v1 projection and require fresh pairing.

Until step 4 succeeds, the extension blocks native connection, HTTP, UI state
broadcast, content execution, and Chrome mutation. It retries safely on a later
startup/alarm. Migration code and fixtures are the only allowed production
references to the legacy key and field names.

No old tab is reloaded or closed. Already injected old content worlds are
untrusted; their messages fail sender, document-generation, and lease checks.

### 8.3 Data disposition

| Legacy data | v1 disposition |
|---|---|
| Raw API key/global token | Delete; never copy, display, log, transmit, or back up |
| Base URL and polling intervals | Delete; server relationship comes from fresh pairing |
| Draft, selection, image URL, page context | Delete; user restages intentionally |
| Browser/context/session/active tab IDs | Delete; create fresh identities |
| Raw tab URLs/titles/window IDs | Do not import; retain all tabs physically open |
| Queue, payloads, results, attempts | Drain/classify server-side, then clear; never import |
| Screenshot data URL in queue/tool result | Clear queue; narrowly redact legacy tool-result history |
| Explicit user chat attachment | Preserve unless the user separately requests deletion |
| Default project/preset | Do not import; server settings remain authoritative |
| Capabilities/content-script state | Delete; renegotiate/reinject under v1 |
| Legacy prompt guidance | Preserve only as inert operator-owned plugin config; never import |

Deleting the browser copy does not rotate the shared Agent Zero external API
token. Automatic rotation could break other API or MCP clients. The UI offers a
separate authenticated rotation workflow, first inventories affected clients,
and explains that rotation is recommended if the token was dedicated to or
exposed through the prototype.

## 9. Legacy drain, quarantine, and retirement

Pairing may coexist with a still-active legacy installation only while the v1
bridge is inactive. `Begin switch` acquires a context cutover lock and atomically:

1. rejects new legacy session upserts, enqueues, and command pulls with
   `409 LEGACY_CUTOVER_IN_PROGRESS`;
2. disables redelivery for that migration generation;
3. drains for no more than the lesser of each command's original deadline and
   30 seconds;
4. accepts a terminal result for an already-dispatched command at most once;
5. terminalizes undispatched commands as `CANCELED_NOT_APPLIED`;
6. terminalizes every dispatched unresolved command as `OUTCOME_UNKNOWN`;
7. clears process-only sessions, queues, payloads, results, and screenshot data;
8. leaves all browser tabs open and reports uncertain work for user review.

No LLM prompt ordering is used to prevent split-brain. While the lock is held,
the duplicate tool cannot enqueue. After drain it first disappears from
effective prompt/tool routing, then returns a safe deprecation result if invoked
by an old context, and finally is removed with the legacy plugin.

The three exact context keys are removed only when
`source == "chrome_extension"`. Removal is lazy on next chat load/save plus an
authenticated, bounded admin sweep. The values are never mapped to v1. The
history redactor matches the exact legacy tool-result structure and removes only
`image_data_url`; it is idempotent and reports safe counts.

Generic plugin toggling currently reloads immediately and has no drain hook.
The cutover UI must finish the controlled drain before invoking the existing
disable operation. Abrupt disable/restart remains safe through v1 expiry and
reconciliation; it does not justify replay or tab cleanup.

After the compatibility window, plugin-specific routes return
`410 LEGACY_BRIDGE_RETIRED` with safe upgrade guidance and no session/config dump.
The plugin status becomes redacted deprecation-only. Old user-owned copies cannot
be forcibly deleted; new core versions mark them unsupported and refuse v1
equivalence.

## 10. Docker/WebUI-first and A0 CLI-first convergence

Both flows invoke the same installer artifact and produce the same server bridge
record and native-host registration schema.

### 10.1 Docker/WebUI-first

1. Agent Zero confirms its additive server capability and displays a short-lived
   pairing offer.
2. WebUI detects platform/browser requirements and provides a signed host
   download plus exact instructions.
3. The user runs the installer on the computer running Chrome.
4. The per-user installer places the companion and exact native-messaging
   manifests into the host browser locations.
5. The companion makes an outbound authenticated connection to the Dockerized
   server at the user-approved address.
6. WebUI verifies, separately: server, extension identity, native registration,
   companion, pairing, versions/capabilities, permissions, legacy quarantine,
   and explicit selection.

`host.docker.internal` is network reachability, not host filesystem authority.
The design never mounts a Chrome profile/native-host directory into `/a0`, never
uses the Docker socket, and never says the container installed a host component.

### 10.2 A0 CLI-first

`a0 browser-extension install|status|repair|uninstall` uses a separate installer
module and does not reinterpret or mutate existing `/browser` commands. Install:

1. discovers or accepts the Agent Zero URL, such as
   `--host http://localhost:50080`;
2. verifies server capability before changing host state;
3. invokes the same signed companion installer and per-browser manifest
   registration;
4. performs pairing, native echo, protocol, and capability checks;
5. leaves the current runtime and browser selection unchanged;
6. exits without terminating the installed companion's on-demand operation or
   the active browser task.

If the CLI itself runs inside Docker or on a different computer from Chrome, it
must refuse a false local install and provide the host-side command/download.

### 10.3 Shared setup ladder

Both surfaces render these independent states:

```text
Agent Zero ready
-> Chrome extension installed
-> native companion installed
-> extension/native connected
-> server paired
-> versions and capabilities ready
-> legacy state quarantined or absent
-> explicitly selected
```

Repair targets the first failed layer. A later green layer never masks an
earlier failure.

## 11. Chrome update, permission, and rollback behavior

The service worker listens for `runtime.onUpdateAvailable`. When an update is
pending it persists the target version, stops accepting new mutations, reaches a
durable boundary for leases, approvals, artifacts, and receipts, closes the
native port, and calls `runtime.reload()` only when safe. It does not use an open
side panel as a keepalive or let the panel block an update indefinitely.

`requestUpdateCheck()` is used only after the server reports a known critical
incompatibility because Chrome throttles it. Normal Chrome update cadence remains
authoritative.

A forced reload, browser exit, disable, or accepted update invalidates the
session projection and generates a fresh extension-load generation. The durable
redacted ledger remains. Tabs from the old generation remain visible orphans;
old handles cannot mutate or close them.

Chrome Web Store rollback:

- republishes only the previous published package under a higher version;
- still reaches browsers through the normal update cycle;
- abandons a partial rollout and returns to the previous 100% version;
- discards pending/staged submissions;
- cannot restore purged credentials or cross-extension-ID data.

Therefore the prototype is never a supported rollback target. Rollback is only
to a signed schema-compatible v1 baseline. That package reads newer ledger
versions safely and never recreates legacy credentials.

## 12. Ordered release and retirement plan

### Phase 0 — identity and release prerequisites

- reserve production and clearly labeled beta store items;
- record exact IDs/origins and establish protected signing/release ownership;
- produce store listing, privacy disclosures, permission justifications,
  screenshots, support path, version history, and `CHROMEWEBSTORE.md`;
- create signed companion artifacts and exact per-browser native manifests;
- add version matrix, migration fixtures, clean-package checks, and security
  sentinel scans.

### Phase 1 — additive server foundation

- add schema, bridge principal, typed extension selection, layered status,
  cutover journal, legacy detector, quarantine hooks, and safe reason codes;
- keep the gate `disabled` and default runtime `container`;
- preserve every current status key and the legacy CDP codec;
- make no extension auto-selection or live Docker change.

### Phase 2 — companion, installers, and beta

- publish compatible signed companion/installers;
- ship the separate beta item to trusted testers/private group;
- set server gate `preview` only for explicit allowlisted subjects/bridges;
- test real packaged IDs and host manifests, not only unpacked builds.

### Phase 3 — production v1 baseline

- publish the schema-compatible baseline to 100%; use optional permissions only
  through a direct user gesture;
- verify purge, pairing, update drain, downgrade reading, and permission copy;
- soak long enough to make it the sole supported store rollback target.

### Phase 4 — final bridge-v1

- stage with deferred publishing and publish within the store's allowed window;
- add the frozen required permission set and Chrome 120 floor;
- remove raw-key UI, HTTP polling, worker timers, static all-site injection,
  full-state broadcasts, active-tab fallback, and the unsafe renderer/assets;
- keep the server gate at `preview` until packaged Docker and CLI acceptance.

### Phase 5 — controlled availability

- use beta and server allowlists for rings;
- use Web Store percentage rollout only if the item meets the store eligibility
  threshold; release percentage can increase but not decrease;
- because new installs may receive the latest package, treat the server feature
  gate—not store percentage—as the safety authority;
- move the server gate to `available` only after exit gates pass; selection
  remains explicit.

### Phase 6 — legacy retirement

- support migration-only legacy behavior for at least 90 days and two
  consecutive stable Agent Zero releases after v1 GA;
- remove legacy prompt/tool exposure, tombstone routes/status, then remove the
  plugin implementation in the following release;
- retain safe history/context redaction migrations for their documented data
  retention horizon;
- do not condition internal Docker browser or legacy A0 CLI CDP availability on
  extension adoption.

## 13. User and operator copy

Copy is normative in meaning; product wording may be shortened without hiding a
required consequence.

**Legacy detected**

> An older Agent Zero Chrome bridge is installed. It stores a reusable Agent
> Zero API token in Chrome and uses page-panel polling. Your current browser mode
> has not changed. Pair the new local companion before switching.

**Docker host boundary**

> Agent Zero is running in Docker at `http://localhost:50080`. Install the
> browser companion on this computer, where Chrome runs. The container cannot
> install into Chrome for you.

**Ready to switch**

> The new bridge is paired and ready but is not controlling Chrome. Starting the
> switch will stop the old bridge, preserve all existing tabs, remove its stored
> browser credential when possible, and then let you explicitly select the new
> bridge.

**Draining**

> Stopping the old Chrome bridge. New old-bridge actions are blocked while
> Agent Zero records which existing actions finished.

**Unfinished legacy action**

> An older browser action did not report a final outcome. Agent Zero will not
> retry it. The affected tabs were left open so you can review them.

**Cross-ID local cleanup required**

> Chrome does not let the new extension erase another extension's storage.
> Remove the older Agent Zero Chrome Bridge from Chrome to delete its saved API
> token and local data. No existing tabs will be closed.

**Credential rotation**

> The browser copy of the token was removed. If that token was dedicated to the
> old extension or may have been exposed, rotate it in Agent Zero. Rotation is a
> separate action because other API or MCP clients may use the same token.

**Migration complete**

> The old Chrome bridge is disabled, its browser credential is removed or you
> confirmed local cleanup, and this profile is paired with bridge v1. Your prior
> tabs remain open. Browser selection changes only when you choose Use this
> browser.

**Version mismatch**

> Agent Zero, the browser companion, and the Chrome extension do not share a
> compatible bridge version. Update the named component. No browser action was
> attempted and Agent Zero did not switch to another browser.

**Permission acceptance required**

> Chrome paused Agent Zero until you review its new browser permissions. Open
> Chrome Extensions, select Agent Zero Chrome Bridge, and approve the update.
> Your existing tabs remain open.

**Update safely deferred**

> An Agent Zero extension update is ready. It will install after this browser
> task reaches a safe stopping point. Closing the side panel does not stop the
> task.

**Forced generation reset**

> Chrome reloaded Agent Zero before the task finished. The affected tabs were
> left open for review; no action will be retried until Agent Zero confirms its
> outcome.

**Emergency pause**

> Extension-backed browsing is paused by the Agent Zero administrator. No new
> browser actions will start. Existing uncertain tabs remain open. Choose the
> internal browser or a configured A0 CLI browser manually if needed.

**Legacy retired**

> This older Chrome bridge is no longer supported. Update to the signed browser
> companion and current Chrome extension. Agent Zero will not send commands or
> accept results through the retired bridge.

Because a permission-disabled extension cannot show its own panel, WebUI and A0
CLI status must also surface permission-acceptance and missing-heartbeat repair
instructions.

## 14. Rollback boundaries

### 14.1 Before drain or purge

The user can cancel. Pairing remains inactive, current browser selection remains
exactly unchanged, and legacy use may continue during the compatibility window.

### 14.2 During drain

Cancellation cannot make an already-dispatched mutation unapplied. Completed
receipts are kept once; unresolved dispatches become `OUTCOME_UNKNOWN`. Tabs stay
open. Re-enabling legacy creates a fresh legacy generation/session and never
redelivers the prior queue.

### 14.3 After credential/local-state purge

The API key, base URL, draft, raw IDs, queue, screenshots, and context bindings
are intentionally unrecoverable. Downgrading to `0.1.0` yields an unconfigured
prototype and is unsupported. The user must not be prompted into silent raw-key
fallback.

### 14.4 Server rollback

Emergency gate-off stops new v1 dispatch, durably drains/finalizes known work,
and retains uncertain tabs. The selected `extension:` value is not silently
rewritten by generic configuration code. If the rollback target understands the
safe pre-activation snapshot, an explicit rollback action may restore the exact
prior container or legacy selection. Otherwise the user explicitly chooses a
supported runtime. Old server code cannot use a v1 bridge and must show an
incompatibility, not perform effects.

### 14.5 Companion and store rollback

The companion rolls back only to a signed, security-floor-compliant artifact
whose advertised range overlaps both server and extension. It preserves the
companion-held key unless the user explicitly unpairs. The Chrome package rolls
back only between schema-compatible v1 packages with monotonic Web Store
versions. Neither rollback re-enables legacy HTTP or recreates deleted data.

## 15. Failure codes and safe diagnostics

At minimum, implementations preserve these stable reason codes:

- `legacy_bridge_detected`
- `legacy_plugin_missing`
- `legacy_bridge_active`
- `legacy_cutover_in_progress`
- `legacy_bridge_retired`
- `legacy_local_purge_required`
- `legacy_outcome_unknown`
- `server_upgrade_required`
- `extension_update_required`
- `unsupported_browser`
- `permission_acceptance_required`
- `native_host_not_found`
- `native_host_forbidden`
- `native_host_failed`
- `native_protocol_error`
- `version_mismatch`
- `migration_incomplete`
- `storage_write_failed`
- `update_pending_active_work`
- `forced_generation_reset`
- `rollback_schema_newer`
- `beta_production_id_mismatch`
- `rollout_aborted`
- `explicit_extension_unavailable`

Diagnostics state the failed layer, safe component versions, capability bucket,
last safe state, and a repair action. They never expose API keys, pairing codes,
proofs, public keys, bridge/SID/context/chat/project IDs, native paths, base URLs
containing secrets, raw exceptions/stacks, URLs/origins, tab titles/favicons,
selectors, page text, typed values, screenshots, files, or command payloads.

## 16. Telemetry and rollout exit gates

Telemetry is bounded server-local audit by default. Remote aggregation is opt-in
and is not required for correctness. Allowed fields are:

- release channel, platform, and browser family;
- component version compatibility buckets and safe reason codes;
- selected backend enum, never its identifier;
- gate state and activation attempt/success/failure;
- `fallback_prevented` count;
- legacy detected/disabled/purge stage and migration duration;
- operation category, terminal status, and latency without payload;
- safe aggregate queued/dispatched/completed/canceled/unknown/orphan counts;
- update/rollback state and installer result code.

Do not collect an origin even hashed. Do not collect identifiers, page data,
files, screenshots, selectors, typed text, credentials, paths, or raw errors.

Each release ring must stop on any security regression, secret sentinel,
unbounded mutation ambiguity, unexpected fallback, cleanup of a non-owned tab,
data-loss signal, schema downgrade failure, or material increase in permission,
pairing, native-host, or migration failure.

General availability additionally requires:

- zero legacy commands after a completed cutover;
- zero fallback from explicit extension selection;
- zero secret in storage projections, UI, logs, APIs, bundles, or diagnostics;
- all old tabs retained during migration and all v1 cleanup lease-verified;
- Docker and A0 CLI clean install, repair, uninstall, reconnect, and rollback
  acceptance using the exact candidate artifacts;
- current source, package hash, store item/version, companion signature, server
  version, and live runtime read back independently.

Readiness, upload, review approval, and synthetic tests are not production/user
acceptance.

## 17. Implementation anchors

### 17.1 Chrome extension repository

Current anchors:

- `chrome-extension/src/manifest.ts`: replace the prototype manifest surface,
  version/channel keys, permissions, content registration, and Chrome floor;
- `src/background/store.ts`: sole exact-key migration entry, storage barrier,
  v1 projection, and journal;
- `src/background/index.ts`: remove REST polling, timers, panel gate, full-state
  broadcast, and legacy event paths; add top-level event registration, native
  lifecycle, update drain, and gated handlers;
- `src/background/browser.ts`: remove raw active-tab fallback/all-window authority
  and route only generation/lease-bound operations;
- `src/lib/api.ts`, `src/lib/compose.ts`, `src/lib/types.ts`: delete raw-key REST
  and prompt-like page-context paths; replace with v1 schemas and redacted types;
- `src/content/index.ts`: remove static legacy runtime; use v1 dynamic isolated
  execution and document-generation checks;
- `src/sidepanel/MessageList.tsx`: remove unsafe untrusted HTML rendering;
- `src/options/App.tsx` and `src/sidepanel/App.tsx`: remove raw token/base URL,
  polling, diagnostic dump, and panel-lifetime assumptions;
- `dist/`: rebuild into an empty staging directory and verify exact manifest-to-
  asset closure; never overlay old output;
- add `CHROMEWEBSTORE.md`, privacy policy source, permission/data-use checks,
  store assets, release manifest, and clean packaging script.

The implementation follows MV3 rules: state is durable/session storage, timers
use alarms, listeners register synchronously at service-worker top level,
optional permissions are requested as the first effect of a direct gesture, and
all asynchronous Chrome operations have typed error handling.

### 17.2 Agent Zero core

- `plugins/_browser/helpers/config.py`: preserve the two top-level modes and
  validate the reserved typed selection;
- `plugins/_browser/helpers/selector.py`: branch on `extension:` before generic
  host selection and unknown-backend normalization;
- preserve `plugins/_browser/helpers/connector_runtime.py` and add a distinct
  `extension_runtime.py` for the nested v1 codec;
- `plugins/_a0_connector/helpers/ws_runtime.py`: add a separate bridge registry,
  pending-operation bindings, cutover state, and legacy quarantine; never infer
  v1 from old host metadata;
- `plugins/_a0_connector/api/ws_connector.py`: authenticate and authorize the
  fixed-scope browser-bridge principal independently of WebUI sessions;
- `plugins/_a0_connector/api/v1/capabilities.py`: advertise bridge/pairing/cutover
  additively without replacing `a0-connector.v1`;
- `plugins/_a0_connector/api/v1/browser_runtime.py`: atomic explicit activation,
  safe prior-selection snapshot, and rollback action;
- `plugins/_browser/api/status.py`: retain existing keys and add layered redacted
  extension/cutover state;
- `plugins/_browser/webui/browser-config-store.js` and `config.html`: retain two
  top-level choices, add typed nested candidates, explicit activation, setup
  ladder, migration/repair states, and no automatic selection;
- prototype plugin: add controlled drain/tombstone behavior before removal;
- add a hook-owned exact legacy context/history redactor; do not modify
  `agent.py` or `initialize.py`.

Disabling `_browser` or `_a0_connector` reports an exact blocked layer. It never
switches runtime. Connector-pushed status plus bounded/focus refresh replaces
perpetual WebUI polling where practical.

### 17.3 A0 CLI and installer

- keep existing `/browser` host/container/selection/profile behavior unchanged;
- add `browser-extension install|status|repair|uninstall` in the CLI command
  router plus a separate installer module;
- share signed artifact metadata, transactional registration, pairing schema,
  diagnostics, rollback, and uninstall logic with WebUI-first setup;
- validate server capability before host mutation and never require the TUI to
  remain open.

### 17.4 Documentation and DOX

Update:

- `docs/guides/browser.md` and `docs/guides/a0-cli-connector.md`;
- a new extension install/migration/troubleshooting and Docker host-boundary
  guide;
- release notes and legacy retirement schedule;
- `plugins/_browser/AGENTS.md`, `plugins/_a0_connector/AGENTS.md`,
  `plugins/AGENTS.md`, `helpers/AGENTS.md`, `tests/AGENTS.md`, and affected
  API/WebSocket `.dox.md` contracts.

Documentation must distinguish installation, pairing, readiness, explicit
selection, live runtime acceptance, store publication, and migration completion.

## 18. Required tests

### 18.1 Migration and forbidden-state tests

- exact, partial, corrupt, oversized, wrong-type, and absent legacy storage;
- crash/fault injection before and after every journal write/remove/read-back;
- quota/I/O failure blocks all effects;
- no legacy value appears in logs, messages, new storage, native frames, UI, or
  artifacts;
- no legacy raw tab ID becomes authority and every pre-v1 tab stays open;
- same-ID purge is machine verified; cross-ID cleanup can only be attested;
- rerunning every migration and redactor step is idempotent;
- exact tool-result screenshot redaction preserves user attachments.

### 18.2 Drain and split-brain tests

- queued, dispatched, completed, late, duplicate, stale, and cross-session
  legacy results;
- no redelivery after drain starts;
- exact `CANCELED_NOT_APPLIED` and `OUTCOME_UNKNOWN` classification;
- new session/enqueue/pull rejected during drain and 410 after retirement;
- no prompt/tool path can dispatch after quarantine;
- plugin reload/restart during every state remains fail-closed;
- two extensions/profiles cannot bind the same context simultaneously.

### 18.3 Compatibility and regression tests

- every row in section 6, including malformed reserved selections;
- exact extension bridge resolution, disconnect, pending binding, and no
  fallback;
- old A0 CLI ignores additive capability fields and retains current CDP behavior;
- new CLI install against old server stops before changing the host;
- all internal-browser, extension-manager, A0 CLI CDP/Playwright, connector,
  WebSocket security/CSRF, and browser agent regression suites stay green;
- Docker/WebUI-first and CLI-first produce the same redacted bridge record.

### 18.4 Chrome packaged-update tests

- pack baseline and final packages with the same production test key;
- optional-permission baseline remains enabled; final warning-bearing update
  enters permission-acceptance state when expected;
- production and beta IDs work only with their exact allowed origins; random
  unpacked IDs and wildcard origins fail;
- correct per-user registration for Chrome, Chrome for Testing, and Chromium on
  each supported OS;
- update arrives during idle, active operation, approval, artifact transfer,
  lease finalization, and open side panel;
- forced reload/profile restart creates a new generation, leaves old tabs as
  orphans, and rejects old handles;
- missing/wrong host manifest, executable permission/path failure, host crash,
  malformed/oversized frame, stdout contamination, and version mismatch.

### 18.5 Rollback, packaging, store, and release tests

- final package -> higher-version baseline rollback reads the new schema and
  never requires a deleted secret;
- old server and incompatible companion yield no browser effect;
- signed companion rollback preserves the key and respects the security floor;
- interrupted installer restores the exact prior binary/manifest state;
- clean build into an empty staging directory contains every referenced asset
  and no orphan old JS/CSS;
- static forbidden-fingerprint scan covers source and packaged output;
- store listing/privacy/permission declarations match the manifest and runtime;
- trusted-tester beta, deferred production submission, exact item IDs, package
  version/hash, signing evidence, and dashboard status are read back;
- ring metrics and stop gates are exercised before expansion.

Forbidden production fingerprints include `X-API-KEY`, the legacy REST routes,
legacy `apiKey` config, command `setInterval`, `panelConnected` gating,
`chrome_bridge`, static `content_scripts`, raw `image_data_url`, unsafe raw HTML
insertion, and remote font URLs. The exact legacy storage key is allowed only in
the migration module and fixtures.

## 19. Frozen non-effects and next frontier

This decision makes no production change. In particular it does not:

- install, disable, delete, pair, select, or repair any browser component;
- alter the running Docker instance or mounted Agent Zero data;
- change the default internal browser or existing A0 CLI CDP behavior;
- publish a store item or claim store/runtime acceptance;
- close, group, navigate, claim, or inspect any user tab;
- rotate the Agent Zero API/MCP token;
- edit `agent.py` or `initialize.py`.

The architecture decision queue is now clear. The next frontier is an execution
slice: **security and compatibility foundation**—versioned schemas and fixtures,
an off-by-default server feature gate and layered status, typed selection
validation/no-fallback tests, and legacy detection/quarantine tests. It performs
no browser mutation and no live deployment. Later vertical slices add the
companion/installer, MV3 runtime, UI, and release acceptance in dependency order.
