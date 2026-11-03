/* Actual provider readback, not SES verification or a locally invented flag. AGPL-3.0. */
import {z} from 'zod';
import {readPrivateJson} from './NewsletterRuntime.js';
const snapshot = z.object({provider: z.literal('resend'), checkedAt: z.string().datetime(),
  domains: z.array(z.object({id: z.string(), name: z.literal('islaelectronics.com'), status: z.string(),
    sending: z.enum(['enabled', 'disabled'])}).strict()).max(1)}).strict();
export async function resendProjectDomains(projectId: string) {
  const value = snapshot.parse(await readPrivateJson('/run/newsletter/resend-domains.json'));
  const age = Date.now() - Date.parse(value.checkedAt);
  if (age < -60000 || age > 2 * 60 * 60 * 1000) throw new Error('Provider domain readback expired');
  return value.domains.map(d => ({id: d.id, projectId, domain: d.name,
    verified: d.status === 'verified' && d.sending === 'enabled', provider: value.provider,
    providerStatus: d.status, checkedAt: value.checkedAt, dkimTokens: []}));
}
