// API-only dependency trace. Reuse production frontend without rebuilding it.
const fs=require('node:fs/promises'),path=require('node:path');
const {nodeFileTrace}=require('../../node_modules/next/dist/compiled/@vercel/nft');
(async()=>{const root=path.resolve(__dirname,'../..'),out=path.resolve(process.argv[2] || 'native-api-bundle','api');
 const trace=await nodeFileTrace(['NativePlunkServer','StaffTestOperator'].map(name=>path.join(root,'apps/api/dist/isla/'+name+'.js')),{base:root,processCwd:root,mixedModules:true});
 await fs.mkdir(out,{recursive:true});
 for(const name of trace.fileList){
  if(name.split('/').some(s=>s==='.env'||s.startsWith('.env.')))throw Error('Forbidden configuration');
  if(name==='package.json')continue;
  const from=path.join(root,name),to=path.join(out,name),info=await fs.lstat(from);await fs.mkdir(path.dirname(to),{recursive:true});
  if(info.isSymbolicLink()){try{await fs.symlink(await fs.readlink(from),to)}catch(e){if(e.code!=='EEXIST')throw e}}else await fs.copyFile(from,to);
 }
 await fs.copyFile(path.join(root,'apps/api/src/isla/schema.sql'),path.resolve(process.argv[2] || 'native-api-bundle','schema.sql'));
 await fs.copyFile(path.join(root,'apps/api/src/isla/staff-test-role.sql'),path.resolve(process.argv[2] || 'native-api-bundle','staff-test-role.sql'));
 console.log('API dependency files',trace.fileList.size,'trace warnings',trace.warnings.size);
})().catch(e=>{console.error(e);process.exit(1)});
