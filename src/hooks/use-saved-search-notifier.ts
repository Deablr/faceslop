// Opt-in desktop notifications: while a faceslop tab is open, re-read saved searches every five
// minutes and notify when one's newCount goes up. The server's background checker does the
// searching; this only reads the local list (no Facebook traffic). The first check after this
// browser logs in to or out of Facebook only records (src/lib/saved-search-increases.ts).
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useNotificationPermission } from '@/hooks/use-notification-permission';
import { accountOf } from '@/lib/account-change';
import { queryKeys } from '@/lib/queries';
import { type SeenNewCounts, savedSearchIncreases } from '@/lib/saved-search-increases';
import { listSavedSearches } from '@/server/functions/saved-searches';
import type { AuthStatus, SavedSearch } from '@/shared/domain';

const INTERVAL_MS = 5 * 60_000;

/** What the previous check saw (null before the first one). */
const seen: { last: SeenNewCounts | null } = { last: null };

function notifyIncreases(list: readonly SavedSearch[], owner: string | null, open: (id: number) => void): void {
  const { seen: now, increased } = savedSearchIncreases(seen.last, owner, list);
  seen.last = now;
  for (const saved of increased) {
    const notification = new Notification(`${String(saved.newCount)} new for “${saved.name}”`, {
      body: 'Found by faceslop. Open it when you have a moment.',
      icon: '/favicon.svg',
      tag: `saved-search-${String(saved.id)}`,
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
      open(saved.id);
    };
  }
}

export function useSavedSearchNotifier(enabled: boolean): void {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const permission = useNotificationPermission();
  const permitted = enabled && permission === 'granted';

  useQuery(
    queryOptions({
      queryKey: ['saved-search-notifier'],
      enabled: permitted,
      refetchInterval: INTERVAL_MS,
      refetchIntervalInBackground: true,
      staleTime: INTERVAL_MS,
      queryFn: async ({ signal }) => {
        // Cancelled when a login or logout restarts the check: the list it would bring is the previous owner's.
        const list = await listSavedSearches({ signal });
        queryClient.setQueryData<readonly SavedSearch[]>(queryKeys.savedSearches, list);
        // Read after the list arrives: a login or logout that started this check has stored its status by then.
        const auth = queryClient.getQueryData<AuthStatus>(queryKeys.auth);
        notifyIncreases(list, auth === undefined ? null : accountOf(auth), (id) => {
          // Like "View new": always re-run it rather than show an older run from the cache.
          void queryClient.resetQueries({ queryKey: queryKeys.savedSearchRun(id) });
          void navigate({ to: '/saved', search: { view: id } });
        });
        return list.length;
      },
    }),
  );
}
