import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

// Generates postman/Media_API.postman_collection.json (+ postman/sample.png used for the upload step).
const outDir = path.resolve('postman');
fs.mkdirSync(outDir, { recursive: true });

const samplePath = path.join(outDir, 'sample.png');
const png = await sharp({ create: { width: 640, height: 400, channels: 3, background: { r: 30, g: 120, b: 220 } } })
  .png()
  .toBuffer();
fs.writeFileSync(samplePath, png);
const SIZE = String(png.length);

type Auth = 'token' | 'tokenReadOnly' | 'tokenOtherTenant' | 'tokenExpired' | 'invalid' | 'none';

interface Req {
  name: string;
  method: string;
  path: string;
  auth?: Auth;
  body?: unknown;
  file?: boolean;
  headers?: Record<string, string>;
  pre?: string;
  tests: string;
}

const OK = (extra = '') => `
pm.test('Status is 200 OK', () => pm.response.to.have.status(200));
const j = pm.response.json();
pm.test('Envelope success=true with requestId', () => { pm.expect(j.success).to.eql(true); pm.expect(j.meta.requestId).to.be.a('string'); });
${extra}`;

const EXPECT = (code: number, errCode: string) => `
pm.test('Status is ${code}', () => pm.response.to.have.status(${code}));
const j = pm.response.json();
pm.test('Error code is ${errCode}', () => { pm.expect(j.success).to.eql(false); pm.expect(j.error.code).to.eql('${errCode}'); });`;

const item = (r: Req) => {
  const header: { key: string; value: string }[] = [];
  const auth = r.auth ?? 'token';
  if (auth === 'invalid') header.push({ key: 'Authorization', value: 'Bearer not.a.jwt' });
  else if (auth !== 'none') header.push({ key: 'Authorization', value: `Bearer {{${auth}}}` });
  if (r.body !== undefined) header.push({ key: 'Content-Type', value: 'application/json' });
  for (const [k, v] of Object.entries(r.headers ?? {})) header.push({ key: k, value: v });
  const request: Record<string, unknown> = { method: r.method, header, url: `{{baseUrl}}${r.path}` };
  if (r.body !== undefined) request.body = { mode: 'raw', raw: JSON.stringify(r.body, null, 2) };
  if (r.file) request.body = { mode: 'file', file: { src: 'sample.png' } };
  const event: unknown[] = [{ listen: 'test', script: { type: 'text/javascript', exec: r.tests.split('\n') } }];
  if (r.pre) event.unshift({ listen: 'prerequest', script: { type: 'text/javascript', exec: r.pre.split('\n') } });
  return { name: r.name, event, request };
};

const folder = (name: string, reqs: Req[]) => ({ name, item: reqs.map(item) });

// Poll helper: re-runs the same request (with a short delay) until `cond` holds, max 25 tries.
const POLL = (cond: string, counter: string) => `
const tries = Number(pm.collectionVariables.get('${counter}') || 0);
if (!(${cond}) && tries < 25) { pm.collectionVariables.set('${counter}', tries + 1); postman.setNextRequest(pm.info.requestName); }
else { pm.collectionVariables.set('${counter}', 0); pm.test('Condition reached', () => pm.expect(${cond}).to.eql(true)); }`;
const DELAY = `setTimeout(() => {}, 300);`;

const setup: Req[] = [
  { name: 'GET /health', method: 'GET', path: '/health', auth: 'none', tests: OK(`pm.test('status ok', () => pm.expect(j.data.status).to.eql('ok'));`) },
  { name: 'GET /ready', method: 'GET', path: '/ready', auth: 'none', tests: OK(`pm.test('db + storage ok', () => pm.expect(j.data.checks).to.eql({ database: 'ok', storage: 'ok' }));`) },
  {
    name: 'POST folder (create)',
    method: 'POST',
    path: '/api/v1/media/folders',
    body: { name: 'Postman {{$timestamp}}' },
    tests: OK(`pm.collectionVariables.set('folderId', j.data.id);
pm.test('Folder id is a decimal string', () => pm.expect(j.data.id).to.match(/^[0-9]+$/));`),
  },
  { name: 'GET folders (list)', method: 'GET', path: '/api/v1/media/folders?parentFolderId=root', tests: OK(`pm.test('Contains created folder', () => pm.expect(j.data.map(f => f.id)).to.include(pm.collectionVariables.get('folderId')));`) },
  { name: 'GET folder by id', method: 'GET', path: '/api/v1/media/folders/{{folderId}}', tests: OK(`pm.test('Right folder', () => pm.expect(j.data.id).to.eql(pm.collectionVariables.get('folderId')));`) },
  {
    name: 'PATCH folder (rename)',
    method: 'PATCH',
    path: '/api/v1/media/folders/{{folderId}}',
    body: { name: 'Renamed {{$timestamp}}' },
    tests: OK(`pm.test('Renamed', () => pm.expect(j.data.name).to.match(/^Renamed/));`),
  },
  {
    name: 'PUT folder (replace)',
    method: 'PUT',
    path: '/api/v1/media/folders/{{folderId}}',
    body: { name: 'Replaced {{$timestamp}}', parentFolderId: null },
    tests: OK(`pm.test('Replaced', () => pm.expect(j.data.name).to.match(/^Replaced/));`),
  },
  {
    name: 'POST sub-folder',
    method: 'POST',
    path: '/api/v1/media/folders',
    body: { name: 'Child', parentFolderId: '{{folderId}}' },
    tests: OK(`pm.collectionVariables.set('subFolderId', j.data.id);
pm.test('Parent set', () => pm.expect(j.data.parentFolderId).to.eql(pm.collectionVariables.get('folderId')));`),
  },
];

const upload: Req[] = [
  {
    name: 'POST upload-session',
    method: 'POST',
    path: '/api/v1/media/upload-sessions',
    headers: { 'Idempotency-Key': '{{$guid}}' },
    body: { fileName: 'hero-banner.png', contentType: 'image/png', sizeBytes: SIZE, folderId: '{{folderId}}' },
    tests: OK(`const d = j.data;
pm.collectionVariables.set('assetId', d.assetId);
pm.collectionVariables.set('uploadUrl', d.uploadUrl);
pm.test('Status PENDING_UPLOAD', () => pm.expect(d.status).to.eql('PENDING_UPLOAD'));
pm.test('assetId is auto-assigned BIGINT string beyond JS safe integer', () => { pm.expect(d.assetId).to.match(/^[0-9]{16,19}$/); pm.expect(BigInt(d.assetId) > BigInt(Number.MAX_SAFE_INTEGER)).to.eql(true); });
pm.test('uploadUrl present', () => pm.expect(d.uploadUrl).to.include('/api/v1/media/uploads/'));`),
  },
  {
    name: 'PUT binary to signed upload URL',
    method: 'PUT',
    path: '',
    auth: 'none',
    file: true,
    headers: { 'Content-Type': 'image/png' },
    tests: OK(`pm.test('uploaded', () => pm.expect(j.data.uploaded).to.eql(true));`),
  },
  {
    name: 'POST complete-upload',
    method: 'POST',
    path: '/api/v1/media/{{assetId}}/complete-upload',
    body: {},
    tests: OK(`pm.test('Moved past PENDING_UPLOAD', () => pm.expect(['UPLOADED','PROCESSING','READY']).to.include(j.data.status));
pm.test('Actual size recorded as string', () => pm.expect(j.data.sizeBytes).to.eql('${SIZE}'));
pm.test('sha256 recorded', () => pm.expect(j.data.checksumSha256).to.match(/^[a-f0-9]{64}$/));`),
  },
  {
    name: 'POST complete-upload (idempotent replay)',
    method: 'POST',
    path: '/api/v1/media/{{assetId}}/complete-upload',
    body: {},
    tests: OK(`pm.test('Replay flagged', () => pm.expect(j.data.idempotentReplay).to.eql(true));`),
  },
  {
    name: 'GET processing-status (poll until READY)',
    method: 'GET',
    path: '/api/v1/media/{{assetId}}/processing-status',
    pre: DELAY,
    tests: OK(POLL(`j.data.status === 'READY'`, 'pollAsset')),
  },
];

const library: Req[] = [
  {
    name: 'GET media (list, filters, cursor pagination)',
    method: 'GET',
    path: '/api/v1/media?limit=5&q=hero&mimeType=image&status=READY&folderId={{folderId}}',
    tests: OK(`pm.test('Contains uploaded asset', () => pm.expect(j.data.map(a => a.id)).to.include(pm.collectionVariables.get('assetId')));
pm.test('Pagination meta', () => pm.expect(j.meta).to.have.property('nextCursor'));`),
  },
  {
    name: 'GET media/:id (detail with variants)',
    method: 'GET',
    path: '/api/v1/media/{{assetId}}',
    tests: OK(`pm.test('Dimensions extracted by worker', () => { pm.expect(j.data.width).to.eql(640); pm.expect(j.data.height).to.eql(400); });
pm.test('Auto thumbnail variant', () => pm.expect(j.data.variants.map(v => v.variantKey)).to.include('thumb_320'));
pm.test('Private by default', () => pm.expect(j.data.visibility).to.eql('PRIVATE'));
pm.test('Storage key not leaked', () => pm.expect(JSON.stringify(j)).to.not.include('storage'));`),
  },
  {
    name: 'PATCH media/:id',
    method: 'PATCH',
    path: '/api/v1/media/{{assetId}}',
    body: { displayName: 'Hero banner', altText: 'A blue banner', folderId: '{{subFolderId}}' },
    tests: OK(`pm.test('Updated', () => { pm.expect(j.data.displayName).to.eql('Hero banner'); pm.expect(j.data.folderId).to.eql(pm.collectionVariables.get('subFolderId')); });`),
  },
  {
    name: 'PUT media/:id',
    method: 'PUT',
    path: '/api/v1/media/{{assetId}}',
    body: { displayName: 'Hero banner v2', altText: 'Blue banner v2', folderId: '{{folderId}}' },
    tests: OK(`pm.test('Replaced', () => { pm.expect(j.data.displayName).to.eql('Hero banner v2'); pm.expect(j.data.folderId).to.eql(pm.collectionVariables.get('folderId')); });`),
  },
  {
    name: 'POST media/:id/references',
    method: 'POST',
    path: '/api/v1/media/{{assetId}}/references',
    body: { sourceType: 'page', sourceId: 'page-42', referenceKey: 'hero' },
    tests: OK(`pm.collectionVariables.set('referenceId', j.data.id);`),
  },
  {
    name: 'GET media/:id/references',
    method: 'GET',
    path: '/api/v1/media/{{assetId}}/references',
    tests: OK(`pm.test('In use', () => { pm.expect(j.data.inUse).to.eql(true); pm.expect(j.data.references.length).to.eql(1); });`),
  },
  {
    name: 'GET media/usage',
    method: 'GET',
    path: '/api/v1/media/usage',
    tests: OK(`pm.test('Usage counted', () => { pm.expect(BigInt(j.data.storedBytes) >= BigInt('${SIZE}')).to.eql(true); pm.expect(j.data.quotaBytes).to.match(/^[0-9]+$/); });`),
  },
];

const variants: Req[] = [
  {
    name: 'POST resize',
    method: 'POST',
    path: '/api/v1/media/{{assetId}}/resize',
    body: { width: 320, fit: 'inside', format: 'webp' },
    tests: OK(`pm.collectionVariables.set('resizeKey', j.data.variantKey);`),
  },
  {
    name: 'POST crop',
    method: 'POST',
    path: '/api/v1/media/{{assetId}}/crop',
    body: { left: 10, top: 10, width: 200, height: 100 },
    tests: OK(`pm.collectionVariables.set('cropKey', j.data.variantKey);`),
  },
  {
    name: 'POST optimize',
    method: 'POST',
    path: '/api/v1/media/{{assetId}}/optimize',
    body: { quality: 70, format: 'jpeg' },
    tests: OK(`pm.collectionVariables.set('optKey', j.data.variantKey);`),
  },
  {
    name: 'GET processing-status (poll until variants READY)',
    method: 'GET',
    path: '/api/v1/media/{{assetId}}/processing-status',
    pre: DELAY,
    tests: OK(POLL(`j.data.variants.length >= 4 && j.data.variants.every(v => v.status === 'READY')`, 'pollVariants')),
  },
  {
    name: 'GET media/:id/url (signed download URL)',
    method: 'GET',
    path: '/api/v1/media/{{assetId}}/url?variant={{resizeKey}}',
    tests: OK(`pm.collectionVariables.set('signedUrl', j.data.url);
pm.test('Signed URL', () => pm.expect(j.data.url).to.include('sig='));`),
  },
  {
    name: 'GET signed URL (no Bearer needed)',
    method: 'GET',
    path: '',
    auth: 'none',
    tests: `pm.test('Status is 200 OK', () => pm.response.to.have.status(200));
pm.test('Served as webp', () => pm.expect(pm.response.headers.get('Content-Type')).to.eql('image/webp'));`,
  },
  {
    name: 'GET media/:id/content (authenticated stream)',
    method: 'GET',
    path: '/api/v1/media/{{assetId}}/content?variant={{cropKey}}',
    tests: `pm.test('Status is 200 OK', () => pm.response.to.have.status(200));
pm.test('Served as png', () => pm.expect(pm.response.headers.get('Content-Type')).to.eql('image/png'));`,
  },
  {
    name: 'PATCH media/:id visibility=PUBLIC (explicit publish)',
    method: 'PATCH',
    path: '/api/v1/media/{{assetId}}',
    body: { visibility: 'PUBLIC' },
    tests: OK(`pm.test('Public', () => pm.expect(j.data.visibility).to.eql('PUBLIC'));`),
  },
  {
    name: 'GET public/:id (no auth, PUBLIC asset)',
    method: 'GET',
    path: '/api/v1/media/public/{{assetId}}',
    auth: 'none',
    tests: `pm.test('Status is 200 OK', () => pm.response.to.have.status(200));`,
  },
];

const security: Req[] = [
  { name: 'No Authorization header -> 401', method: 'GET', path: '/api/v1/media', auth: 'none', tests: EXPECT(401, 'UNAUTHENTICATED') },
  { name: 'Malformed token -> 401', method: 'GET', path: '/api/v1/media', auth: 'invalid', tests: EXPECT(401, 'INVALID_TOKEN') },
  { name: 'Expired token -> 401', method: 'GET', path: '/api/v1/media', auth: 'tokenExpired', tests: EXPECT(401, 'TOKEN_EXPIRED') },
  {
    name: 'Read-only token cannot create upload session -> 403',
    method: 'POST',
    path: '/api/v1/media/upload-sessions',
    auth: 'tokenReadOnly',
    body: { fileName: 'x.png', contentType: 'image/png', sizeBytes: '10' },
    tests: EXPECT(403, 'INSUFFICIENT_PERMISSION'),
  },
  {
    name: 'Other tenant cannot read asset -> 404',
    method: 'GET',
    path: '/api/v1/media/{{assetId}}',
    auth: 'tokenOtherTenant',
    tests: EXPECT(404, 'MEDIA_NOT_FOUND'),
  },
  {
    name: 'Spoofed X-Tenant-Id header is ignored (other tenant list is empty)',
    method: 'GET',
    path: '/api/v1/media',
    auth: 'tokenOtherTenant',
    headers: { 'X-Tenant-Id': '1001', 'X-Organization-Id': '5001', 'X-User-Id': '7001' },
    tests: OK(`pm.test('No leak of tenant 1001 assets', () => pm.expect(j.data.map(a => a.id)).to.not.include(pm.collectionVariables.get('assetId')));`),
  },
  { name: 'Non-numeric id -> 400', method: 'GET', path: '/api/v1/media/abc', tests: EXPECT(400, 'VALIDATION_ERROR') },
  {
    name: 'Unsupported content type -> 415',
    method: 'POST',
    path: '/api/v1/media/upload-sessions',
    body: { fileName: 'x.exe', contentType: 'application/x-msdownload', sizeBytes: '10' },
    tests: EXPECT(415, 'UNSUPPORTED_MEDIA_TYPE'),
  },
  {
    name: 'Oversized file -> 413',
    method: 'POST',
    path: '/api/v1/media/upload-sessions',
    body: { fileName: 'big.png', contentType: 'image/png', sizeBytes: '99999999999' },
    tests: EXPECT(413, 'FILE_TOO_LARGE'),
  },
  {
    name: 'Validation error -> 400',
    method: 'POST',
    path: '/api/v1/media/upload-sessions',
    body: { contentType: 'image/png' },
    tests: EXPECT(400, 'VALIDATION_ERROR'),
  },
  {
    name: 'Tampered signed URL -> 403',
    method: 'GET',
    path: '',
    auth: 'none',
    pre: `pm.request.url.update(pm.collectionVariables.get('signedUrl').replace(/sig=[a-f0-9]+/, 'sig=' + '0'.repeat(64)));`,
    tests: EXPECT(403, 'FORBIDDEN'),
  },
  {
    name: 'Delete in-use asset -> 409',
    method: 'DELETE',
    path: '/api/v1/media/{{assetId}}',
    tests: EXPECT(409, 'ASSET_IN_USE'),
  },
  {
    name: 'Resize variant on unknown asset -> 404',
    method: 'POST',
    path: '/api/v1/media/1/resize',
    body: { width: 100 },
    tests: EXPECT(404, 'MEDIA_NOT_FOUND'),
  },
];

const cleanup: Req[] = [
  {
    name: 'PATCH media/:id visibility=PRIVATE (unpublish)',
    method: 'PATCH',
    path: '/api/v1/media/{{assetId}}',
    body: { visibility: 'PRIVATE' },
    tests: OK(`pm.test('Private again', () => pm.expect(j.data.visibility).to.eql('PRIVATE'));`),
  },
  {
    name: 'GET public/:id after unpublish -> 404',
    method: 'GET',
    path: '/api/v1/media/public/{{assetId}}',
    auth: 'none',
    tests: EXPECT(404, 'MEDIA_NOT_FOUND'),
  },
  {
    name: 'DELETE media/:id/references/:referenceId',
    method: 'DELETE',
    path: '/api/v1/media/{{assetId}}/references/{{referenceId}}',
    tests: OK(`pm.test('Removed', () => pm.expect(j.data.removed).to.eql(true));`),
  },
  {
    name: 'DELETE media/:id',
    method: 'DELETE',
    path: '/api/v1/media/{{assetId}}',
    tests: OK(`pm.test('Soft-deleted', () => pm.expect(j.data.status).to.eql('DELETE_PENDING'));`),
  },
  {
    name: 'GET media/:id after delete -> 404',
    method: 'GET',
    path: '/api/v1/media/{{assetId}}',
    tests: EXPECT(404, 'MEDIA_NOT_FOUND'),
  },
  {
    name: 'DELETE folder (non-empty parent without flag) -> 409',
    method: 'DELETE',
    path: '/api/v1/media/folders/{{folderId}}',
    tests: EXPECT(409, 'FOLDER_NOT_EMPTY'),
  },
  {
    name: 'DELETE sub-folder',
    method: 'DELETE',
    path: '/api/v1/media/folders/{{subFolderId}}',
    tests: OK(`pm.test('Deleted', () => pm.expect(j.data.deleted).to.eql(true));`),
  },
  {
    name: 'DELETE folder',
    method: 'DELETE',
    path: '/api/v1/media/folders/{{folderId}}',
    tests: OK(`pm.test('Deleted', () => pm.expect(j.data.deleted).to.eql(true));`),
  },
];

const collection = {
  info: {
    name: 'Media Management API',
    description: 'Run with the generated environment (npm run test:postman). Success flow asserts 200 OK; the Security folder deliberately asserts the correct 4xx codes.',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: ['folderId', 'subFolderId', 'assetId', 'uploadUrl', 'signedUrl', 'referenceId', 'resizeKey', 'cropKey', 'optKey'].map((key) => ({ key, value: '' })),
  item: [
    folder('1 Health and folders', setup),
    folder('2 Upload lifecycle', upload),
    folder('3 Library, metadata, references', library),
    folder('4 Variants and delivery', variants),
    folder('5 Security and error contract (expected 4xx)', security),
    folder('6 Cleanup (delete)', cleanup),
  ],
};

// The two requests that use a full dynamic URL get it from collection variables via pre-request.
function patchUrl(items: any[]) {
  for (const it of items) {
    if (it.item) patchUrl(it.item);
    else if (it.request.url === '{{baseUrl}}') {
      it.request.url = it.name.startsWith('PUT binary') ? '{{uploadUrl}}' : '{{signedUrl}}';
    }
  }
}
patchUrl(collection.item);

fs.writeFileSync(path.join(outDir, 'Media_API.postman_collection.json'), JSON.stringify(collection, null, 2));
console.log(`Wrote collection (sample.png = ${SIZE} bytes)`);
