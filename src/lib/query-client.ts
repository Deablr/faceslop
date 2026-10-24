// The QueryClient defaults for the whole app (one client per request on the server, one in the browser).
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { LOCKED_APP_AUTH, queryKeys } from '@/lib/queries';
import { appErrorOf, toClientError } from '@/shared/errors';

/** Failures worth one quiet retry: Facebook was slow, or the server was briefly unreachable. */
const isTransient = (error: unknown): boolean => {
  const { code } = toClientError(error);
  return code === 'FB_TIMEOUT' || code === 'NETWORK';
};

export function createQueryClient(): QueryClient {
  // Any call refused with APP_LOCKED (APP_PASSWORD is set and this browser hasn't entered it, or the
  // password changed since) flips the cached app-auth status, which makes the root show the lock screen.
  // Per client, so per request on the server: no state shared between requests.
  const onError = (error: unknown): void => {
    if (appErrorOf(error)?.code === 'APP_LOCKED') queryClient.setQueryData(queryKeys.appAuth, LOCKED_APP_AUTH);
  };
  const queryClient: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: {
        // Calm by default: no refetch storms against Facebook.
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        // A query that failed (e.g. during SSR) stays failed until the user retries: no surprise
        // refetches against Facebook, and SSR renders the error instead of a loading state.
        retryOnMount: false,
        retry: (failureCount, error) => failureCount < 1 && isTransient(error),
      },
      mutations: { retry: false },
      dehydrate: {
        // AppErrors are already safe to show; anything else is redacted during SSR dehydration.
        shouldRedactErrors: (error) => appErrorOf(error) === null,
      },
    },
  });
  return queryClient;
}
