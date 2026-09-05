# Local-development delivery v1

Status: approved by the user's “Proceed” following the explicit proposal for a
separately identified local-development installation. Owner: current root task.
This is the single Wayfinder decision for this session; implementation follows
this boundary and does not reopen production activation decisions.

## Decision

Provide an explicitly source-built development channel. It is not a signed
release, production preview, or a mechanism for enabling test-fixture trust.
Production roots, origins, installer gates, and full-runtime admission stay
unchanged. Development installation is opt-in on the browser host; Docker
never writes host native-messaging configuration.

- Native host: `io.agentzero.browser_bridge.dev`.
- Extension: `Agent Zero Chrome Bridge (Development)`, with stable public-key
  identity `paoagmddepkmonpeboobaijlenlcokpc`.
- Public manifest key: generated for this development identity; its private key
  was discarded and is not a signing authority or credential.
- Separate per-user install and OS credential namespaces; no production state
  adoption, fallback, or manifest overwrite.
- Native development behavior is a separate compile-time build profile, not a
  runtime flag enabling production or `cfg(test)` trust.
- Installation consumes an explicitly chosen local source build, validates its
  development identity/version, and records exact installed bytes and owned
  targets. It must refuse foreign collisions and provide owned-only removal.
- Server pairing preserves normal session/CSRF checks, one-use codes, exact
  extension binding, proof-of-possession, and scoped credentials. Runtime
  control requires a separate honest development admission contract, never
  fabricated full-production readiness booleans.
- Development control may advertise only composed actions/transports. Site,
  action, document, turn, and lease authority are not relaxed. Unsupported
  actions, reconnect ownership recovery, and production migration remain
  unavailable until implemented.

## Target and delivery

The development server URL is an explicitly configured canonical loopback URL
with an explicit port; this contract does not fix one workstation-specific
value. Prepare and inspect changes before any reversible, scoped deployment; do
not replace the container, chats, credentials, or browser profile. Local
deployment evidence is not included in this repository and is not release
evidence.

Both the host installer and A0 CLI should use the same native implementation.
Manual Chrome Developer mode / Load unpacked remains a browser-owned user
gesture; do not modify Chrome's profile files to force extension installation.

## Evidence and remaining work

The development extension build is available at
`chrome-extension/dist-development`. Its manifest public key derives the exact
development ID above, and its native connection targets the separate `.dev`
host. The default production build has no development key/host/copy; permissions
are unchanged. A real handshake construction regression found and fixed the
worker's advertised screenshot/hover/click/type capabilities being rejected by
its own hello validator before native connection.

The A0 CLI has a separate `browser-extension development` command family. It
executes only an explicit local source binary, confirms mutations with `--yes`,
and delegates all registration to native code. Results require the exact fixed
development identity/channel; malformed or production results cannot report
development success. The process has bounded output and a 60-second deadline;
timeout is an unknown outcome requiring inspection before retry. Focused CLI
checks passed (47 existing/new cases and one actual process-deadline check).

The pairing-only implementation uses a separate Core store,
protected setup/inventory endpoints, a separate exchange endpoint, and a fixed
development extension identity. It does not authenticate a production socket,
install a runtime owner, select a browser, or issue full activation evidence.
Every development readiness projection remains false. This is intentional scope
labeling, not completion of the requested browser-control overhaul.

Core's isolated development API/UI checks passed 19 focused cases. The extension
requires the exact development envelope and rejects activation or true
readiness flags; its focused pairing/handshake checks passed 45 cases plus
TypeScript and builds. Eight synthetic captures of actual built options and
sidepanel pages covered paired/unpaired states at desktop and 390px without
page errors or document overflow. They are not a live native/Chrome pairing
result. The Browser settings development panel is a separate transient store,
not a mode switch in production setup, and keeps existing credentials revocable
after new development pairing is disabled.
Status and inventory failures are reported separately; stale setup status
cannot create new codes. The actual settings markup/store was also inspected
at desktop/mobile sizes. The optional Impeccable detector lacked its HTML
parser packages; visual/source inspection was used without installing them.

The initial native source-built profile implemented separate Unix self-install,
status, and owned removal. It refused changed-build installation, foreign
files, dangling symlinks, unsafe lock files, and changed rollback targets.
Both production/development library metadata and development main metadata
compiled using existing offline Linux Rust artifacts. The native agent ran 22
focused cases; all 14 structural checks also pass after replacing stale
extension-only pairing assertions with the required profile-bound calls.
Those earlier Linux checks were not a Cargo release build or Mac acceptance;
the subsequent host installation evidence is recorded below.

The user loaded/reloaded the fixed-key extension and confirmed that Options
reports the local companion detected. A live native process has the exact
development extension origin. Protected code creation now works in the named
Docker instance. Live pairing completed: protected Core inventory lists the
development browser as paired-only, and the user independently confirmed the
extension reports “Development identity paired” with browser control unavailable.
Development runtime admission and owned-tab acceptance remain pending in this
historical snapshot. Local deployment evidence is not included in this
repository and is not release evidence.

## Mac host installation evidence — 2026-09-05

- Installed Rust 1.85.1 for `aarch64-apple-darwin` using the official Rustup
  installer with the minimal profile and `--no-modify-path`. The repository's
  pinned toolchain also installed its declared rustfmt component. Shell startup
  files were not changed. The tool installation path was machine-local and is
  intentionally omitted from this published snapshot.
- `cargo build --locked --release --features local-development` succeeded on
  the Mac, fetching the locked dependencies without modifying the lockfile.
  The resulting companion is version `2.12.0`, Mach-O ARM64.
- Native and source-checkout A0 CLI preflight both returned
  `DEVELOPMENT_NOT_INSTALLED`. No existing development root or Chrome manifest
  was present.
- Installed through this checkout's A0 CLI with the explicit release binary,
  `--browser chrome --yes --json`. It returned `DEVELOPMENT_INSTALLED`, exit 0,
  with exactly one registered browser (`chrome`). The installed A0 Python
  package was not replaced; invocation used this checkout's `PYTHONPATH=src`.
- Subsequent A0 CLI status and direct installed-binary status both returned
  `DEVELOPMENT_INSTALLED`, exit 0. The source and installed executable SHA-256
  are both `240461e27643ed5f442bdb62ff43234d47114386412ebce0739ea12a06d86a82`.
- Chrome's per-user native-messaging manifest path was inspected but is
  machine-local and intentionally omitted from this published snapshot.
  Readback confirms stdio, the exact `.dev` host, and only the fixed development
  extension origin. Its absolute executable path is under the separate
  `Agent Zero/Browser Bridge Development/releases/2.12.0/macos-aarch64/`
  digest directory.
- Owner/mode readback: development root 0700, state and manifest 0600,
  installed executable 0500, all owned by the current user. No production
  registration, Chrome profile, credential, or live Docker state was changed.
- These checks prove a local build and native registration, not Chrome's
  `connectNative` launch, a live pairing exchange, or browser-control readiness.

## Completed integration frontier — live development pairing

Claimed by the current root task on 2026-09-05 after the user's “Continue.”
Resolve the already-approved development channel against the named Docker
instance and the installed Mac companion. This frontier does not broaden
production trust or introduce a development browser-control admission bypass.

- Inspect the exact additive Core deployment/dependency set and preserve a
  scoped rollback before any live deployment.
- Load the fixed-key development extension through Chrome's own user UI.
  Browser automation rejects `chrome://extensions`; the user has been asked
  to perform Load unpacked. Do not use another automation surface, profile
  edits, or raw browser commands to bypass that restriction.
- Keep options-page connection status current through native hello/reconnect
  so successful pairing does not require a manual page refresh.
- Accept only protected Core code creation and the separate development
  exchange, followed by explicit paired-but-control-unavailable readback.
- Deployed only the additive pairing subset, enabled the exact loopback URL via
  the existing `usr/.env` loader, and stopped/started only `run_ui`. The
  container was not replaced; private rollback copies and exact readback are
  recorded in the deployment evidence.
- Protected Browser settings reports ready-to-pair and successfully created a
  one-time code. The code was not printed in tools/chat. Chrome's extension
  settings URL is also blocked by the automation policy, so the user
  completed the code transfer and pairing through that UI. Core then reported
  “Development companion paired. Browser control remains off” and one paired-only
  inventory row; the user confirmed the matching extension success state.
- Fixed options status subscription using the existing worker presentation
  port. New pushes invalidate older request snapshots, and teardown removes
  only the page's listener/port. Eight focused observer/presentation cases,
  TypeScript, one development build, and synthetic desktop/390px reconnect
  transitions passed. The user reloaded that build and confirmed host detection.

## Completed source frontier — signed development session

Live pairing is accepted. The isolated-source implementation of the
[separate signed hello-only session](development-session-v1.md): a development
challenge/proof domain, restricted principal and handler, and native worker
state. It keeps browser readiness false and makes no live install/deployment
changes. It is implemented and passed focused proof/wire/state checks; it has
not been installed or deployed live. Useful browser control still needs its own exact limited admission,
explicit selection and composed policy/operation/lifecycle transport.

## Completed source frontier — runtime scopes

[Runtime transport and capability scopes](runtime-transport-scopes-v1.md)
separates fixed internal production/development routing identities and tightens
the extension's negotiated capability/connection fences. It does not activate
development control, borrow production persistence or change the live pairing.

## Active frontier — limited development control

[Limited development browser control](limited-development-control-v1.md)
is defining the actual browser-only admission, explicit selection, isolated
owner/persistence and existing site-approval/lifecycle composition. It targets
owned-tab browsing without pretending unsupported lanes or production readiness.
The current live setup remains paired-only until scoped installation/deployment.

## Host commands (source build, not a published installer)

Once the native build prerequisites are available, from the companion source's
`native/browser-bridge` directory:

```sh
cargo build --locked --release --features local-development
```

Choose the absolute path of that development binary. Docker/WebUI users can run
the native installer directly on the browser computer without installing A0 CLI:

```sh
/absolute/path/to/a0-browser-bridge development install --browser chrome --yes
/absolute/path/to/a0-browser-bridge development status
/absolute/path/to/a0-browser-bridge development update --yes
/absolute/path/to/a0-browser-bridge development uninstall --yes
```

With this checkout's A0 CLI, the equivalent path is:

```sh
a0 browser-extension development install --source-binary /absolute/path/to/a0-browser-bridge --browser chrome --yes
a0 browser-extension development status --source-binary /absolute/path/to/a0-browser-bridge
a0 browser-extension development update --source-binary /absolute/path/to/a0-browser-bridge --yes
a0 browser-extension development uninstall --source-binary /absolute/path/to/a0-browser-bridge --yes
```

The source path is explicit execution consent, not a claimed signature check.
Neither path discovers an arbitrary same-name executable on `PATH`. The native
installer owns exact file/manifest readback and collision-safe removal. These
commands describe the source interface; they are not local installation or
release evidence.

`development update` preserves the existing registered target set, installation ID and
profile-bound OS credentials, retains old immutable builds, and uses an owned
recovery journal. It accepts no browser targets. Reconnect after successful
update; pending recovery blocks install/uninstall. These commands do not imply
that the limited browser-control owner/admission is implemented or deployed.

Development uninstall removes only verified owned local registration/binary
state. It does not claim to enumerate/delete every profile's OS credential,
revoke Core records, or close Chrome tabs. A partial cleanup result is retained
as exit 6; A0 CLI explains that local keys may remain and directs the user to
development credential revocation in Browser settings.
