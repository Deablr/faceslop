import { useQuery } from '@tanstack/react-query';
import { Link, useRouterState } from '@tanstack/react-router';
import { Bookmark, MessageCircle, Search, Settings, Tag, type LucideIcon } from 'lucide-react';
import { Logo } from '@/components/logo';
import { SearchBox } from '@/components/search-box';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { buttonVariants } from '@/components/ui/button';
import { authStatusQuery } from '@/lib/queries';

type NavPath = '/' | '/saved' | '/messages' | '/selling' | '/settings';

interface NavItem {
  readonly to: NavPath;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly matches: (path: string) => boolean;
}

const NAV: readonly NavItem[] = [
  { to: '/', label: 'Search', icon: Search, matches: (p) => p === '/' || p.startsWith('/search') || p.startsWith('/item') },
  { to: '/saved', label: 'Saved', icon: Bookmark, matches: (p) => p.startsWith('/saved') },
  { to: '/messages', label: 'Messages', icon: MessageCircle, matches: (p) => p.startsWith('/messages') },
  { to: '/selling', label: 'Selling', icon: Tag, matches: (p) => p.startsWith('/selling') },
  { to: '/settings', label: 'Settings', icon: Settings, matches: (p) => p.startsWith('/settings') },
];

const usePathname = () => useRouterState({ select: (s) => s.location.pathname });

export function TopBar() {
  const pathname = usePathname();
  const isHome = pathname === '/';
  return (
    <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-3 px-4 sm:gap-6 sm:px-6">
        <Link to="/" aria-label="faceslop home" className="shrink-0 rounded-md">
          <Logo compact={!isHome} />
        </Link>
        <div className="min-w-0 flex-1 md:max-w-md">{!isHome && <SearchBox size="sm" />}</div>
        <nav aria-label="Main" className="hidden md:ml-auto md:block">
          <ul className="flex items-center gap-1">
            {NAV.map((item) => (
              <li key={item.to}>
                <Link
                  to={item.to}
                  activeOptions={{ exact: true }}
                  // The section is current on its sub-pages too (Search on /search and /item/…).
                  aria-current={item.matches(pathname) ? 'page' : undefined}
                  data-active={item.matches(pathname) || undefined}
                  className="rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground data-active:bg-muted data-active:font-medium data-active:text-foreground"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <AccountButton />
      </div>
    </header>
  );
}

/** Facebook connection state: a quiet "Connect Facebook", or who is connected. */
function AccountButton() {
  const { data } = useQuery(authStatusQuery);
  if (data?.state === 'logged_in') {
    const name = data.userName ?? 'Facebook';
    return (
      <Link
        to="/settings"
        hash="facebook"
        className="flex shrink-0 items-center gap-2 rounded-full text-sm text-muted-foreground hover:text-foreground"
        title={`Connected to Facebook as ${name}`}
      >
        <Avatar aria-hidden="true">
          <AvatarFallback>{name.charAt(0).toUpperCase()}</AvatarFallback>
        </Avatar>
        <span className="hidden max-w-32 truncate lg:inline">{name}</span>
        <span className="sr-only lg:hidden">Facebook account: {name}</span>
      </Link>
    );
  }
  return (
    <Link to="/login" className={buttonVariants({ variant: 'outline', size: 'sm', className: 'shrink-0' })}>
      <span className="sm:hidden">Connect</span>
      <span className="hidden sm:inline">Connect Facebook</span>
    </Link>
  );
}

/** Phone-width navigation, pinned to the bottom within thumb reach. */
export function MobileNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t bg-background/90 backdrop-blur-md md:hidden">
      <ul className="mx-auto grid max-w-md grid-cols-5">
        {NAV.map(({ to, label, icon: Icon, matches }) => (
          <li key={to}>
            <Link
              to={to}
              activeOptions={{ exact: true }}
              aria-current={matches(pathname) ? 'page' : undefined}
              data-active={matches(pathname) || undefined}
              className="flex flex-col items-center gap-0.5 py-2 text-xs text-muted-foreground data-active:font-medium data-active:text-primary"
            >
              <Icon className="size-5" strokeWidth={1.75} aria-hidden="true" />
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
