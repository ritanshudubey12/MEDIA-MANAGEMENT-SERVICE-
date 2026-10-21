import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../lib/errors.js';

export type Permission =
  | 'media:read'
  | 'media:upload'
  | 'media:update'
  | 'media:process'
  | 'media:delete'
  | 'media:manage';

// media:manage is a superset of every other media permission.
export const requirePermission = (perm: Permission) => (req: Request, _res: Response, next: NextFunction) => {
  const p = req.ctx.permissions;
  if (p.has(perm) || p.has('media:manage')) return next();
  next(new ApiError(403, 'INSUFFICIENT_PERMISSION', `Missing permission ${perm}`));
};

export function assertWebsiteAccess(req: Request, websiteId: string | null | undefined) {
  const allowed = req.ctx.websiteIds;
  if (allowed && !websiteId) throw new ApiError(403, 'FORBIDDEN', 'websiteId is required for website-restricted tokens');
  if (allowed && websiteId && !allowed.has(websiteId)) throw new ApiError(403, 'FORBIDDEN', 'No access to the requested website');
}
