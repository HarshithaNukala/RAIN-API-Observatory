import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import type { TestProject } from 'vitest/node';
import { assertSafeTestDatabaseUrl } from '../support/database-safety.js';

const MIGRATIONS = fileURLToPath(new URL('../../apps/server/drizzle', import.meta.url));

/**
 * Recreates the schema from scratch on a database the safety guard has already approved.
 * Supabase's `auth.users` is stubbed with just the columns our foreign keys need.
 */
async function prepareDatabase(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`
      DROP SCHEMA IF EXISTS public CASCADE;
      DROP SCHEMA IF EXISTS drizzle CASCADE;
      DROP SCHEMA IF EXISTS auth CASCADE;
      CREATE SCHEMA public;
      CREATE SCHEMA auth;
      CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
    `);
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS });
  } finally {
    await sql.end();
  }
}

export default async function setup(project: TestProject) {
  let container: StartedPostgreSqlContainer | undefined;
  let url: string;

  const external = process.env.TEST_DATABASE_URL;
  if (external) {
    assertSafeTestDatabaseUrl(external, { applicationDatabaseUrl: process.env.DATABASE_URL });
    url = external;
  } else {
    try {
      container = await new PostgreSqlContainer('postgres:17-alpine')
        .withDatabase('rain_test')
        .start();
    } catch (err) {
      throw new Error(
        'Integration tests need Docker (for Testcontainers) or TEST_DATABASE_URL pointing at a ' +
          'local Postgres database whose name ends in "_test".',
        { cause: err },
      );
    }
    url = container.getConnectionUri();
    assertSafeTestDatabaseUrl(url, { allowedHosts: [container.getHost()] });
  }

  await prepareDatabase(url);
  project.provide('databaseUrl', url);

  return async () => {
    await container?.stop();
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}
