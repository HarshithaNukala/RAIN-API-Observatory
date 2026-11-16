import { randomUUID } from 'node:crypto';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';

export const TEST_ISSUER = 'https://test-project.supabase.co/auth/v1';
export const TEST_AUDIENCE = 'authenticated';
export const TEST_HS256_SECRET = 'test-only-legacy-secret-0123456789abcdef';

/**
 * A real ES256 key pair and a local JWKS, standing in for a Supabase project's signing keys.
 * Tokens are genuinely signed and verified; nothing about verification is mocked.
 */
export async function createTestSigner() {
  const kid = 'test-key-1';
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' };
  const jwks: JWTVerifyGetKey = createLocalJWKSet({ keys: [jwk] });

  async function sign(
    overrides: JWTPayload = {},
    options: { expiresIn?: string | number; key?: CryptoKey; kid?: string } = {},
  ): Promise<string> {
    return new SignJWT({
      role: 'authenticated',
      email: 'user@example.com',
      iss: TEST_ISSUER,
      aud: TEST_AUDIENCE,
      sub: randomUUID(),
      ...overrides,
    })
      .setProtectedHeader({ alg: 'ES256', kid: options.kid ?? kid, typ: 'JWT' })
      .setIssuedAt()
      .setExpirationTime(options.expiresIn ?? '5m')
      .sign(options.key ?? privateKey);
  }

  return { jwks, sign };
}

export async function signHs256(payload: JWTPayload, secret = TEST_HS256_SECRET): Promise<string> {
  return new SignJWT({ role: 'authenticated', ...payload })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(TEST_ISSUER)
    .setAudience(TEST_AUDIENCE)
    .setSubject(typeof payload.sub === 'string' ? payload.sub : randomUUID())
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(secret));
}
