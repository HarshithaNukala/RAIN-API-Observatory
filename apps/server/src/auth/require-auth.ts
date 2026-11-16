import type { Request, RequestHandler } from 'express';
import { unauthenticated } from '../errors.js';
import type { AuthenticatedUser, VerifyAccessToken } from './verify-token.js';

const BEARER = /^Bearer[ ]+([A-Za-z0-9._~+/-]+=*)$/i;

export function requireAuth(verify: VerifyAccessToken): RequestHandler {
  return async (req, _res, next) => {
    const header = req.get('authorization');
    if (!header) throw unauthenticated('Missing bearer token');
    const token = BEARER.exec(header)?.[1];
    if (!token) throw unauthenticated('Malformed Authorization header');
    req.user = await verify(token);
    next();
  };
}

/** For handlers mounted behind `requireAuth`. */
export function currentUser(req: Request): AuthenticatedUser {
  if (!req.user) throw unauthenticated();
  return req.user;
}
