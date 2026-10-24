import { useQuery, type QueryClient } from '@tanstack/react-query';
import { HeadContent, Outlet, Scripts, createRootRouteWithContext, useRouter, type NavigateOptions } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { RouterProvider } from 'react-aria-components';
import { AppLockScreen } from '@/components/app-lock-screen';
import { Toaster } from '@/components/ui/sonner';
import { appAuthQuery, settled } from '@/lib/queries';
import appCss from '../styles.css?url';

export interface RouterContext {
  readonly queryClient: QueryClient;
}

declare module 'react-aria-components' {
  interface RouterConfig {
    routerOptions: Pick<NavigateOptions, 'replace' | 'resetScroll'>;
  }
}

/**
 * Follow the OS color scheme: toggle `.dark` on <html> before first paint and on changes.
 * (A user-chosen theme can later set/remove the class instead.)
 */
const THEME_SCRIPT = `(function(){var d=document.documentElement,m=window.matchMedia('(prefers-color-scheme: dark)');function a(){d.classList.toggle('dark',m.matches)}a();m.addEventListener('change',a)})()`;

export const Route = createRootRouteWithContext<RouterContext>()({
  // The app password gate is decided during SSR, so a locked app never flashes its pages.
  loader: ({ context }) => settled(context.queryClient.query({ ...appAuthQuery, staleTime: 'static' })),
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
      { name: 'color-scheme', content: 'light dark' },
      { name: 'description', content: 'Facebook Marketplace, without the rest of Facebook.' },
      { title: 'faceslop' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
    ],
    scripts: [{ children: THEME_SCRIPT }],
  }),
  shellComponent: RootDocument,
  component: RootComponent,
});

function RootDocument({ children }: { readonly children: ReactNode }) {
  return (
    // The theme script adds `class="dark"` before hydration.
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Toaster />
        <Scripts />
      </body>
    </html>
  );
}

/** React Aria links and menus navigate through the router; the app-password gate wraps everything. */
function RootComponent() {
  const router = useRouter();
  const { data: appAuth } = useQuery(appAuthQuery);
  // A failed check (e.g. the server is mid-restart) is not "locked": each call reports APP_LOCKED itself.
  const locked = appAuth?.required === true && !appAuth.authenticated;
  return (
    <RouterProvider
      navigate={(href, options) => {
        void router.navigate({ ...options, href });
      }}
      useHref={(href) => href}
    >
      {locked ? <AppLockScreen /> : <Outlet />}
    </RouterProvider>
  );
}
