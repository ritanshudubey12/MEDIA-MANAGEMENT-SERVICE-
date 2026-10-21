import { SignJWT } from 'jose';
import { env } from '../config/env.js';

// Dev helper: mint a Bearer JWT signed with JWT_SECRET. Usage: npm run token -- [tenantId] [orgId] [userId] [perm,perm] [ttl]
// In production the identity provider / BFF issues tokens; this only exists so the API can be exercised locally.
export const ALL_PERMISSIONS = ['media:read', 'media:upload', 'media:update', 'media:process', 'media:delete', 'media:manage'];

export async function mintToken(opts: {
  tenantId: string;
  organizationId: string;
  userId: string;
  permissions?: string[];
  websiteIds?: string[];
  expiresIn?: string;
}) {
  return new SignJWT({
    tenant_id: opts.tenantId,
    organization_id: opts.organizationId,
    permissions: opts.permissions ?? ALL_PERMISSIONS,
    ...(opts.websiteIds ? { website_ids: opts.websiteIds } : {}),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(opts.userId)
    .setIssuer(env.AUTH_ISSUER)
    .setAudience(env.AUTH_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? '8h')
    .sign(new TextEncoder().encode(env.JWT_SECRET));
}

if (process.argv[1]?.endsWith('generate-token.ts')) {
  const [tenantId = '1001', organizationId = '5001', userId = '7001', perms, ttl] = process.argv.slice(2);
  mintToken({
    tenantId,
    organizationId,
    userId,
    permissions: perms ? perms.split(',') : undefined,
    expiresIn: ttl,
  }).then((t) => console.log(t));
}
