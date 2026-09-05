# Delivery and release status

This repository is private and the current bridge is a development preview,
not a production release. Local builds produce installable development packages;
they do not publish to a browser store or authorize production browser control.

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

GitHub Actions is optional and is not a completion dependency. The owner has
requested local delivery because Actions is rate-limited. Build on the Chrome
computer with the existing Node and pinned Rust toolchain:

```sh
node scripts/build-local-delivery.mjs --connector /absolute/path/to/a0-connector --output /absolute/path/to/new-package-directory --cargo /absolute/path/to/cargo
```

This builds both extension channels and the host's development companion using
locked offline Rust dependencies. It emits a source-fingerprinted local package,
checksum and install/update entry point for macOS or Linux; it does not install
anything or touch Chrome profiles while building. Existing paired identities
are preserved by the installer. Local source packaging is available independently
of the optional workflow below. It does not claim signed production or Windows
installer availability.

To export matching Core and CLI source without changing their Git indexes or
publishing their branches:

```sh
node scripts/export-source-handoff.mjs --core /absolute/path/to/agent-zero --connector /absolute/path/to/a0-connector --output /absolute/path/to/new-source-handoff
```

The handoff records exact base commits, full-index patches and hashes for every
new file. Apply only to clean matching checkouts; never overwrite existing user
files. Source availability is not production activation.

The initial GitHub login has `repo` but not `workflow` authorization. Therefore
the source import contains an **inactive** template at
[`docs/workflows/build.yml`](docs/workflows/build.yml); CI is not enabled and
local prerelease assets do not claim an Actions run. The executable workflow is also ready
locally at `.github/workflows/build.yml`, outside the initial commit.

No workflow authorization or Actions run is required for the local delivery
above. The inactive template can remain unused while Actions is rate-limited.

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
4. Configure approved public trust pins and protected local or CI signing authority.
   Never commit private signing keys, publisher credentials or pairing state.
5. Verify coordinated CLI and Docker/WebUI host installation, one-time pairing,
   reconnect, scoped browser actions and owned-tab cleanup.
6. Resolve source licensing, live privacy/support URLs and store listing assets.
7. Publish reviewed versioned artifacts and read back their exact hashes and
   distribution state. A private repository or green build is not this gate.

Native installation belongs on the Chrome computer, even when Agent Zero runs
in Docker. Updating must preserve the paired profile identity. Never advise
uninstall/re-pair as the normal update or reconnect path.
