import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env.js';
import { mintToken } from './generate-token.js';

// Writes postman/media.local.environment.json (git-ignored) with every variable filled in: baseUrl plus freshly minted
// Bearer tokens. The signing secret itself is never written -- only tokens that expire.
export async function writeEnvironment(opts: { waitForExpiry?: boolean } = {}) {
  const dir = path.resolve('postman');
  fs.mkdirSync(dir, { recursive: true });
  const values = {
    baseUrl: process.env.BASE_URL ?? `http://localhost:${env.PORT}`,
    // tenant 1001 / org 5001 / user 7001, every media:* permission
    token: await mintToken({ tenantId: '1001', organizationId: '5001', userId: '7001' }),
    // same tenant, read-only user -> used to prove 403 on writes
    tokenReadOnly: await mintToken({ tenantId: '1001', organizationId: '5001', userId: '7002', permissions: ['media:read'] }),
    // different tenant/org -> used to prove tenant isolation
    tokenOtherTenant: await mintToken({ tenantId: '2002', organizationId: '6001', userId: '8001' }),
    // already-expired token -> used to prove 401 TOKEN_EXPIRED (expires 1s after minting)
    tokenExpired: await mintToken({ tenantId: '1001', organizationId: '5001', userId: '7001', expiresIn: '1s' }),
  };
  if (opts.waitForExpiry) await new Promise((r) => setTimeout(r, 7000)); // 1s ttl + 5s clock tolerance
  const file = path.join(dir, 'media.local.environment.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ name: 'Media API (local)', values: Object.entries(values).map(([key, value]) => ({ key, value, type: 'default', enabled: true })) }, null, 2),
  );
  return file;
}

if (process.argv[1]?.endsWith('postman-env.ts')) {
  writeEnvironment().then((f) => console.log(`Wrote ${f} (tokens valid 8h; import it into Postman and select it)`));
}
