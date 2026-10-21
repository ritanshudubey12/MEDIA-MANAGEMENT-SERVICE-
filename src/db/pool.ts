import pg from 'pg';
import { env } from '../config/env.js';

// BIGINT (int8, OID 20) stays a string in pg by default; make that explicit so IDs never become Number.
pg.types.setTypeParser(20, (v) => v);

export const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 10 });

export type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
