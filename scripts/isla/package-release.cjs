// Explicit build allowlist. Never use the repository root as a Docker context.
const fs=require('node:fs/promises'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'../..'),out=path.resolve(process.argv[2]||'native-release-bundle');
(async()=>{
 try{await fs.stat(out);throw Error('Use a fresh release output path')}catch(e){if(e.code!=='ENOENT')throw e}
 const result=cp.spawnSync(process.execPath,[path.join(__dirname,'package-api.cjs'),out],{cwd:root,stdio:'inherit'});
 if(result.status!==0)throw Error('API dependency trace failed');
 await fs.cp(path.join(root,'apps/web/.next/standalone'),path.join(out,'api/web'),{recursive:true});
 await fs.cp(path.join(root,'apps/web/.next/static'),path.join(out,'api/web/apps/web/.next/static'),{recursive:true});
 await fs.cp(path.join(root,'apps/web/public'),path.join(out,'api/web/apps/web/public'),{recursive:true});
 const revision=cp.execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
 await fs.writeFile(path.join(out,'api/SOURCE_REVISION'),revision+'\n');
 await fs.copyFile(path.join(root,'LICENSE'),path.join(out,'api/LICENSE'));
 async function check(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){
  if(entry.name==='.env'||entry.name.startsWith('.env.')||entry.name==='runtime'||entry.name==='private-exports'||entry.name.startsWith('.next-preserved'))throw Error('Forbidden release material');
  if(entry.isDirectory())await check(path.join(dir,entry.name));
 }}
 await check(out);console.log('Native release source',revision,'output',out);
})().catch(e=>{console.error(e);process.exit(1)});
