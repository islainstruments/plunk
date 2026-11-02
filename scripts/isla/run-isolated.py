"""Sequential native fixtures. Requires PostgreSQL 17, Redis and repo deps.
All state goes under TMPDIR. This script never loads .env or production config.
Redis binary may be selected with REDIS_SERVER; browser optional via --browser
and ISLA_PLAYWRIGHT_MODULE (absolute path to installed Playwright index.mjs).
"""
import os,pathlib,subprocess,tempfile,time,shutil,sys
root=pathlib.Path(__file__).resolve().parents[2]
pgbin=pathlib.Path(os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin'))
redisbin=os.environ.get('REDIS_SERVER') or shutil.which('redis-server')
if not redisbin:raise RuntimeError('Redis binary required; set REDIS_SERVER')
if not os.environ.get('TMPDIR'):raise RuntimeError('Private TMPDIR required')
def run(args,**kw):subprocess.run(args,check=True,**kw)
with tempfile.TemporaryDirectory(prefix='native-fixture-',dir=os.environ['TMPDIR']) as temp:
 state=pathlib.Path(temp);data=state/'pg';log=(state/'servers.log').open('w')
 run([str(pgbin/'initdb'),'-D',str(data),'-A','trust','-U','fixture'],stdout=subprocess.DEVNULL)
 pg=subprocess.Popen([str(pgbin/'postgres'),'-D',str(data),'-k','','-p','55473','-h','127.0.0.1'],stdout=log,stderr=log)
 redis=subprocess.Popen([redisbin,'--bind','127.0.0.1','--port','56373','--save','','--appendonly','no'],stdout=log,stderr=log)
 try:
  for _ in range(80):
   if pg.poll() is not None or redis.poll() is not None:raise RuntimeError('Fixture port unavailable or server failed')
   if subprocess.run([str(pgbin/'pg_isready'),'-h','127.0.0.1','-p','55473'],stdout=subprocess.DEVNULL).returncode==0:break
   time.sleep(.1)
  run([str(pgbin/'createdb'),'-h','127.0.0.1','-p','55473','-U','fixture','plunk_native'])
  env={**os.environ,'DATABASE_URL':'postgresql://fixture@127.0.0.1:55473/plunk_native','DIRECT_DATABASE_URL':'postgresql://fixture@127.0.0.1:55473/plunk_native','REDIS_URL':'redis://127.0.0.1:56373','EMAIL_TRANSPORT':'held','JWT_SECRET':'synthetic-fixture-not-production','API_URI':'https://staff.example.invalid/staff/newsletters/api','DASHBOARD_URI':'https://staff.example.invalid/staff/newsletters/plunk','LANDING_URI':'https://staff.example.invalid','WIKI_URI':'https://staff.example.invalid/source'}
  run(['node','node_modules/prisma/build/index.js','db','push','--schema','packages/db/prisma/schema.prisma','--skip-generate'],cwd=root,env=env)
  run(['node','node_modules/typescript/bin/tsc','-p','apps/api/tsconfig.json'],cwd=root,env=env)
  for name in ['controller','delivery','import']+(['ui'] if '--browser' in sys.argv else []):
   run(['node',str(root/'scripts/isla'/('native-'+name+'.integration.mjs'))],cwd=root,env=env)
 finally:
  for process in [pg,redis]:process.terminate()
  for process in [pg,redis]:
   try:process.wait(timeout=12)
   except subprocess.TimeoutExpired:process.kill();process.wait()
  log.close()
