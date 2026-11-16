import { LayoutDashboard, LogOut } from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { toast } from 'sonner';
import { useAuth } from '@/auth/auth-context';
import { cn } from '@/lib/utils';
import { Brand } from './brand';
import { Button } from './ui/button';
import { Spinner } from './ui/spinner';

// Only routes that exist. Monitors, incidents and status pages join this list as they ship.
const NAV_ITEMS = [{ to: '/', label: 'Overview', icon: LayoutDashboard, end: true }];

export function AppShell() {
  const { auth, signOut } = useAuth();
  const [signingOut, setSigningOut] = useState(false);
  const email = auth.status === 'signed-in' ? auth.session.user.email : undefined;

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await signOut();
    } catch {
      toast.error('Sign-out failed. Please try again.');
      setSigningOut(false);
    }
  }

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-card/40 md:flex">
        <div className="flex h-16 items-center px-5">
          <Brand />
        </div>
        <nav aria-label="Main" className="flex flex-col gap-1 px-3 py-2">
          {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                  isActive && 'bg-accent text-foreground',
                )
              }
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 items-center justify-between gap-4 border-b border-border px-4 md:px-8">
          <Brand className="md:hidden" />
          <div className="ml-auto flex items-center gap-3">
            {email && (
              <span
                className="hidden max-w-56 truncate text-sm text-muted-foreground sm:block"
                title={email}
              >
                {email}
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleSignOut()}
              disabled={signingOut}
            >
              {signingOut ? <Spinner label="Signing out" /> : <LogOut aria-hidden />}
              Sign out
            </Button>
          </div>
        </header>
        <main className="flex-1 px-4 py-8 md:px-8">
          <div className="mx-auto w-full max-w-5xl">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
