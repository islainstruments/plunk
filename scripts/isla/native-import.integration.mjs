// Native secret-key/controller and real PostgreSQL/Redis fixtures. No provider HTTP.
import assert from 'node:assert/strict';
import request from '../../node_modules/supertest/index.js';
import {prisma} from '../../apps/api/dist/database/prisma.js';
import {createNativePlunkApp} from '../../apps/api/dist/isla/NativePlunkApp.js';
import {nativePlunkControllers} from '../../apps/api/dist/isla/NativePlunkControllers.js';
import {NativeContactImport} from '../../apps/api/dist/isla/NativeContactImport.js';
import {approvedSourceCategories} from '../../apps/api/dist/isla/NativeContactImport.js';
let canonical=true;
try {
 const project=await prisma.project.create({data:{name:'Synthetic native import',public:'pk_fixture_import',secret:'sk_fixture_import',tracking:'DISABLED'}});
 const other=await prisma.project.create({data:{name:'Synthetic other',public:'pk_fixture_other',secret:'sk_fixture_other',tracking:'DISABLED'}});
 const app=createNativePlunkApp({origin:'https://staff.example.invalid',projectId:project.id,lookup:async()=>null,
  controllers:nativePlunkControllers(),ready:async()=>{},project:async()=>project,
  contactImport:new NativeContactImport(prisma,project.id,async()=>{if(canonical==='offline')throw Error('offline');return canonical;})});
 const call=(method,path,body,key=project.secret)=>{let r=request(app)[method](path);if(key)r=r.set('Authorization','Bearer '+key);return body?r.send(body):r;};
 const row=(email,extra={})=>({email,subscribed:true,data:{name:'Fixture',isla:{provenance:[{sourceCategory:'synthetic',sourceSystem:'fixture',sourceRecordId:email,observedAt:'2026-11-02T00:00:00.000Z'}],priorSends:[{campaignId:'old-fixture',reference:'fixture-ref',state:'accepted'}],review:false,consentEvidence:'synthetic fixture only',...extra}}});
 for(const key of [null,project.public,'bad'])assert.equal((await call('get','/contacts',null,key)).status,401);
 assert.equal((await call('get','/contacts',null,other.secret)).status,403);
 assert.equal((await call('get','/contacts').set('Origin','https://staff.example.invalid')).status,403);
 assert.equal((await call('post','/contacts',{email:'missing@example.invalid'})).status,400);
 assert.equal((await call('post','/contacts',row('held@example.com'))).status,423);
 let r=await call('post','/contacts',row('a-import@example.invalid'));assert.equal(r.status,201,r.text);assert.equal(r.body.subscribed,true);const id=r.body.id;
 r=await call('get','/contacts/'+id+'/marketing-status');assert.equal(r.status,200,r.text);assert.equal(r.body.eligible,true);assert.equal(r.body.canonical.state,'not_suppressed');
 canonical=false;r=await call('get','/contacts/'+id+'/marketing-status');assert.equal(r.body.eligible,false);assert.equal(r.body.canonical.state,'suppressed');assert.ok(r.body.canonical.checkedAt);
 canonical='offline';r=await call('get','/contacts/'+id+'/marketing-status');assert.equal(r.status,200);assert.equal(r.body.eligible,null);assert.equal(r.body.canonical.state,'unavailable');assert.equal(r.body.canonical.checkedAt,null);canonical=true;
 assert.equal((await call('get','/contacts/'+id+'/marketing-status',null,null)).status,401);
 assert.equal((await call('get','/contacts/'+id+'/marketing-status',null,other.secret)).status,403);
 assert.equal((await call('get','/contacts/missing/marketing-status')).status,404);
 r=await call('post','/contacts',{...row('a-import@example.invalid'),subscribed:false});assert.equal(r.status,200,r.text);assert.equal(r.body.subscribed,false);
 r=await call('post','/contacts',row('A-IMPORT@example.invalid',{priorSends:[],consentEvidence:'replacement'}));assert.equal(r.status,200,r.text);assert.equal(r.body.id,id);assert.equal(r.body.subscribed,false);assert.equal(r.body.data.isla.priorSends.length,1);assert.equal(r.body.data.isla.consentEvidence,'synthetic fixture only');
 r=await call('get','/contacts/'+id+'/marketing-status');assert.equal(r.body.eligible,false);assert.deepEqual(r.body.localVetoes,['unsubscribe']);
 r=await call('post','/contacts',row('review-import@example.invalid',{review:true}));assert.equal(r.status,201,r.text);assert.equal(r.body.subscribed,false);
 r=await call('post','/contacts',row('review-import@example.invalid'));assert.equal(r.body.data.isla.review,true);assert.equal(r.body.subscribed,false);
 canonical=false;r=await call('post','/contacts',row('canonical-import@example.invalid'));assert.equal(r.status,201,r.text);assert.equal(r.body.subscribed,false);
 canonical='offline';r=await call('post','/contacts',row('offline-import@example.invalid'));assert.equal(r.status,500);canonical=true;
 const expected=['a-import@example.invalid','canonical-import@example.invalid','review-import@example.invalid'];
 r=await call('get','/contacts?limit=100');assert.equal(r.status,200,r.text);assert.equal(r.body.total,expected.length);assert.deepEqual(r.body.data.map(c=>c.email).sort(),expected);assert.ok(r.body.data.every(c=>c.subscribed===false));
 for(const path of ['/contacts/import','/contacts/bulk','/v1/send','/send','/auth/login','/campaigns/fixture/send','/campaigns/fixture/test','/campaigns/fixture/schedule'])assert.equal((await call('post',path,{})).status,423,path);
 for(const method of ['patch','delete'])assert.equal((await call(method,'/contacts/'+id,{})).status,423);
 console.log('PASS native secret/public/wrong-project/anonymous/Origin auth; native POST contacts provenance/history/review/opt-out/canonical veto; held customer address and dispatch; exact 3-address/count readback; offline canonical no write. Synthetic only.');
 // Routable-shaped fixtures exist ONLY in this isolated local DB; never sent.
 const released=createNativePlunkApp({origin:'https://staff.example.invalid',projectId:project.id,lookup:async()=>null,
  controllers:nativePlunkControllers(),ready:async()=>{},project:async()=>project,customerImports:true,
  contactImport:new NativeContactImport(prisma,project.id,async()=>{if(canonical==='offline')throw Error('offline');return canonical;},true)});
 const releasedCall=(body)=>request(released).post('/contacts').set('Authorization','Bearer '+project.secret).send(body);
 assert.equal((await releasedCall(row('unapproved@example.com'))).status,400);
 const approved=category=>({...row('release-'+approvedSourceCategories.indexOf(category)+'@example.com'),data:{isla:{...row('').data.isla,
  provenance:[{sourceCategory:category,sourceSystem:'synthetic-local-only',sourceRecordId:category,observedAt:'2026-11-02T00:00:00.000Z'}]}}});
 for(const category of approvedSourceCategories){const body=approved(category);r=await releasedCall(body);assert.equal(r.status,201,r.text);assert.equal(r.body.subscribed,true);}
 const optedOut=approved(approvedSourceCategories[0]);assert.equal((await releasedCall({...optedOut,subscribed:false})).body.subscribed,false);
 assert.equal((await releasedCall(optedOut)).body.subscribed,false);
 canonical=false;const veto=approved(approvedSourceCategories[1]);assert.equal((await releasedCall(veto)).body.subscribed,false);canonical=true;
 canonical='offline';assert.equal((await releasedCall({...approved(approvedSourceCategories[2]),email:'offline-release@example.com'})).status,500);canonical=true;
 assert.equal(await prisma.contact.count({where:{projectId:project.id,email:'offline-release@example.com'}}),0);
 r=await request(released).get('/health/ready');assert.equal(r.body.imports,true);assert.equal(r.body.sending,false);
 const expectedReleased=approvedSourceCategories.map(c=>approved(c).email).sort();
 const actual=await prisma.contact.findMany({where:{projectId:project.id,email:{endsWith:'@example.com'}}});
 assert.deepEqual(actual.map(c=>c.email).sort(),expectedReleased);
 for(const path of ['/contacts/import','/contacts/bulk','/campaigns/fixture/send','/campaigns/fixture/test','/campaigns/fixture/schedule'])
  assert.equal((await request(released).post(path).set('Authorization','Bearer '+project.secret).send({})).status,423);
 console.log('PASS released import gate: exact five approved categories/readback, unknown category rejected, sticky opt-out/canonical veto/offline no-write, customer/test/alternate dispatch still held. Local synthetic DB only.');
 await prisma.$disconnect();process.exit(0);
}catch(error){console.error(error);await prisma.$disconnect();process.exit(1);}
