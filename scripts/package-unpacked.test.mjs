import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageUnpacked } from './package-unpacked.mjs';
import { renderGuide } from './unpacked-guide.mjs';

test('offline guide explains all platforms and never implies unavailable native installers are ready', () => {
  const html = renderGuide();
  for (const text of ['macOS', 'Windows', 'Linux', 'Docker', 'Load unpacked', 'manifest.json',
    'default', 'All websites', 'not released yet', 'Do not remove the extension', 'no-referrer']) assert(html.includes(text));
  assert(!/fetch\(|XMLHttpRequest|localStorage|sessionStorage|document\.cookie/.test(html));
  assert(!/<script[^>]+src=["']https?:/.test(html));
  assert(!/<(?:img|link)[^>]+(?:src|href)=["']https?:/.test(html));
  assert(html.includes('Copy this address manually:'));
});

test('direct package refuses relative paths and never replaces an existing output', t => {
  assert.throws(() => packageUnpacked('relative', '/unused'), /absolute/);
  const output = mkdtempSync(join(tmpdir(), 'a0-unpacked-test-'));
  t.after(() => rmSync(output, { recursive: true }));
  assert.throws(() => packageUnpacked('/unused', output), /never overwrite/);
});
