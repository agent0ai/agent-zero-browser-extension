import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

// Build checks are not release trust or runtime admission evidence.
const roots = process.argv.slice(2);
const productionIdentity = JSON.parse(await readFile(new URL('../src/production-identity.json', import.meta.url), 'utf8'));
assert(roots.length === 0 || roots.length === 2, 'Supply production and development output directories');
for (const [directory, development] of [[roots[0] ?? 'dist', false], [roots[1] ?? 'dist-development', true]]) {
  const root = resolve(directory);
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert(Number(manifest.minimum_chrome_version) >= 120);
  assert.equal(manifest.background.type, 'module');
  assert(!manifest.permissions.includes('activeTab'));
  assert.equal(manifest.content_scripts, undefined);
  if (development) {
    assert(manifest.name.endsWith('(Development)'));
    assert.equal(typeof manifest.key, 'string');
    const id = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex')
      .slice(0, 32).replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
    assert.equal(id, 'paoagmddepkmonpeboobaijlenlcokpc');
  } else {
    assert.equal(manifest.key, productionIdentity.manifest_public_key);
    const hash = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex');
    assert.equal(hash, productionIdentity.public_key_sha256);
    assert.equal(hash.slice(0, 32).replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16))), productionIdentity.extension_id);
    assert(!manifest.name.includes('(Development)'));
  }
  const files = [manifest.background.service_worker, manifest.options_page,
    manifest.side_panel.default_path, ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
    'fonts/rubik-variable.ttf', 'fonts/roboto-mono-variable.ttf',
    'fonts/rubik-OFL.txt', 'fonts/roboto-mono-OFL.txt'];
  for (const file of files) {
    assert.equal(typeof file, 'string');
    const path = resolve(root, file);
    assert(path.startsWith(root + sep), 'Package reference escapes output');
    assert((await stat(path)).isFile(), `Missing packaged file: ${file}`);
  }
  console.log(`${development ? 'Development' : 'Production candidate'} package structure verified`);
}
