import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint } from './build-local-delivery.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const productionIdentity = JSON.parse(readFileSync(join(root, 'src/production-identity.json'), 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const inputs = ['package.json', 'package-lock.json', 'vite.config.ts', 'src', 'public', 'options.html', 'sidepanel.html'];

// This validates packaging, not publisher ownership, platform signing or runtime readiness.
export function inspectCandidate(directory) {
  assert(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink());
  const files = [];
  function visit(relative = '') {
    for (const name of readdirSync(join(directory, relative)).sort()) {
      assert(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(name), 'Unexpected package filename');
      const path = relative ? `${relative}/${name}` : name;
      const info = lstatSync(join(directory, path));
      assert(!info.isSymbolicLink(), 'Package symlinks are forbidden');
      if (info.isDirectory()) {
        assert(['assets', 'fonts', 'icons'].includes(path), 'Unexpected package directory');
        visit(path);
      } else {
        assert(info.isFile() && info.nlink === 1 && info.size <= 10 * 1024 * 1024, 'Invalid package file');
        assert(/^(manifest\.json|(?:options|sidepanel)\.html|service-worker-loader\.js|assets\/[A-Za-z0-9_.-]+\.(?:js|css)|icons\/icon(?:16|48|128)\.png|fonts\/(?:rubik|roboto-mono)-(?:variable\.ttf|OFL\.txt))$/.test(path), 'Unexpected packaged content');
        files.push(path);
      }
    }
  }
  visit();
  assert(files.length > 0 && files.length <= 128, 'Unexpected package file count');
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, 'Agent Zero Chrome Bridge');
  assert.equal(manifest.key, productionIdentity.manifest_public_key, 'Only the verified production public key may enter the store candidate');
  const keyHash = digest(Buffer.from(manifest.key, 'base64'));
  assert.equal(keyHash, productionIdentity.public_key_sha256);
  assert.equal(keyHash.slice(0, 32).replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16))), productionIdentity.extension_id);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.action?.default_popup, undefined);
  assert.equal(manifest.update_url, undefined);
  assert(Number(manifest.minimum_chrome_version) >= 120);
  assert(typeof manifest.description === 'string' && manifest.description.length <= 132);
  assert(/^\d+(?:\.\d+){0,3}$/.test(manifest.version));
  assert.equal(manifest.background?.type, 'module');
  assert.deepEqual([...manifest.permissions].sort(), ['alarms', 'contextMenus', 'debugger', 'nativeMessaging', 'scripting', 'sidePanel', 'storage', 'tabGroups', 'tabs']);
  assert.deepEqual(manifest.host_permissions, ['http://*/*', 'https://*/*']);
  for (const reference of [manifest.background.service_worker, manifest.options_page,
    manifest.side_panel?.default_path, ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
    'fonts/rubik-variable.ttf', 'fonts/roboto-mono-variable.ttf',
    'fonts/rubik-OFL.txt', 'fonts/roboto-mono-OFL.txt']) {
    assert(files.includes(reference), 'Missing manifest or licensed-font asset');
  }
  for (const size of [16, 48, 128]) {
    const png = readFileSync(join(directory, `icons/icon${size}.png`));
    assert(png.length >= 33 && png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')));
    assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR');
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
  return { manifest, files, hashes: files.map(path => ({ path, sha256: digest(readFileSync(join(directory, path))) })) };
}

export function packageCandidate(output) {
  assert(isAbsolute(output ?? ''), 'Supply one new absolute output directory');
  assert(!existsSync(output), 'Output already exists; never overwrite a release artifact');
  const before = fingerprint(root, inputs);
  mkdirSync(output, { mode: 0o700 });
  const candidate = join(output, 'extension');
  execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--mode', 'production', '--outDir', candidate], { cwd: root, stdio: 'inherit', timeout: 120_000 });
  assert.equal(fingerprint(root, inputs), before, 'Sources changed during build; output is incomplete');
  const inspected = inspectCandidate(candidate);
  const name = `agent-zero-chrome-bridge-${inspected.manifest.version}-store-candidate.zip`;
  const archive = join(output, name);
  execFileSync('zip', ['-X', '-q', archive, ...inspected.files], { cwd: candidate, timeout: 30_000 });
  const entries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8', timeout: 30_000 }).trim().split('\n').sort();
  assert.deepEqual(entries, [...inspected.files].sort(), 'ZIP contents differ from inspected package');
  const sha256 = digest(readFileSync(archive));
  writeFileSync(join(output, 'BUILD.json'), JSON.stringify({
    contract: 'a0.browser-bridge.store-candidate.v1', version: inspected.manifest.version,
    submitted: false, production_ready: false, source_sha256: before,
    archive: name, archive_sha256: sha256, files: inspected.hashes,
    extension_id: productionIdentity.extension_id, store_status: productionIdentity.store_status,
    remaining: ['signed_companion_release', 'runtime_acceptance', 'store_review_and_listing_assets'],
  }, null, 2) + '\n', { flag: 'wx' });
  writeFileSync(join(output, 'SHA256SUMS'), `${sha256}  ${name}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ archive, sha256, submitted: false, production_ready: false }));
  return { archive, sha256 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 3, 'Usage: node scripts/package-store-candidate.mjs NEW_ABSOLUTE_DIRECTORY');
    packageCandidate(process.argv[2]);
  } catch (error) {
    console.error(`Store candidate packaging stopped: ${error.message}`);
    process.exitCode = 1;
  }
}
