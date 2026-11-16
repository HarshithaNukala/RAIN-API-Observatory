import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export function createDatabase(url: string, options: { maxConnections?: number } = {}) {
  const sql = postgres(url, {
    max: options.maxConnections ?? 10,
    // Required for Supabase's transaction pooler; harmless on direct connections.
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 30,
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema });
  return {
    db,
    async ping(timeoutMs = 2000): Promise<void> {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('database ping timed out')), timeoutMs);
      });
      try {
        await Promise.race([sql`select 1`, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
    close: () => sql.end({ timeout: 5 }),
  };
}

export type DatabaseHandle = ReturnType<typeof createDatabase>;
export type Database = DatabaseHandle['db'];
