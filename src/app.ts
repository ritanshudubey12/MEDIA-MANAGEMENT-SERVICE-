import cors from 'cors';
import express from 'express';
import fsp from 'node:fs/promises';
import helmet from 'helmet';
import { env } from './config/env.js';
import { pool } from './db/pool.js';
import { asyncHandler } from './lib/http.js';
import { authenticate } from './middleware/authenticate.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { requestId } from './middleware/request-id.js';
import { foldersRouter } from './modules/folders/folders.routes.js';
import { mediaRouter } from './modules/media/media.routes.js';
import { publicRouter } from './modules/media/public.routes.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestId);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: true, exposedHeaders: ['X-Request-Id'] }));

  app.get('/health', (req, res) => {
    res.status(200).json({ success: true, data: { status: 'ok' }, meta: { requestId: req.requestId } });
  });
  app.get(
    '/ready',
    asyncHandler(async (req, res) => {
      const checks: Record<string, string> = {};
      try {
        await pool.query('SELECT 1');
        checks.database = 'ok';
      } catch {
        checks.database = 'unavailable';
      }
      try {
        await fsp.mkdir(env.STORAGE_LOCAL_DIR, { recursive: true });
        await fsp.access(env.STORAGE_LOCAL_DIR);
        checks.storage = 'ok';
      } catch {
        checks.storage = 'unavailable';
      }
      const ready = Object.values(checks).every((v) => v === 'ok');
      res.status(ready ? 200 : 503).json({ success: ready, data: { status: ready ? 'ready' : 'degraded', checks }, meta: { requestId: req.requestId } });
    }),
  );

  // Signed-URL / public-asset routes (no Bearer): mounted before the JSON parser so raw uploads are untouched.
  app.use('/api/v1/media', publicRouter);

  app.use(express.json({ limit: '100kb' }));
  // Everything below requires a verified Bearer JWT. Folder routes come first so /folders is not captured by /:id.
  app.use('/api/v1/media/folders', authenticate, foldersRouter);
  app.use('/api/v1/media', authenticate, mediaRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
