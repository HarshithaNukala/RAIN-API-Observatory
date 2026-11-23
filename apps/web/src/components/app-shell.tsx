import {
  Activity,
  BarChart3,
  Bell,
  ChevronDown,
  Layers,
  LayoutGrid,
  LogOut,
  Menu,
  TriangleAlert,
} from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { NavLink, Outlet, ScrollRestoration, useLocation } from 'react-router';
import { toast } from 'sonner';
import { useAuth } from '@/auth/auth-context';
import { cn } from '@/lib/utils';
import { Brand } from './brand';
import { Waves } from './decor';
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

// Only routes that exist.
const NAV_ITEMS = [
  { to: '/app', label: 'Overview', icon: LayoutGrid, end: true },
  { to: '/app/monitors', label: 'Monitors', icon: Activity, end: false },
  { to: '/app/incidents', label: 'Incidents', icon: TriangleAlert, end: false },
  { to: '/app/analytics', label: 'Analytics', icon: BarChart3, end: false },
  { to: '/app/notifications', label: 'Notifications', icon: Bell, end: false },
  { to: '/app/status-pages', label: 'Status pages', icon: Layers, end: false },
];

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav aria-label="Main" className="flex flex-col gap-1 px-4 py-2">
      <p className="px-3 pt-3 pb-2 text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
        Workspace
      </p>
      {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              'group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-[15px] font-medium text-foreground/80 transition-[background-color,color,transform] duration-200 ease-(--ease-out-soft) hover:translate-x-0.5 hover:bg-accent hover:text-foreground',
              // Active: peach surface, terracotta text and icon, and a heavier weight.
              isActive &&
                'bg-peach/80 font-semibold text-primary hover:bg-peach hover:text-primary',
            )
          }
        >
          <Icon
            className="size-[18px] transition-transform duration-300 ease-(--ease-out-soft) group-hover:scale-110"
            aria-hidden
          />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

/** The release card at the bottom of the sidebar. */
function SidebarCard() {
  return (
    <div className="relative mx-4 mb-5 overflow-hidden rounded-2xl border border-primary/10 bg-peach/45">
      <Waves className="h-20 w-full" />
      <div className="px-4 pt-1 pb-4">
        <p className="font-display text-base font-bold">RAIN V1</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          API monitoring, incidents and status pages.
        </p>
      </div>
    </div>
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
        <Button
          variant="ghost"
          className="h-11 gap-2.5 rounded-full py-1 pr-3 pl-1 hover:text-foreground"
          aria-label="Account menu"
        >
          <span
            aria-hidden
            className="flex size-9 items-center justify-center rounded-full bg-linear-to-b from-primary to-primary-strong text-sm font-bold text-primary-foreground shadow-[0_6px_14px_-6px_var(--color-primary)]"
          >
            {(email?.[0] ?? '?').toUpperCase()}
          </span>
          <span className="hidden max-w-48 truncate text-sm font-medium sm:block">{email}</span>
          <ChevronDown className="hidden text-muted-foreground sm:block" aria-hidden />
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

/** Fades the page in on every route change without remounting it (keeps component state). */
function usePageEnterAnimation() {
  const ref = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof el.animate !== 'function') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    el.animate(
      [
        { opacity: 0, transform: 'translateY(8px)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 380, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' },
    );
  }, [pathname]);
  return ref;
}

export function AppShell() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const pageRef = usePageEnterAnimation();

  return (
    <div className="flex min-h-screen">
      {/* New pages start at the top; Back restores the previous scroll position. */}
      <ScrollRestoration />
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-border bg-sidebar/80 backdrop-blur lg:flex">
        <div className="flex h-20 items-center px-7">
          <Brand />
        </div>
        <NavItems />
        <div className="mt-auto">
          <SidebarCard />
        </div>
      </aside>

      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* Decorative dunes behind the top of every page. */}
        <Waves className="absolute top-0 right-0 -z-0 h-64 w-[min(60rem,90%)] opacity-70" />

        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 bg-background/70 px-4 backdrop-blur-md sm:h-20 lg:px-10">
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
            <SheetContent className="flex flex-col bg-sidebar">
              <DialogTitle className="sr-only">Navigation</DialogTitle>
              <DialogDescription className="sr-only">Main sections of RAIN</DialogDescription>
              <div className="flex h-20 items-center px-7">
                <Brand />
              </div>
              <NavItems onNavigate={() => setMobileNavOpen(false)} />
              <div className="mt-auto">
                <SidebarCard />
              </div>
            </SheetContent>
          </Dialog>
          <Brand className="lg:hidden" />
          <div className="ml-auto">
            <ProfileMenu />
          </div>
        </header>
        <main className="relative z-10 flex-1 px-4 pt-2 pb-10 sm:pb-12 lg:px-10">
          <div ref={pageRef} className="mx-auto w-full max-w-7xl">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
