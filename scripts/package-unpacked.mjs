import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectCandidate } from './package-store-candidate.mjs';
import { renderGuide } from './unpacked-guide.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// Public, dependency-free user bundle; no native binary or installation authority.
// Input is an already-built production candidate, not a rebuild or user profile.
export function packageUnpacked(candidate, output) {
  assert(isAbsolute(candidate ?? '') && isAbsolute(output ?? ''), 'Supply absolute candidate and new output directories');
  assert(!existsSync(output), 'Output already exists; never overwrite a delivery');
  const source = inspectCandidate(join(candidate, 'extension'));
  const build = JSON.parse(readFileSync(join(candidate, 'BUILD.json'), 'utf8'));
  assert.equal(build.contract, 'a0.browser-bridge.store-candidate.v1');
  assert.deepEqual(build.files, source.hashes, 'Candidate differs from its build receipt');
  const installation = JSON.parse(readFileSync(new URL('../src/installation-platforms.json', import.meta.url), 'utf8'));
  mkdirSync(output, { mode: 0o700 });
  const root = join(output, 'Agent-Zero-Browser');
  mkdirSync(root);
  cpSync(join(candidate, 'extension'), join(root, 'extension'), { recursive: true, force: false, errorOnExist: true });
  assert.deepEqual(inspectCandidate(join(root, 'extension')).hashes, source.hashes);
  writeFileSync(join(root, 'START-HERE.html'), renderGuide(), { flag: 'wx' });
  writeFileSync(join(root, 'README.txt'), 'Open START-HERE.html in your browser.\n\nExtract this entire ZIP to a permanent folder before using Chrome > Extensions > Developer mode > Load unpacked. Select the extension subfolder. Keep this folder for future Chrome launches.\n\nThe extension works across macOS, Windows and Linux. The native companion is separate: macOS is released; Windows and Linux native installers are not yet released. An unpacked extension alone does not enable browser control.\n\nDocker users: install on the computer running Chrome, not inside Docker. Pair once and select the browser as Agent Zero\'s default. Never share your pairing code.\n', { flag: 'wx' });
  cpSync(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), join(root, 'THIRD_PARTY_NOTICES.md'));
  const files = ['THIRD_PARTY_NOTICES.md', 'README.txt', 'START-HERE.html', ...source.files.map(path => `extension/${path}`)].sort();
  const hashes = files.map(path => ({ path, sha256: digest(readFileSync(join(root, path))) }));
  const receipt = {
    contract: 'a0.browser-bridge.unpacked-bundle.v1', extension_id: build.extension_id,
    version: source.manifest.version, source_sha256: build.source_sha256,
    extension_platforms: ['macos', 'windows', 'linux'],
    native_installer_platforms: Object.entries(installation.platforms).filter(([, value]) => value.available).map(([key]) => key),
    store_published: false, full_cross_platform_ready: false, files: hashes,
  };
  writeFileSync(join(root, 'BUNDLE.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  files.push('BUNDLE.json');
  const archive = join(output, `agent-zero-browser-${source.manifest.version}-unpacked.zip`);
  execFileSync('zip', ['-X', '-q', archive, ...files.map(path => `Agent-Zero-Browser/${path}`)], { cwd: output, timeout: 30_000 });
  const entries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).trim().split('\n').sort();
  assert.deepEqual(entries, files.map(path => `Agent-Zero-Browser/${path}`).sort());
  // Verify every archived byte, not just the ZIP directory or source receipt.
  for (const path of files) {
    assert.equal(digest(execFileSync('unzip', ['-p', archive, `Agent-Zero-Browser/${path}`], { maxBuffer: 12 * 1024 * 1024 })), digest(readFileSync(join(root, path))));
  }
  assert.deepEqual(inspectCandidate(join(candidate, 'extension')).hashes, source.hashes, 'Input changed during packaging');
  const sha256 = digest(readFileSync(archive));
  writeFileSync(join(output, 'SHA256SUMS'), `${sha256}  ${archive.split('/').at(-1)}\n`, { flag: 'wx' });
  return { archive, sha256, ...receipt };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 4, 'Usage: node scripts/package-unpacked.mjs CANDIDATE_DIRECTORY NEW_OUTPUT_DIRECTORY');
    const result = packageUnpacked(process.argv[2], process.argv[3]);
    console.log(JSON.stringify({ archive: result.archive, sha256: result.sha256, full_cross_platform_ready: false }));
  } catch (error) { console.error(`Unpacked packaging stopped: ${error.message}`); process.exitCode = 1; }
}
