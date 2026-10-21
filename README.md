# Media Management API

Node.js + TypeScript + Express + PostgreSQL (`pg`, raw parameterized SQL). Bearer-JWT auth, BIGINT IDs (decimal strings in JSON),
local object storage behind a `StorageAdapter` interface, in-process processing worker (sharp).

## Run
```
npm install
npm run db:up          # Postgres in Docker (credentials come from .env)
npm run dev            # runs migrations, starts API on PORT (4017) + worker
npm run token          # prints a dev Bearer JWT (tenant 1001 / org 5001 / user 7001, all permissions)
npm run test:postman   # regenerates the collection and runs it with newman against the running API
```
All secrets live in `.env` (git-ignored). `.env.example` lists every variable.

## Auth
`Authorization: Bearer <JWT>` (HS256; issuer/audience/exp/nbf verified). Tenant, organization, user and permissions come from the
token claims only (`tenant_id`, `organization_id`, `sub`, `permissions[]`, optional `website_ids[]`). `X-Tenant-Id`-style headers are ignored.
Permissions: `media:read|upload|update|process|delete|manage` (`manage` implies all).

## Auto-assigned values
IDs (snowflake BIGINT), tenant/org/user (from token), storage keys, timestamps, status, visibility=PRIVATE, quotas, request IDs.

## Endpoints (all success responses are `200`)
`GET /health`, `GET /ready` — `GET|POST /api/v1/media/folders`, `GET|PATCH|PUT|DELETE /api/v1/media/folders/:id`
`GET /api/v1/media` (cursor, q, status, folderId, websiteId, mimeType, visibility) — `GET /usage`
`POST /upload-sessions` (optional `Idempotency-Key`) → `PUT <uploadUrl>` (signed, no Bearer) → `POST /:id/complete-upload`
`GET|PATCH|PUT|DELETE /:id` — `GET /:id/processing-status` — `POST /:id/resize|crop|optimize`
`GET /:id/url` (signed download) — `GET /:id/content` — `GET /public/:id` (only PUBLIC+READY)
`GET|POST /:id/references`, `DELETE /:id/references/:referenceId`

Errors: `{ success:false, error:{ code, message, details? }, meta:{ requestId } }` with 400/401/403/404/409/413/415/422/429.

## Known limitations
- Storage driver is local disk only (no S3 adapter yet); variants are not counted toward quota; no OpenAPI file yet; no unit tests (Postman suite only).
- The processing worker runs in the API process and polls Postgres (no Redis/BullMQ).
- `npm run token` is a dev helper; production tokens must come from your identity provider/BFF using the same secret/issuer/audience.
