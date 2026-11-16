import { z } from 'zod';

export const ProfileSchema = z.object({
  id: z.uuid(),
  displayName: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const MeSchema = z.object({
  id: z.uuid(),
  email: z.string().nullable(),
  profile: ProfileSchema,
});
export type Me = z.infer<typeof MeSchema>;
