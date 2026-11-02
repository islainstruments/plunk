"""Sequential real PostgreSQL fixtures; no production config or provider calls."""
import os, pathlib, subprocess, tempfile
root = pathlib.Path(__file__).resolve().parents[2]
scratch = pathlib.Path(os.environ['TMPDIR'])
assert '/cache/scratch' in str(scratch)
pg = pathlib.Path('/usr/lib/postgresql/17/bin')
def run(args, **kw):
    subprocess.run([str(x) for x in args], check=True, **kw)
with tempfile.TemporaryDirectory(prefix='ledger-', dir=scratch) as temp:
    data = pathlib.Path(temp)/'pg'
    run([pg/'initdb', '-D', data, '-A', 'trust', '--no-locale', '-E', 'UTF8'], stdout=subprocess.DEVNULL)
    run([pg/'pg_ctl', '-D', data, '-l', pathlib.Path(temp)/'pg.log', '-o', f'-k {scratch} -h "" -p 55439', '-w', 'start'], stdout=subprocess.DEVNULL)
    try:
        run([pg/'createdb', '-h', scratch, '-p', '55439', 'isla_newsletter_fixture'])
        run(['node', 'node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.isla.config.ts'], cwd=root)
    finally:
        run([pg/'pg_ctl', '-D', data, '-w', 'stop'], stdout=subprocess.DEVNULL)
