import type { ReactNode } from 'react';
import { Brand } from './brand';
import { Waves } from './decor';
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
    <main className="relative flex min-h-screen overflow-hidden flex-col items-center justify-center px-4 py-12">
      <Waves className="absolute inset-x-0 bottom-0 h-56 w-full opacity-80" />
      <Brand className="relative mb-8" />
      <Card className="relative w-full max-w-sm animate-pop-in">
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
