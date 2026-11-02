/* ISLA native Plunk staff boundary. AGPL-3.0. */
import type {NextFunction, Request, Response} from 'express';
import type {StaffLookup} from './StaffBoundary.js';
import {requireSecretKey} from '../middleware/auth.js';

// Not express input: only the server-side staff verifier may mark a response.
const verified = new WeakSet<Response>();
export const hasVerifiedStaffPlunk = (res: Response) => verified.has(res);
const reads = [
  /^\/templates(?:\/[^/]+(?:\/usage)?)?$/,
  /^\/campaigns(?:\/[^/]+(?:\/(?:stats|recipients|delivery|content))?)?$/,
  /^\/contacts(?:\/fields(?:\/[^/]+\/(?:values|usage))?|\/[^/]+(?:\/marketing-status)?)?$/,
  /^\/segments(?:\/[^/]+(?:\/contacts)?)?$/,
  /^\/analytics\/(?:overview|timeseries|deliverability|leaderboard|links|heatmap|audience|events)$/,
  /^\/activity(?:\/(?:stats|recent-count|types|upcoming|emails\/[^/]+))?$/,
  /^\/users\/@me(?:\/projects)?$/,
  /^\/config$/,
  /^\/domains\/project\/[^/]+$/,
];
const writes: Record<string, RegExp[]> = {
  POST: [/^\/templates$/, /^\/templates\/[^/]+\/duplicate$/, /^\/campaigns$/, /^\/campaigns\/[^/]+\/(?:duplicate|archive|unarchive)$/, /^\/segments$/],
  PATCH: [/^\/templates\/[^/]+$/, /^\/segments\/[^/]+$/],
  PUT: [/^\/campaigns\/[^/]+(?:\/content)?$/],
  DELETE: [/^\/templates\/[^/]+$/, /^\/campaigns\/[^/]+$/, /^\/segments\/[^/]+$/],
};
export function staffPlunkBoundary(options: {lookup: StaffLookup; origin: string; projectId: string; contactWrites?: boolean}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    res.set({'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'});
    try {
      // Native secret-key authentication, restricted to this deployment's project.
      // Never fall back to a browser session after a supplied credential fails.
      if (req.headers.authorization !== undefined) {
        if (req.headers.origin !== undefined || req.headers.cookie !== undefined) return res.sendStatus(403);
        await new Promise<void>((resolve, reject) => {
          Promise.resolve(requireSecretKey(req, res, error => error ? reject(error) : resolve())).catch(reject);
        });
        if (res.locals.auth.projectId !== options.projectId) return res.sendStatus(403);
        const read = ['GET', 'HEAD'].includes(req.method);
        const allowed = read
          ? reads.some(rule => rule.test(req.path)) && !/^\/(?:users|contacts\/public)/.test(req.path)
          : (writes[req.method] ?? []).some(rule => rule.test(req.path)) ||
            (options.contactWrites === true && req.method === 'POST' && req.path === '/contacts');
        if (!allowed) return res.status(423).json({error: {message: 'Action held'}});
        verified.add(res);
        return next();
      }
      const staff = await options.lookup(req);
      if (!staff) return res.status(401).json({error: {message: 'Existing website staff sign-in required'}});
      const read = req.method === 'GET' || req.method === 'HEAD';
      if (!read && (req.headers.origin !== options.origin || staff.role !== 'admin')) {
        return res.status(403).json({error: {message: 'Admin role and exact website Origin required'}});
      }
      const path = req.path;
      // Contact public preference routes have a separate token-based implementation;
      // never expose upstream subscribe/snooze/import or dispatch through this wall.
      const allowed = read ? reads.some(rule => rule.test(path)) && !path.startsWith('/contacts/public')
        : (writes[req.method] ?? []).some(rule => rule.test(path));
      if (!allowed) return res.status(423).json({error: {message: 'Sending, imports and uncommissioned actions are held'}});
      verified.add(res);

      res.locals.staff = staff;
      res.locals.auth = {type: 'apiKey', projectId: options.projectId};
      next();
    } catch (error) {
      if (req.headers.authorization !== undefined) return res.status(401).json({error: {message: 'Native project secret key required'}});
      res.status(503).json({error: {message: 'Staff authorization unavailable'}});
    }
  };
}
