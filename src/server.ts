import { createApp } from './app.js';
import { env } from './config/env.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { startWorker, stopWorker } from './workers/media-processing.worker.js';

async function main() {
  const ran = await migrate();
  if (ran.length) console.log(`Applied migrations: ${ran.join(', ')}`);

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    console.log(`Media Management API listening on http://localhost:${env.PORT}`);
  });
  startWorker();

  const shutdown = (signal: string) => {
    console.log(`${signal} received, shutting down`);
    stopWorker();
    server.close(() => void pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
