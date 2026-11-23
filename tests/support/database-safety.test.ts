import { describe, expect, it } from 'vitest';
import { UnsafeTestDatabaseError, assertSafeTestDatabaseUrl } from './database-safety.js';

const ok = 'postgresql://postgres:pw@localhost:5432/rain_test';

describe('assertSafeTestDatabaseUrl', () => {
  it('accepts a local database whose name ends in _test', () => {
    expect(() => assertSafeTestDatabaseUrl(ok)).not.toThrow();
    expect(() => assertSafeTestDatabaseUrl('postgres://u:p@127.0.0.1:55432/x_test')).not.toThrow();
  });

  it.each([
    ['the legacy rain_db', 'postgresql://postgres:pw@localhost:5432/rain_db'],
    ['the Supabase main database', 'postgresql://postgres:pw@localhost:5432/postgres'],
    ['a name without the _test suffix', 'postgresql://postgres:pw@localhost:5432/rain_dev'],
    ['a remote Supabase host', 'postgresql://postgres:pw@db.abc.supabase.co:5432/rain_test'],
    ['a pooler host', 'postgresql://u:pw@aws-0-eu-west-1.pooler.supabase.com:6543/app_test'],
    ['a non-postgres URL', 'mysql://u:pw@localhost/app_test'],
    ['garbage', 'not a url'],
  ])('rejects %s', (_label, url) => {
    expect(() => assertSafeTestDatabaseUrl(url)).toThrow(UnsafeTestDatabaseError);
  });

  it('rejects the application DATABASE_URL even if it looks safe', () => {
    expect(() => assertSafeTestDatabaseUrl(ok, { applicationDatabaseUrl: ok })).toThrow(
      /same as DATABASE_URL/,
    );
  });

  it('accepts an explicitly allowed disposable host', () => {
    const url = 'postgresql://t:t@172.17.0.1:32768/rain_test';
    expect(() => assertSafeTestDatabaseUrl(url)).toThrow(UnsafeTestDatabaseError);
    expect(() => assertSafeTestDatabaseUrl(url, { allowedHosts: ['172.17.0.1'] })).not.toThrow();
  });

  it('does not leak the password in the error message', () => {
    expect(() =>
      assertSafeTestDatabaseUrl('postgresql://postgres:hunter2@localhost:5432/rain_db'),
    ).toThrow(expect.objectContaining({ message: expect.not.stringContaining('hunter2') }));
  });
});
