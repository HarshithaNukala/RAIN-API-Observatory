import type { Profile } from '@rain/shared';
import { eq } from 'drizzle-orm';
import { AppError } from '../errors.js';
import type { Database } from './client.js';
import { profiles, type ProfileRow } from './schema.js';

export interface ProfileStore {
  /** Returns the user's profile, creating it on first access. Safe under concurrent calls. */
  ensure(userId: string): Promise<Profile>;
}

const FOREIGN_KEY_VIOLATION = '23503';

/** Drizzle wraps driver errors, so look through the `cause` chain for the SQLSTATE. */
function pgErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === 'string') return code;
    current = cause;
  }
  return undefined;
}

export function toProfile(row: ProfileRow): Profile {
  return {
    id: row.id,
    displayName: row.displayName,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createProfileStore(db: Database): ProfileStore {
  return {
    async ensure(userId) {
      try {
        await db
          .insert(profiles)
          .values({ id: userId })
          .onConflictDoNothing({ target: profiles.id });
      } catch (err) {
        // A valid token whose user was deleted from auth.users.
        if (pgErrorCode(err) === FOREIGN_KEY_VIOLATION) {
          throw new AppError(401, 'UNAUTHENTICATED', 'This account no longer exists');
        }
        throw err;
      }
      const [row] = await db.select().from(profiles).where(eq(profiles.id, userId)).limit(1);
      if (!row) throw new Error('Profile row missing immediately after upsert');
      return toProfile(row);
    },
  };
}
