import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useAuth } from '@/auth/auth-context';
import { forgotPasswordSchema, validateForm } from '@/auth/schemas';
import { AuthLayout } from '@/components/auth-layout';
import { FormField } from '@/components/form-field';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

export function ForgotPasswordPage() {
  const { supabase } = useAuth();
  const [emailError, setEmailError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    const { data, errors } = validateForm(forgotPasswordSchema, new FormData(event.currentTarget));
    setEmailError(errors?.email);
    if (!data) return;

    setPending(true);
    const { error } = await supabase.auth.resetPasswordForEmail(data.email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setPending(false);
    if (error) setFormError(error.message);
    else setSentTo(data.email);
  }

  const footer = (
    <Link className="font-medium text-primary hover:underline" to="/login">
      Back to sign in
    </Link>
  );

  if (sentTo) {
    return (
      <AuthLayout title="Check your inbox" footer={footer}>
        <Alert variant="success">
          If an account exists for <strong className="font-medium">{sentTo}</strong>, it will
          receive a link to choose a new password. The link expires after a short time.
        </Alert>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Reset your password"
      description="Enter your account email and we'll send you a reset link."
      footer={footer}
    >
      <form noValidate onSubmit={(e) => void onSubmit(e)} className="grid gap-4">
        {formError && <Alert variant="error">{formError}</Alert>}
        <FormField
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          autoFocus
          error={emailError}
        />
        <Button type="submit" disabled={pending} className="w-full">
          {pending && <Spinner label="Sending reset link" />}
          Send reset link
        </Button>
      </form>
    </AuthLayout>
  );
}
