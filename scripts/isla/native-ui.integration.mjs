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
 const app=createNativePlunkApp({origin,projectId:project.id,providerDomains:async()=>[{id:'synthetic-provider-domain',domain:'example.invalid',verified:true,provider:'resend'}],delivery:new NativeNewsletterDelivery(prisma,ledger,project.id),controllers:nativePlunkControllers(),lookup:async req=>req.headers.cookie?.includes('fixture_staff=admin')?{id:'synthetic-staff',role:'admin'}:null,project:()=>prisma.project.findUnique({where:{id:project.id}}),ready:async()=>{await prisma.$queryRaw`SELECT 1`;}});
 server=http.createServer((req,res)=>{
  if(req.url.startsWith('/staff/newsletters/api/')){req.url=req.url.slice('/staff/newsletters/api'.length);return app(req,res);}
  // Authentication is also required for the native page and its assets.
  if(!req.headers.cookie?.includes('fixture_staff=admin')){res.writeHead(401);return res.end('Staff sign-in required');}
  if(req.url==='/theme-fixture'){res.setHeader('Content-Type','text/html');return res.end('<!doctype html><html><body><iframe title="Native fixture" src="'+base+'/templates/create" style="width:100%;height:950px"></iframe></body></html>');}
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
 await page.locator('#from').fill('fixture');
 assert.equal(await page.getByText('No verified domains',{exact:true}).count(),0);
 assert.ok((await page.getByRole('combobox').first().innerText()).includes('example.invalid'));
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
 const themePage=await context.newPage();await themePage.goto(origin+'/theme-fixture');
 const frame=themePage.frameLocator('iframe');await frame.locator('#name').waitFor();
 for(const theme of ['dark','light']) {
  await themePage.evaluate(t=>document.documentElement.classList.toggle('dark',t==='dark'),theme);
  await frame.locator('html').evaluate((el,dark)=>new Promise((resolve,reject)=>{let n=0;const timer=setInterval(()=>{if(el.classList.contains('dark')===dark){clearInterval(timer);resolve(true);}else if(++n>50){clearInterval(timer);reject(Error('Parent theme not synchronized'));}},20);}),theme==='dark');
  await frame.locator('#name').fill('Visible typed '+theme);await frame.locator('#name').focus();
  await frame.locator('.tiptap[contenteditable=true]').fill('Visible editor '+theme);
  for(const selector of ['#name','#subject','#from','[role=combobox]','.tiptap[contenteditable=true]']) {
   const result=await frame.locator(selector).first().evaluate(el=>{const s=getComputedStyle(el);const l=c=>{const v=c.match(/[\d.]+/g).slice(0,3).map(Number).map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;});return .2126*v[0]+.7152*v[1]+.0722*v[2];};const a=l(s.color),b=l(s.backgroundColor);return {ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),color:s.color,bg:s.backgroundColor};});
   assert.ok(result.ratio>=4.5,theme+' '+selector+' '+JSON.stringify(result));
  }
  await frame.locator('#name').evaluate(el=>{el.disabled=true;});
  const disabled=await frame.locator('#name').evaluate(el=>({color:getComputedStyle(el).color,bg:getComputedStyle(el).backgroundColor,opacity:getComputedStyle(el).opacity}));assert.notEqual(disabled.color,disabled.bg);assert.equal(disabled.opacity,'1');
  await frame.locator('#name').evaluate(el=>{el.disabled=false;});
  await frame.getByRole('combobox').first().click();await frame.getByRole('option').first().waitFor();
  assert.notEqual(await frame.getByRole('listbox').evaluate(el=>getComputedStyle(el).color),await frame.getByRole('listbox').evaluate(el=>getComputedStyle(el).backgroundColor));await themePage.keyboard.press('Escape');
  await themePage.screenshot({path:'newsletter-parent-controls-'+theme+'.png',fullPage:true});
 }
 await themePage.close();console.log('PASS native typed input/editor/selector contrast >=4.5, disabled controls, popup and actual parent theme synchronization BOTH themes');
 await page.screenshot({path:'native-plunk-template-editor.png',fullPage:true});
 const draftResponse=await context.request.post(origin+'/staff/newsletters/api/campaigns',{
  headers:{Origin:origin},data:{name:'Browser native campaign',subject:'Browser draft subject',
   body:'<p>Synthetic campaign content</p>',from:'fixture@example.invalid',type:'MARKETING',audienceType:'ALL'}});
 assert.equal(draftResponse.status(),201,await draftResponse.text());
 const draft=(await draftResponse.json()).data;
 await page.goto(origin+base+'/campaigns/'+draft.id);
 await page.getByText('Resend delivery ledger',{exact:true}).waitFor();
 await page.getByText('Acceptance is not delivery.',{exact:false}).first().waitFor();
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
 // Explicitly synthetic UI responses below exercise presentation, not real provider delivery.
 await page.route('**/campaigns/'+draft.id+'/delivery', route=>route.fulfill({json:{
  intended:12,queued:2,accepted:8,skipped:1,review:1,unsubscribed:1,
  providerEvents:[{event_type:'email.delivered',unique_messages:6,total_events:7},{event_type:'email.bounced',unique_messages:1,total_events:2}],
  caveat:'SYNTHETIC browser metrics fixture — not live delivery',trackingCapability:'unavailable',
  manifest:{frozen_at:'2026-11-02T00:00:00Z',selected:14,excluded:2,remaining:0},
  staffTests:{intended:0,queued:0,accepted:0,skipped:0,review:0,unsubscribed:0,providerEvents:[],caveat:'SYNTHETIC staff fixture',trackingCapability:'unavailable'}
 }}));
 await page.getByRole('button',{name:'Refresh delivery ledger',exact:true}).click();
 await page.getByText('75.0% (6 / 8 accepted)',{exact:true}).waitFor();
 assert.equal(await page.getByRole('row').filter({hasText:'Opened'}).getByText('Unavailable',{exact:true}).count(),2);
 await page.getByText('Separate staff-test ledger',{exact:true}).click();
 await page.getByText('N/A — no accepted messages',{exact:true}).first().waitFor();
 await page.getByText('Plain-text preview (draft only)',{exact:true}).click();
 assert.ok((await page.locator('pre').first().innerText()).includes('{{email}}'));
 // Retain unsaved edits through revision conflict and permission errors; never imply a save.
 await page.route('**/campaigns/'+draft.id+'/content',route=>route.request().method()==='PUT'?route.fulfill({status:409,json:{message:'SYNTHETIC stale revision'}}):route.continue());
 await page.locator('#newsletter-plain-text').fill('SYNTHETIC retained conflict text');
 await page.getByRole('button',{name:'Save plain text',exact:true}).click();
 await page.getByRole('status').filter({hasText:'Revision conflict: your text is retained'}).waitFor();
 assert.equal(await page.locator('#newsletter-plain-text').inputValue(),'SYNTHETIC retained conflict text');
 await page.unroute('**/campaigns/'+draft.id+'/content');
 await page.route('**/campaigns/'+draft.id+'/content',route=>route.request().method()==='PUT'?route.fulfill({status:403,json:{message:'SYNTHETIC permission failure'}}):route.continue());
 await page.getByRole('button',{name:'Save plain text',exact:true}).click();
 await page.getByRole('status').filter({hasText:'Permission denied'}).waitFor();
 assert.equal(await page.locator('#newsletter-plain-text').inputValue(),'SYNTHETIC retained conflict text');
 for(const theme of ['light','dark']) {
  await page.emulateMedia({colorScheme:theme});
  for(const width of [1440,390]) {
   await page.setViewportSize({width,height:1000});
   await page.waitForTimeout(150);
   assert.equal(await page.locator('html').evaluate(el=>el.classList.contains('dark')),theme==='dark');
   assert.ok(await page.locator('body').evaluate(el=>el.scrollWidth<=window.innerWidth));
   await page.locator('#newsletter-plain-text').focus();
   assert.equal(await page.locator('#newsletter-plain-text').evaluate(el=>getComputedStyle(el).outlineStyle),'solid');
   await page.screenshot({path:`newsletter-fixture-${theme}-${width}.png`,fullPage:true});
  }
 }
 await page.unroute('**/campaigns/'+draft.id+'/content');
 await page.unroute('**/campaigns/'+draft.id+'/delivery');
 page.once('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'Load latest saved text',exact:true}).click();
 await page.setViewportSize({width:1440,height:1000});
 console.log('PASS SYNTHETIC metrics/rates, separate zero-denominator ledger, draft preview, retained409/403 edits, both themes and desktop/mobile focus/overflow checks');
 await page.getByRole('button',{name:'Send',exact:true}).click();
 for(const label of ['Send test email','Send now','Schedule for later']){
  assert.equal(await page.getByRole('menuitem').filter({hasText:label}).getAttribute('aria-disabled'),'true');
 }
 await page.keyboard.press('Escape');
 console.log('PASS native campaign draft edit/reload persistence; test/send/schedule visibly held');
 const contact=await prisma.contact.create({data:{projectId:project.id,email:'suppression-ui@example.invalid',subscribed:false}});
 const projection={version:1,nativeSubscribed:false,review:true,localVetoes:['unsubscribe'],canonical:{state:'suppressed',reason:'canonical-marketing-veto',checkedAt:'2026-11-02T00:00:00Z'},eligible:false,consentEvidencePresent:true};
 await page.route('**/contacts/'+contact.id+'/marketing-status',route=>route.fulfill({json:projection}));
 await page.goto(origin+base+'/contacts/'+contact.id);
 await page.getByRole('heading',{name:'Durable marketing suppression',exact:true}).waitFor();
 await page.getByText('Excluded from marketing',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Save Changes',exact:true}).isDisabled(),true);
 await page.unroute('**/contacts/'+contact.id+'/marketing-status');
 projection.canonical={state:'unavailable',reason:null,checkedAt:null};projection.eligible=null;
 await page.route('**/contacts/'+contact.id+'/marketing-status',route=>route.fulfill({json:projection}));
 await page.getByRole('button',{name:'Refresh suppression status',exact:true}).click();
 await page.getByText('Unknown — fail closed',{exact:true}).waitFor();
 await page.unroute('**/contacts/'+contact.id+'/marketing-status');
 await page.route('**/contacts/'+contact.id+'/marketing-status',route=>route.fulfill({status:503,json:{message:'SYNTHETIC service unavailable'}}));
 await page.getByRole('button',{name:'Refresh suppression status',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'Suppression details unavailable'}).waitFor();
 console.log('PASS SYNTHETIC suppression projection, canonical unavailable fail-closed, service503 alert and held contact mutations');
 await page.screenshot({path:'native-plunk-campaign-editor.png',fullPage:true});
 console.log('BROWSER_ERRORS',JSON.stringify(errors));console.log('HTTP_ERRORS',JSON.stringify(failed));
 assert.deepEqual(errors,[]);assert.deepEqual(failed.filter(([status])=>![403,409,503].includes(status)),[]);
} catch(error) {
 if(browser){for(const context of browser.contexts()){for(const page of context.pages()){console.log('FAILURE_PAGE',await page.locator('body').innerText());await page.screenshot({path:'native-ui-failure.png',fullPage:true});}}}
 throw error;
} finally {
 await browser?.close();server?.closeAllConnections();await new Promise(r=>server?server.close(r):r());
 if(frontend.exitCode===null){const exited=new Promise(r=>frontend.once('exit',r));frontend.kill('SIGTERM');await exited;}
 await Promise.all(Object.entries(queues).filter(([name,value])=>name.endsWith('Queue')&&typeof value.close==='function').map(([,queue])=>queue.close()));
 await prisma.$disconnect();await redis.quit();await ledgerPool.end();
}
