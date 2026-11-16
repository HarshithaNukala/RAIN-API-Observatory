const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
/** `rain_db` is the legacy Java app's database; `postgres` is Supabase's main database. */
const FORBIDDEN_DATABASES = new Set(['rain_db', 'postgres']);

export class UnsafeTestDatabaseError extends Error {
  constructor(reason: string) {
    super(`Refusing to run integration tests: ${reason}`);
    this.name = 'UnsafeTestDatabaseError';
  }
}

export interface SafetyOptions {
  /** Extra hosts known to be disposable, e.g. the Testcontainers host. */
  allowedHosts?: string[];
  /** The application's own DATABASE_URL; tests must never share it. */
  applicationDatabaseUrl?: string | undefined;
}

/**
 * Integration tests drop and recreate schemas, so they may only touch a local database whose
 * name ends in `_test`. Anything else is rejected before a connection is opened.
 */
export function assertSafeTestDatabaseUrl(raw: string, options: SafetyOptions = {}): void {
  const url = URL.parse(raw);
  if (!url || !/^postgres(ql)?:$/.test(url.protocol)) {
    throw new UnsafeTestDatabaseError('the test database URL is not a postgres:// URL');
  }
  if (options.applicationDatabaseUrl && raw === options.applicationDatabaseUrl) {
    throw new UnsafeTestDatabaseError('the test database URL is the same as DATABASE_URL');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (FORBIDDEN_DATABASES.has(database)) {
    throw new UnsafeTestDatabaseError(`"${database}" is a protected database name`);
  }
  if (!database.endsWith('_test')) {
    throw new UnsafeTestDatabaseError(`database "${database}" does not end with "_test"`);
  }
  const allowed = new Set([...LOCAL_HOSTS, ...(options.allowedHosts ?? [])]);
  if (!allowed.has(url.hostname)) {
    throw new UnsafeTestDatabaseError(`host "${url.hostname}" is not a local or disposable host`);
  }
}
