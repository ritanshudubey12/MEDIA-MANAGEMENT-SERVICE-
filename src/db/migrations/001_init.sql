CREATE TABLE media_folders (
  id BIGINT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  organization_id BIGINT NOT NULL,
  website_id BIGINT,
  parent_folder_id BIGINT REFERENCES media_folders(id),
  name TEXT NOT NULL,
  created_by BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX idx_folders_scope ON media_folders (tenant_id, organization_id, website_id, parent_folder_id)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_folders_sibling_name ON media_folders
  (tenant_id, organization_id, COALESCE(website_id, 0), COALESCE(parent_folder_id, 0), lower(name))
  WHERE deleted_at IS NULL;

CREATE TABLE media_assets (
  id BIGINT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  organization_id BIGINT NOT NULL,
  website_id BIGINT,
  folder_id BIGINT REFERENCES media_folders(id),
  created_by BIGINT NOT NULL,
  original_filename TEXT NOT NULL,
  display_name TEXT,
  storage_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  checksum_sha256 TEXT,
  width INTEGER,
  height INTEGER,
  duration_ms BIGINT,
  alt_text TEXT,
  status TEXT NOT NULL CHECK (status IN
    ('PENDING_UPLOAD','UPLOADED','PROCESSING','READY','FAILED','DELETE_PENDING','DELETED')),
  visibility TEXT NOT NULL DEFAULT 'PRIVATE' CHECK (visibility IN ('PRIVATE','PUBLIC')),
  failure_code TEXT,
  processing_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX idx_media_scope_created ON media_assets (tenant_id, organization_id, website_id, created_at DESC);
CREATE INDEX idx_media_scope_status ON media_assets (tenant_id, organization_id, status);
CREATE INDEX idx_media_scope_folder ON media_assets (tenant_id, organization_id, folder_id);
CREATE INDEX idx_media_worker_status ON media_assets (status) WHERE status IN ('UPLOADED','DELETE_PENDING');

CREATE TABLE media_variants (
  id BIGINT PRIMARY KEY,
  asset_id BIGINT NOT NULL REFERENCES media_assets(id),
  variant_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  params JSONB NOT NULL DEFAULT '{}',
  storage_key TEXT,
  mime_type TEXT,
  width INTEGER,
  height INTEGER,
  size_bytes BIGINT,
  status TEXT NOT NULL CHECK (status IN ('PENDING','PROCESSING','READY','FAILED')),
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (asset_id, variant_key)
);
CREATE INDEX idx_variants_pending ON media_variants (status) WHERE status = 'PENDING';

CREATE TABLE media_upload_sessions (
  id BIGINT PRIMARY KEY,
  asset_id BIGINT NOT NULL REFERENCES media_assets(id),
  tenant_id BIGINT NOT NULL,
  organization_id BIGINT NOT NULL,
  actor_id BIGINT NOT NULL,
  expected_size_bytes BIGINT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OPEN','COMPLETED','EXPIRED')),
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_upload_idem ON media_upload_sessions (tenant_id, organization_id, actor_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_upload_open ON media_upload_sessions (status, expires_at);

CREATE TABLE media_asset_references (
  id BIGINT PRIMARY KEY,
  asset_id BIGINT NOT NULL REFERENCES media_assets(id),
  tenant_id BIGINT NOT NULL,
  organization_id BIGINT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  reference_key TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (asset_id, source_type, source_id, reference_key)
);

CREATE TABLE tenant_media_usage (
  tenant_id BIGINT NOT NULL,
  organization_id BIGINT NOT NULL,
  stored_bytes BIGINT NOT NULL DEFAULT 0 CHECK (stored_bytes >= 0),
  asset_count BIGINT NOT NULL DEFAULT 0 CHECK (asset_count >= 0),
  quota_bytes BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, organization_id)
);

CREATE TABLE outbox_events (
  id BIGINT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  organization_id BIGINT NOT NULL,
  event_type TEXT NOT NULL,
  aggregate_id BIGINT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
CREATE INDEX idx_outbox_unpublished ON outbox_events (created_at) WHERE published_at IS NULL;

CREATE TABLE audit_events (
  id BIGINT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  organization_id BIGINT NOT NULL,
  actor_id BIGINT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id BIGINT,
  request_id TEXT,
  details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_scope ON audit_events (tenant_id, organization_id, created_at DESC);
