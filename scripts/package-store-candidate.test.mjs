import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectCandidate } from './package-store-candidate.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'a0-store-package-test-'));
  t.after(() => rmSync(root, { recursive: true }));
  for (const name of ['assets', 'fonts', 'icons']) mkdirSync(join(root, name));
  const manifest = { manifest_version: 3, name: 'Agent Zero Chrome Bridge', version: '0.1.0',
    minimum_chrome_version: '120', description: 'Browser assistance.',
    permissions: ['alarms', 'contextMenus', 'debugger', 'nativeMessaging', 'scripting', 'sidePanel', 'storage', 'tabGroups', 'tabs'],
    host_permissions: ['http://*/*', 'https://*/*'],
    background: { type: 'module', service_worker: 'service-worker-loader.js' },
    action: {}, options_page: 'options.html', side_panel: { default_path: 'sidepanel.html' },
    icons: { '16': 'icons/icon16.png', '48': 'icons/icon48.png', '128': 'icons/icon128.png' } };
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
  for (const name of ['service-worker-loader.js', 'options.html', 'sidepanel.html',
    'fonts/rubik-variable.ttf', 'fonts/roboto-mono-variable.ttf',
    'fonts/rubik-OFL.txt', 'fonts/roboto-mono-OFL.txt']) writeFileSync(join(root, name), 'test-only');
  for (const size of [16, 48, 128]) {
    const header = Buffer.alloc(33);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(header);
    header.write('IHDR', 12);
    header.writeUInt32BE(size, 16); header.writeUInt32BE(size, 20);
    writeFileSync(join(root, `icons/icon${size}.png`), header);
  }
  return { root, manifest };
}

test('candidate package inventories exact allowed files and rejects the development key', t => {
  const { root, manifest } = fixture(t);
  assert.equal(inspectCandidate(root).hashes.length, 11);
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ ...manifest, key: 'development' }));
  assert.throws(() => inspectCandidate(root), /Development key/);
});

test('candidate refuses hidden files, source maps and links rather than publishing them', t => {
  for (const name of ['.env', 'assets/source.js.map', 'assets/link.js']) {
    const { root } = fixture(t);
    if (name.endsWith('link.js')) symlinkSync(join(root, 'options.html'), join(root, name));
    else writeFileSync(join(root, name), 'must-not-ship');
    assert.throws(() => inspectCandidate(root));
  }
});

test('candidate rejects wrong icon dimensions and missing referenced resources', t => {
  const { root, manifest } = fixture(t);
  const header = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(header); header.write('IHDR', 12);
  header.writeUInt32BE(32, 16); header.writeUInt32BE(32, 20);
  writeFileSync(join(root, 'icons/icon16.png'), header);
  assert.throws(() => inspectCandidate(root));
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ ...manifest, options_page: '../outside.html' }));
  assert.throws(() => inspectCandidate(root), /Missing manifest/);
});
