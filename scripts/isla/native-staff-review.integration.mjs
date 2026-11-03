// Disposable PostgreSQL only. Exact-staff review exception, never real HTTP/mail.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import pg from '../../node_modules/pg/lib/index.js';
import {prisma} from '../../apps/api/dist/database/prisma.js';
import {NewsletterLedger} from '../../apps/api/dist/isla/NewsletterLedger.js';
import {NativeNewsletterDelivery} from '../../apps/api/dist/isla/NativeNewsletterDelivery.js';
import {reserveStaffTest, reviewedStaffTestEligible, staffTestAuthorization, staffTestRecipient} from '../../apps/api/dist/isla/StaffTestCommissioning.js';
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
const scoped=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c role=plunk_staff_test_operator'});
try {
 const url=new URL(process.env.DATABASE_URL);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55473');assert.equal(url.pathname,'/plunk_native');
 await pool.query('DROP SCHEMA IF EXISTS isla_newsletter CASCADE');
 await pool.query(await fs.readFile('apps/api/src/isla/schema.sql','utf8'));
 await pool.query(await fs.readFile('apps/api/src/isla/staff-test-role.sql','utf8'));
 const project=await prisma.project.create({data:{name:'Synthetic reviewed staff',public:'review-fixture-public',secret:'review-fixture-secret',tracking:'DISABLED'}});
 const contact=await prisma.contact.create({data:{projectId:project.id,email:staffTestRecipient,subscribed:false}});
 const campaign=await prisma.campaign.create({data:{projectId:project.id,name:'Reviewed fixture ONLY',subject:'Fixture',body:'<p>Fixture</p>',from:'noreply@islaelectronics.com',fromName:'ISLA Electronics',replyTo:staffTestRecipient,type:'MARKETING',status:'DRAFT',audienceType:'ALL'}});
 let calls=0;let canonical=true;let outage=false;let now=new Date();
 const opts={mode:'staff-test',apiKey:'mock-fixture-not-real',designatedRecipients:[staffTestRecipient],publicOrigin:'https://example.invalid',webhookSecret:'',clock:()=>now,
  eligibility:async()=>{if(outage)throw Error('synthetic canonical outage');return canonical;},
  fetch:async()=>{calls++;return new Response(JSON.stringify({id:'mock-reviewed-staff'}),{status:200});}};
 const ledger=new NewsletterLedger(pool,opts);
 const consent='Synthetic real-source-shaped consent, fixture only';
 await ledger.importContact({email:staffTestRecipient,review:true,consentEvidence:consent,provenance:[{sourceCategory:'fixture',sourceSystem:'fixture',sourceRecordId:'fixture',observedAt:now.toISOString()}]});
 const normal=new NativeNewsletterDelivery(prisma,ledger,project.id);
 await normal.saveContent(campaign.id,'Reviewed explicit text',0);
 await assert.rejects(()=>normal.staffTestRevision(campaign.id,staffTestRecipient),/ineligible/);
 const draft={from:'ISLA Electronics <noreply@islaelectronics.com>',reply_to:staffTestRecipient,subject:'Fixture',html:'<p>Fixture</p>',text:'Reviewed explicit text'};
 const version=createHash('sha256').update(JSON.stringify(draft)).digest('hex');
 const proof=(id,email,cid,v)=>reviewedStaffTestEligible(scoped,id,email,cid,v);
 assert.equal(await proof(contact.id,staffTestRecipient,campaign.id,version),false);
 await pool.query(`INSERT INTO isla_newsletter.staff_test_review_audit(authorization_id,recipient,native_contact_id,campaign_id,content_version,consent_sha256,review_reasons,evidence_reference) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[staffTestAuthorization,staffTestRecipient,contact.id,campaign.id,version,createHash('sha256').update(consent).digest('hex'),JSON.stringify(['validation_missing','provider_failure_review']),'synthetic audit, no production evidence']);
 assert.equal(await proof(contact.id,staffTestRecipient,campaign.id,version),true);
 for(const args of [[contact.id,'other@example.invalid',campaign.id,version],['wrong',staffTestRecipient,campaign.id,version],[contact.id,staffTestRecipient,'wrong',version],[contact.id,staffTestRecipient,campaign.id,'0'.repeat(64)]])assert.equal(await proof(...args),false);
 await assert.rejects(()=>scoped.query('INSERT INTO isla_newsletter.staff_test_review_audit SELECT * FROM isla_newsletter.staff_test_review_audit'),/permission denied/);
 await assert.rejects(()=>pool.query('DELETE FROM isla_newsletter.staff_test_review_audit'),/immutable/);
 await assert.rejects(()=>pool.query("UPDATE isla_newsletter.staff_test_review_audit SET evidence_reference='changed'"),/immutable/);
 await pool.query('UPDATE isla_newsletter.contacts SET consent_evidence=NULL WHERE email=$1',[staffTestRecipient]);assert.equal(await proof(contact.id,staffTestRecipient,campaign.id,version),false);
 await pool.query('UPDATE isla_newsletter.contacts SET consent_evidence=$2 WHERE email=$1',[staffTestRecipient,'changed']);assert.equal(await proof(contact.id,staffTestRecipient,campaign.id,version),false);
 await pool.query('UPDATE isla_newsletter.contacts SET consent_evidence=$2 WHERE email=$1',[staffTestRecipient,consent]);
 const reviewed=new NativeNewsletterDelivery(prisma,ledger,project.id,proof);
 assert.equal((await reviewed.staffTestRevision(campaign.id,staffTestRecipient)).version,version);
 const id=await reviewed.prepareStaffTest(campaign.id,staffTestRecipient,undefined,version);
 const pin=await reserveStaffTest(scoped,id,version);
 const reviewedStaffTest=(email,v)=>proof(contact.id,email,campaign.id,v);
 const runner=new NewsletterLedger(scoped,{...opts,authorizedDelivery:pin,reviewedStaffTest});
 await reviewed.resumeStaffTest(campaign.id);
 const reset=async()=>{await pool.query("UPDATE isla_newsletter.deliveries SET status='queued',reason=NULL WHERE id=$1",[id]);now=new Date(now.getTime()+3000);};
 // No immutable pin => callback cannot waive review.
 assert.equal(await new NewsletterLedger(scoped,{...opts,reviewedStaffTest}).attempt(id),'skipped');assert.equal(calls,0);await reset();
 for(const reason of ['unsubscribe','hard_bounce','complaint','withdrawal','quarantine']){
  await ledger.suppress(staffTestRecipient,reason,'synthetic','fixture-'+reason);
  assert.equal(await proof(contact.id,staffTestRecipient,campaign.id,version),false);
  assert.equal(await runner.attempt(id),'skipped');assert.equal(calls,0);
  await pool.query('DELETE FROM isla_newsletter.suppressions WHERE email=$1',[staffTestRecipient]);await reset();
 }
 canonical=false;assert.equal(await runner.attempt(id),'skipped');assert.equal(calls,0);canonical=true;await reset();
 outage=true;await assert.rejects(()=>runner.attempt(id),/outage/);assert.equal(calls,0);outage=false;
 // Native/customer state is NEVER resubscribed or cleared by the exception.
 assert.equal((await prisma.contact.findUnique({where:{id:contact.id}})).subscribed,false);
 assert.equal((await pool.query('SELECT review FROM isla_newsletter.contacts WHERE email=$1',[staffTestRecipient])).rows[0].review,true);
 assert.equal(await runner.attempt(id),'accepted');assert.equal(calls,1);
 assert.equal(await runner.attempt(id),'accepted');assert.equal(calls,1);
 await assert.rejects(()=>normal.staffTestRevision(campaign.id,staffTestRecipient),/ineligible/);
 const customer='reviewed-customer-still-held';await ledger.createCampaign(customer,'customer');const customerId=await ledger.enqueue(customer,version,staffTestRecipient,draft);await ledger.setCampaignState(customer,'running');assert.equal(await runner.attempt(customerId),'customer-dispatch-disabled');assert.equal(calls,1);
 console.log('PASS exact-staff immutable review audit: missing/wrong identity/campaign/version/consent denied; operator cannot write audit; native unsubscribed/review preserved; ALL five veto reasons/canonical denial/outage fail closed; no pin cannot waive review; single accepted/dedup mock; customer dispatch held. NO real sends.');
} finally {await prisma.$disconnect();await scoped.end();await pool.end();}
