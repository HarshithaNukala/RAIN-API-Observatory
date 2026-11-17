import { randomUUID } from 'node:crypto';
import { MeSchema, dataEnvelope } from '@rain/shared';
import { eq, sql } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApp } from '../../apps/server/src/app.js';
import { createTokenVerifier } from '../../apps/server/src/auth/verify-token.js';
import { createDatabase } from '../../apps/server/src/db/client.js';
import { createProfileStore } from '../../apps/server/src/db/profiles.js';
import { profiles } from '../../apps/server/src/db/schema.js';
import { AppError } from '../../apps/server/src/errors.js';
import { client } from '../../apps/server/src/test-support/http.js';
import { stubMonitorService } from '../../apps/server/src/test-support/monitor-service-stub.js';
import {
  TEST_AUDIENCE,
  TEST_ISSUER,
  createTestSigner,
} from '../../apps/server/src/test-support/tokens.js';

const database = createDatabase(inject('databaseUrl'), { maxConnections: 5 });
const store = createProfileStore(database.db);

async function createAuthUser(id = randomUUID()): Promise<string> {
  await database.db.execute(sql`insert into auth.users (id) values (${id})`);
  return id;
}

afterAll(async () => {
  await database.close();
});

describe('profiles migration', () => {
  it('creates the profiles table with row-level security enabled', async () => {
    const rows = await database.db.execute<{ relrowsecurity: boolean }>(
      sql`select relrowsecurity from pg_class where oid = 'public.profiles'::regclass`,
    );
    expect(rows[0]?.relrowsecurity).toBe(true);
  });
});

describe('ProfileStore.ensure (real Postgres)', () => {
  it('creates a profile on first access with null display name and timestamps', async () => {
    const id = await createAuthUser();
    const profile = await store.ensure(id);
    expect(profile).toMatchObject({ id, displayName: null });
    expect(Date.parse(profile.createdAt)).not.toBeNaN();
  });

  it('is idempotent: a second call returns the same row', async () => {
    const id = await createAuthUser();
    const first = await store.ensure(id);
    const second = await store.ensure(id);
    expect(second).toEqual(first);
  });

  it('creates exactly one row under concurrent first access', async () => {
    const id = await createAuthUser();
    await Promise.all(Array.from({ length: 10 }, () => store.ensure(id)));
    const rows = await database.db.select().from(profiles).where(eq(profiles.id, id));
    expect(rows).toHaveLength(1);
  });

  it('rejects a user that does not exist in auth.users with a 401', async () => {
    const err = await store.ensure(randomUUID()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(401);
  });

  it('is removed when the auth user is deleted', async () => {
    const id = await createAuthUser();
    await store.ensure(id);
    await database.db.execute(sql`delete from auth.users where id = ${id}`);
    const rows = await database.db.select().from(profiles).where(eq(profiles.id, id));
    expect(rows).toHaveLength(0);
  });
});

describe('API against the real database', () => {
  let signer: Awaited<ReturnType<typeof createTestSigner>>;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    signer = await createTestSigner();
    app = createApp({
      logger: pino({ level: 'silent' }),
      corsOrigins: [],
      trustProxy: 0,
      verifyAccessToken: createTokenVerifier({
        issuer: TEST_ISSUER,
        audience: TEST_AUDIENCE,
        jwks: signer.jwks,
      }),
      profiles: store,
      monitors: stubMonitorService(),
      readiness: async () => {
        await database.ping();
        return { database: 'ok', auth: 'ok' };
      },
    });
  });

  it('GET /api/v1/me provisions and returns the profile', async () => {
    const id = await createAuthUser();
    const token = await signer.sign({ sub: id, email: 'lin@example.com' });
    const res = await client(app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(dataEnvelope(MeSchema).parse(res.body).data.profile.id).toBe(id);
    const rows = await database.db.select().from(profiles).where(eq(profiles.id, id));
    expect(rows).toHaveLength(1);
  });

  it('GET /readyz pings the real database', async () => {
    await client(app).get('/readyz').expect(200);
  });
});
