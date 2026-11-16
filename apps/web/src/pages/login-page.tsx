import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useAuth } from '@/auth/auth-context';
import { loginSchema, validateForm, type FieldErrors } from '@/auth/schemas';
import { AuthLayout } from '@/components/auth-layout';
import { FormField } from '@/components/form-field';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

export function LoginPage() {
  const { supabase } = useAuth();
  const [errors, setErrors] = useState<FieldErrors<{ email: string; password: string }>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    const { data, errors: fieldErrors } = validateForm(
      loginSchema,
      new FormData(event.currentTarget),
    );
    setErrors(fieldErrors ?? {});
    if (!data) return;

    setPending(true);
    const { error } = await supabase.auth.signInWithPassword(data);
    setPending(false);
    // On success the auth listener updates the session and GuestOnly redirects.
    if (error) setFormError(error.message);
  }

  return (
    <AuthLayout
      title="Sign in"
      description="Welcome back. Sign in to your RAIN workspace."
      footer={
        <>
          New to RAIN?{' '}
          <Link className="font-medium text-primary hover:underline" to="/register">
            Create an account
          </Link>
        </>
      }
    >
      <form noValidate onSubmit={(e) => void onSubmit(e)} className="grid gap-4">
        {formError && <Alert variant="error">{formError}</Alert>}
        <FormField
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          autoFocus
          error={errors.email}
        />
        <div className="grid gap-2">
          <FormField
            label="Password"
            name="password"
            type="password"
            autoComplete="current-password"
            error={errors.password}
          />
          <Link
            to="/forgot-password"
            className="justify-self-end text-xs text-muted-foreground hover:text-foreground"
          >
            Forgot your password?
          </Link>
        </div>
        <Button type="submit" disabled={pending} className="mt-1 w-full">
          {pending && <Spinner label="Signing in" />}
          Sign in
        </Button>
      </form>
    </AuthLayout>
  );
}
