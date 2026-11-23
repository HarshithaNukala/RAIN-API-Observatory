import type { AuthenticatedUser } from '../auth/verify-token.js';

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

export {};
