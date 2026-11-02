// Synthetic-only browser commissioning of the actual compiled upstream Plunk UI.
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
const {chromium}=await import(process.env.ISLA_PLAYWRIGHT_MODULE || 'playwright');
import {createNativePlunkApp} from '../../apps/api/dist/isla/NativePlunkApp.js';
import {nativePlunkControllers} from '../../apps/api/dist/isla/NativePlunkControllers.js';
import {prisma} from '../../apps/api/dist/database/prisma.js';
import {redis} from '../../apps/api/dist/database/redis.js';
import * as queues from '../../apps/api/dist/services/QueueService.js';
import pg from '../../node_modules/pg/lib/index.js';
import {NewsletterLedger} from '../../apps/api/dist/isla/NewsletterLedger.js';
import {NativeNewsletterDelivery} from '../../apps/api/dist/isla/NativeNewsletterDelivery.js';
const ledgerPool=new pg.Pool({connectionString:process.env.DATABASE_URL});
const ledger=new NewsletterLedger(ledgerPool,{mode:'disabled',publicOrigin:'https://staff.example.invalid',webhookSecret:'',eligibility:async()=>false});
const base='/staff/newsletters/plunk';
const origin='http://127.0.0.1:55475';
let browser, server;
const frontend=spawn(process.execPath,['../../node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','55476'],{cwd:new URL('../../apps/web/',import.meta.url),env:{...process.env,NEXT_PUBLIC_ISLA_STAFF:'true'},stdio:['ignore','pipe','pipe']});
frontend.stdout.on('data',()=>{}); frontend.stderr.on('data',b=>console.error(b.toString()));
try {
 const project=await prisma.project.create({data:{name:'Synthetic UI commissioning',public:'ui-fixture-public',secret:'ui-fixture-secret',tracking:'DISABLED'}});
 const app=createNativePlunkApp({origin,projectId:project.id,delivery:new NativeNewsletterDelivery(prisma,ledger,project.id),controllers:nativePlunkControllers(),lookup:async req=>req.headers.cookie?.includes('fixture_staff=admin')?{id:'synthetic-staff',role:'admin'}:null,project:()=>prisma.project.findUnique({where:{id:project.id}}),ready:async()=>{await prisma.$queryRaw`SELECT 1`;}});
 server=http.createServer((req,res)=>{
  if(req.url.startsWith('/staff/newsletters/api/')){req.url=req.url.slice('/staff/newsletters/api'.length);return app(req,res);}
  // Authentication is also required for the native page and its assets.
  if(!req.headers.cookie?.includes('fixture_staff=admin')){res.writeHead(401);return res.end('Staff sign-in required');}
  const upstream=http.request({hostname:'127.0.0.1',port:55476,path:req.url,method:req.method,headers:req.headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});
  upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);
 });
 await new Promise(r=>server.listen(55475,'127.0.0.1',r));
 for(let n=0;n<80;n++){try{if((await fetch('http://127.0.0.1:55476'+base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({headless:true});
 const context=await browser.newContext();
 assert.equal((await context.request.get(origin+base)).status(),401);
 await context.addCookies([{name:'fixture_staff',value:'admin',url:origin}]);
 const errors=[],failed=[];
 context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
 await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 const page=await context.newPage();
 page.on('response',r=>{if(r.status()>=400)failed.push([r.status(),new URL(r.url()).pathname]);});
 for(const [path,title] of [['/templates','Templates'],['/contacts','Contacts'],['/segments','Segments'],['/campaigns','Campaigns'],['/analytics','Analytics']]){
  await page.goto(origin+base+path);
  try { await page.getByRole('heading',{name:title,exact:true}).waitFor({timeout:12000}); }
  catch(error){console.log('PAGE',await page.locator('body').innerText());console.log('ERRORS',JSON.stringify({errors,failed}));await page.screenshot({path:'native-ui-failure.png',fullPage:true});throw error;}
  await page.waitForTimeout(400);console.log('PASS native page '+path);
 }
 await page.goto(origin+base+'/templates/create');
 await page.getByRole('heading',{name:'Create template',exact:true}).waitFor();
 await page.locator('#name').fill('Browser native reusable template');
 await page.locator('#subject').fill('Synthetic browser subject');
 await page.locator('#from').fill('fixture@example.invalid');
 await page.locator('.tiptap[contenteditable=true]').fill('Synthetic visual editor content');
 const created=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/api/templates'));
 await page.getByRole('button',{name:'Create Template',exact:true}).click();
 const response=await created;assert.equal(response.status(),201,await response.text());
 const template=await response.json();assert.equal(template.type,'MARKETING');
 await page.getByRole('heading',{name:'Edit template',exact:true}).waitFor();
 await page.locator('#subject').fill('Edited native browser subject');
 const [saved]=await Promise.all([
  page.waitForResponse(r=>r.request().method()==='PATCH'&&r.url().endsWith('/templates/'+template.id)),
  page.locator('button[type=submit]').filter({hasText:'Save Changes'}).click(),
 ]);
 assert.equal(saved.status(),200);
 await page.reload();await page.locator('#subject').waitFor();
 assert.equal(await page.locator('#subject').inputValue(),'Edited native browser subject');
 assert.ok((await prisma.template.findUnique({where:{id:template.id}})).body.includes('Synthetic visual editor content'));
 console.log('PASS native visual editor create, save, database persistence and reload');
 await page.screenshot({path:'native-plunk-template-editor.png',fullPage:true});
 const draftResponse=await context.request.post(origin+'/staff/newsletters/api/campaigns',{
  headers:{Origin:origin},data:{name:'Browser native campaign',subject:'Browser draft subject',
   body:'<p>Synthetic campaign content</p>',from:'fixture@example.invalid',type:'MARKETING',audienceType:'ALL'}});
 assert.equal(draftResponse.status(),201,await draftResponse.text());
 const draft=(await draftResponse.json()).data;
 await page.goto(origin+base+'/campaigns/'+draft.id);
 await page.getByText('Resend delivery ledger',{exact:true}).waitFor();
 await page.getByText('Acceptance is not delivery.',{exact:false}).waitFor();
 await page.locator('#newsletter-plain-text').fill('Reviewed native campaign plain text {{email}}');
 const [textSaved]=await Promise.all([
  page.waitForResponse(r=>r.request().method()==='PUT'&&r.url().endsWith('/campaigns/'+draft.id+'/content')),
  page.getByRole('button',{name:'Save plain text',exact:true}).click(),
 ]);
 assert.equal(textSaved.status(),200,await textSaved.text());
 await page.locator('#subject').waitFor();
 await page.locator('#subject').fill('Edited browser campaign subject');
 const [campaignSaved]=await Promise.all([
  page.waitForResponse(r=>r.request().method()==='PUT'&&r.url().endsWith('/campaigns/'+draft.id)),
  page.locator('button[type=submit]').filter({hasText:'Save'}).first().click(),
 ]);
 assert.equal(campaignSaved.status(),200,await campaignSaved.text());
 await page.reload();await page.locator('#subject').waitFor();
 assert.equal(await page.locator('#subject').inputValue(),'Edited browser campaign subject');
 assert.equal(await page.locator('#newsletter-plain-text').inputValue(),'Reviewed native campaign plain text {{email}}');
 assert.equal((await prisma.campaign.findUnique({where:{id:draft.id}})).status,'DRAFT');
 await page.getByRole('button',{name:'Send',exact:true}).click();
 for(const label of ['Send test email','Send now','Schedule for later']){
  assert.equal(await page.getByRole('menuitem').filter({hasText:label}).getAttribute('aria-disabled'),'true');
 }
 await page.keyboard.press('Escape');
 console.log('PASS native campaign draft edit/reload persistence; test/send/schedule visibly held');
 await page.screenshot({path:'native-plunk-campaign-editor.png',fullPage:true});
 console.log('BROWSER_ERRORS',JSON.stringify(errors));console.log('HTTP_ERRORS',JSON.stringify(failed));
 assert.deepEqual(errors,[]);assert.deepEqual(failed,[]);
} catch(error) {
 if(browser){for(const context of browser.contexts()){for(const page of context.pages()){console.log('FAILURE_PAGE',await page.locator('body').innerText());await page.screenshot({path:'native-ui-failure.png',fullPage:true});}}}
 throw error;
} finally {
 await browser?.close();server?.closeAllConnections();await new Promise(r=>server?server.close(r):r());
 if(frontend.exitCode===null){const exited=new Promise(r=>frontend.once('exit',r));frontend.kill('SIGTERM');await exited;}
 await Promise.all(Object.entries(queues).filter(([name,value])=>name.endsWith('Queue')&&typeof value.close==='function').map(([,queue])=>queue.close()));
 await prisma.$disconnect();await redis.quit();await ledgerPool.end();
}
