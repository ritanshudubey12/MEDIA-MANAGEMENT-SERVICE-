import type { NextFunction, Request, Response } from 'express';
import { jwtVerify, errors as joseErrors } from 'jose';
import { env } from '../config/env.js';
import { ApiError } from '../lib/errors.js';

export interface RequestContext {
  userId: string;
  tenantId: string;
  organizationId: string;
  permissions: Set<string>;
  websiteIds: Set<string> | null; // null = unrestricted
  requestId: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    ctx: RequestContext;
    requestId: string;
  }
}

const secret = new TextEncoder().encode(env.JWT_SECRET);
const ID_RE = /^[0-9]{1,19}$/;

function claimId(value: unknown, name: string): string {
  const s = typeof value === 'number' ? String(value) : value;
  if (typeof s !== 'string' || !ID_RE.test(s)) {
    throw new ApiError(401, 'INVALID_TOKEN', `Token claim ${name} missing or invalid`);
  }
  return s;
}

// Verifies the Bearer JWT (signature, issuer, audience, exp, nbf). Identity and tenant/org scope come ONLY from
// the verified token claims; X-Tenant-Id / X-User-Id style headers sent by the client are ignored.
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.header('authorization');
    if (!header) throw new ApiError(401, 'UNAUTHENTICATED', 'Authorization header is required');
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new ApiError(401, 'UNAUTHENTICATED', 'Authorization must be of the form: Bearer <token>');
    }
    let payload;
    try {
      ({ payload } = await jwtVerify(token, secret, {
        issuer: env.AUTH_ISSUER,
        audience: env.AUTH_AUDIENCE,
        algorithms: ['HS256'],
        requiredClaims: ['exp', 'sub'], // tokens must expire and identify a subject
        clockTolerance: 5,
      }));
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) throw new ApiError(401, 'TOKEN_EXPIRED', 'Token has expired');
      throw new ApiError(401, 'INVALID_TOKEN', 'Token is invalid');
    }
    const perms = Array.isArray(payload.permissions) ? payload.permissions.map(String) : [];
    const sites = Array.isArray(payload.website_ids) ? payload.website_ids.map(String) : null;
    req.ctx = {
      userId: claimId(payload.sub, 'sub'),
      tenantId: claimId(payload.tenant_id, 'tenant_id'),
      organizationId: claimId(payload.organization_id, 'organization_id'),
      permissions: new Set(perms),
      // website_ids claim present => restricted to exactly that list (an empty list means no website access).
      websiteIds: sites ? new Set(sites) : null,
      requestId: req.requestId,
    };
    next();
  } catch (err) {
    next(err);
  }
}
