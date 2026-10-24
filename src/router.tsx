import { createRouter, parseSearchWith, stringifySearchWith } from '@tanstack/react-router';
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query';
import { NotFound, RouteError } from '@/components/route-fallbacks';
import { createQueryClient } from '@/lib/query-client';
import { stringifySearchValue } from '@/lib/search-params';
import { routeTree } from './routeTree.gen';

/** Called by Start once per request on the server and once in the browser. */
export function getRouter() {
  const queryClient = createQueryClient();
  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    // Loaders only warm cheap local data (never Facebook), so preloading on intent is free.
    defaultPreload: 'intent',
    // TanStack Query owns caching; let every preload/load consult it.
    defaultPreloadStaleTime: 0,
    defaultErrorComponent: RouteError,
    defaultNotFoundComponent: NotFound,
    // Readable URLs: ?query=road+bike&conditions=new,used_good (each route's validateSearch coerces).
    parseSearch: parseSearchWith((value) => value),
    stringifySearch: stringifySearchWith(stringifySearchValue),
  });
  // Dehydrates the QueryClient into the SSR stream and wraps the app in QueryClientProvider.
  setupRouterSsrQueryIntegration({ router, queryClient });
  return router;
}
