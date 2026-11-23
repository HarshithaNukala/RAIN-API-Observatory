import { z } from 'zod';

/** Every successful /api response body is `{ data: T }`. */
export const dataEnvelope = <T extends z.ZodType>(schema: T) => z.object({ data: schema });

export type DataEnvelope<T> = { data: T };
