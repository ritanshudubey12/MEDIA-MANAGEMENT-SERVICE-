import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { badRequest } from './errors.js';

// Express 4 does not forward rejected promises to the error handler; wrap async handlers.
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export function validateIdParam(_req: Request, _res: Response, next: NextFunction, value: string) {
  if (!/^[0-9]{1,19}$/.test(value)) return next(badRequest('Path ID must be a decimal string'));
  next();
}
