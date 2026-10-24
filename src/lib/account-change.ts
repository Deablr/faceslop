// How the client cache follows this browser's Facebook connection. Local data (favorites, saved
// searches, hidden listings, blocked sellers, settings) belongs to the Facebook account a browser
// is logged in with, or to the browser alone until then: logging in moves it to the account (so
// whatever the account saved on other devices shows up too) and logging out goes back to the
// browser's own (see src/server/session/identity.ts). The client can't see that binding itself;
// AuthStatus.userId stands in for it (Auth names the bound account in every state, also after the
// account's Facebook session ended; null only while unbound). Every AuthStatus the client learns
// (status fetches, login, logout, connection checks) goes through here, so the reaction lives in
// one place.
import type { Query, QueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import type { AuthStatus } from '@/shared/domain';

/** Stands in for a logged-in status that doesn't name its account (the server always does). */
const UNNAMED_ACCOUNT = 'logged-in';

/**
 * The Facebook account this browser's local data belongs to, or null while it isn't bound to one
 * (the data is this browser's alone). A status that names an account counts as that account even
 * when the account's Facebook session ended or a new login is under way.
 */
export function accountOf(status: AuthStatus): string | null {
  return status.userId ?? (status.state === 'logged_in' ? UNNAMED_ACCOUNT : null);
}

/**
 * This browser's Facebook session changed (a login started or ended, or the remote view saved new
 * cookies): listing details (canMessage / hasMessaged) are stale, so they refetch when next shown.
 * Search results stay visible; their sessions are gone on the server, so "Load more" offers
 * "Refresh results".
 */
export function onSessionChanged(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.listings, refetchType: 'none' });
}

/** Results from Facebook (seconds each): refetching them on our own would repeat work nobody asked for. */
const FROM_FACEBOOK: ReadonlySet<unknown> = new Set([
  queryKeys.searches[0],
  queryKeys.savedSearchRuns[0],
  queryKeys.listings[0],
  queryKeys.locationLookups[0],
]);

/** The data owner's own lists: never shown to anyone else, not even while they refetch. */
const OWNER_DATA: ReadonlySet<unknown> = new Set([
  queryKeys.favorites[0],
  queryKeys.savedSearches[0],
  queryKeys.hidden[0],
  queryKeys.blockedSellers[0],
  queryKeys.settings[0],
]);

const isAppAuth = (q: Query): boolean => q.queryKey[0] === queryKeys.appAuth[0];
const isAuth = (q: Query): boolean => q.queryKey[0] === queryKeys.auth[0];

/**
 * Start failed queries over (except those `leave` keeps), so they load again when shown instead of
 * showing the old failure (retryOnMount is off), and invalidate the other local queries: those on
 * screen refetch now, the rest when next shown. Facebook results stay as they are.
 */
function reloadLocal(queryClient: QueryClient, leave: (q: Query) => boolean): void {
  // Collected up front: once reset, a query no longer looks failed when resetQueries picks which to refetch.
  const failed = new Set<Query>(
    queryClient.getQueryCache().findAll({ predicate: (q) => !leave(q) && q.state.status === 'error' && q.state.data === undefined }),
  );
  void queryClient.resetQueries({ predicate: (q) => failed.has(q) });
  void queryClient.invalidateQueries({ predicate: (q) => !leave(q) && !failed.has(q) && !FROM_FACEBOOK.has(q.queryKey[0]) });
  onSessionChanged(queryClient);
}

/**
 * Whose data this browser shows changed: it logged in to Facebook (its data is now the account's)
 * or logged out (back to its own). The owner's lists start over rather than being invalidated:
 * route loaders read the cache with `staleTime: 'static'`, which ignores invalidation, and would
 * render the previous owner's lists until the refetch returns. Saved-search runs ("View new") are
 * dropped (a run only executes when shown; another owner's id is NOT_FOUND). Other local queries
 * (remote-view state, categories, ...) refetch, failed ones start over, and Facebook results stay
 * (onSessionChanged). The Facebook status was just stored by the caller and the app-lock status
 * belongs to the browser: both are left alone.
 */
export function onDataOwnerChanged(queryClient: QueryClient): void {
  const isOwnerData = (q: Query): boolean => OWNER_DATA.has(q.queryKey[0]);
  void queryClient.resetQueries({ predicate: isOwnerData });
  queryClient.removeQueries({ queryKey: queryKeys.savedSearchRuns });
  reloadLocal(queryClient, (q) => isAppAuth(q) || isAuth(q) || isOwnerData(q));
}

/**
 * This browser was just unlocked (APP_PASSWORD): what loaded while it was locked failed, and the
 * browser may already be logged in to Facebook. Unlocking keeps the browser's session and binding,
 * so what loaded before the lock is still its owner's: everything local (the Facebook status too)
 * loads again, without replaying Facebook searches.
 */
export function onUnlocked(queryClient: QueryClient): void {
  reloadLocal(queryClient, isAppAuth);
}

/**
 * React to an AuthStatus the client just learned, compared with the cached one (so call it before
 * storing the new one): another account, or none, changes the data owner; a new state for the same
 * account only changes the session.
 */
export function reactToAuthStatus(queryClient: QueryClient, status: AuthStatus): void {
  const before = queryClient.getQueryData<AuthStatus>(queryKeys.auth);
  // The first status (e.g. during SSR) has nothing to compare with.
  if (before === undefined) return;
  if (accountOf(before) !== accountOf(status)) onDataOwnerChanged(queryClient);
  else if (before.state !== status.state) onSessionChanged(queryClient);
}

/**
 * Store the AuthStatus a login, logout or connection check returned, reacting to what changed.
 * `startedFrom` is the cached status when that call started. If it changed meanwhile (another
 * call or a status fetch finished first), this result may be older than the cached one (e.g. a
 * slow "Check connection" that returns after "Log out on this device"), so the status is fetched
 * again instead. Status fetches still in flight are cancelled so they can't land on top of it.
 */
export function storeAuthStatus(queryClient: QueryClient, status: AuthStatus, startedFrom: AuthStatus | undefined): void {
  if (queryClient.getQueryData<AuthStatus>(queryKeys.auth) !== startedFrom) {
    void queryClient.invalidateQueries({ queryKey: queryKeys.auth });
    return;
  }
  void queryClient.cancelQueries({ queryKey: queryKeys.auth });
  reactToAuthStatus(queryClient, status);
  queryClient.setQueryData(queryKeys.auth, status);
}
