import { z } from 'zod';
import { AppError } from '../errors.js';

/** Position of the last row on a page, in the list's (created_at DESC, id DESC) order. */
export interface PageCursor {
  createdAt: Date;
  id: string;
}

const payload = z.object({ t: z.iso.datetime(), i: z.uuid() });

export function encodeCursor(cursor: PageCursor): string {
  const json = JSON.stringify({ t: cursor.createdAt.toISOString(), i: cursor.id });
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): PageCursor {
  try {
    const parsed = payload.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    return { createdAt: new Date(parsed.t), id: parsed.i };
  } catch {
    throw new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', [
      { path: 'cursor', message: 'Invalid pagination cursor' },
    ]);
  }
}
