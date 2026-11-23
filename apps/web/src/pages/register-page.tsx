import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useAuth } from '@/auth/auth-context';
import { registerSchema, validateForm, type FieldErrors } from '@/auth/schemas';
import { AuthLayout } from '@/components/auth-layout';
import { FormField } from '@/components/form-field';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

type Fields = { email: string; password: string; confirmPassword: string };

export function RegisterPage() {
  const { supabase } = useAuth();
  const [errors, setErrors] = useState<FieldErrors<Fields>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmationSentTo, setConfirmationSentTo] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    const { data, errors: fieldErrors } = validateForm(
      registerSchema,
      new FormData(event.currentTarget),
    );
    setErrors(fieldErrors ?? {});
    if (!data) return;

    setPending(true);
    const { data: result, error } = await supabase.auth.signUp({
      email: data.email,
      password: data.password,
      options: { emailRedirectTo: `${window.location.origin}/` },
    });
    setPending(false);
    if (error) {
      setFormError(error.message);
      return;
    }
    // With email confirmation enabled there is no session yet. When it is disabled, the auth
    // listener receives the session and GuestOnly redirects into the app.
    if (!result.session) setConfirmationSentTo(data.email);
  }

  if (confirmationSentTo) {
    return (
      <AuthLayout
        title="Check your inbox"
        footer={
          <Link className="font-medium text-primary hover:underline" to="/login">
            Back to sign in
          </Link>
        }
      >
        <Alert variant="success">
          If <strong className="font-medium">{confirmationSentTo}</strong> can be registered, we
          sent it a confirmation link. Open it to activate your account.
        </Alert>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Create your account"
      description="Start monitoring your APIs with RAIN."
      footer={
        <>
          Already have an account?{' '}
          <Link className="font-medium text-primary hover:underline" to="/login">
            Sign in
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
        <FormField
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          hint="At least 8 characters."
          error={errors.password}
        />
        <FormField
          label="Confirm password"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          error={errors.confirmPassword}
        />
        <Button type="submit" disabled={pending} className="mt-1 w-full">
          {pending && <Spinner label="Creating account" />}
          Create account
        </Button>
      </form>
    </AuthLayout>
  );
}
