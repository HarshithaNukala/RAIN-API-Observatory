import { z } from 'zod';

export const LivenessSchema = z.object({
  status: z.literal('ok'),
  uptimeSeconds: z.number().nonnegative(),
});
export type Liveness = z.infer<typeof LivenessSchema>;

export const CheckStatusSchema = z.enum(['ok', 'error']);

export const ReadinessSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  checks: z.object({
    database: CheckStatusSchema,
    auth: CheckStatusSchema,
  }),
});
export type Readiness = z.infer<typeof ReadinessSchema>;
