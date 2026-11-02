"""Pull only native newsletter data/config over SSH; AES-256-GCM at rest.
Run with system Python + cryptography. Config/key/archive are PRIVATE, never repo.
No email/provider call. Host SSH trust must already be provisioned.
"""
import argparse, datetime, hashlib, io, json, os, pathlib, secrets, subprocess, tarfile
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

REMOTE = '''import io,pathlib,subprocess,tarfile,sys
root=pathlib.Path('/opt/isla-plunk-native')
dump=subprocess.check_output(['docker','exec','isla-newsletter-staging-db','pg_dump','-U','newsletter_owner','-Fc','plunk_native'],timeout=90)
assert len(dump)<128*1024*1024
with tarfile.open(fileobj=sys.stdout.buffer,mode='w|') as archive:
 info=tarfile.TarInfo('plunk-native.dump');info.size=len(dump);info.mode=0o600;archive.addfile(info,io.BytesIO(dump))
 for name in ['runtime','app-run.json','native-api-deployment.json']:
  archive.add(root/name,arcname=name,recursive=True)
'''
AAD=b'ISLA-native-newsletter-backup-v1'

def private(path):
    if path.stat().st_mode & 0o077: raise RuntimeError('Private permissions required')

def restore_bytes(archive, key):
    blob=archive.read_bytes()
    if blob[:8]!=b'ISLANL01': raise RuntimeError('Unknown backup format')
    return AESGCM(key).decrypt(blob[8:20],blob[20:],AAD)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--config',required=True);args=parser.parse_args()
    configpath=pathlib.Path(args.config);private(configpath);config=json.loads(configpath.read_text())
    destination=pathlib.Path(config['directory']);destination.mkdir(parents=True,exist_ok=True,mode=0o700);private(destination)
    keypath=pathlib.Path(config['keyFile']);private(keypath);key=keypath.read_bytes()
    if len(key)!=32: raise RuntimeError('AES-256 recovery key required')
    host=config['sshHost']
    if host.startswith('-') or any(c.isspace() for c in host): raise RuntimeError('Invalid SSH host')
    import shlex
    result=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10',host,'python3 -c '+shlex.quote(REMOTE)],capture_output=True,timeout=120)
    if result.returncode: raise RuntimeError('Native database/config backup failed; inspect private server')
    if len(result.stdout)>128*1024*1024: raise RuntimeError('Backup exceeds bounded memory budget')
    now=datetime.datetime.now(datetime.timezone.utc);stamp=now.strftime('%Y%m%dT%H%M%SZ')
    path=destination/(stamp+'.tar.aesgcm');nonce=secrets.token_bytes(12)
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'wb') as output: output.write(b'ISLANL01'+nonce+AESGCM(key).encrypt(nonce,result.stdout,AAD))
    restored=restore_bytes(path,key)
    if hashlib.sha256(restored).digest()!=hashlib.sha256(result.stdout).digest(): raise RuntimeError('Backup integrity mismatch')
    with tarfile.open(fileobj=io.BytesIO(restored)) as archive:
        names=archive.getnames()
        if 'plunk-native.dump' not in names or 'runtime/native-database.json' not in names: raise RuntimeError('Incomplete native backup')
        member=archive.extractfile('plunk-native.dump')
        if member is None: raise RuntimeError('Missing database member')
        dump=member.read()
        if not dump.startswith(b'PGDMP'): raise RuntimeError('Not a PostgreSQL custom archive')
    evidence={'at':now.isoformat(),'encrypted':True,'offHost':True,'decryptRoundTrip':True,'archiveSHA256':hashlib.sha256(path.read_bytes()).hexdigest(),'backup':str(path),'databaseFormat':'pg_dump-custom','sending':False}
    status=destination/'latest.json';status.write_text(json.dumps(evidence,indent=2));status.chmod(0o600)
    # Retain at least 14 days; never touch recovery key or arbitrary files.
    for old in destination.glob('*.tar.aesgcm'):
        if old!=path and now.timestamp()-old.stat().st_mtime>14*86400: old.unlink()
    print(json.dumps(evidence))

if __name__=='__main__':
    try: main()
    except Exception as error:
        # Do not print raw subprocess output/credentials or decrypted material.
        print(json.dumps({'backup':'failed','errorType':type(error).__name__}));raise SystemExit(1)
