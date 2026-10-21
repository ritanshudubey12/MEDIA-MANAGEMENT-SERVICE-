import path from 'node:path';
import newman from 'newman';
import { writeEnvironment } from './postman-env.js';

const dir = path.resolve('postman');
const envFile = await writeEnvironment({ waitForExpiry: true });

newman.run(
  {
    collection: path.join(dir, 'Media_API.postman_collection.json'),
    environment: envFile,
    workingDir: dir,
    insecureFileRead: true,
    reporters: ['cli'],
  },
  (err: Error | null, summary: any) => {
    if (err) throw err;
    const f: unknown[] = summary.run.failures;
    console.log(`\nRequests: ${summary.run.stats.requests.total}, assertions: ${summary.run.stats.assertions.total}, failed: ${summary.run.stats.assertions.failed}`);
    process.exit(f.length ? 1 : 0);
  },
);
