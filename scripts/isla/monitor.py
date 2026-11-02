"""Read-only native newsletter checks. Fails closed; no email notifications/sends."""
import argparse,datetime,json,pathlib,subprocess,urllib.request,urllib.error

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--config',required=True);args=parser.parse_args()
 p=pathlib.Path(args.config)
 if p.stat().st_mode % 512 != 0o600: raise RuntimeError('Private monitor config required')
 config=json.loads(p.read_text());host=config['sshHost']
 if host.startswith('-') or any(c.isspace() for c in host): raise RuntimeError('Invalid SSH host')
 command='docker exec isla-plunk-native node native-healthcheck.mjs && docker inspect isla-plunk-native --format "{{.State.Health.Status}} {{.RestartCount}}"'
 result=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10',host,command],capture_output=True,timeout=25)
 healthy=result.returncode==0 and result.stdout.decode().strip()=='healthy 0'
 statuses=[]
 for url,expected in [('https://islaelectronics.com/',200),('https://islaelectronics.com/staff/newsletters/api/contacts',401)]:
  req=urllib.request.Request(url,headers={'User-Agent':'ISLA-Newsletter-Integration/1.0'})
  try:
   with urllib.request.urlopen(req,timeout=15) as response: status=response.status
  except urllib.error.HTTPError as error: status=error.code
  statuses.append({'expected':expected,'observed':status});healthy=healthy and status==expected
 latest=pathlib.Path(config['directory'])/'latest.json';backup=json.loads(latest.read_text())
 age=(datetime.datetime.now(datetime.timezone.utc)-datetime.datetime.fromisoformat(backup['at'])).total_seconds()
 healthy=healthy and age<26*3600 and backup['encrypted'] and backup['offHost']
 evidence={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'healthy':healthy,'nativeReadiness':result.returncode==0,'ingress':statuses,'backupAgeHours':round(age/3600,2),'sending':False,'customerImports':False,'alertChannel':'local systemd failure/journal; external paging not commissioned'}
 target=pathlib.Path(config['directory']).parent/'monitor-latest.json';target.write_text(json.dumps(evidence,indent=2));target.chmod(0o600)
 print(json.dumps(evidence));return 0 if healthy else 1
if __name__=='__main__':
 try:raise SystemExit(main())
 except Exception as error:print(json.dumps({'healthy':False,'errorType':type(error).__name__}));raise SystemExit(1)
