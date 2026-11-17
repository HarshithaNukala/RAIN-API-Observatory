import { Activity, LayoutDashboard, LogOut, Menu } from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet, ScrollRestoration } from 'react-router';
import { toast } from 'sonner';
import { useAuth } from '@/auth/auth-context';
import { cn } from '@/lib/utils';
import { Brand } from './brand';
import { Button } from './ui/button';
import { Dialog, DialogDescription, DialogTitle, SheetContent } from './ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { Spinner } from './ui/spinner';

// Only routes that exist. Incidents, alerts and status pages join this list when they ship.
const NAV_ITEMS = [
  { to: '/app', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/app/monitors', label: 'Monitors', icon: Activity, end: false },
];

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav aria-label="Main" className="flex flex-col gap-1 px-3 py-2">
      {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
              isActive && 'bg-accent font-medium text-foreground',
            )
          }
        >
          <Icon className="size-4" aria-hidden />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

function ProfileMenu() {
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
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-9 gap-2 px-2" aria-label="Account menu">
          <span
            aria-hidden
            className="flex size-7 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary"
          >
            {(email?.[0] ?? '?').toUpperCase()}
          </span>
          <span className="hidden max-w-48 truncate text-sm text-muted-foreground sm:block">
            {email}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-60">
        <DropdownMenuLabel>
          Signed in as
          <span className="block truncate text-sm text-foreground" title={email}>
            {email ?? 'Unknown user'}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={signingOut}
          onSelect={(event) => {
            // Keep the menu open so the spinner is visible until the session ends.
            event.preventDefault();
            void handleSignOut();
          }}
        >
          {signingOut ? <Spinner label="Signing out" /> : <LogOut aria-hidden />}
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppShell() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <div className="flex min-h-screen">
      {/* New pages start at the top; Back restores the previous scroll position. */}
      <ScrollRestoration />
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-border bg-card/40 lg:flex">
        <div className="flex h-16 items-center px-5">
          <Brand />
        </div>
        <NavItems />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border bg-background/90 px-4 backdrop-blur lg:px-8">
          <Dialog open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              aria-label="Open navigation"
              onClick={() => setMobileNavOpen(true)}
            >
              <Menu aria-hidden />
            </Button>
            <SheetContent>
              <DialogTitle className="sr-only">Navigation</DialogTitle>
              <DialogDescription className="sr-only">Main sections of RAIN</DialogDescription>
              <div className="flex h-16 items-center px-5">
                <Brand />
              </div>
              <NavItems onNavigate={() => setMobileNavOpen(false)} />
            </SheetContent>
          </Dialog>
          <Brand className="lg:hidden" />
          <div className="ml-auto">
            <ProfileMenu />
          </div>
        </header>
        <main className="flex-1 px-4 py-8 lg:px-8">
          <div className="mx-auto w-full max-w-6xl">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
