# Platform-scoped signed release catalogs v2

Status: release-format implementation; not production activation.

## Decision

A release may deliver a complete subset of supported operating systems without
claiming that unfinished platforms are available. macOS installation must not
require Windows or Linux payloads merely to satisfy a global artifact count.
This refines release packaging only; browser protocol, native installation,
Core admission, pairing, approvals and supported-platform roadmap are unchanged.

## Signed shape and compatibility

Catalog schema v1 remains unchanged: the existing exact fields and complete
nine-artifact matrix are mandatory. It does not accept a platforms field.

Schema v2 adds the required signed `platforms` array. It contains one through
three unique known platform names in strict ASCII lexical order:
`linux`, `macos`, `windows`. Empty, unknown, duplicate or unsorted declarations
are rejected. All v1 fields and their validation remain required.

The artifact tuples must equal the union of COMPLETE declared groups:

| Platform | Required artifacts |
| --- | --- |
| macos | universal2 installer and payload |
| windows | x86_64 installer/payload and arm64 installer/payload |
| linux | any bootstrap, x86_64 payload and aarch64 payload |

No missing group member, duplicate tuple, undeclared platform, extra artifact
or placeholder may establish release coverage. An undeclared host target has
no install candidate; there is no fallback to another platform or architecture.
A macOS-only release still includes a real installer AND universal payload.

## Trust is unchanged

The detached Ed25519 signature covers the canonical full catalog, including
schema version, declared scope and every artifact. Compiled publisher roots,
exact extension origins, secure-version floors, immutable download locations,
bounded archive/hash verification, independent builder provenance, platform
signature/notarization, metadata and self-test gates all remain mandatory.
Neither schema version nor platform scope enables a fixture or bypasses runtime
release admission. Older native binaries reject v2 as incompatible.

The independent A0 CLI bootstrap does not parse catalog contents: it selects
the exact locally compiled host-target pin and authenticates the native
bootstrap bytes. Only native validates the downloaded signed catalog. Unknown
or unprovisioned CLI targets remain unavailable.

## Sources and acceptance boundary

Native owns `release_catalog.rs` and
`schemas/release-catalog-v2.schema.json` in A0 Connector. Tests must cover Mac-only
v2 acceptance under test-only signers, complete multi-platform unions, unchanged
v1 rejection of partial matrices, and malformed/tampered scope rejection.
Those fixtures are parser evidence, not installed or signed production proof.
No publisher/builder keys, artifact digests or platform availability are invented.
