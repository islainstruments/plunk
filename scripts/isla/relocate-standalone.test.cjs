const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {relocateStandalone} = require('./relocate-standalone.cjs');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'standalone-links-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const source = path.join(root, 'build/.next/standalone');
  await fs.mkdir(path.join(source, 'node_modules/pkg'), {recursive: true});
  await fs.writeFile(path.join(source, 'node_modules/pkg/index.js'), 'module.exports=42;');
  await fs.mkdir(path.join(source, 'apps/web/.next/node_modules'), {recursive: true});
  const alias = 'apps/web/.next/node_modules/pkg-hash';
  await fs.symlink('../../../../node_modules/pkg', path.join(source, alias));
  return {root, source, alias};
}
test('reproduces default fs.cp absolute links; repair survives relocation/removal of build host', async t => {
  const {root, source, alias} = await fixture(t);
  const out = path.join(root, 'release'); await fs.cp(source, out, {recursive: true});
  assert(path.isAbsolute(await fs.readlink(path.join(out, alias))));
  await fs.rm(path.join(root, 'build'), {recursive: true});
  assert.deepEqual(await relocateStandalone(out), {links: 1, repaired: 1});
  assert.equal(require(path.join(out, alias)), 42);
  assert.deepEqual(await relocateStandalone(out), {links: 1, repaired: 0});
});
test('verbatim copy remains relocatable without repair', async t => {
  const {root, source, alias} = await fixture(t);
  const out = path.join(root, 'release'); await fs.cp(source, out, {recursive: true, verbatimSymlinks: true});
  await fs.rm(path.join(root, 'build'), {recursive: true});
  assert.deepEqual(await relocateStandalone(out), {links: 1, repaired: 0});
  assert.equal(require(path.join(out, alias)), 42);
});
test('rejects arbitrary external links', async t => {
  const {source} = await fixture(t); await fs.symlink('/etc', path.join(source, 'escape'));
  await assert.rejects(relocateStandalone(source), /escapes bundle/);
});
test('rejects dangling and traversal targets', async t => {
  const {source} = await fixture(t);
  const bad = path.join(source, 'bad');
  await fs.symlink('/build/.next/standalone/missing', bad);
  await assert.rejects(relocateStandalone(source), /ENOENT/);
  await fs.unlink(bad); await fs.symlink('/build/.next/standalone/../../escape', bad);
  await assert.rejects(relocateStandalone(source), /escapes bundle/);
});
