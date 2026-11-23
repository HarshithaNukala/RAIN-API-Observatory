import { randomUUID } from 'node:crypto';
import { SignJWT, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import {
  TEST_AUDIENCE,
  TEST_HS256_SECRET,
  TEST_ISSUER,
  createTestSigner,
  signHs256,
} from '../test-support/tokens.js';
import { createTokenVerifier, type VerifyAccessToken } from './verify-token.js';

let signer: Awaited<ReturnType<typeof createTestSigner>>;
let verify: VerifyAccessToken;

async function expectAuthError(promise: Promise<unknown>, code: string, status = 401) {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  expect((err as AppError).status).toBe(status);
}

beforeAll(async () => {
  signer = await createTestSigner();
  verify = createTokenVerifier({ issuer: TEST_ISSUER, audience: TEST_AUDIENCE, jwks: signer.jwks });
});

describe('createTokenVerifier (JWKS / asymmetric keys)', () => {
  it('accepts a valid token and returns the user identity', async () => {
    const sub = randomUUID();
    const user = await verify(await signer.sign({ sub, email: 'ada@example.com' }));
    expect(user).toEqual({ id: sub, email: 'ada@example.com' });
  });

  it('returns a null email when the claim is absent', async () => {
    const user = await verify(await signer.sign({ email: undefined }));
    expect(user.email).toBeNull();
  });

  it('rejects an expired token with TOKEN_EXPIRED', async () => {
    const token = await signer.sign({}, { expiresIn: Math.floor(Date.now() / 1000) - 60 });
    await expectAuthError(verify(token), 'TOKEN_EXPIRED');
  });

  it('rejects a correctly signed token from another issuer', async () => {
    const token = await signer.sign({ iss: 'https://other-project.supabase.co/auth/v1' });
    await expectAuthError(verify(token), 'UNAUTHENTICATED');
  });

  it('rejects a correctly signed token for another audience', async () => {
    await expectAuthError(verify(await signer.sign({ aud: 'anon' })), 'UNAUTHENTICATED');
  });

  it('rejects a token without an expiry', async () => {
    const token = await new SignJWT({ role: 'authenticated', sub: randomUUID() })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(TEST_ISSUER)
      .setAudience(TEST_AUDIENCE)
      .sign(new TextEncoder().encode(TEST_HS256_SECRET));
    const legacy = createTokenVerifier({
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      jwks: signer.jwks,
      legacyHs256Secret: TEST_HS256_SECRET,
    });
    await expectAuthError(legacy(token), 'UNAUTHENTICATED');
  });

  it('rejects a token signed by an unknown key', async () => {
    const { privateKey } = await generateKeyPair('ES256');
    await expectAuthError(verify(await signer.sign({}, { key: privateKey })), 'UNAUTHENTICATED');
  });

  it('rejects a tampered payload', async () => {
    const [header, , signature] = (await signer.sign()).split('.');
    const payload = Buffer.from(
      JSON.stringify({ sub: randomUUID(), role: 'authenticated', iss: TEST_ISSUER }),
    ).toString('base64url');
    await expectAuthError(verify(`${header}.${payload}.${signature}`), 'UNAUTHENTICATED');
  });

  it('rejects an unsigned (alg: none) token', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: randomUUID(),
        role: 'authenticated',
        iss: TEST_ISSUER,
        aud: TEST_AUDIENCE,
        exp: Math.floor(Date.now() / 1000) + 300,
      }),
    ).toString('base64url');
    await expectAuthError(verify(`${header}.${payload}.`), 'UNAUTHENTICATED');
  });

  it('rejects garbage that is not a JWT', async () => {
    await expectAuthError(verify('not-a-jwt'), 'UNAUTHENTICATED');
  });

  it('rejects a token whose subject is not a UUID', async () => {
    await expectAuthError(verify(await signer.sign({ sub: 'service-account' })), 'UNAUTHENTICATED');
  });

  it('rejects anon-role tokens (e.g. the public anon key)', async () => {
    await expectAuthError(verify(await signer.sign({ role: 'anon' })), 'UNAUTHENTICATED');
  });

  it('rejects service_role tokens', async () => {
    await expectAuthError(verify(await signer.sign({ role: 'service_role' })), 'UNAUTHENTICATED');
  });
});

describe('createTokenVerifier (legacy HS256 secret)', () => {
  it('rejects HS256 tokens when no legacy secret is configured', async () => {
    await expectAuthError(verify(await signHs256({})), 'UNAUTHENTICATED');
  });

  it('accepts HS256 tokens signed with the configured legacy secret', async () => {
    const legacy = createTokenVerifier({
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      jwks: signer.jwks,
      legacyHs256Secret: TEST_HS256_SECRET,
    });
    const sub = randomUUID();
    await expect(legacy(await signHs256({ sub }))).resolves.toMatchObject({ id: sub });
    // Asymmetric tokens keep working alongside the legacy secret during key rotation.
    await expect(legacy(await signer.sign())).resolves.toBeDefined();
  });

  it('rejects HS256 tokens signed with a different secret', async () => {
    const legacy = createTokenVerifier({
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      jwks: signer.jwks,
      legacyHs256Secret: TEST_HS256_SECRET,
    });
    const token = await signHs256({}, 'a-completely-different-secret-value-1234');
    await expectAuthError(legacy(token), 'UNAUTHENTICATED');
  });
});

describe('createTokenVerifier (key-server failures)', () => {
  it('reports SERVICE_UNAVAILABLE when signing keys cannot be fetched', async () => {
    const offline = createTokenVerifier({
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      jwks: () => Promise.reject(new TypeError('fetch failed')),
    });
    await expectAuthError(offline(await signer.sign()), 'SERVICE_UNAVAILABLE', 503);
  });
});
