import { Brand } from '@/components/brand';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/** Rendered instead of the app when the browser build is missing its Supabase settings. */
export function ConfigErrorPage({ problems }: { problems: string[] }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 px-4 py-12">
      <Brand />
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle className="text-xl">Configuration required</CardTitle>
          <CardDescription>
            The web app can't start until it knows which Supabase project to use.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 text-sm">
          <Alert variant="error">
            <ul className="grid gap-1">
              {problems.map((p) => (
                <li key={p} className="font-mono text-xs">
                  {p}
                </li>
              ))}
            </ul>
          </Alert>
          <ol className="grid list-decimal gap-2 pl-5 text-muted-foreground">
            <li>
              Copy <code className="text-foreground">.env.example</code> to{' '}
              <code className="text-foreground">.env</code> in the repository root.
            </li>
            <li>
              Set <code className="text-foreground">VITE_SUPABASE_URL</code> and{' '}
              <code className="text-foreground">VITE_SUPABASE_PUBLISHABLE_KEY</code> from your
              Supabase project's API settings.
            </li>
            <li>Restart the dev server.</li>
          </ol>
        </CardContent>
      </Card>
    </main>
  );
}
