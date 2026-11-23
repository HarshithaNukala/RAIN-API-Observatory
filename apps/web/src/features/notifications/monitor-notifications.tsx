import type { NotificationSettings, UpdateNotificationSettingsInput } from '@rain/shared';
import { Copy, KeyRound, Mail, ShieldAlert, Webhook } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { ErrorState } from '@/components/page';
import { FormField } from '@/components/form-field';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { ApiError } from '@/lib/api-client';
import { useNotificationSettings, useUpdateNotificationSettings } from './api';

function Toggle({
  id,
  label,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-center gap-2 text-sm">
      <input
        id={id}
        type="checkbox"
        className="size-4 accent-[var(--color-primary)]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

/** Shown once after a webhook is created or its secret rotated. */
function SigningSecret({ secret, onDismiss }: { secret: string; onDismiss: () => void }) {
  return (
    <Alert variant="success">
      <div className="grid gap-2">
        <p className="font-medium">Signing secret</p>
        <p className="text-muted-foreground">
          Copy it now and store it with your receiver. It won't be shown again. Use it to verify the
          X-Rain-Signature header on every request.
        </p>
        <code
          className="rounded bg-muted px-2 py-1 font-mono text-xs break-all"
          data-testid="signing-secret"
        >
          {secret}
        </code>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void navigator.clipboard
                ?.writeText(secret)
                .then(() => toast.success('Signing secret copied'))
                .catch(() => toast.error("Couldn't copy; select and copy it manually"))
            }
          >
            <Copy aria-hidden /> Copy
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            I've stored it
          </Button>
        </div>
      </div>
    </Alert>
  );
}

function issue(err: unknown, path: string): string | undefined {
  return err instanceof ApiError ? err.issues.find((i) => i.path === path)?.message : undefined;
}

function SettingsForm({
  monitorId,
  settings,
  onSecret,
}: {
  monitorId: string;
  settings: NotificationSettings;
  onSecret: (secret: string) => void;
}) {
  const update = useUpdateNotificationSettings(monitorId);
  const [emailEnabled, setEmailEnabled] = useState(settings.email.enabled);
  const [url, setUrl] = useState(settings.webhook?.url ?? '');
  const [webhookEnabled, setWebhookEnabled] = useState(settings.webhook?.enabled ?? true);
  const [headerName, setHeaderName] = useState('');
  const [headerValue, setHeaderValue] = useState('');
  const [removeHeader, setRemoveHeader] = useState(false);
  const hasWebhook = settings.webhook !== null;

  function save(patch: UpdateNotificationSettingsInput, message: string) {
    update.mutate(patch, {
      onSuccess: (result) => {
        toast.success(message);
        if (result.signingSecret) onSecret(result.signingSecret);
        setHeaderName('');
        setHeaderValue('');
        setRemoveHeader(false);
        setUrl(result.settings.webhook?.url ?? '');
      },
    });
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = url.trim();
    const header =
      headerName.trim() || headerValue
        ? { name: headerName.trim(), value: headerValue }
        : removeHeader
          ? null
          : undefined;
    save(
      {
        emailEnabled,
        ...(trimmed
          ? {
              webhook: {
                enabled: webhookEnabled,
                url: trimmed,
                ...(header !== undefined && { header }),
              },
            }
          : hasWebhook
            ? { webhook: null }
            : {}),
      },
      'Notification settings saved',
    );
  }

  const busy = update.isPending;
  const generalError =
    update.isError && !(update.error instanceof ApiError && update.error.issues.length > 0)
      ? update.error.message
      : undefined;

  return (
    <form className="grid gap-6" onSubmit={submit} noValidate>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Mail className="size-4" aria-hidden /> Email
          </CardTitle>
          <CardDescription>
            An email when an incident opens and when it resolves. Not for individual failed checks.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <Toggle
            id="email-enabled"
            label={
              settings.email.address
                ? `Email ${settings.email.address} about incidents`
                : 'Email me about incidents'
            }
            checked={emailEnabled}
            disabled={!settings.email.address}
            onChange={setEmailEnabled}
          />
          {!settings.email.address && (
            <p className="text-xs text-muted-foreground">
              Your account has no email address, so email can't be enabled.
            </p>
          )}
          {!settings.email.providerConfigured && (
            <Alert variant="info">
              Email delivery isn't configured on this RAIN server yet. Emails will be listed as
              failed in the delivery history until an administrator sets up the email provider.
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Webhook className="size-4" aria-hidden /> Webhook
          </CardTitle>
          <CardDescription>
            A signed JSON POST to your endpoint when an incident opens or resolves.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Alert variant="info">
            <span className="flex gap-2">
              <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                RAIN only sends to public http(s) addresses on ports 80 and 443, checks every DNS
                answer before connecting and never follows redirects. Verify the X-Rain-Signature
                header on your side and reject old timestamps, so forged or replayed requests are
                ignored.
              </span>
            </span>
          </Alert>
          <FormField
            label="Endpoint URL"
            type="url"
            placeholder="https://hooks.example.com/rain"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            error={issue(update.error, 'webhook.url')}
            hint={hasWebhook ? 'Clear the URL and save to remove the webhook.' : undefined}
          />
          <Toggle
            id="webhook-enabled"
            label="Send webhook notifications"
            checked={webhookEnabled}
            onChange={setWebhookEnabled}
          />
          <div className="grid gap-3 rounded-md border border-border p-3">
            <p className="flex items-center gap-2 text-sm font-medium">
              <KeyRound className="size-4" aria-hidden /> Authentication header (optional)
            </p>
            {settings.webhook?.headerName && !removeHeader && (
              <p className="text-xs text-muted-foreground">
                <span className="font-mono">{settings.webhook.headerName}</span> is configured. Its
                value is encrypted and never shown. Enter a new one below to replace it.
              </p>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                label="Header name"
                placeholder="Authorization"
                value={headerName}
                onChange={(e) => setHeaderName(e.target.value)}
                error={issue(update.error, 'webhook.header.name')}
              />
              <FormField
                label="Header value"
                type="password"
                autoComplete="off"
                value={headerValue}
                onChange={(e) => setHeaderValue(e.target.value)}
                error={issue(update.error, 'webhook.header.value')}
              />
            </div>
            {settings.webhook?.headerName && (
              <Toggle
                id="remove-header"
                label="Remove the stored header"
                checked={removeHeader}
                onChange={setRemoveHeader}
              />
            )}
          </div>
          {hasWebhook && (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  save(
                    {
                      webhook: {
                        enabled: settings.webhook!.enabled,
                        url: settings.webhook!.url,
                        rotateSecret: true,
                      },
                    },
                    'New signing secret generated',
                  )
                }
              >
                Rotate signing secret
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={() => save({ webhook: null }, 'Webhook removed')}
              >
                Remove webhook
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {generalError && <Alert variant="error">{generalError}</Alert>}
      {update.error instanceof ApiError &&
        update.error.issues.length > 0 &&
        !issue(update.error, 'webhook.url') && (
          <Alert variant="error">{update.error.issues.map((i) => i.message).join(' ')}</Alert>
        )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy}>
          {busy && <Spinner label="Saving" />}
          Save notification settings
        </Button>
        <Link
          to={`/app/notifications?monitorId=${monitorId}`}
          className="text-sm text-muted-foreground hover:text-primary"
        >
          View delivery history
        </Link>
      </div>
    </form>
  );
}

/** The Notifications tab of a monitor's details page. */
export function MonitorNotifications({ monitorId }: { monitorId: string }) {
  const query = useNotificationSettings(monitorId);
  // Kept here, not in the form: the form remounts after a save, the one-time secret must not.
  const [secret, setSecret] = useState<string | null>(null);
  if (query.isPending) {
    return (
      <div className="grid gap-4" aria-busy>
        <Skeleton className="h-32" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <ErrorState
        title="Couldn't load notification settings"
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  // Keyed by save time so the form restarts from the server's state after each save.
  return (
    <div className="grid gap-6">
      {secret && <SigningSecret secret={secret} onDismiss={() => setSecret(null)} />}
      <SettingsForm
        key={query.data.webhook?.updatedAt ?? 'none'}
        monitorId={monitorId}
        settings={query.data}
        onSecret={setSecret}
      />
    </div>
  );
}
