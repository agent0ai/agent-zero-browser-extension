# Delivery and release status

This repository is private and the current bridge is a development preview,
not a production release. Successful CI produces downloadable build artifacts;
it does not publish to a browser store or authorize native/browser control.

## Repository ownership

- [Chrome extension](https://github.com/TerminallyLazy/agent-zero-browser-extension):
  Manifest V3 worker, Options, side panel, cursor and browser operations.
- [A0 Connector](https://github.com/TerminallyLazy/a0-connector):
  A0 CLI and the `native/browser-bridge` companion implementation.
- [Agent Zero](https://github.com/TerminallyLazy/agent-zero):
  Core integration, pairing, browser policy, approvals and Docker/WebUI setup.

The related bridge changes are being developed in isolated worktrees and are
not implied to exist on those repositories' default branches. Record the exact
compatible commits before distributing a coordinated release. Do not distribute
an extension-only build as a complete installation.

## Prepared build workflow

The initial GitHub login has `repo` but not `workflow` authorization. Therefore
the source import contains an **inactive** template at
[`docs/workflows/build.yml`](docs/workflows/build.yml); CI is not yet enabled
and there are no remote build artifacts. The executable workflow is also ready
locally at `.github/workflows/build.yml`, outside the initial commit.

The owner can authorize workflow upload with:

```sh
gh auth refresh --hostname github.com --scopes workflow
```

After that account authorization, copy the exact reviewed template into
`.github/workflows/build.yml` if absent, commit and push it, and verify the first
run and its artifacts. GitHub documents this separate permission in
[OAuth scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps).

Once enabled, the `Extension build` workflow installs the lockfile, typechecks, runs the unit
suite, builds both channels and checks their manifests and packaged assets.
It uploads separately named development and gated production-candidate
artifacts for 14 days. Run it manually from Actions or use a main-branch build.
Only output directories are uploaded; source, credentials and local profiles
are excluded. Actions are pinned to verified full commit hashes and the token
has read-only contents permission. The setup follows the
[GitHub Node.js build guidance](https://docs.github.com/en/actions/tutorials/build-and-test-code/nodejs).

## Production release gates

Before enabling a production publishing workflow:

1. Reserve the production/beta store identities and configure publisher access.
2. Complete full runtime activation, mandatory transport lanes and safe migration.
3. Build all supported native installers and payloads with the required platform
   signatures, release catalog signature, checksums, notices/SBOM and provenance.
4. Configure approved public trust pins and protected CI signing authority.
   Never commit private signing keys, publisher credentials or pairing state.
5. Verify coordinated CLI and Docker/WebUI host installation, one-time pairing,
   reconnect, scoped browser actions and owned-tab cleanup.
6. Resolve source licensing, live privacy/support URLs and store listing assets.
7. Publish reviewed versioned artifacts and read back their exact hashes and
   distribution state. A private repository or green build is not this gate.

Native installation belongs on the Chrome computer, even when Agent Zero runs
in Docker. Updating must preserve the paired profile identity. Never advise
uninstall/re-pair as the normal update or reconnect path.
