import { useId, type ComponentProps, type ReactNode } from 'react';
import { Input } from './ui/input';
import { Label } from './ui/label';

export function FormField({
  label,
  error,
  hint,
  ...inputProps
}: { label: string; error?: string | undefined; hint?: ReactNode } & ComponentProps<'input'>) {
  const id = useId();
  const messageId = `${id}-message`;
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? messageId : undefined}
        {...inputProps}
      />
      {error ? (
        <p id={messageId} className="text-xs font-semibold text-status-down-fg">
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
