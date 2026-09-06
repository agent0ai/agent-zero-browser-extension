---
name: Agent Zero Browser Extension
description: Native Agent Zero connection and task surfaces for Chrome.
colors:
  bg: "#131313"
  surface: "#1a1a1a"
  surface-soft: "#212121"
  text: "#f1f1f1"
  muted: "#b6b6b6"
  line: "#383838"
  accent: "#2b5ab9"
  accent-hover: "#356bcc"
  accent-text: "#9abbff"
  accent-soft: "#1b2942"
  warning: "#e9b969"
  danger: "#ffa3a7"
  focus: "#99baff"
  on-accent: "#fff"
typography:
  headline:
    fontFamily: "Rubik, Arial, sans-serif"
    fontSize: "23px"
    fontWeight: 500
    lineHeight: 1.25
    letterSpacing: "-.02em"
  title:
    fontFamily: "Rubik, Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 500
    lineHeight: 1.4
  body:
    fontFamily: "Rubik, Arial, sans-serif"
    fontSize: "13px"
    lineHeight: 1.6
  label:
    fontFamily: "Rubik, Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 500
  button:
    fontFamily: "Rubik, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.4
  code:
    fontFamily: "'Roboto Mono', monospace"
    fontSize: "12px"
    lineHeight: 1.6
rounded:
  label: "4px"
  control: "6px"
  brand: "7px"
  message: "8px"
spacing:
  compact: "8px"
  control-gap: "12px"
  inset: "14px"
  section-gap: "16px"
  narrow-gap: "20px"
  section: "24px"
  columns: "32px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-quiet:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
  button-quiet-hover:
    backgroundColor: "{colors.surface-soft}"
  button-danger:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.danger}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "8px 10px"
    width: "100%"
  development-label:
    textColor: "{colors.muted}"
    rounded: "{rounded.label}"
    padding: "2px 7px"
  connection-strip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.muted}"
    padding: "0 14px"
  notice:
    backgroundColor: "{colors.surface-soft}"
    textColor: "{colors.muted}"
    rounded: "{rounded.control}"
    padding: "12px 14px"
---

# Design System: Agent Zero Browser Extension

## Overview

**Creative North Star: "Native Agent Zero"**

The extension follows the user's confirmed Agent Zero identity: local Rubik and
Roboto Mono, dark neutral surfaces, compact blue controls, and plain connection
guidance. It is quiet and technical, with clear status and a practical next action.
Rows, restrained borders, and disclosures carry the hierarchy.

This document records the implemented options page and side panel from
`src/options/App.tsx`, `src/options/styles.css`, `src/sidepanel/App.tsx`,
`src/sidepanel/styles.css`, and their shared `src/ui/theme.css`. The frontmatter
extracts the current source values; the CSS remains the implementation authority.
The durable product context is [PRODUCT.md](PRODUCT.md).

The scoped independent visual review returned **SHIP** for synthetic
limited-development-ready captures of desktop options, narrow options, and the
narrow side panel. That verdict does not establish fresh-install acceptance,
live browser effects, every runtime state, or full production readiness. The
reported detector warnings concerned inherited Roboto Mono use; the font remains
part of the confirmed identity.

**Key Characteristics:**

- Native Agent Zero typography and dark neutral surfaces.
- Compact blue actions and readable connection rows.
- Plain pairing guidance with installation and diagnostics in disclosures.
- Status language that preserves the actual control boundary.

## Colors

Neutral charcoal layers occupy most of each surface; Agent Zero blue identifies
actions and admitted states, with amber and rose reserved for notices and errors.

### Primary

- `accent` and `accent-hover` fill primary actions; `on-accent` supplies their text.
- `accent-text` identifies links, successful checks, and ready status.
- `accent-soft` supplies the fully ready side-panel connection-strip background.
- `focus` identifies keyboard focus independently of connection state.

### Neutral

- `bg` is the page and footer canvas; `surface` is the control and strip layer.
- `surface-soft` distinguishes notices, user messages, and composer surfaces.
- `text` carries primary copy; `muted` carries explanations and metadata.
- `line` separates sections and outlines controls without creating raised cards.
- `warning` marks pairing feedback; `danger` marks blocked/error states and the
  disconnect action. These are semantic signals, not additional brand accents.

**The Status Truth Rule.** Pairing, limited browser control, and full task/chat
readiness remain distinct. Text and icon shape must explain state; color alone
must never claim a capability.

## Typography

Rubik is the interface family with Arial and sans-serif fallbacks. Roboto Mono
is limited to commands, code, and technical diagnostics, with monospace fallback
and tabular numbers for code. Both variable fonts are bundled locally with their
OFL licenses; no remote font request is required.

The frontmatter's headline and title roles describe desktop options. Narrow
options use a smaller headline (21px); side-panel recovery headings use that
size with a more open line height (1.3). Conversation titles are smaller again
(18px), and side-panel section headings use 14px. Most explanatory copy uses the
body role; messages and recovery paragraphs use line height 1.65. Secondary copy
uses 12px, metadata 11px, and the panel's persistent closing reassurance 10px.
The base document font size is 14px with line height 1.5. There is no display-type
or marketing-hero role.

## Layout

Options use one centered surface capped at 820px, with 24px horizontal margins
and 32px top padding. Rules separate the header, connection checks, pairing,
installation, privacy explanation, and diagnostics. The pairing section uses
two columns with a 32px gap. At 600px and below, margins become 16px, top padding
becomes 20px, health-row details stack, and pairing becomes one column with a
20px gap. Paired actions stretch across the narrow column.

The side panel fills the available width and at least the dynamic viewport
height. Its grid holds the identity header, connection strip, flexible main
content, and sticky footer. Main content uses 24px vertical and 16px horizontal
padding. The tab count hides at 340px and below; labels, controls, and long message
content otherwise fit through wrapping, flexible columns, or deliberate
ellipsis. Recovery paragraphs are capped at 65ch; long options explanations at
74ch. Commands wrap within their container.

Keep each surface's current connection state and next available action easy to
find. The detailed composition above describes these two surfaces, not a
requirement to reuse their exact section order on every future screen.

## Elevation & Depth

The implemented surfaces have no box shadows, blur, gradients, or lifted cards.
Depth comes from neutral surface changes and single-pixel rules. Context and
activity containers are open sections with top borders. User messages, notices,
and the composer receive a tonal fill when their role needs separation.

Status changes interpolate color over 240ms; primary and quiet buttons
interpolate background, border, and text over 160ms using the shared ease-out
curve. Reduced-motion mode removes those transitions while keeping status
visible. Exact motion and focus treatments are recorded in the sidecar.

## Shapes

Use the frontmatter's small radius vocabulary: label, control, brand mark, and
message/composer corners. Status dots are circles (6px). The brand mark uses
Agent Zero's original symbol geometry in a 34px SVG, without a surrounding box.
Both headers share `src/ui/AgentZeroLogo.tsx`; its color follows the text token,
including forced colors. Boundaries are ordinarily one pixel; keyboard
focus uses a separate visible outline (2px, offset 3px). There are no decorative
pill-shaped action buttons.

## Components

### Buttons

Primary buttons are compact, blue, and labeled with the next action. Quiet
buttons use a neutral fill and border; disconnect uses the same geometry with
danger-colored text. Their minimum height is 40px, increasing to 44px at narrow
widths or with a coarse pointer. Disabled buttons retain their label, use a
not-allowed cursor, and reduce opacity to one half. Busy labels describe the
pending operation. Utility icons use inline SVG with accessible button names.

### Inputs / Fields

Pairing fields use a neutral fill, quiet border, visible labels, and the control
radius. Their minimum height is 40px, increasing to 44px in narrow options.
Placeholder and caret colors use shared tokens. The code clears after submission;
the saved credential belongs to the companion, outside the extension.

### Navigation

The side-panel header carries the Agent Zero identity, an accessible settings
button, and a native task select when authorized tasks are available. Selecting
a task and anchoring a browser page remain separate concepts. Narrow and coarse
pointer layouts give the select and utility buttons 44px interaction targets.

### Labels and connection rows

The Development label is a small neutral bordered tag. Options status uses a
dot and descriptive text; the health list combines circle/check/error glyphs
with separate installation, companion, pairing, and browser-control rows.
The side-panel connection strip carries a text status and Check action with a
polite live region. Limited-ready copy remains explicit even though full-ready
strip styling is gated separately.

### Containers and disclosures

Prefer open sections with rules. Notices use the soft neutral fill. Installation
and technical diagnostics use native details/summary disclosures, with
installation initially open when the companion is missing. Technical values
wrap and use the mono face. Recovery keeps the explanatory paragraph and a
full-width setup, repair, or connection-details action together.

### Conversation and composer

Assistant messages sit directly on the canvas; user messages use a softly
rounded neutral fill and right alignment. Activity receipts pair an icon with
text. The sticky composer uses a bordered soft surface and a focus-within border
change. It appears only with full readiness and a selected task. Otherwise a
disabled placeholder explains what is unavailable. Limited development control
continues in Agent Zero and does not enable extension chat, screenshots, clicking,
or typing. Closing the panel does not stop work or close tabs.

## Do's and Don'ts

- Do preserve local Rubik and Roboto Mono, neutral dark surfaces, and compact blue actions.
- Do explain that pairing is saved once per Chrome profile across ordinary restarts.
- Do keep browser selection and site approvals separate from saved pairing.
- Do keep reduced-motion feedback visible and keyboard focus explicit.
- Do describe limited browser control with its actual supported and unavailable actions.
- Don't introduce a new visual identity, decorative card stacks, or dashboard styling.
- Don't promote synthetic visual approval to production or fresh-install acceptance.
- Don't expose credentials or internal admission identities as setup guidance.
