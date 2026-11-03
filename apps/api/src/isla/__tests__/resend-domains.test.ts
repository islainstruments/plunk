import {describe,it,expect,vi} from 'vitest';
vi.mock('../NewsletterRuntime.js',()=>({readPrivateJson:vi.fn()}));
import {readPrivateJson} from '../NewsletterRuntime.js';
import {resendProjectDomains} from '../ResendDomains.js';
const fresh=()=>({provider:'resend',checkedAt:new Date().toISOString(),domains:[{id:'provider-fixture',name:'islaelectronics.com',status:'verified',sending:'enabled'}]});
describe('Resend provider-backed native domain selector',()=>{
 it('maps actual verified sending identity without credentials or SES tokens',async()=>{
  vi.mocked(readPrivateJson).mockResolvedValue(fresh());
  expect(await resendProjectDomains('fixed-project')).toMatchObject([{projectId:'fixed-project',domain:'islaelectronics.com',verified:true,provider:'resend',dkimTokens:[]}]);
 });
 it('never verifies failed or sending-disabled provider identities',async()=>{
  for(const patch of [{status:'failed'},{sending:'disabled'}]){const v=fresh();Object.assign(v.domains[0],patch);vi.mocked(readPrivateJson).mockResolvedValue(v);expect((await resendProjectDomains('fixed'))[0]?.verified).toBe(false);}
 });
 it('fails closed on missing, stale, future, wrong-domain or extra secret fields',async()=>{
  const stale={...fresh(),checkedAt:'2020-01-01T00:00:00Z'};
  const future={...fresh(),checkedAt:'2099-01-01T00:00:00Z'};
  const wrong=fresh();wrong.domains[0]!.name='wrong.invalid';
  for(const value of [null,stale,future,wrong,{...fresh(),apiKey:'synthetic-never-accepted'}]){vi.mocked(readPrivateJson).mockResolvedValue(value);await expect(resendProjectDomains('fixed')).rejects.toThrow();}
  vi.mocked(readPrivateJson).mockRejectedValue(new Error('unavailable'));await expect(resendProjectDomains('fixed')).rejects.toThrow();
 });
});
