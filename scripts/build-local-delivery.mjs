import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function fingerprint(root, names) {
  const entries = [];
  function visit(relative) {
    const path = join(root, relative);
    const info = lstatSync(path);
    assert(!info.isSymbolicLink(), `Source links are not packaged: ${relative}`);
    if (info.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(relative, name));
    } else {
      assert(info.isFile(), `Not a regular source file: ${relative}`);
      entries.push([relative, hash(readFileSync(path))]);
    }
  }
  for (const name of names) visit(name);
  return hash(JSON.stringify(entries));
}

export function installerScript(binaryHash) {
  assert(/^[a-f0-9]{64}$/.test(binaryHash));
  return `#!/bin/sh
set -eu
bundle_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
companion="$bundle_dir/a0-browser-bridge"
if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != "--yes" ]; }; then
  echo 'Usage: install.sh [--yes]' >&2
  exit 2
fi
echo 'Agent Zero browser companion — local source build'
echo 'Run this on the computer with Chrome, not inside Docker.'
echo 'This installs or updates only the separate development companion.'
echo 'Existing pairing is preserved. This is not a signed production release.'
if [ "$#" -eq 0 ]; then
  printf 'Trust this local build and continue? Type yes: '
  read -r answer
  [ "$answer" = yes ] || exit 4
fi
[ -f "$companion" ] && [ ! -L "$companion" ] || exit 5
if command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$companion")
elif command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$companion")
else
  echo 'A SHA-256 tool is required before this build can run.' >&2
  exit 7
fi
actual=${'${'}actual%% *}
[ "$actual" = '${binaryHash}' ] || { echo 'The companion file changed. Installation stopped.' >&2; exit 5; }
status=0
"$companion" development status --json >/dev/null || status=$?
case "$status" in
  0) "$companion" development update --yes ;;
  3) "$companion" development install --browser chrome --yes ;;
  *) echo 'Existing companion needs attention. No reinstall was attempted.' >&2
     "$companion" development status || exit "$status" ;;
esac
echo 'Companion ready. Pair once in extension Options; keep your existing pairing when updating.'
`;
}

function run(program, args, cwd) {
  execFileSync(program, args, { cwd, stdio: 'inherit', timeout: 240_000 });
}

function gitRevision(root) {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

export function buildLocalDelivery(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    assert(['--connector', '--output', '--cargo'].includes(key) && !options[key] && args[index + 1], 'Use --connector ABSOLUTE_PATH --output NEW_ABSOLUTE_PATH [--cargo ABSOLUTE_PATH]');
    options[key] = args[index + 1];
  }
  assert(isAbsolute(options['--connector'] ?? '') && isAbsolute(options['--output'] ?? ''), 'Connector and output paths must be absolute');
  const connector = resolve(options['--connector']);
  const output = resolve(options['--output']);
  const native = join(connector, 'native/browser-bridge');
  const cargo = options['--cargo'] ?? 'cargo';
  assert(!options['--cargo'] || isAbsolute(cargo), 'Explicit cargo path must be absolute');
  assert(['darwin', 'linux'].includes(platform()), 'Local source installers currently support macOS and Linux only');
  assert(!existsSync(output), 'Choose a new output directory; existing packages are never overwritten');
  assert(!lstatSync(connector).isSymbolicLink() && lstatSync(connector).isDirectory(), 'Choose the real connector checkout');
  const nativeInputs = ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'build.rs', 'browser-registry-v1.json', 'release-policy-v1.json', 'src', 'data'];
  // Source set is explicit; generated targets, profiles, credentials and logs never enter a package.
  const actualNativeInputs = nativeInputs.filter(name => existsSync(join(native, name)));
  const extensionInputs = ['package.json', 'package-lock.json', 'vite.config.ts', 'src', 'public', 'options.html', 'sidepanel.html'];
  const before = { extension: fingerprint(extensionRoot, extensionInputs), companion: fingerprint(native, actualNativeInputs) };
  mkdirSync(output, { mode: 0o700 });
  const bundle = join(output, `agent-zero-browser-${platform()}-${arch()}-local`);
  mkdirSync(bundle, { mode: 0o700 });
  const production = join(output, 'production-candidate');
  const development = join(bundle, 'chrome-extension');
  run('npm', ['run', 'build', '--', '--outDir', production], extensionRoot);
  run('npm', ['run', 'build:development', '--', '--outDir', development], extensionRoot);
  run(process.execPath, ['scripts/check-packages.mjs', production, development], extensionRoot);
  run(cargo, ['build', '--locked', '--offline', '--release', '--features', 'local-development', '--target-dir', join(native, 'target')], native);
  const binary = join(native, 'target/release/a0-browser-bridge');
  assert(!lstatSync(binary).isSymbolicLink() && lstatSync(binary).isFile());
  const after = { extension: fingerprint(extensionRoot, extensionInputs), companion: fingerprint(native, actualNativeInputs) };
  assert.deepEqual(after, before, 'Source changed during packaging; discard this incomplete output and retry into a new directory');
  const binaryHash = hash(readFileSync(binary));
  copyFileSync(binary, join(bundle, 'a0-browser-bridge'));
  chmodSync(join(bundle, 'a0-browser-bridge'), 0o700);
  writeFileSync(join(bundle, 'install.sh'), installerScript(binaryHash), { mode: 0o700, flag: 'wx' });
  if (platform() === 'darwin') {
    copyFileSync(join(bundle, 'install.sh'), join(bundle, 'Install.command'));
    chmodSync(join(bundle, 'Install.command'), 0o700);
  }
  const metadata = {
    contract: 'a0.browser-bridge.local-delivery.v1', channel: 'local-development',
    signed_production_release: false, platform: platform(), architecture: arch(),
    extension_id: 'paoagmddepkmonpeboobaijlenlcokpc', native_host: 'io.agentzero.browser_bridge.dev',
    source: { extension_base: gitRevision(extensionRoot), connector_base: gitRevision(connector), input_sha256: before },
    companion_sha256: binaryHash,
  };
  writeFileSync(join(bundle, 'BUILD.json'), JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' });
  writeFileSync(join(bundle, 'START-HERE.txt'), `Agent Zero browser companion: local source package\n\n1. Keep this folder on the computer running Chrome. Agent Zero may run in Docker.\n2. Run ${platform() === 'darwin' ? 'Install.command' : './install.sh'} and confirm. It updates an existing healthy development companion without deleting pairing.\n3. In Chrome Developer mode, load the chrome-extension folder as an unpacked extension.\n4. Open extension Options. If already paired, keep the saved pairing. Otherwise follow Pair this browser once.\n5. Select the browser for your chat in Agent Zero and approve the sites it may use.\n\nThis package retains the development identity and its negotiated capability limits.\nChat in the extension, screenshots and click/type are not enabled by this package.\nThe production-candidate folder is not an install-ready or signed release.\nBUILD.json records source fingerprints and a checksum, not a platform signature or CI attestation.\n`, { flag: 'wx' });
  const archive = join(output, basename(bundle) + '.tar.gz');
  run('tar', ['-czf', archive, '-C', output, basename(bundle)], extensionRoot);
  const sha256 = hash(readFileSync(archive));
  writeFileSync(join(output, 'SHA256SUMS'), `${sha256}  ${basename(archive)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ package: archive, sha256, channel: metadata.channel, signed_production_release: false }));
  return { archive, sha256 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { buildLocalDelivery(process.argv.slice(2)); }
  catch (error) { console.error(`Local packaging stopped: ${error.message}`); process.exitCode = 1; }
}
