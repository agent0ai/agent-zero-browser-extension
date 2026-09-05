import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

// Export task source against an exact Git base without touching either index,
// creating commits, publishing source, or collecting ignored runtime state.
const args = process.argv.slice(2);
const options = {};
for (let index = 0; index < args.length; index += 2) {
  assert(['--core', '--connector', '--output'].includes(args[index]) && !options[args[index]] && args[index + 1]);
  options[args[index]] = args[index + 1];
}
for (const key of ['--core', '--connector', '--output']) assert(isAbsolute(options[key] ?? ''), `${key} must be absolute`);
const output = resolve(options['--output']);
assert(!existsSync(output), 'Existing source handoff is never overwritten');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const exports = [];
for (const [name, key, scopes] of [
  ['agent-zero-core', '--core', ['helpers', 'plugins/_browser', 'plugins/_a0_connector', 'tests', 'docs']],
  ['a0-connector', '--connector', ['AGENTS.md', 'src', 'native/browser-bridge', 'tests', 'docs', 'pyproject.toml', 'README.md']],
]) {
  const root = resolve(options[key]);
  assert(!lstatSync(root).isSymbolicLink() && lstatSync(root).isDirectory());
  const git = args => execFileSync('git', args, {cwd: root, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore']});
  const base = git(['rev-parse', 'HEAD']).toString().trim();
  assert(/^[a-f0-9]{40}$/.test(base));
  const patch = git(['diff', '--binary', '--full-index', 'HEAD', '--', ...scopes]);
  const names = git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...scopes]).toString().split('\0').filter(Boolean).sort();
  const files = names.map(relative => {
    assert(!relative.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.')), 'Unexpected hidden/path component');
    assert(/\.(py|rs|md|json|yaml|yml|toml|lock|js|ts|html|css|txt|sh|ps1)$/.test(relative), `Review unexpected source type: ${relative}`);
    let target = root;
    for (const [index, part] of relative.split('/').entries()) {
      target = join(target, part);
      const stat = lstatSync(target);
      assert(!stat.isSymbolicLink() && (index === relative.split('/').length - 1 ? stat.isFile() : stat.isDirectory()));
    }
    const bytes = readFileSync(target);
    return {path: relative, sha256: hash(bytes), bytes};
  });
  exports.push({name, root, base, patch, files});
}
mkdirSync(output, {mode: 0o700});
for (const entry of exports) {
  const destination = join(output, entry.name);
  mkdirSync(destination, {mode: 0o700});
  writeFileSync(join(destination, 'tracked.patch'), entry.patch, {flag: 'wx'});
  for (const file of entry.files) {
    const target = join(destination, 'new-files', file.path);
    mkdirSync(dirname(target), {recursive: true, mode: 0o700});
    copyFileSync(join(entry.root, file.path), target);
    assert(hash(readFileSync(target)) === file.sha256, 'Source changed while exporting');
  }
  writeFileSync(join(destination, 'SOURCE.json'), JSON.stringify({
    contract: 'a0.browser-bridge.source-handoff.v1', base_commit: entry.base,
    tracked_patch_sha256: hash(entry.patch), new_files: entry.files.map(({bytes, ...file}) => file),
  }, null, 2) + '\n', {flag: 'wx'});
}
writeFileSync(join(output, 'README.txt'), 'Browser overhaul source handoff\n\nThese are local source changes, not production activation or published releases.\nFor each repository, use a clean checkout at SOURCE.json base_commit, run git apply --check tracked.patch and git apply tracked.patch, then copy the new-files contents into that checkout without overwriting existing files. Do not apply over unrelated edits. SOURCE.json records every new file digest. No Git index, remote, credentials, Docker state, or signing authority was changed to produce this handoff.\n', {flag: 'wx'});
console.log(JSON.stringify({output, repositories: exports.map(e => ({name: e.name, new_files: e.files.length, base: e.base}))}));
