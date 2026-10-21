import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export function requestId(req: Request, res: Response, next: NextFunction) {
  const incoming = req.header('x-request-id');
  req.requestId = incoming && /^[\w.-]{1,64}$/.test(incoming) ? incoming : `req_${crypto.randomUUID()}`;
  res.setHeader('X-Request-Id', req.requestId);
  next();
}
