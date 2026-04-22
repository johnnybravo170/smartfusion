/**
 * Postgres connection for the MCP server.
 *
 * Uses the `postgres` driver with connection pooling via Supabase's pgbouncer.
 * `prepare: false` is required for transaction-mode pooling.
 */

import postgres from 'postgres';

let sql: ReturnType<typeof postgres>;

export function getDb(): ReturnType<typeof postgres> {
  if (!sql) {
    const url = process.env.HEYHENRY_DATABASE_URL ?? process.env.SMARTFUSION_DATABASE_URL;
    if (!url) {
      throw new Error('HEYHENRY_DATABASE_URL is not set');
    }
    sql = postgres(url, {
      max: 3,
      idle_timeout: 30,
      prepare: false,
    });
  }
  return sql;
}
