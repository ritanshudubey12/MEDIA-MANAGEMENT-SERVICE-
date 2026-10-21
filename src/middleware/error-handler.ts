import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { ApiError } from '../lib/errors.js';

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    success: false,
    error: { code: 'ROUTE_NOT_FOUND', message: `${req.method} ${req.path} not found` },
    meta: { requestId: req.requestId },
  });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Internal server error';
  let details: unknown;

  if (err instanceof ApiError) {
    ({ status, code, message, details } = err);
  } else if (err instanceof ZodError) {
    status = 400;
    code = 'VALIDATION_ERROR';
    message = 'Request validation failed';
    details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  } else if ((err as { type?: string }).type === 'entity.too.large') {
    status = 413;
    code = 'FILE_TOO_LARGE';
    message = 'Payload too large';
  } else if ((err as { type?: string }).type === 'entity.parse.failed') {
    status = 400;
    code = 'VALIDATION_ERROR';
    message = 'Malformed JSON body';
  } else {
    console.error(JSON.stringify({ level: 'error', requestId: req.requestId, err: String((err as Error)?.stack ?? err) }));
  }
  res.status(status).json({ success: false, error: { code, message, details }, meta: { requestId: req.requestId } });
}
