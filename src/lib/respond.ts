import type { Request, Response } from 'express';

export const ok = (req: Request, res: Response, data: unknown, extraMeta: Record<string, unknown> = {}) =>
  res.status(200).json({ success: true, data, meta: { requestId: req.requestId, ...extraMeta } });
