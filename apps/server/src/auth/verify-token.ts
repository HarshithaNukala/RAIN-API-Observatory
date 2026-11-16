import {
  decodeProtectedHeader,
  errors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import { z } from 'zod';
import { AppError, unauthenticated } from '../errors.js';

export interface AuthenticatedUser {
  id: string;
  email: string | null;
}

export type VerifyAccessToken = (token: string) => Promise<AuthenticatedUser>;

export interface TokenVerifierOptions {
  issuer: string;
  audience: string;
  /** Resolves asymmetric signing keys, normally `createRemoteJWKSet(<project>/auth/v1/.well-known/jwks.json)`. */
  jwks: JWTVerifyGetKey;
  /** Only for projects still on the legacy shared-secret (HS256) signing. */
  legacyHs256Secret?: string | undefined;
  clockToleranceSeconds?: number;
}

const ASYMMETRIC_ALGORITHMS = ['ES256', 'RS256', 'EdDSA'];

const claimsSchema = z.object({
  sub: z.uuid(),
  role: z.literal('authenticated'),
  email: z.string().optional(),
});

/**
 * Verifies Supabase access tokens: signature, `iss`, `aud`, `exp`, and that the token belongs
 * to a signed-in user (UUID `sub`, role `authenticated`). Anon/service keys are rejected.
 */
export function createTokenVerifier(options: TokenVerifierOptions): VerifyAccessToken {
  const hsKey = options.legacyHs256Secret
    ? new TextEncoder().encode(options.legacyHs256Secret)
    : undefined;
  const common = {
    issuer: options.issuer,
    audience: options.audience,
    requiredClaims: ['sub', 'exp'],
    clockTolerance: options.clockToleranceSeconds ?? 5,
  };

  return async (token) => {
    let alg: string | undefined;
    try {
      alg = decodeProtectedHeader(token).alg;
    } catch {
      throw unauthenticated('Invalid access token');
    }

    let payload: JWTPayload;
    try {
      if (alg === 'HS256') {
        if (!hsKey) throw unauthenticated('Invalid access token');
        ({ payload } = await jwtVerify(token, hsKey, { ...common, algorithms: ['HS256'] }));
      } else {
        ({ payload } = await jwtVerify(token, options.jwks, {
          ...common,
          algorithms: ASYMMETRIC_ALGORITHMS,
        }));
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (err instanceof errors.JWTExpired) {
        throw new AppError(401, 'TOKEN_EXPIRED', 'Access token has expired');
      }
      if (err instanceof errors.JWKSTimeout || !(err instanceof errors.JOSEError)) {
        throw new AppError(
          503,
          'SERVICE_UNAVAILABLE',
          'Unable to verify credentials right now',
          undefined,
          {
            cause: err,
          },
        );
      }
      throw unauthenticated('Invalid access token');
    }

    const claims = claimsSchema.safeParse(payload);
    if (!claims.success) throw unauthenticated('Access token is not for a signed-in user');
    return { id: claims.data.sub, email: claims.data.email ?? null };
  };
}
