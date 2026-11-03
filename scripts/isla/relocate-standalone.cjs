/* Relocatable Next standalone dependencies. AGPL-3.0. */
const fs = require('node:fs/promises');
const path = require('node:path');
async function relocateStandalone(directory) {
  const root = await fs.realpath(directory);
  const within = target => target === root || target.startsWith(root + path.sep);
  const changes = [];
  let links = 0;
  async function visit(dir) {
    for (const entry of await fs.readdir(dir, {withFileTypes: true})) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { await visit(file); continue; }
      if (!entry.isSymbolicLink()) continue;
      links++;
      const old = await fs.readlink(file);
      let target = path.resolve(path.dirname(file), old);
      if (!within(target)) {
        const marker = '/.next/standalone/';
        if (!path.isAbsolute(old) || !old.includes(marker)) throw Error('Standalone link escapes bundle');
        target = path.resolve(root, old.slice(old.lastIndexOf(marker) + marker.length));
      }
      if (!within(target)) throw Error('Standalone link escapes bundle');
      const actual = await fs.realpath(target);
      if (!within(actual)) throw Error('Standalone resolved target escapes bundle');
      if (path.isAbsolute(old)) changes.push({file, value: path.relative(path.dirname(file), target)});
    }
  }
  await visit(root); // Validate every target before writing any link.
  for (const {file, value} of changes) { await fs.unlink(file); await fs.symlink(value, file); }
  return {links, repaired: changes.length};
}
module.exports = {relocateStandalone};
if (require.main === module) relocateStandalone(process.argv[2]).then(result => console.log(JSON.stringify(result))).catch(error => {console.error(error.message); process.exitCode = 1;});
