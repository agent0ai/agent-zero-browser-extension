# Protocol compatibility snapshots

This repository vendors the extension-facing v1 design contracts in
[`planning/`](../planning/). They define wire shape and safety boundaries; they
do not prove a production release, store approval, installed native companion,
deployed Agent Zero Core, or live browser acceptance.

The snapshots came from the surrounding development workspace on 2026-09-05.
The hashes below identify each source document before publication-only
normalization. The vendored copies may therefore have different hashes:
machine-local absolute paths and links to omitted local deployment reports were
removed or replaced, and implementation-only evidence was collapsed where it
depended on those omitted reports. Non-secret historical status narrative may
remain as snapshot context; it is not release evidence. Protocol fields and
normative semantics were not intentionally changed.

| Snapshot | Source SHA-256 |
|---|---|
| `protocol-v1.md` | `2f298499af29af7c2b68c229a56f7af1d74cf9c96fc1c2b64d788effe527736b` |
| `pairing-trust-v1.md` | `e596f0b1e88c4db430005fc69db4f659d4c493bf0ef4304219b57ba4b65da633` |
| `host-companion-install-v1.md` | `418de73cd7731e5a14438de475953144545b508dc6d66ccb150638c66c6bbefe` |
| `core-adapter-v1.md` | `bfb5d976cbec63e2168f505f7c9f39ba3138b898504edbaca99cb27c8275c4e7` |
| `mv3-runtime-v1.md` | `109ef747d23b468195a6374c542c9a3e9016fa47fe1f1e91d7c0599a959d9314` |
| `visible-ux-v1.md` | `267b86d60335ed1add8cd4692606803b54a764d1475e8136d879ef1a7747d70d` |
| `legacy-cutover-v1.md` | `dd07eb809a3785d52fc37e091ce5841fa5c73de96b786c0c3d107db69784cb0c` |
| `click-authority-v1.md` | `9c88aa35db225582c76e8d6ea43c0bc9cbf62d3139682e2035c411ea3352e21c` |
| `type-authority-v1.md` | `205829afa664b0a259385f961beee90908820dd6863a6ef245c6f0af81d21d94` |
| `development-session-v1.md` | `ef6f27f9e5ead29b8d1433364fd9eb1b26e8120e293086ecd6ee2b024e7e74a2` |
| `local-development-delivery-v1.md` | `d82a34dd83f6bb27cc2d2578fc7acb3e529ea6d0dbe0f58e472e90cd7c2d0728` |
| `limited-development-control-v1.md` | `b29d2a0eb7259c8bf524f9fb5622c5fb32bd8962e8dd34fa256672312c80be61` |
| `runtime-transport-scopes-v1.md` | `fa7443570e560d9ac1a96858c5428d3a7d8419b96419c549a9dd4a76103538c3` |

Compatibility is negotiated at runtime. Do not infer compatibility from a
repository name, matching version string, local build, or these documents.
The host-install snapshot includes the 2026-09-05 local-delivery clarification:
approved detached local-build provenance can replace GitHub Actions attestation,
and Darwin uses a tightly bound private staging-path verification exception
because its public signature/exec APIs do not accept executable descriptors.
This changes release tooling policy, not runtime wire authority; mandatory
catalog/platform/notarization gates and production roots remain intact.
The same correction removes impossible native executable/catalog self-pins:
native trust pins signer roots and immutable version URLs, while installed
status authenticates retained signed catalog and derivation sidecars. A
separately distributed CLI can still pin the final companion/catalog bytes.
The CLI-first pairing clarification preserves Chrome profile authority: the
explicit human terminal command creates one authenticated five-minute intent
and shows its code for Options once. JSON/redirected output creates no secret;
there is no unsupported native CLI impersonation or invented install identity.
The protocol snapshot includes the additive production-only queue and explicit
local-approval methods implemented across Core, native and worker codecs on
2026-09-05. Their shared fixture is `context-queue-approval-v1.json`, SHA-256
`fb9c3b3e28f2d8e5be457dc0fe68d6d60ed99025acd23196e0a4b354178e178f`.
The additive native-owned credential rotation/status/self-revoke shape is
frozen by `credential-control-v1.json`, SHA-256
`743e1676ca9c6cc0a4b9c36da7b80eaf72501b6f8a5e5a0977f5dd5f9dc1b676`.
Production activation additionally requires independently verified release,
identity, pairing, selection, lifecycle, and attestation evidence. No compatible
Core or native-companion release SHA is asserted here because the source
worktrees were not immutable release inputs when these snapshots were made.

When a wire contract changes, update the affected snapshot, cross-language
fixture, strict parser tests, and this provenance table in the same reviewed
change.
