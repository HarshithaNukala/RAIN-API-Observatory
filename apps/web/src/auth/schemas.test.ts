import { describe, expect, it } from 'vitest';
import { loginSchema, registerSchema, validateForm } from './schemas';

const form = (entries: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(entries)) data.set(k, v);
  return data;
};

describe('validateForm', () => {
  it('returns parsed data for valid input', () => {
    expect(validateForm(loginSchema, form({ email: 'a@b.co', password: 'x' }))).toEqual({
      data: { email: 'a@b.co', password: 'x' },
    });
  });

  it('returns one message per invalid field', () => {
    const { errors } = validateForm(loginSchema, form({ email: 'nope', password: '' }));
    expect(errors).toEqual({
      email: 'Enter a valid email address',
      password: 'Enter your password',
    });
  });

  it('flags mismatched password confirmation on the confirm field', () => {
    const { errors } = validateForm(
      registerSchema,
      form({ email: 'a@b.co', password: 'long-enough', confirmPassword: 'different!' }),
    );
    expect(errors).toEqual({ confirmPassword: 'Passwords do not match' });
  });

  it('enforces the minimum password length on registration', () => {
    const { errors } = validateForm(
      registerSchema,
      form({ email: 'a@b.co', password: 'short', confirmPassword: 'short' }),
    );
    expect(errors?.password).toMatch(/at least 8/);
  });
});
