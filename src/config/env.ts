import 'dotenv/config';
import path from 'node:path';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4017),
  WORKER_ID: z.coerce.number().int().min(0).max(1023).default(1),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters')
    .refine((v) => !/change-me|<.*>/i.test(v), 'JWT_SECRET is still a placeholder'),
  AUTH_ISSUER: z.string().min(1),
  AUTH_AUDIENCE: z.string().min(1),
  STORAGE_DRIVER: z.enum(['local']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./storage-data'),
  STORAGE_PUBLIC_BASE_URL: z.string().url(),
  UPLOAD_SIGNING_SECRET: z
    .string()
    .min(32, 'UPLOAD_SIGNING_SECRET must be at least 32 characters')
    .refine((v) => !/change-me|<.*>/i.test(v), 'UPLOAD_SIGNING_SECRET is still a placeholder'),
  PRESIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(10485760),
  DEFAULT_TENANT_QUOTA_BYTES: z.coerce.number().int().positive().default(1073741824),
  WORKER_POLL_MS: z.coerce.number().int().positive().default(1000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) console.error(` - ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  STORAGE_LOCAL_DIR: path.resolve(parsed.data.STORAGE_LOCAL_DIR),
};
