import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprint, installerScript, buildLocalDelivery } from './build-local-delivery.mjs';

test('fingerprints exact source bytes and rejects symbolic links', () => {
  const root = mkdtempSync(join(tmpdir(), 'a0-package-test-'));
  try {
    writeFileSync(join(root, 'source'), 'first');
    const first = fingerprint(root, ['source']);
    assert.equal(first, fingerprint(root, ['source']));
    writeFileSync(join(root, 'source'), 'second');
    assert.notEqual(first, fingerprint(root, ['source']));
    symlinkSync('source', join(root, 'link'));
    assert.throws(() => fingerprint(root, ['link']), /links are not packaged/);
  } finally { rmSync(root, { recursive: true }); }
});

test('installer preserves pairing and never falls back from failed update to reinstall', () => {
  const script = installerScript('a'.repeat(64));
  assert.match(script, /development update --yes/);
  assert.match(script, /3\) .*development install --browser chrome --yes/);
  assert.doesNotMatch(script, /uninstall|sudo|curl|xattr|eval/);
  assert.match(script, /Type yes/);
  assert.throws(() => installerScript('not a digest'));
});

test('packaging requires explicit source and fresh absolute output', () => {
  assert.throws(() => buildLocalDelivery([]), /paths must be absolute/);
  assert.throws(() => buildLocalDelivery(['--output', '/tmp/example', '--extra', 'value']), /Use --connector/);
});
