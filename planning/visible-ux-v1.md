# Agent Zero Browser Bridge Visible UX v1

Status: **Frozen architecture decision**  
Contract: `a0.browser-bridge.visible-ux.v1`  
Canonical map: https://github.com/TerminallyLazy/agent-zero/issues/13  
Decision ticket: https://github.com/TerminallyLazy/agent-zero/issues/19  
Depends on: `a0.browser-bridge.trust.v1`,
`a0.browser-bridge.install.v1`, `a0.browser-bridge.adapter.v1`, and
`a0.browser-bridge.mv3-runtime.v1`

## 1. Verdict

Agent Zero has one browser task and conversation, rendered through two
synchronized shells: the Agent Zero WebUI and a tab-bound Chrome side panel.
Neither surface owns a second chat, transport, policy decision, or browser
lifecycle. Closing the panel affects only presentation; the task continues.

The experience follows the public ChatGPT browser extension's useful product
patterns—side chat associated with the invoking tab, recent-task continuity,
explicit tab and selected-text context, concise activity, a quiet composer, and
native tab groups—without copying OpenAI branding, assets, wording, geometry, or
unpublished behavior. Agent Zero adds its own explicit ownership, cleanup,
recovery, and accessibility contract.

The panel never silently reads the current page, retargets when the active tab
changes, or stores an API key. It stages locally visible context as removable
chips; page content enters Agent Zero only after an explicit send/attach action
and the applicable site-policy decision. Only agent-created tabs join the task
group and close by default. Claimed user tabs stay in place and stay open.

The visual system is calm and sparse. Conversation is the main surface;
browser activity, approvals, and tab ownership appear inline only when useful.
The illuminated cursor is non-interactive visual telemetry with an equivalent
redacted text status in the panel.

## 2. Evidence boundary

Public OpenAI documentation establishes product precedent, not a protocol or
implementation blueprint:

- side chat opens from browser chrome and remains associated with the tab where
  it was opened;
- recent chats can continue between the app and side chat;
- open tabs and selected text can be brought into a chat, including from a
  context-menu action;
- setup and persistent site policy live in the main application;
- browser work may use the user's existing signed-in profile while a separate
  built-in browser has isolated state.

Sources:

- https://learn.chatgpt.com/docs/chrome-extension
- https://help.openai.com/en/articles/20001277-using-the-built-in-browser-in-the-chatgpt-desktop-app
- https://chromewebstore.google.com/detail/chatgpt/hehggadaopoacecdllhhajmbjkdcmajg

The public sources do **not** specify OpenAI's private transport, cursor
implementation, group lifecycle, cleanup algorithm, or approval-card layout.
Those details below are Agent Zero decisions derived from the frozen trust,
adapter, and MV3 runtime contracts.

Chrome's platform contract also shapes the design:

- a tab-specific side panel can have its own instance and follows the tab;
- programmatic `sidePanel.open()` requires a user gesture;
- side-panel controls do not receive `activeTab` authority;
- a service worker, not the panel, owns privileged and durable work.

Sources:

- https://developer.chrome.com/docs/extensions/reference/api/sidePanel
- https://developer.chrome.com/docs/extensions/develop/concepts/activeTab
- https://developer.chrome.com/docs/extensions/develop/ui/a11y

An earlier product-reference brief, not included in this repository, informed
the desired outcomes. It was not an authoritative source of instructions.

## 3. Experience invariants

1. **One authoritative task.** Thread, challenge, activity, ownership, and tab
   disposition objects have the same identifiers and terminal state in WebUI
   and side panel.
2. **User action opens UI.** Remote events may set badge/status state but never
   force the side panel open or steal focus.
3. **Context is explicit.** Opening the panel exposes only local display
   metadata. Page content, selection text, screenshots, and files are attached
   only by an explicit user action.
4. **The invoking tab anchors the panel.** Switching browser tabs does not
   silently change the panel's anchor or attached context.
5. **User ownership wins.** User intervention pauses/releases the affected
   lease. The extension does not fight a move, ungroup, close, focus change, or
   Chrome debugger cancellation.
6. **Cleanup is visible and exact.** Before the first agent-created tab, the UI
   says temporary task tabs close when work ends. Completion reports what was
   closed, retained, handed off, or left uncertain.
7. **No color-only or motion-only meaning.** Every state has text and a static
   equivalent.
8. **Page content is untrusted.** The page cannot author product approvals,
   accessibility announcements, task identity, or policy copy.
9. **Secrets stay out of UI state.** No raw API key, connector credential,
   sensitive field value, full query string, or fragment is rendered or stored.
10. **Panel lifetime is irrelevant to work lifetime.** Close/reopen reconstructs
    the current projection without cancellation, duplicate work, or autofocus.

## 4. Surface responsibilities

| Surface | Owns | Does not own |
|---|---|---|
| Agent Zero Browser settings | Runtime choice, install/pairing ladder, persistent site policy, capabilities, version/update/repair/uninstall, sanitized diagnostics | Chrome API execution, extension-local secrets, separate conversation |
| Agent Zero thread | Canonical conversation, browser context picker, challenges, activity, stop/cancel, final result | Direct DOM access, Chrome tab IDs |
| Chrome side panel | Tab-bound view of the same thread, local context staging, approvals, current action, task tabs, send/update/stop controls | Native port, policy authority, operation retry, finalization on close |
| Chrome browser chrome | Action entry point, badge, native debugger warning, native task group | Product approval replacement or hidden background authority |
| Page overlay | Cursor, target ring, compact `Agent Zero` identity label | Input capture, focus, page mutation, live-region announcements |
| Extension options | Browser-local pairing/health/version/permissions and links to authoritative Browser settings | Raw server/API-key configuration, duplicate site policy, polling controls |

## 5. Side-panel binding and entry points

The primary entry point is the extension toolbar action. The manifest has an
action but no popup. A synchronous `chrome.action.onClicked` handler configures
and opens a **tab-specific** panel for the clicked tab. This preserves the
documented side-chat expectation that the panel stays with the invoking tab.
The panel receives the tab identifier through service-worker state; it never
infers it with `activeTab`.

Secondary entry points are:

- a keyboard command chosen so it does not override browser zoom, screen-reader,
  or platform editing shortcuts;
- `Ask Agent Zero` in the page/selection context menu;
- `Open side panel` from Agent Zero WebUI after a browser-host user gesture where
  the platform can honor it.

Every entry point stages, but does not transmit, a candidate for the invoking
tab. A context-menu selection also stages a bounded selection chip. If the
panel is already open on another tab, opening it on the new tab creates or
reveals that tab's panel instance; it does not mutate the first tab's draft or
anchor.

A panel can select any authorized Agent Zero task from its task switcher. Its
anchor remains the invoking browser tab. The header always shows both the
selected task and the anchor origin so these concepts cannot be confused.

## 6. Information architecture

DOM and visual order are identical:

1. header: Agent Zero mark, task switcher/title, connection state, task-tab
   count, and overflow menu;
2. attention rail: at most one highest-priority approval, intervention, blocked,
   reconnect, update, or orphan item;
3. current action: a compact redacted action plus origin;
4. conversation: user messages, assistant content, and compact activity receipts;
5. task tabs: collapsed summary by default, expanded ownership list on request;
6. composer: context chips, labeled input, attach control, Send update, and Stop
   while work is active.

The panel is not a dashboard. Connection details, model selection, project
selection, raw JSON, screenshots, and polling controls do not compete with the
conversation. Advanced diagnostics live in Browser settings/options.

### 6.1 Working wireframe

```text
┌──────────────────────────────────────┐
│ [A0] Research vendors ▾   3 tabs  ⋯ │
│ ● Working · comparing on example.com │
├──────────────────────────────────────┤
│ You                                  │
│ Compare these vendors and summarize. │
│                                      │
│ Agent Zero                           │
│ I found three relevant plans…        │
│  ✓ Read pricing · 8s                 │
│  ● Comparing support terms           │
│                                      │
│ Task tabs ▸ 2 temporary · 1 yours    │
├──────────────────────────────────────┤
│ [Pricing ×] [Selection · 184 chars ×]│
│ Message Agent Zero…                  │
│ [+ Attach]       [Stop] [Send update]│
└──────────────────────────────────────┘
```

### 6.2 Approval wireframe

```text
┌──────────────────────────────────────┐
│ [A0] Research vendors ▾   3 tabs  ⋯ │
├──────────────────────────────────────┤
│ Approval required                    │
│ Submit contact form on example.com   │
│ This sends your name and email.      │
│                       [Review request]│
├──────────────────────────────────────┤
│ Conversation remains readable…       │
├──────────────────────────────────────┤
│ Message Agent Zero…            [Stop]│
└──────────────────────────────────────┘
```

The incoming card never opens a dialog or moves focus. Activating `Review
request` opens the appropriate dialog.

### 6.3 Completion wireframe

```text
┌──────────────────────────────────────┐
│ [A0] Research vendors       Complete │
├──────────────────────────────────────┤
│ Finished                             │
│ Closed 3 temporary task tabs.        │
│ Kept your pricing tab open.          │
│ Retained 1 results tab for handoff.  │
│ [Open result]        [View activity] │
├──────────────────────────────────────┤
│ Ask a follow-up…              [Send] │
└──────────────────────────────────────┘
```

### 6.4 Browser-settings wireframe

```text
Browser runtime
(•) Internal browser
( ) Your browser
    (•) Agent Zero extension  Recommended
    ( ) A0 CLI remote debugging  Advanced

Your browser
✓ Agent Zero server       http://localhost:50080
✓ Native browser bridge  Connected on this computer
✓ Chrome extension       Paired with this profile
✓ Browser permissions    Ready

[Manage site access] [Run diagnostics] [Repair]
```

Docker copy is explicit:

> Agent Zero is running in Docker at `http://localhost:50080`. The browser
> bridge runs on this computer so Chrome can communicate with that instance.

## 7. User-visible state contract

Every state renders a stable title, explanatory copy, one clear primary next
action, and text-plus-icon status. `event_id` deduplication prevents repeat
announcements after rerender or reconnect.

| State | Required presentation and primary action |
|---|---|
| `unavailable` | Unsupported browser/profile or disabled capability. **Open compatibility help.** |
| `setup_required` | Identify the missing extension or browser-host companion, never generic “offline.” **Open Browser settings.** |
| `unpaired` | Name the detected local components and what pairing permits. **Pair browser.** |
| `pairing` | Indeterminate labeled progress; Cancel remains available. **Finish pairing** when code confirmation is required. |
| `connecting` | Name server, companion, and profile layers separately. **Troubleshoot** only after bounded automatic retry. |
| `connected_idle` | Show server identity and anchor origin. **Send** starts or continues the selected Agent Zero task. |
| `context_staged` | Show exactly which tab/selection/file will be shared and removable chips. **Send with context.** |
| `starting` | Stable task position and “Starting browser task.” **Stop** remains available. |
| `running` | Current redacted action, origin, elapsed phase, task tabs, and activity. **Send update**; Stop is always adjacent. |
| `waiting_site_approval` | Origin, requested capability, reason, scope, and expiry. **Review request.** |
| `waiting_action_confirmation` | Exact action, destination/account, data category, effect, tab count, and expiry. **Review request.** |
| `waiting_user` | Exact sign-in, CAPTCHA, file-picker, or other requested intervention. **I’m done** after the user acts; Cancel remains available. |
| `user_takeover` | “You took control; Agent Zero stopped using this tab.” **Resume control** is explicit and revalidates policy/identity. |
| `paused` | State the actor/reason. **Resume task**; Stop and inspect tabs remain available. |
| `reconnecting` | Existing work and tabs remain visible; show affected layer. **Troubleshoot** while safe automatic reconnect continues. |
| `update_pending` | Update waits for a safe boundary. **Review update**; active work is never interrupted implicitly. |
| `completing` | “Finishing task” and provisional tab disposition. **Stop** only while the protocol can still honor it. |
| `completed` | Result plus exact closed/retained/handoff counts. **Open result.** |
| `handoff_ready` | Retained deliverable has left agent lifecycle and will stay open. **Focus retained tab.** |
| `failed` | Affected action, whether it was applied, and safe recovery. **Retry** only for protocol-proven `not_applied`; otherwise inspect. |
| `outcome_unknown` | “This action may have completed. It will not be retried automatically.” **Inspect page.** |
| `canceled` | Cancellation and exact tab disposition. **View retained tabs** when any remain. |
| `blocked` | Identity/version/security/policy fault with safe diagnostic summary. **Open Browser settings.** |
| `orphan_review` | Uncertain prior-generation tabs stay open and lose control. **Review retained tabs.** |

Initial page load does not announce a stable state. Transitions to approval,
failure, unknown outcome, or interrupted work announce once. Background state
changes never steal focus.

## 8. Conversation and composer

Assistant responses use normal full-width document flow. User messages use a
quiet, compact bubble. Activity receipts are short, interleaved rows such as
`Read pricing · 8s`; a disclosure reveals redacted detail. Historical activity
is a normal ordered list with live announcements disabled.

The composer has a persistent visually hidden label. It grows vertically and
remains usable while work runs so the user can steer the task. `Enter` sends;
`Shift+Enter` inserts a line break. During work, `Send update` and `Stop` are
separate controls—sending an update never masquerades as stopping the task.

The attach menu offers only locally discoverable candidates:

- Current tab
- Other open tab
- Current selection, when present
- Screenshot
- Files

Each chip contains a type, bounded title/origin or filename, and Remove button.
Opening the attach menu or context menu does not grant authority. A candidate
becomes remotely readable only when the user submits it and policy succeeds.
Side-panel drafts are per task and per anchor tab, stored in
`chrome.storage.session` only, capped at 20 KiB, expire after 30 minutes, and
clear on send, reset, or generation change.

Task switching never changes the anchor tab, silently attaches it, or discards
an unsent draft. If a second surface updates the same task, messages and states
merge by server revision rather than arrival time.

## 9. Tab ownership, groups, and disposition

The native group title is `A0 · <sanitized task label>`, capped at 40 grapheme
clusters. The label is action-oriented, excludes secrets, personal identifiers,
URLs, and verbatim prompts, and falls back to `A0 · Browser task`. A
deterministic Chrome-supported color is chosen from the task identity; blue is
the default. Only agent-created leased tabs enter this group.

Claimed user tabs remain in their original window, position, pin state, and
group. The extension never renames, recolors, or absorbs an existing user group.
Background work preserves the user's active window and tab unless visible
foreground interaction is necessary or explicitly requested.

The task-tab collection is a list of articles, not an ARIA tab widget and not a
single nested-click target. Each card shows bounded title, redacted origin,
favicon, ownership, state, and independent controls:

- `Focus <page title>`
- `Details`
- `Keep open` for an ephemeral agent-created tab
- `Release from task` for a claimed tab
- `Close tab…` only for an agent-created tab and only after confirmation

Required labels are:

- `Your tab · stays open`
- `Agent-created · closes when task ends`
- `Kept open`
- `You took control · Agent Zero stopped using this tab`
- `Needs review · left open`

Moving, pinning, ungrouping, closing, or canceling Chrome debugging for a
controlled tab is user takeover. The affected lease pauses/releases and is
never silently reclaimed. `Keep open` changes disposition to deliverable and
ungroups/releases it at finalization. Uncertain ownership always retains the tab.
When the last owned tab is closed or released, Chrome may remove the empty group.

Before Agent Zero creates its first tab for a task, show once:

> Agent Zero will group temporary task tabs and close them when this task ends.
> Your existing tabs always stay open. You can keep any result.

## 10. Approval and user-intervention interaction

An incoming challenge creates a persistent attention card, one alert keyed by
challenge ID, and an attention badge. It does not open a modal, focus a control,
or consume the user's current Enter key. `Review request` opens a dialog only
after activation.

### 10.1 Site access

The review names exact origin, requested capability, task purpose, expiry, and
whether page data will enter Agent Zero. Actions are:

- `Allow once` — primary
- `Allow for this task` — exact origin, context, turn, and bounded lifetime
- `Always allow example.com` — persistent exact origin with revocation copy
- `Block this site` — persistent exact-origin denial
- `Decline`

Global all-sites access exists only in Browser settings behind an elevated-risk
confirmation. It is never a routine inline choice. History is outside v1.

### 10.2 Consequential action

The review names action, origin, destination/account, data category, external
effect, affected tabs/files, and expiry. Actions are `Approve once` and
`Decline`; no persistent grant appears unless a later trust contract adds one.
File transfer copy names site, filename, direction, and destination without
exposing sensitive content.

### 10.3 Dialog behavior

Routine review uses a modal dialog. Irreversible, credential, publication,
message-send, upload, purchase, account-change, or multi-tab-close decisions
use `alertdialog` semantics. The background is inert and focus is trapped.
`Escape` always declines/cancels and never approves. The approval button is not
the implicit default; concise destructive dialogs initially focus the safe
action, while long dialogs focus their heading. Close restores focus to the
invoking review control or the next logical task heading.

After a response, controls disable and copy reads `Recording decision…` until
server acknowledgement. The first terminal response across WebUI and panel
wins. All other surfaces update to `Approved`, `Declined`, `Expired`, or
`Already resolved`; no stale control remains actionable and no operation is
replayed from the UI.

Sign-in, CAPTCHA, native file selection, and other user work use a non-modal
intervention card. The cursor freezes, the lease is marked waiting, and the
agent continues only after `I’m done` or an explicit safe alternative.

## 11. Browser chrome and illuminated cursor

### 11.1 Extension action and badge

The existing Agent Zero mark remains the extension icon. Badge semantics are:

| State | Badge | Accessible action title |
|---|---|---|
| Idle/ready | empty | `Agent Zero — connected` |
| Working | `•` on Agent Zero blue | `Agent Zero — working` |
| Attention/approval | `!` on amber | `Agent Zero — approval required` |
| Disconnected during work | `!` on red | `Agent Zero — disconnected` |
| Completed | `✓` on green for at most 5 seconds | `Agent Zero — task complete` |

Text/title always carries meaning; badge color is supplementary. V1 requests no
notification permission, so operating-system notifications are not part of this
contract. Chrome's native debugger banner is never hidden, covered, or imitated.

### 11.2 Cursor

The cursor is Agent Zero visual telemetry, not a substitute operating-system
pointer. It consists of a compact branded pointer/dot, black-and-white dual
outline, restrained blue halo, optional `A0` label, and a separate target ring.
The ring appears before a click and pulses once after activation. It renders only
meaningful action endpoints, not streamed pointer coordinates.

The overlay is a fixed, layout-independent shadow host injected in an isolated
content-script world. The host and descendants are `aria-hidden="true"`,
`pointer-events: none`, `user-select: none`, unfocusable, and have no input or
focus listeners. It never changes selection, invokes `scrollIntoView` merely
for animation, alters page dimensions, or captures click/drag/hover/keyboard/
touch. It is excluded from screenshots returned to the agent.

Normal travel is interruptible and bounded by the MV3 contract's 600 ms ceiling.
Under `prefers-reduced-motion: reduce`, movement is instantaneous and the target
is static. Forced-colors mode uses system colors and outlines, not glow. The
overlay freezes or disappears immediately on approval, pause, navigation,
lease loss, user takeover, completion, or disconnect. The redacted screen-reader
equivalent lives only in the panel current-action status.

## 12. Setup, diagnostics, and equivalent entry paths

Browser settings preserve the existing top-level runtime choices:

- `Internal browser`
- `Your browser` (`host_required` in the adapter contract)

Inside `Your browser`, the UI offers `Agent Zero extension` as recommended and
`A0 CLI remote debugging` as advanced/legacy. The UX does not invent a third
top-level runtime that would violate the adapter contract.

The authoritative readiness ladder is:

1. Agent Zero server
2. native browser companion
3. extension and browser profile
4. paired companion identity
5. negotiated capabilities and site policy

Each row has its own state, version, sanitized diagnosis, and applicable
install/pair/update/repair action. A single green `Connected` may not mask a
failed layer.

### 12.1 Docker/WebUI-first

1. Select `Your browser` in Browser settings.
2. Download the signed host installer and open the extension-store listing.
3. The installer registers the companion on the computer running Chrome, never
   in the container.
4. Create a short-lived, single-use pairing code in WebUI.
5. Enter/confirm it in the extension onboarding surface.
6. Browser settings reads back all five layers before enabling selection.

### 12.2 A0 CLI-first

1. Run `a0 browser-extension install`.
2. The CLI installs the same companion/manifest and opens extension onboarding.
3. It uses the selected Agent Zero host to initiate the same pairing protocol.
4. `a0 browser-extension status|repair|uninstall` presents the same readiness
   layers and deterministic outcomes.
5. After pairing, Browser settings remains the authority for policy and health;
   the CLI TUI does not remain open.

### 12.3 Extension onboarding/options

The unpaired panel presents concise explanation, companion detection, and
`Pair browser`; it never requests base URL plus raw API key. Once paired, the
options page shows only local profile, extension version/ID, companion detection,
permission readiness, paired server display name, and links to Browser settings,
repair, disconnect, and uninstall documentation. Persistent policy and raw
diagnostics remain in Agent Zero.

## 13. Visual system

The design uses Agent Zero's own mark and semantic tokens. Rubik is the primary
UI family and Roboto Mono is reserved for bounded identifiers/diagnostics. Font
files are bundled with their licenses or the platform system stack is used;
remote font imports and remote runtime assets are prohibited.

Required semantic tokens are `background`, `surface`, `surface-raised`,
`input`, `border`, `text`, `text-muted`, `brand`, `attention`, `danger`,
`success`, and `focus`. Light, dark, and forced-colors themes meet the contrast
acceptance below. Chrome group colors are not copied directly into text without
contrast validation.

Layout uses a 4/8/12/16/24 px spacing scale, 10–12 px controls, 18–20 px user
message bubbles, and one 22–24 px composer surface. Decorative gradients,
backdrop blur, stacked glass cards, and perpetual pulsing are removed. State
transitions are 120–180 ms; no motion is required to understand state.

At 320 CSS px the layout is one column, chips wrap, button groups stack in DOM
order, long text uses `overflow-wrap: anywhere`, and there is no page-level
horizontal scrolling. Logical properties support a left- or right-positioned
panel and RTL text.

## 14. Accessibility acceptance

Target WCAG 2.2 AA and native HTML first. Do not use `role="application"`.

- Landmarks are `header`, `main`, and a named composer/footer; the task title is
  the level-one heading.
- One pre-rendered `role="status"` is polite and atomic for non-urgent state.
  Current-action announcements are redacted, replaced atomically, deduplicated,
  and coalesced to at most one per two seconds.
- One separate alert channel is used once per approval, interrupted task, new
  error, or unknown outcome. Historical activity has live announcements off.
- Background updates never move focus. Stable keyed nodes preserve focus and
  active-tab changes never reorder task cards.
- Native buttons, inputs, progress, lists, disclosures, and dialogs provide
  accessible name/role/state. No click-only `div`, positive `tabindex`, or
  tooltip-only action is permitted.
- Every operation is keyboard accessible. `Escape` closes menus/dialogs and
  restores focus. Focus has a 2 CSS px minimum visible outline with 3:1 adjacent
  contrast and is not obscured by sticky UI.
- Text meets 4.5:1 contrast, large text and UI indicators 3:1. Meaning never
  depends on color.
- Actionable targets are at least 32 by 32 CSS px; 44 px is preferred. The hard
  WCAG floor is 24 by 24.
- The panel reflows at 320 CSS px, 200% text zoom, and 400% browser zoom without
  clipped text, lost controls, overlap, or two-dimensional scrolling.
- Reduced motion eliminates cursor travel, pulse, smooth scroll, and ornamental
  transitions. Forced-colors light/dark retain focus, selected/current/error
  states, dialogs, and cursor/target boundaries.
- `aria-busy` applies only to the subsection being updated. Stop/Pause controls
  remain operable. Progress is native and labeled; spoken updates are named
  phases or milestones, at most one per five seconds.
- Visible validation errors use `aria-invalid` and `aria-describedby`; submit
  focuses the first invalid field. A failed user-triggered action normally keeps
  focus on its initiating control.

ARIA/APG references:

- https://www.w3.org/TR/wai-aria-1.2/#status
- https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/
- https://www.w3.org/WAI/ARIA/apg/patterns/alertdialog/
- https://www.w3.org/WAI/WCAG22/Understanding/reflow.html
- https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html
- https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html

## 15. Content safety and privacy

- Assistant Markdown is parsed through an allowlisted structural renderer or a
  maintained sanitizer. Raw unsanitized `dangerouslySetInnerHTML` is forbidden.
- Page titles, origins, selection labels, filenames, and favicon URLs are
  untrusted, escaped, bounded, and never used as HTML. External links use a safe
  new-tab policy and cannot access the extension opener.
- Page-authored text cannot become an approval title/button, browser badge,
  extension status, or live announcement.
- Initial panel opening transmits no page content. Candidate metadata stays in
  session storage until the user submits it.
- Full URLs are reduced to origin plus a safe bounded path label when needed;
  query and fragment are excluded from normal UI, logs, and announcements.
- Screenshot previews and page content are not persisted in extension local
  storage. The MV3 ledger remains redacted as already frozen.
- No remote fonts, scripts, CSS, or images are loaded by extension pages.
- Errors show a stable safe code and recovery action, not raw stack traces,
  native host paths, credentials, or connector payloads.

## 16. Implementation insertion points

This session does not implement production UI. The first implementation slice
uses these boundaries.

### 16.1 Chrome extension

| Current/new module | Required change |
|---|---|
| `chrome-extension/src/manifest.ts` | Action without popup; tab-specific side panel; keyboard command; context menu; no new v1 permissions |
| `chrome-extension/src/background/index.ts` | Register action/command/context-menu listeners synchronously and route user-gesture panel opens |
| `chrome-extension/src/background/store.ts` | Delete API-key persistence/broadcast; retain only the redacted tiered runtime state frozen in MV3 v1 |
| `chrome-extension/src/background/browser.ts` | Replace all-tab/raw-ID/full-URL enumeration with local candidate projection and opaque, leased handles |
| `chrome-extension/src/lib/compose.ts` | Stop concatenating page content/URLs into natural-language intent; send typed untrusted context objects |
| `chrome-extension/src/protocol/presentation.ts` (new) | Strict redacted `BridgeHealth`, `TaskPresentation`, `TabPresentation`, `ChallengePresentation`, `OperationPresentation`, and deliverable schemas |
| `chrome-extension/src/background/presentation.ts` (new) | Build safe panel/options snapshots with monotonic revisions |
| `chrome-extension/src/background/ui-router.ts` (new) | Project server/runtime state to panels; stage local candidates; never own native connection |
| `chrome-extension/src/sidepanel/App.tsx` | Reduce to shell/state router; remove raw setup, project/model clutter, polling, and unsafe reset actions |
| `chrome-extension/src/sidepanel/state.ts` (new) | Exhaustive discriminated UI state and revision/event deduplication |
| `chrome-extension/src/sidepanel/components/` (new) | `TaskHeader`, `AttentionRail`, `CurrentAction`, `ConversationLog`, `ActivityReceipt`, `ApprovalCard`, `TaskTabList`, `TaskTabCard`, `Composer`, `ContextChip`, `TaskSwitcher`, `RecoveryState`, `ConfirmDialog` |
| `chrome-extension/src/sidepanel/MessageList.tsx` | Replace raw HTML injection with safe semantic Markdown/content rendering |
| `chrome-extension/src/sidepanel/styles.css` | Semantic tokens, light/dark/forced-colors, narrow reflow, focus, reduced motion; remove remote font and perpetual pulse |
| `chrome-extension/src/options/App.tsx` | Replace raw URL/API-key form and JSON snapshot with pairing/local health/repair handoff |
| `chrome-extension/src/options/styles.css` | Share the panel token system rather than a second visual language |
| `chrome-extension/src/content/index.ts` plus isolated `cursor.ts`, `overlay.ts`, and `semantics.ts` | Non-intercepting cursor shadow host and teardown; no raw-selector automation authority |
| `chrome-extension/src/lib/types.ts` | UI projection, context-candidate, challenge, tab-disposition, and safe diagnostic types |
| `chrome-extension/CHROMEWEBSTORE.md` | Permission justifications, context/data handling, setup, accessible behavior, test instructions, and screenshots before release |

Component code uses `async`/`await` with explicit error states. Side-panel code
does not keep authoritative state in module globals, use `activeTab`, or create
long-running timers.

### 16.2 Agent Zero

| Current/new module | Required change |
|---|---|
| `plugins/_browser/webui/config.html` | Add an instance-scoped bridge card after Browser Runtime and before Browsing; extension path remains under `host_required`; include readiness ladder, Docker boundary copy, persistent policy and repair controls |
| `plugins/_browser/webui/config.html` existing `Extensions` card | Rename visible scope to `Internal browser add-ons` so it cannot be confused with the host Chrome extension |
| `plugins/_browser/webui/browser-config-store.js` | Accept typed extension candidates without `cdp_endpoint`; keep project selection as `host_browser_selection=extension:<bridge_id>` and state `Save to apply` |
| instance-global `browserBridgeSettings` store (new) | Pairing, bridge inventory, policy, audit, and layered status use immediate CSRF-protected actions, separate from project draft state |
| `plugins/_browser/webui/browser-panel.html` | Branch before internal Xpra initialization and render an extension-specific panel when selected |
| extension-specific browser surface/store (new) | Consume canonical revisioned task/ownership/approval projection, offer `Open task in Chrome`, and never initialize Xpra |
| `plugins/_browser/api/status.py` | Expose the layered safe readiness schema frozen by the adapter contract |
| `plugins/_a0_connector/` pairing/API modules | Serve short-lived pairing and challenge-resolution UI actions from trust contract |
| Agent Zero chat composer modules | Add browser/tab/selection picker backed by the connector projection, not DOM injection from the extension |
| `agent0ai/a0-connector/src/agent_zero_cli/` | `browser-extension install|status|repair|uninstall` with the same readiness vocabulary |

Exact filenames for new pairing APIs and Agent Zero composer components must be
confirmed against the implementation checkout before coding; this contract does
not create parallel APIs where the adapter/installer work lands first.

Agent Zero WebUI implementation reuses `createStore`, `callJsonApi`/`fetchApi`,
shared `openModal`, notifications, `x-icon`, local component styles, and proper
`x-create`/`x-destroy` cleanup. It reuses the existing DOMPurify/marked safety
pipeline in `webui/js/safe-markdown.js` and semantic theme tokens from
`webui/index.css`; it does not copy the entire WebUI stylesheet into the
extension.

### 16.3 Prototype hazards that block release

The implementation is incomplete until all of these current paths are removed
or made unreachable:

- `MessageList.tsx` sends parsed Markdown directly to
  `dangerouslySetInnerHTML` without sanitization;
- `background/store.ts` persists the raw Agent Zero API key and broadcasts the
  same configuration to extension pages;
- `options/App.tsx` renders a raw runtime snapshot that may include secrets,
  URLs, and provider identifiers;
- `background/index.ts` polls on `setInterval` and only while a side-panel port
  exists, making panel close a task-lifetime event;
- `background/browser.ts` enumerates all tabs and exposes raw Chrome IDs and
  full URLs;
- `content/index.ts` performs selector-driven DOM mutation without lease,
  sender, frame, or document-generation validation;
- `lib/compose.ts` embeds page context into a natural-language prompt instead of
  preserving an untrusted typed boundary;
- `manifest.ts` statically injects on `<all_urls>` instead of the dynamic,
  approved, leased injection frozen in MV3 v1;
- the current single status dot collapses server, companion, registration,
  extension, Chrome permission, policy, and task-runtime health.

## 17. Acceptance suite

### 17.1 Component and state tests

- exhaustive render/action tests for every state in section 7;
- same event/revision does not duplicate status or alert announcements;
- stale approvals are disabled and first terminal resolution wins;
- drafts are task/anchor scoped, bounded, session-only, expired, and cleared;
- hostile Markdown, title, origin, filename, favicon, and link inputs cannot
  inject HTML/script, navigate extension pages, or enter approval copy;
- no extension page makes remote asset requests.

### 17.2 Chrome extension E2E

- toolbar, shortcut, and context menu open a tab-specific panel only from a
  user gesture;
- switching tabs neither retargets nor transmits context; the original panel
  and draft remain associated with their anchor;
- closing/reopening the panel preserves task work and reconstructs current state;
- side-panel controls work without `activeTab` authority;
- only agent-created tabs join `A0 · …`; claimed tabs retain position/group and
  survive completion;
- ephemeral tabs close, deliverables/handoffs remain, uncertain tabs remain for
  review, and repeated finalization is harmless;
- moving/ungrouping/pinning/closing a controlled tab or canceling debugger
  produces takeover and no automatic fight-back;
- Stop remains available through work, reconnect, and user intervention;
- light, dark, forced-colors, 320 px, 200% text zoom, 400% browser zoom, RTL,
  and reduced-motion snapshots pass.

### 17.3 Cursor noninterference

Before and after injection, prove that `elementFromPoint`, focused element,
selection, tab order, accessibility tree, scroll dimensions, viewport layout,
and click/drag/hover/keyboard/touch routing are unchanged. Test ordinary DOM,
shadow DOM, iframes, fullscreen, extreme z-index, navigation, teardown, and
screenshot exclusion.

### 17.4 Cross-surface and setup

- WebUI and panel render the same task/challenge/tab revisions and resolving in
  either surface resolves everywhere;
- a clean Docker/WebUI user and clean A0 CLI user reach the same paired state;
- Docker instructions install on the browser host and never claim the container
  can register Chrome;
- server, companion, extension/profile, identity, capabilities, and policy fail
  and recover independently with precise copy;
- VoiceOver plus Chrome on macOS and NVDA plus Chrome on Windows pass manual
  status, alert, dialog, focus restoration, tab-card, progress, and removal flows.

The live Docker instance at `http://localhost:50080/` remains a read-only legacy
baseline for this decision. Its current UI does not prove the future contract;
implementation acceptance must deploy an identified build and read back the
five readiness layers.

## 18. Deferred from v1

- Firefox and Safari; certification beyond Chrome 120+ is separate.
- Opera side chat until tab-specific panel behavior is verified there.
- browser history, bookmarks, general download-manager, or operating-system
  notification UI;
- built-in-browser annotation mode and YouTube-specific transcript UI;
- automatic attachment of all open tabs or automatic retargeting on tab switch;
- a second side-panel-only conversation store;
- exact reproduction of any undocumented OpenAI cursor, protocol, or cleanup
  implementation.

## 19. Decision and next frontier

`a0.browser-bridge.visible-ux.v1` is frozen when issue #19 closes. It resolves
both the visible-interaction and side-panel/setup design questions in the map;
implementation can now target an exhaustive, accessible state projection
instead of evolving the prototype ad hoc.

The next Wayfinder decision frontier is **legacy migration and cutover**: define
how raw API-key setup, HTTP polling, the panel-open dependency, duplicate
`chrome_bridge` tooling, legacy stored data, and version compatibility are
detected, communicated, migrated, feature-gated, and removed without disrupting
the existing Docker browser or A0 CLI CDP modes.
