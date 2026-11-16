import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { useAuth } from '@/auth/auth-context';
import { resetPasswordSchema, validateForm, type FieldErrors } from '@/auth/schemas';
import { AuthLayout } from '@/components/auth-layout';
import { FormField } from '@/components/form-field';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FullPageSpinner, Spinner } from '@/components/ui/spinner';

/**
 * Target of the password-recovery email. Supabase's client exchanges the link's one-time code
 * for a short-lived session on load; with that session the user can set a new password.
 */
export function ResetPasswordPage() {
  const { auth, supabase } = useAuth();
  const navigate = useNavigate();
  const [errors, setErrors] = useState<FieldErrors<{ password: string; confirmPassword: string }>>(
    {},
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (auth.status === 'loading') return <FullPageSpinner label="Verifying your reset link" />;

  if (auth.status === 'signed-out') {
    return (
      <AuthLayout title="Link invalid or expired">
        <div className="grid gap-4">
          <Alert variant="error">
            This password-reset link can't be used. It may have expired or already been used.
          </Alert>
          <Button asChild className="w-full">
            <Link to="/forgot-password">Request a new link</Link>
          </Button>
        </div>
      </AuthLayout>
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    const { data, errors: fieldErrors } = validateForm(
      resetPasswordSchema,
      new FormData(event.currentTarget),
    );
    setErrors(fieldErrors ?? {});
    if (!data) return;

    setPending(true);
    const { error } = await supabase.auth.updateUser({ password: data.password });
    setPending(false);
    if (error) {
      setFormError(error.message);
      return;
    }
    toast.success('Your password has been updated.');
    await navigate('/', { replace: true });
  }

  return (
    <AuthLayout
      title="Choose a new password"
      description={`For ${auth.session.user.email ?? 'your account'}`}
    >
      <form noValidate onSubmit={(e) => void onSubmit(e)} className="grid gap-4">
        {formError && <Alert variant="error">{formError}</Alert>}
        <FormField
          label="New password"
          name="password"
          type="password"
          autoComplete="new-password"
          autoFocus
          hint="At least 8 characters."
          error={errors.password}
        />
        <FormField
          label="Confirm new password"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          error={errors.confirmPassword}
        />
        <Button type="submit" disabled={pending} className="w-full">
          {pending && <Spinner label="Updating password" />}
          Update password
        </Button>
      </form>
    </AuthLayout>
  );
}
