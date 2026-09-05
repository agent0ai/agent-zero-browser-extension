# Agent Zero browser companion

## Product and audience

Give Agent Zero a visible, user-controlled browser workspace in the user's
Chrome profile. People running Agent Zero through Docker/WebUI should have the
same clear host-companion setup as people using A0 CLI, without needing to
understand native messaging or container networking.

## User commitments

- Follow Agent Zero's native UI: Rubik, neutral dark surfaces, compact blue
  controls and subtle accessible state feedback in both Options and side panel.
- Pair once per Chrome profile; normal reconnects and updates preserve identity.
  Chat selection and site/action approvals remain separate, explicit choices.
- Explain one useful next action in plain language. Hide installation details
  after setup and keep technical diagnostics in a disclosure.
- Show AI activity with an illuminated cursor and grouped task-owned tabs.
  Close only exact eligible agent-created ephemeral tabs after a task; retain
  user-owned, handed-off, taken-over, deliverable and ambiguous tabs.
- UI viewers do not own task lifetime or grant browser authority.

## Honest current scope

The development channel has live signed handshake and reconciliation evidence
for the limited runtime. It supports the negotiated owned-tab, reading,
navigation and scrolling scope. Extension chat, screenshots and click/type are
unavailable in that channel. Full production activation and signed installers
are unfinished, even where their underlying source components exist.

The user considers this overhaul finished only when the requested functionality
and installation paths are available and usable. A preview, source import,
green build or disabled feature is not completion. See [RELEASING.md](RELEASING.md)
for repository ownership and outstanding delivery gates, and [DESIGN.md](DESIGN.md)
for implemented visual conventions.
