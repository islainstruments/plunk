/* Build a minimal corresponding-source-pinned artifact, never the monorepo app. AGPL-3.0. */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmod, copyFile, lstat, mkdir, readdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const destination = process.argv[2];
if (!destination || !destination.startsWith('/')) throw new Error('New absolute artifact directory required');
const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trim();
if (git('status', '--porcelain')) throw new Error('Refuse release from dirty source');
if (git('branch', '--show-current') !== 'isla/resend-staff') throw new Error('Assigned release branch required');
const revision = git('rev-parse', 'HEAD');
execFileSync('corepack', ['yarn', 'tsc', '-p', 'tsconfig.isla.build.json'], {cwd: root, stdio: 'inherit'});
await mkdir(destination, {recursive: false, mode: 0o700});
const modules = ['NewsletterRuntime', 'NewsletterServer', 'NewsletterDraftApp', 'NewsletterDrafts', 'NewsletterEditor', 'StaffBoundary'];
for (const name of modules) await copyFile(join(root, 'apps/api/dist/isla', name + '.js'), join(destination, name + '.js'));
for (const name of ['package.json', 'package-lock.json', 'Dockerfile', 'healthcheck.mjs', 'grants.sql', 'staff-read.sql', 'staff-db-proxy.mjs', 'newsletter-ingress.conf.in', 'RUNTIME.md', 'loopback.socket.in', 'loopback.service.in'])
  await copyFile(join(root, 'deploy/newsletter-runtime', name), join(destination, name));
await copyFile(join(root, 'apps/api/src/isla/schema.sql'), join(destination, 'schema.sql'));
await copyFile(join(root, 'LICENSE'), join(destination, 'LICENSE'));
await writeFile(join(destination, 'release.json'), JSON.stringify({revision,
  source: 'https://github.com/islainstruments/plunk/tree/' + revision}) + '\n');
execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {cwd: destination, stdio: 'inherit'});
// Hash every application/config/build file; lockfile pins all runtime transitive packages.
const files = [...modules.map(name => name + '.js'), 'release.json', 'package.json', 'package-lock.json',
  'Dockerfile', 'healthcheck.mjs', 'grants.sql', 'staff-read.sql', 'staff-db-proxy.mjs', 'newsletter-ingress.conf.in', 'schema.sql', 'LICENSE', 'RUNTIME.md', 'loopback.socket.in', 'loopback.service.in'];
const hashes = {};
for (const file of files) hashes[file] = createHash('sha256').update(await readFile(join(destination, file))).digest('hex');
await writeFile(join(destination, 'manifest.json'), JSON.stringify({revision, hashes}, null, 2) + '\n');
// The operator may use umask 077. Artifact contains public code only, never secrets:
// normalize contents for non-root image execution while keeping its host root private.
async function publicCodePermissions(directory) {
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) continue;
    await chmod(path, info.isDirectory() ? 0o755 : 0o644);
    if (info.isDirectory()) await publicCodePermissions(path);
  }
}
await publicCodePermissions(destination);
console.log('Built non-sending artifact at ' + destination + ' revision=' + revision);
