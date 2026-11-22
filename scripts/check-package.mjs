import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../packages/fleet-shell/', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
assert.equal(manifest.name, '@dsh-fleet/shell');
assert.equal(manifest.type, 'module');
assert.ok(manifest.dsh.bundle.patch);
assert.ok(manifest.dsh.client);
assert.ok(manifest.exports['./client']);
assert.ok(manifest.exports['./icon']);
assert.ok(manifest.exports['./locale/*.json']);
for (const key of ['.', './runtime', './client', './icon']) {
  const target = path.resolve(root, manifest.exports[key]);
  assert.ok(target.startsWith(root), `Export escapes package: ${key}`);
  assert.ok((await stat(target)).isFile(), `Missing export: ${key}`);
}
const javascript = ['index.js', 'runtime.js', 'client.js', 'src/fleet-core.js', 'src/fleet-model.js', 'src/fleet-store.js', 'src/fleet-service.js', 'src/fleet-dsh-adapter.js', 'src/fleet-chat.js', 'src/fleet-dashboard-api.js', 'src/fleet-runtime-lifecycle.js'];
for (const filename of javascript) {
  assert.ok(manifest.files.includes(filename), `Runtime file is not distributed: ${filename}`);
  const result = spawnSync(process.execPath, ['--check', path.join(root, filename)], { stdio: 'inherit' });
  assert.equal(result.status, 0, `Invalid JavaScript: ${filename}`);
}
for (const language of ['en', 'zh']) {
  const locale = JSON.parse(await readFile(path.join(root, 'locale', `${language}.json`), 'utf8'));
  assert.ok(locale.meta.title && locale.meta.description, `Missing display metadata: ${language}`);
}
const icon = await stat(path.resolve(root, manifest.exports['./icon']));
assert.ok(icon.size > 0 && icon.size <= 256 * 1024);
const source = await readFile(path.join(root, 'src/fleet-client.js'), 'utf8');
assert.ok(!source.includes('@deepseek-ai/dsh-client-'), 'Fleet source must not import framework internals');
assert.equal(manifest.engines.dsh, '0.2.2-rc.5');
const generated = spawnSync(process.execPath, [fileURLToPath(new URL('build-client.mjs',import.meta.url)), '--check'], {stdio:'inherit'});
assert.equal(generated.status, 0, 'Pinned adapter or generated bundle is stale');
assert.ok((await stat(path.join(root,'THIRD-PARTY-NOTICES.txt'))).size > 0);
console.log(JSON.stringify({ status: 'PASS', package: manifest.name, version: manifest.version, javascript: javascript.length, metadataLocales: 2, iconBytes: icon.size }, null, 2));
