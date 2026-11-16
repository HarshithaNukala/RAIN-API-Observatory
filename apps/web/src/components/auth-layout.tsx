import type { ReactNode } from 'react';
import { Brand } from './brand';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';

export function AuthLayout({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center px-4 py-12">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-80 bg-linear-to-b from-primary/10 to-transparent"
      />
      <Brand className="relative mb-8" />
      <Card className="relative w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
      {footer && <div className="relative mt-6 text-sm text-muted-foreground">{footer}</div>}
    </main>
  );
}
