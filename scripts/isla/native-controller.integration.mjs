// Real compiled Plunk controllers + real isolated PostgreSQL/Redis. Synthetic only.
import assert from 'node:assert/strict';
import request from '../../node_modules/supertest/index.js';
import {createNativePlunkApp} from '../../apps/api/dist/isla/NativePlunkApp.js';
import {nativePlunkControllers} from '../../apps/api/dist/isla/NativePlunkControllers.js';
import {prisma} from '../../apps/api/dist/database/prisma.js';
const origin='https://staff.example.invalid';
let role='admin';
try {
 const project=await prisma.project.create({data:{name:'Synthetic commissioning',public:'fixture-public',secret:'fixture-secret',tracking:'DISABLED'}});
 const app=createNativePlunkApp({origin,projectId:project.id,controllers:nativePlunkControllers(),
   lookup:async()=>role?{id:'synthetic-staff',role}:null,
   project:async()=>prisma.project.findUnique({where:{id:project.id}}),ready:async()=>{await prisma.$queryRaw`SELECT 1`;}});
 const call=(method,path,body)=>{let r=request(app)[method](path).set('Origin',origin); return body?r.send(body):r;};
 const content={name:'Synthetic template',subject:'Fixture preview',body:'<p>Native content <img src="https://example.invalid/image.png" alt="Fixture" /></p>',from:'fixture@example.invalid',type:'TRANSACTIONAL'};
 let r=await call('post','/templates',content); assert.equal(r.status,201,r.text); const template=r.body;
 assert.equal(template.type,'MARKETING'); assert.equal(template.body,content.body);
 r=await call('get','/templates'); assert.equal(r.status,200,r.text); assert.equal(r.body.total,1);
 r=await call('patch','/templates/'+template.id,{name:'Renamed template',body:content.body}); assert.equal(r.status,200,r.text);
 r=await call('get','/templates/'+template.id); assert.equal(r.body.name,'Renamed template');
 r=await call('post','/templates/'+template.id+'/duplicate'); assert.equal(r.status,201,r.text);
 r=await call('post','/campaigns',{...content,name:'Synthetic campaign',audienceType:'ALL'}); assert.equal(r.status,201,r.text);
 const campaign=r.body.data; assert.equal(campaign.status,'DRAFT'); assert.equal(campaign.type,'MARKETING');
 r=await call('get','/campaigns'); assert.equal(r.status,200,r.text);
 r=await call('post','/segments',{name:'Synthetic empty list',type:'STATIC'}); assert.equal(r.status,201,r.text);
 r=await call('get','/contacts'); assert.equal(r.status,200,r.text); assert.equal(r.body.total,0);
 for(const path of ['/templates','/campaigns','/segments','/analytics/overview','/config','/users/@me/projects']) {
   r=await call('get',path); assert.equal(r.status,200,path+': '+r.text); assert.ok(!r.text.includes('fixture-secret'));
 }
 for(const path of ['/campaigns/'+campaign.id+'/send','/campaigns/'+campaign.id+'/test','/contacts/import','/v1/send','/auth/login']) {
   r=await call('post',path,{}); assert.equal(r.status,423,path);
 }
 role='viewer'; r=await call('post','/templates',content); assert.equal(r.status,403);
 r=await call('get','/templates'); assert.equal(r.status,200);
 role=null; r=await call('get','/templates'); assert.equal(r.status,401);
 console.log('PASS: real native template create/edit/reload/duplicate, draft campaign, static list, empty contacts, analytics/config, holds, viewer and unauthenticated boundaries');
 await prisma.$disconnect(); process.exit(0);
} catch(error) { console.error(error); await prisma.$disconnect(); process.exit(1); }
