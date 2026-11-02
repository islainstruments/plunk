/* ISLA staff-session compatibility boundary. AGPL-3.0. */
import {createHmac, timingSafeEqual} from 'node:crypto';
import type {Pool} from 'pg';
import type {Request} from 'express';

export interface Staff {
  id: string;
  role: 'admin' | 'support_agent' | 'developer' | 'viewer';
}
export type StaffLookup = (request: Request) => Promise<Staff | null>;
/** Matches the existing website isla_staff HMAC format, never accepts Plunk/API keys. */
export function websiteStaffLookup(staffDb: Pool, authSecret: string, clock = Date.now): StaffLookup {
  if (authSecret.length < 32) throw new Error('Strong server-side staff secret required');
  return async request => {
    const cookie = request.headers.cookie ?? '';
    const entries = cookie
      .split(';')
      .map(p => p.trim())
      .filter(p => p.startsWith('isla_staff='));
    if (entries.length !== 1) return null;
    const token = entries[0]!.slice('isla_staff='.length);
    if (token.length > 1024) return null;
    const parts = token.split('.');
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]!) || !/^[a-f0-9]{64}$/.test(parts[1]!)) return null;
    const encoded = parts[0]!;
    const expected = createHmac('sha256', authSecret).update(encoded).digest();
    if (!timingSafeEqual(expected, Buffer.from(parts[1]!, 'hex'))) return null;
    let payload: {exp?: unknown; authUserId?: unknown};
    try {
      payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as typeof payload;
    } catch {
      return null;
    }
    if (
      typeof payload.exp !== 'number' ||
      !Number.isFinite(payload.exp) ||
      payload.exp <= clock() ||
      typeof payload.authUserId !== 'string' ||
      !payload.authUserId
    )
      return null;
    const row = (
      await staffDb.query('SELECT id,role FROM public.staff_users WHERE id=$1 AND active=true LIMIT 1', [
        payload.authUserId,
      ])
    ).rows[0];
    if (!row || !['admin', 'support_agent', 'developer', 'viewer'].includes(row.role as string)) return null;
    return {id: row.id as string, role: row.role as Staff['role']};
  };
}
