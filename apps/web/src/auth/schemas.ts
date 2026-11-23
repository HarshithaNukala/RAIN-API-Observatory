import { z } from 'zod';

export const emailSchema = z.email('Enter a valid email address');

// Supabase hashes passwords with bcrypt, which ignores bytes beyond 72.
export const newPasswordSchema = z
  .string()
  .min(8, 'Use at least 8 characters')
  .max(72, 'Use at most 72 characters');

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password'),
});

export const registerSchema = z
  .object({ email: emailSchema, password: newPasswordSchema, confirmPassword: z.string() })
  .refine((v) => v.password === v.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords do not match',
  });

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z
  .object({ password: newPasswordSchema, confirmPassword: z.string() })
  .refine((v) => v.password === v.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords do not match',
  });

export type FieldErrors<T> = Partial<Record<keyof T, string>>;

/** Validates FormData against a schema, returning either the data or one message per field. */
export function validateForm<T extends z.ZodType>(
  schema: T,
  form: FormData,
):
  { data: z.infer<T>; errors?: undefined } | { data?: undefined; errors: FieldErrors<z.infer<T>> } {
  const result = schema.safeParse(Object.fromEntries(form));
  if (result.success) return { data: result.data };
  const errors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = String(issue.path[0] ?? '');
    errors[key] ??= issue.message;
  }
  return { errors: errors as FieldErrors<z.infer<T>> };
}
