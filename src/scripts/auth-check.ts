import { SignJWT } from 'jose';
import 'dotenv/config';
const enc = (s: string) => new TextEncoder().encode(s);
const base = { tenant_id: '1001', organization_id: '5001', permissions: ['media:read'] };
const mk = async (o: { secret?: string; iss?: string; aud?: string; exp?: string | null; sub?: string | null; extra?: object; alg?: string }) => {
  let j = new SignJWT({ ...base, ...(o.extra ?? {}) }).setProtectedHeader({ alg: (o.alg ?? 'HS256') as 'HS256' }).setIssuer(o.iss ?? process.env.AUTH_ISSUER!).setAudience(o.aud ?? process.env.AUTH_AUDIENCE!).setIssuedAt();
  if (o.sub !== null) j = j.setSubject(o.sub ?? '7001');
  if (o.exp !== null) j = j.setExpirationTime(o.exp ?? '1h');
  return j.sign(enc(o.secret ?? process.env.JWT_SECRET!));
};
const none = Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url') + '.' + Buffer.from(JSON.stringify({ ...base, sub: '7001', iss: process.env.AUTH_ISSUER, aud: process.env.AUTH_AUDIENCE, exp: 9999999999 })).toString('base64url') + '.';
const cases: [string, string, number][] = [
  ['valid', await mk({}), 200],
  ['wrong secret', await mk({ secret: 'x'.repeat(40) }), 401],
  ['wrong issuer', await mk({ iss: 'evil' }), 401],
  ['wrong audience', await mk({ aud: 'evil' }), 401],
  ['alg HS512', await mk({ alg: 'HS512' }), 401],
  ['alg none', none, 401],
  ['no exp', await mk({ exp: null }), 401],
  ['no sub', await mk({ sub: null }), 401],
  ['non-numeric tenant', await mk({ extra: { tenant_id: 'abc' } }), 401],
  
];
for (const [name, t, want] of cases) {
  const r = await fetch('http://localhost:4017/api/v1/media', { headers: { authorization: `Bearer ${t}` } });
  const j: any = await r.json();
  console.log(`${r.status === want ? 'ok  ' : 'FAIL'} ${name}: ${r.status} ${j.error?.code ?? ''} ${name.startsWith('empty') ? 'items=' + j.data?.length : ''}`);
}
for (const h of ['Basic abc', 'Bearer', 'bearer  ', 'Token abc']) {
  const r = await fetch('http://localhost:4017/api/v1/media', { headers: { authorization: h } });
  console.log(`${r.status === 401 ? 'ok  ' : 'FAIL'} header "${h}": ${r.status}`);
}

// Website-scoped tokens: website_ids claim restricts upload sessions.
const post = async (token: string, body: object) => {
  const r = await fetch('http://localhost:4017/api/v1/media/upload-sessions', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.status;
};
const f = { fileName: 'a.png', contentType: 'image/png', sizeBytes: '10' };
const scoped = await mk({ extra: { permissions: ['media:upload'], website_ids: ['111'] } });
const empty = await mk({ extra: { permissions: ['media:upload'], website_ids: [] } });
for (const [name, t, body, want] of [
  ['scoped token, other website', scoped, { ...f, websiteId: '222' }, 403],
  ['scoped token, no websiteId', scoped, f, 403],
  ['empty website_ids, any website', empty, { ...f, websiteId: '111' }, 403],
] as [string, string, object, number][]) {
  const s = await post(t, body);
  console.log(`${s === want ? 'ok  ' : 'FAIL'} ${name}: ${s}`);
}
