import {
  CreateMonitorSchema,
  HEADER_LIMITS,
  MONITOR_LIMITS,
  MONITOR_METHODS,
  methodAllowsBody,
  monitorOrigin,
  type CreateMonitor,
  type CreateMonitorInput,
  type Monitor,
  type MonitorHeaderUpdateInput,
  type MonitorMethod,
  type UpdateMonitorInput,
} from '@rain/shared';
import { Eye, EyeOff, KeyRound, Plus, RotateCcw, Trash2, Undo2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Alert } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge, Select, Textarea } from '@/components/ui/misc';
import { Spinner } from '@/components/ui/spinner';
import { ApiError, type FieldIssue } from '@/lib/api-client';
import { useCreateMonitor, useUpdateMonitor, useUpdateMonitorHeaders } from './api';
import {
  INTERVAL_OPTIONS,
  ORIGIN_CHANGE_WARNING,
  byteLength,
  formatBytes,
  formatInterval,
} from './format';

const L = MONITOR_LIMITS;

type HeaderRow =
  /** A header saved on the server. Its value is never fetched; empty `replacement` keeps it. */
  | { key: string; kind: 'stored'; name: string; replacement: string; remove: boolean }
  | { key: string; kind: 'new'; name: string; value: string };

interface MonitorFormValues {
  name: string;
  description: string;
  url: string;
  method: MonitorMethod;
  expectedStatusCode: string;
  timeoutMs: string;
  latencyThresholdMs: string;
  checkIntervalSeconds: string;
  requestBody: string;
  bodyContentType: string;
  headers: HeaderRow[];
}

type Errors = Record<string, string>;

let rowCounter = 0;
const rowKey = () => `row-${++rowCounter}`;

function initialValues(monitor?: Monitor): MonitorFormValues {
  return {
    name: monitor?.name ?? '',
    description: monitor?.description ?? '',
    url: monitor?.url ?? '',
    method: monitor?.method ?? 'GET',
    expectedStatusCode: String(monitor?.expectedStatusCode ?? L.expectedStatusCode.default),
    timeoutMs: String(monitor?.timeoutMs ?? L.timeoutMs.default),
    latencyThresholdMs: String(monitor?.latencyThresholdMs ?? L.latencyThresholdMs.default),
    checkIntervalSeconds: String(monitor?.checkIntervalSeconds ?? L.checkIntervalSeconds.default),
    requestBody: monitor?.requestBody ?? '',
    bodyContentType: monitor?.bodyContentType ?? '',
    headers: (monitor?.headers ?? []).map((h) => ({
      key: rowKey(),
      kind: 'stored',
      name: h.name,
      replacement: '',
      remove: false,
    })),
  };
}

const toNumber = (value: string) => (value.trim() === '' ? Number.NaN : Number(value));

/** Headers that carry a value in this submission: new ones and stored ones being replaced. */
function headersWithValues(rows: HeaderRow[]) {
  return rows.flatMap((row) => {
    if (row.kind === 'new') {
      // A row left completely empty is ignored rather than reported.
      return row.name.trim() === '' && row.value === ''
        ? []
        : [{ key: row.key, name: row.name.trim(), value: row.value }];
    }
    return !row.remove && row.replacement !== ''
      ? [{ key: row.key, name: row.name, value: row.replacement }]
      : [];
  });
}

/** Validates with the API's own schema, so the form and server enforce exactly the same rules. */
function validate(values: MonitorFormValues): { data?: CreateMonitor; errors: Errors } {
  const withValues = headersWithValues(values.headers);
  const input: CreateMonitorInput = {
    name: values.name,
    description: values.description,
    url: values.url,
    method: values.method,
    expectedStatusCode: toNumber(values.expectedStatusCode),
    timeoutMs: toNumber(values.timeoutMs),
    latencyThresholdMs: toNumber(values.latencyThresholdMs),
    checkIntervalSeconds: toNumber(values.checkIntervalSeconds),
    requestBody: values.requestBody,
    bodyContentType: values.bodyContentType,
    headers: withValues.map(({ name, value }) => ({ name, value })),
  };
  const result = CreateMonitorSchema.safeParse(input);
  const errors: Errors = {};
  if (!result.success) {
    for (const issue of result.error.issues) {
      const [first, index, field] = issue.path;
      if (first === 'headers' && typeof index === 'number') {
        const row = withValues[index];
        if (row) errors[`header:${row.key}:${String(field ?? 'name')}`] ??= issue.message;
      } else {
        errors[String(first ?? 'form')] ??= issue.message;
      }
    }
  }
  // A new header may not shadow one that is already saved (and not being removed).
  const stored = new Set(
    values.headers.flatMap((r) => (r.kind === 'stored' && !r.remove ? [r.name.toLowerCase()] : [])),
  );
  for (const row of values.headers) {
    if (row.kind === 'new' && stored.has(row.name.trim().toLowerCase())) {
      errors[`header:${row.key}:name`] =
        `"${row.name.trim()}" is already configured. Use Replace on the saved header instead.`;
    }
  }
  return Object.keys(errors).length ? { errors } : { data: result.data!, errors };
}

/** The settings that differ from the saved monitor, as a minimal PATCH body. */
function settingsPatch(next: CreateMonitor, saved: Monitor): UpdateMonitorInput {
  const patch: UpdateMonitorInput = {};
  if (next.name !== saved.name) patch.name = next.name;
  if (next.description !== saved.description) patch.description = next.description;
  if (next.url !== saved.url) patch.url = next.url;
  if (next.method !== saved.method) patch.method = next.method;
  if (next.expectedStatusCode !== saved.expectedStatusCode) {
    patch.expectedStatusCode = next.expectedStatusCode;
  }
  if (next.timeoutMs !== saved.timeoutMs) patch.timeoutMs = next.timeoutMs;
  if (next.latencyThresholdMs !== saved.latencyThresholdMs) {
    patch.latencyThresholdMs = next.latencyThresholdMs;
  }
  if (next.checkIntervalSeconds !== saved.checkIntervalSeconds) {
    patch.checkIntervalSeconds = next.checkIntervalSeconds;
  }
  if (next.requestBody !== saved.requestBody) patch.requestBody = next.requestBody;
  const effectiveType = next.requestBody
    ? (next.bodyContentType ?? L.defaultBodyContentType)
    : null;
  if (effectiveType !== saved.bodyContentType) patch.bodyContentType = next.bodyContentType;
  return patch;
}

function headerChanges(values: MonitorFormValues): Required<MonitorHeaderUpdateInput> {
  return {
    upsert: headersWithValues(values.headers).map(({ name, value }) => ({ name, value })),
    remove: values.headers.flatMap((r) => (r.kind === 'stored' && r.remove ? [r.name] : [])),
  };
}

/** Server field issues use request paths (`url`, `headers.0.value`); map them onto the form. */
function errorsFromIssues(issues: FieldIssue[], values: MonitorFormValues): Errors {
  const withValues = headersWithValues(values.headers);
  const errors: Errors = {};
  for (const { path, message } of issues) {
    const [first, index, field] = path.split('.');
    // `headers.N` (create) and `upsert.N` (header update) both index the headers with values.
    const row =
      (first === 'headers' || first === 'upsert') && index !== undefined
        ? withValues[Number(index)]
        : undefined;
    if (row) errors[`header:${row.key}:${field ?? 'name'}`] ??= message;
    else if (first === 'headers' || first === 'upsert' || first === 'remove') {
      errors.headers ??= message;
    } else errors[first || 'form'] ??= message;
  }
  return errors;
}

function Field({
  label,
  error,
  hint,
  children,
  className,
}: {
  label: string;
  error?: string | undefined;
  hint?: ReactNode;
  className?: string;
  children: (props: {
    id: string;
    'aria-invalid'?: true;
    'aria-describedby'?: string;
  }) => ReactNode;
}) {
  const id = useId();
  const messageId = `${id}-message`;
  return (
    <div className={`grid content-start gap-2 ${className ?? ''}`}>
      <Label htmlFor={id}>{label}</Label>
      {children({
        id,
        ...(error && { 'aria-invalid': true as const }),
        ...((error || hint) && { 'aria-describedby': messageId }),
      })}
      {error ? (
        <p id={messageId} className="text-xs text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p id={messageId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="grid gap-5 md:grid-cols-2">{children}</CardContent>
    </Card>
  );
}

function SecretInput({
  label,
  value,
  onChange,
  placeholder,
  error,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  error?: string | undefined;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input
        aria-label={label}
        aria-invalid={error ? true : undefined}
        type={visible ? 'text' : 'password'}
        // Never offer to save or autofill these: they are API credentials, not the user's password.
        autoComplete="new-password"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        maxLength={HEADER_LIMITS.maxValueLength}
        onChange={(e) => onChange(e.target.value)}
        className="pr-10 font-mono placeholder:font-sans"
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? `Hide ${label}` : `Show ${label}`}
        aria-pressed={visible}
        className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
      >
        {visible ? (
          <EyeOff className="size-4" aria-hidden />
        ) : (
          <Eye className="size-4" aria-hidden />
        )}
      </button>
    </div>
  );
}

function HeaderEditor({
  rows,
  errors,
  onChange,
}: {
  rows: HeaderRow[];
  errors: Errors;
  onChange: (rows: HeaderRow[]) => void;
}) {
  const update = (key: string, patch: Partial<HeaderRow>) =>
    onChange(rows.map((r) => (r.key === key ? ({ ...r, ...patch } as HeaderRow) : r)));
  const activeCount = rows.filter((r) => !(r.kind === 'stored' && r.remove)).length;

  return (
    <div className="grid gap-3 md:col-span-2">
      {rows.length === 0 && (
        <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          No headers. Add one for API keys or bearer tokens; values are encrypted and never shown
          again after saving.
        </p>
      )}
      {rows.map((row) => {
        const nameError = errors[`header:${row.key}:name`];
        const valueError = errors[`header:${row.key}:value`];
        if (row.kind === 'stored') {
          return (
            <div
              key={row.key}
              className="grid gap-3 rounded-md border border-border bg-background/40 p-3 sm:grid-cols-[minmax(0,12rem)_1fr_auto] sm:items-start"
            >
              <div className="flex min-h-10 items-center gap-2">
                <KeyRound className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate font-mono text-sm" title={row.name}>
                  {row.name}
                </span>
              </div>
              {row.remove ? (
                <p className="flex min-h-10 items-center text-sm text-destructive">
                  Will be removed when you save.
                </p>
              ) : (
                <div className="grid gap-1.5">
                  <Badge tone="success" className="w-fit">
                    Credential configured
                  </Badge>
                  <SecretInput
                    label={`New value for ${row.name}`}
                    value={row.replacement}
                    placeholder="Leave empty to keep the saved value"
                    error={valueError}
                    onChange={(replacement) => update(row.key, { replacement })}
                  />
                  {valueError && <p className="text-xs text-destructive">{valueError}</p>}
                </div>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={row.remove ? `Keep ${row.name}` : `Remove ${row.name}`}
                onClick={() => update(row.key, { remove: !row.remove, replacement: '' })}
              >
                {row.remove ? <Undo2 aria-hidden /> : <Trash2 aria-hidden />}
                {row.remove ? 'Undo' : 'Remove'}
              </Button>
            </div>
          );
        }
        return (
          <div
            key={row.key}
            className="grid gap-3 rounded-md border border-border bg-background/40 p-3 sm:grid-cols-[minmax(0,12rem)_1fr_auto] sm:items-start"
          >
            <div className="grid gap-1.5">
              <Input
                aria-label="Header name"
                aria-invalid={nameError ? true : undefined}
                placeholder="Authorization"
                value={row.name}
                maxLength={HEADER_LIMITS.maxNameLength}
                spellCheck={false}
                onChange={(e) => update(row.key, { name: e.target.value })}
                className="font-mono"
              />
              {nameError && <p className="text-xs text-destructive">{nameError}</p>}
            </div>
            <div className="grid gap-1.5">
              <SecretInput
                label={`Value for ${row.name.trim() || 'new header'}`}
                value={row.value}
                placeholder="Bearer …"
                error={valueError}
                onChange={(value) => update(row.key, { value })}
              />
              {valueError && <p className="text-xs text-destructive">{valueError}</p>}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Remove header ${row.name.trim() || 'row'}`}
              onClick={() => onChange(rows.filter((r) => r.key !== row.key))}
            >
              <Trash2 aria-hidden /> Remove
            </Button>
          </div>
        );
      })}
      {errors.headers && <p className="text-xs text-destructive">{errors.headers}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={activeCount >= HEADER_LIMITS.maxCount}
          onClick={() => onChange([...rows, { key: rowKey(), kind: 'new', name: '', value: '' }])}
        >
          <Plus aria-hidden /> Add header
        </Button>
        <span className="text-xs text-muted-foreground">
          {activeCount} of {HEADER_LIMITS.maxCount} headers
        </span>
      </div>
    </div>
  );
}

export interface MonitorFormProps {
  /** The saved monitor when editing; omitted when creating. */
  monitor?: Monitor;
  onSaved: (monitor: Monitor, result: { savedConfigurationCleared: boolean }) => void;
  onCancel: () => void;
}

export function MonitorForm({ monitor, onSaved, onCancel }: MonitorFormProps) {
  const [values, setValues] = useState(() => initialValues(monitor));
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmOrigin, setConfirmOrigin] = useState<CreateMonitor | null>(null);

  const create = useCreateMonitor();
  const update = useUpdateMonitor(monitor?.id ?? '');
  const updateHeaders = useUpdateMonitorHeaders(monitor?.id ?? '');

  const set = <K extends keyof MonitorFormValues>(key: K, value: MonitorFormValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }));

  // After a failed submit, move focus to the first invalid field (or the form error), which may
  // be far above the submit button.
  const formRef = useRef<HTMLFormElement>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  useEffect(() => {
    if (focusRequest === 0) return;
    const form = formRef.current;
    const target =
      form?.querySelector<HTMLElement>('[aria-invalid="true"]') ??
      form?.querySelector<HTMLElement>('[role="alert"]');
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'center' });
  }, [focusRequest]);
  const focusFirstError = () => setFocusRequest((n) => n + 1);

  const bodyAllowed = methodAllowsBody(values.method);
  const bodyBytes = byteLength(values.requestBody);
  const intervalOptions = INTERVAL_OPTIONS.some(
    (o) => String(o.seconds) === values.checkIntervalSeconds,
  )
    ? INTERVAL_OPTIONS
    : [
        ...INTERVAL_OPTIONS,
        {
          seconds: Number(values.checkIntervalSeconds),
          label: formatInterval(Number(values.checkIntervalSeconds)),
        },
      ];

  function fail(err: unknown, prefix = '') {
    focusFirstError();
    if (err instanceof ApiError && err.issues.length > 0) {
      setErrors(errorsFromIssues(err.issues, values));
      setFormError(`${prefix}Some fields need attention.`);
    } else {
      setFormError(`${prefix}${err instanceof Error ? err.message : 'Something went wrong.'}`);
    }
  }

  async function saveNew(data: CreateMonitor) {
    try {
      const created = await create.mutateAsync(data);
      onSaved(created, { savedConfigurationCleared: false });
    } catch (err) {
      fail(err);
    }
  }

  async function saveExisting(saved: Monitor, data: CreateMonitor, confirmed: boolean) {
    const patch = settingsPatch(data, saved);
    const headers = headerChanges(values);
    let current = saved;
    let cleared = false;

    if (Object.keys(patch).length > 0) {
      try {
        const result = await update.mutateAsync(
          confirmed ? { ...patch, confirmOriginChange: true } : patch,
        );
        current = result.data;
        cleared = result.meta.savedConfigurationCleared;
      } catch (err) {
        // The server is authoritative: if it still wants confirmation, ask for it.
        if (err instanceof ApiError && err.code === 'MONITOR_ORIGIN_CHANGE_CONFIRMATION_REQUIRED') {
          setConfirmOrigin(data);
          return;
        }
        fail(err);
        return;
      }
    }

    // Removals of headers an origin change already deleted are dropped, not re-sent.
    const savedNames = new Set(current.headers.map((h) => h.name.toLowerCase()));
    const remove = headers.remove.filter((name) => savedNames.has(name.toLowerCase()));
    if (headers.upsert.length > 0 || remove.length > 0) {
      try {
        current = await updateHeaders.mutateAsync({ upsert: headers.upsert, remove });
      } catch (err) {
        fail(
          err,
          Object.keys(patch).length > 0
            ? 'Settings were saved, but the header changes were not. '
            : 'Header changes were not saved. ',
        );
        return;
      }
    }

    if (Object.keys(patch).length === 0 && headers.upsert.length === 0 && remove.length === 0) {
      setFormError('There are no changes to save.');
      focusFirstError();
      return;
    }
    onSaved(current, { savedConfigurationCleared: cleared });
  }

  async function submit(confirmed: boolean, validated?: CreateMonitor) {
    if (submitting) return;
    setFormError(null);
    let data = validated;
    if (!data) {
      const result = validate(values);
      setErrors(result.errors);
      if (!result.data) {
        setFormError('Some fields need attention.');
        focusFirstError();
        return;
      }
      data = result.data;
    }

    if (monitor && !confirmed) {
      const originChanged = monitorOrigin(data.url) !== monitorOrigin(monitor.url);
      const hasSaved = monitor.headers.length > 0 || monitor.requestBody !== null;
      if (originChanged && hasSaved) {
        setConfirmOrigin(data);
        return;
      }
    }

    setSubmitting(true);
    try {
      if (monitor) await saveExisting(monitor, data, confirmed);
      else await saveNew(data);
    } finally {
      setSubmitting(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void submit(false);
  }

  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={onSubmit}
      className="grid gap-6"
      aria-busy={submitting}
    >
      {formError && (
        <Alert variant="error" tabIndex={-1}>
          {formError}
        </Alert>
      )}

      <Section title="Basic details" description="How this monitor appears in RAIN.">
        <Field label="Name" error={errors.name}>
          {(p) => (
            <Input
              {...p}
              value={values.name}
              maxLength={L.nameMaxLength}
              placeholder="Payments API"
              onChange={(e) => set('name', e.target.value)}
            />
          )}
        </Field>
        <Field
          label="Description (optional)"
          error={errors.description}
          hint={`${values.description.length}/${L.descriptionMaxLength} characters`}
        >
          {(p) => (
            <Input
              {...p}
              value={values.description}
              maxLength={L.descriptionMaxLength}
              placeholder="What this endpoint does"
              onChange={(e) => set('description', e.target.value)}
            />
          )}
        </Field>
      </Section>

      <Section title="Endpoint" description="The request RAIN will send on each check.">
        <Field
          label="URL"
          error={errors.url}
          hint="Public http:// or https:// address on the standard port (80 or 443)."
          className="md:col-span-2"
        >
          {(p) => (
            <Input
              {...p}
              type="url"
              inputMode="url"
              spellCheck={false}
              value={values.url}
              maxLength={L.urlMaxLength}
              placeholder="https://api.example.com/health"
              onChange={(e) => set('url', e.target.value)}
              className="font-mono"
            />
          )}
        </Field>
        <Field label="HTTP method" error={errors.method}>
          {(p) => (
            <Select
              {...p}
              value={values.method}
              onChange={(e) => set('method', e.target.value as MonitorMethod)}
            >
              {MONITOR_METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label="Expected status code"
          error={errors.expectedStatusCode}
          hint="The response status that counts as up."
        >
          {(p) => (
            <Input
              {...p}
              type="number"
              inputMode="numeric"
              min={L.expectedStatusCode.min}
              max={L.expectedStatusCode.max}
              value={values.expectedStatusCode}
              onChange={(e) => set('expectedStatusCode', e.target.value)}
            />
          )}
        </Field>
      </Section>

      <Section title="Performance" description="When a check counts as slow or failed.">
        <Field
          label="Timeout (ms)"
          error={errors.timeoutMs}
          hint={`${L.timeoutMs.min}–${L.timeoutMs.max} ms`}
        >
          {(p) => (
            <Input
              {...p}
              type="number"
              inputMode="numeric"
              min={L.timeoutMs.min}
              max={L.timeoutMs.max}
              value={values.timeoutMs}
              onChange={(e) => set('timeoutMs', e.target.value)}
            />
          )}
        </Field>
        <Field
          label="Latency threshold (ms)"
          error={errors.latencyThresholdMs}
          hint="Slower responses count as degraded. Must not exceed the timeout."
        >
          {(p) => (
            <Input
              {...p}
              type="number"
              inputMode="numeric"
              min={L.latencyThresholdMs.min}
              max={L.latencyThresholdMs.max}
              value={values.latencyThresholdMs}
              onChange={(e) => set('latencyThresholdMs', e.target.value)}
            />
          )}
        </Field>
        <Field label="Check interval" error={errors.checkIntervalSeconds}>
          {(p) => (
            <Select
              {...p}
              value={values.checkIntervalSeconds}
              onChange={(e) => set('checkIntervalSeconds', e.target.value)}
            >
              {intervalOptions.map((o) => (
                <option key={o.seconds} value={o.seconds}>
                  Every {o.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </Section>

      <Section
        title="Request body"
        description="Optional. Sent with POST, PUT and PATCH only, and stored encrypted."
      >
        <Field
          label="Body"
          error={errors.requestBody}
          hint={
            bodyAllowed
              ? `${formatBytes(bodyBytes)} of ${formatBytes(L.requestBodyMaxBytes)}`
              : `${values.method} requests don't send a body.`
          }
          className="md:col-span-2"
        >
          {(p) => (
            <Textarea
              {...p}
              value={values.requestBody}
              disabled={!bodyAllowed && values.requestBody === ''}
              spellCheck={false}
              placeholder={bodyAllowed ? '{ "ping": true }' : ''}
              onChange={(e) => set('requestBody', e.target.value)}
            />
          )}
        </Field>
        <Field
          label="Content type"
          error={errors.bodyContentType}
          hint={`Defaults to ${L.defaultBodyContentType} when a body is set.`}
        >
          {(p) => (
            <Input
              {...p}
              value={values.bodyContentType}
              maxLength={L.bodyContentTypeMaxLength}
              disabled={values.requestBody === '' && values.bodyContentType === ''}
              placeholder={L.defaultBodyContentType}
              spellCheck={false}
              onChange={(e) => set('bodyContentType', e.target.value)}
              className="font-mono"
            />
          )}
        </Field>
      </Section>

      <Section
        title="Authentication headers"
        description="Header values are encrypted and write-only: after saving, RAIN only shows that a credential is configured."
      >
        <HeaderEditor
          rows={values.headers}
          errors={errors}
          onChange={(rows) => set('headers', rows)}
        />
      </Section>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        {monitor && (
          <Button
            type="button"
            variant="ghost"
            disabled={submitting}
            onClick={() => {
              setValues(initialValues(monitor));
              setErrors({});
              setFormError(null);
            }}
          >
            <RotateCcw aria-hidden /> Reset
          </Button>
        )}
        <Button type="submit" disabled={submitting}>
          {submitting && <Spinner label="Saving" />}
          {monitor ? 'Save changes' : 'Create monitor'}
        </Button>
      </div>

      <AlertDialog
        open={confirmOrigin !== null}
        onOpenChange={(open) => {
          if (open) return;
          // Cancelled: nothing was sent. Put the saved destination back so that is visible.
          setConfirmOrigin(null);
          if (monitor) set('url', monitor.url);
          setFormError(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>Change the destination?</AlertDialogTitle>
          <AlertDialogDescription>{ORIGIN_CHANGE_WARNING}</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button variant="outline">Cancel</Button>
            </AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => {
                const data = confirmOrigin;
                setConfirmOrigin(null);
                if (data) void submit(true, data);
              }}
            >
              Change destination
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}
