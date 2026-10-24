// What the client cache does when this browser logs in to or out of Facebook, or is unlocked
// (src/lib/account-change.ts): local data refetches as its new owner, Facebook results don't replay.
// Also the notifier's rule for a new owner (src/lib/saved-search-increases.ts).
import { QueryClient, QueryObserver, type QueryKey } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountOf, onUnlocked, reactToAuthStatus, storeAuthStatus } from '@/lib/account-change';
import { queryKeys } from '@/lib/query-keys';
import { savedSearchIncreases } from '@/lib/saved-search-increases';
import type { AuthStatus, SavedSearch } from '@/shared/domain';

const LOGGED_OUT: AuthStatus = { state: 'logged_out', userId: null, userName: null, message: null };
const WINDOW_OPEN: AuthStatus = { ...LOGGED_OUT, state: 'window_open' };
const loggedIn = (userId: string): AuthStatus => ({ state: 'logged_in', userId, userName: 'Sam', message: null });

const clients: QueryClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  clients.push(queryClient);
  const calls = new Map<string, number>();
  const fetcher = (key: QueryKey) => () => {
    const name = JSON.stringify(key);
    calls.set(name, (calls.get(name) ?? 0) + 1);
    return Promise.resolve(name);
  };
  const callsOf = (key: QueryKey): number => calls.get(JSON.stringify(key)) ?? 0;
  /** Cached data, as if a route loader or an earlier visit had fetched it. */
  const cached = (key: QueryKey, data: unknown) => {
    queryClient.setQueryData(key, data);
  };
  /** A query on screen: an observer with the real fetcher (no fetch on mount: the data is fresh or failed). */
  const onScreen = (key: QueryKey) => {
    const observer = new QueryObserver(queryClient, { queryKey: key, queryFn: fetcher(key), retryOnMount: false });
    return observer.subscribe(() => undefined);
  };
  /** A query whose last fetch failed (e.g. APP_LOCKED while locked) and has no data. */
  const failed = async (key: QueryKey) => {
    await queryClient.query({ queryKey: key, queryFn: () => Promise.reject(new Error('locked')) }).catch(() => undefined);
  };
  const state = (key: QueryKey) => queryClient.getQueryState(key);
  return { queryClient, callsOf, cached, onScreen, failed, state };
}

describe('accountOf', () => {
  it('names the account a status is logged in with, or null while not logged in', () => {
    expect(accountOf(loggedIn('100'))).toBe('100');
    expect(accountOf(LOGGED_OUT)).toBeNull();
    expect(accountOf(WINDOW_OPEN)).toBeNull();
    // A problem with the account's Facebook session: its data still belongs to the account.
    expect(accountOf({ state: 'error', userId: '100', userName: null, message: 'Check Facebook' })).toBe('100');
    // Still bound to the account after its Facebook session ended (until "Log out on this device").
    expect(accountOf({ state: 'logged_out', userId: '100', userName: null, message: 'Your Facebook session has ended.' })).toBe('100');
    expect(accountOf({ state: 'logged_in', userId: null, userName: null, message: null })).not.toBeNull();
  });
});

describe('reactToAuthStatus', () => {
  it('does nothing for the first status (nothing to compare with, e.g. during SSR)', () => {
    const { queryClient, cached, state } = setup();
    cached(queryKeys.favorites, []);
    reactToAuthStatus(queryClient, loggedIn('100'));
    expect(state(queryKeys.favorites)?.isInvalidated).toBe(false);
  });

  it('a new state for the same owner only marks listing details stale', () => {
    const { queryClient, cached, state, onScreen, callsOf } = setup();
    cached(queryKeys.auth, LOGGED_OUT);
    cached(queryKeys.favorites, []);
    cached(queryKeys.listing('1'), { id: '1' });
    onScreen(queryKeys.listing('1'));
    reactToAuthStatus(queryClient, WINDOW_OPEN);
    expect(state(queryKeys.listing('1'))?.isInvalidated).toBe(true);
    expect(callsOf(queryKeys.listing('1'))).toBe(0);
    expect(state(queryKeys.favorites)?.isInvalidated).toBe(false);
  });

  it('a Facebook login reloads local data as the account, without replaying Facebook work', async () => {
    const { queryClient, cached, state, onScreen, failed, callsOf } = setup();
    cached(queryKeys.appAuth, { required: true, authenticated: true });
    cached(queryKeys.auth, WINDOW_OPEN);
    cached(queryKeys.favorites, ['before']);
    cached(queryKeys.settings, { before: true });
    cached(queryKeys.categories, []);
    cached(queryKeys.remoteView, { open: true });
    cached(queryKeys.search({ query: 'desk' }), { pages: [], pageParams: [] });
    cached(queryKeys.listing('1'), { id: '1' });
    cached(queryKeys.savedSearchRun(5), { newListings: [] });
    await failed(queryKeys.hidden);
    for (const key of [queryKeys.favorites, queryKeys.remoteView, queryKeys.search({ query: 'desk' }), queryKeys.listing('1'), queryKeys.hidden]) {
      onScreen(key);
    }

    storeAuthStatus(queryClient, loggedIn('100'), queryClient.getQueryData(queryKeys.auth));

    expect(queryClient.getQueryData(queryKeys.auth)).toEqual(loggedIn('100'));
    // The owner's lists are gone at once (route loaders would show them as they are), on screen or not.
    expect(state(queryKeys.favorites)?.data).toBeUndefined();
    expect(state(queryKeys.settings)?.status).toBe('pending');
    // Saved-search runs are dropped: they run again only when shown.
    expect(state(queryKeys.savedSearchRun(5))).toBeUndefined();
    // On screen: refetched now. Off screen: refetched when next shown.
    await vi.waitFor(() => {
      expect(callsOf(queryKeys.favorites)).toBe(1);
      expect(callsOf(queryKeys.remoteView)).toBe(1);
      expect(callsOf(queryKeys.hidden)).toBe(1);
    });
    expect(state(queryKeys.categories)?.isInvalidated).toBe(true);
    // Facebook results: search pages stay; listing details refetch when next shown.
    expect(state(queryKeys.search({ query: 'desk' }))?.isInvalidated).toBe(false);
    expect(callsOf(queryKeys.search({ query: 'desk' }))).toBe(0);
    expect(state(queryKeys.listing('1'))?.isInvalidated).toBe(true);
    expect(callsOf(queryKeys.listing('1'))).toBe(0);
    // The app lock belongs to the browser, and the Facebook status was just stored.
    expect(state(queryKeys.appAuth)?.isInvalidated).toBe(false);
    expect(state(queryKeys.auth)?.isInvalidated).toBe(false);
  });

  it('a logout, or another account, changes the owner too', () => {
    const { queryClient, cached, state } = setup();
    cached(queryKeys.auth, loggedIn('100'));
    cached(queryKeys.blockedSellers, ['theirs']);
    storeAuthStatus(queryClient, LOGGED_OUT, queryClient.getQueryData(queryKeys.auth));
    expect(state(queryKeys.blockedSellers)?.data).toBeUndefined();

    cached(queryKeys.auth, loggedIn('100'));
    cached(queryKeys.blockedSellers, ['theirs']);
    storeAuthStatus(queryClient, loggedIn('200'), queryClient.getQueryData(queryKeys.auth));
    expect(state(queryKeys.blockedSellers)?.data).toBeUndefined();
  });

  it('the account\'s Facebook session ending keeps the owner (the browser is still bound)', () => {
    const { queryClient, cached, state } = setup();
    cached(queryKeys.auth, loggedIn('100'));
    cached(queryKeys.favorites, ['ours']);
    cached(queryKeys.listing('1'), { id: '1' });
    reactToAuthStatus(queryClient, { state: 'logged_out', userId: '100', userName: null, message: 'Your Facebook session has ended.' });
    expect(state(queryKeys.favorites)?.data).toEqual(['ours']);
    expect(state(queryKeys.favorites)?.isInvalidated).toBe(false);
    expect(state(queryKeys.listing('1'))?.isInvalidated).toBe(true);
  });
});

describe('storeAuthStatus', () => {
  it('does not store a result that returns after a newer one (a slow check after a logout)', async () => {
    const { queryClient, cached, onScreen, callsOf } = setup();
    cached(queryKeys.auth, loggedIn('100'));
    onScreen(queryKeys.auth);
    const checkStartedFrom = queryClient.getQueryData<AuthStatus>(queryKeys.auth);
    // "Log out on this device" returns first...
    storeAuthStatus(queryClient, LOGGED_OUT, queryClient.getQueryData(queryKeys.auth));
    // ...then "Check connection", which the server answered while the browser was still bound.
    storeAuthStatus(queryClient, loggedIn('100'), checkStartedFrom);

    expect(queryClient.getQueryData(queryKeys.auth)).toEqual(LOGGED_OUT);
    // The status is fetched again instead.
    await vi.waitFor(() => {
      expect(callsOf(queryKeys.auth)).toBe(1);
    });
  });

  it('a status fetch already in flight does not land on top of it', async () => {
    const { queryClient, cached } = setup();
    cached(queryKeys.auth, loggedIn('100'));
    let answer: (status: AuthStatus) => void = () => undefined;
    const fetching = queryClient
      .query({ queryKey: queryKeys.auth, queryFn: () => new Promise<AuthStatus>((resolve) => (answer = resolve)), staleTime: 0 })
      .catch(() => undefined);

    storeAuthStatus(queryClient, LOGGED_OUT, queryClient.getQueryData(queryKeys.auth));
    answer(loggedIn('100'));
    await fetching;

    expect(queryClient.getQueryData(queryKeys.auth)).toEqual(LOGGED_OUT);
  });
});

describe('onUnlocked', () => {
  it('starts failed queries over (so they load when shown) and refetches the Facebook status', async () => {
    const { queryClient, cached, state, onScreen, failed, callsOf } = setup();
    cached(queryKeys.appAuth, { required: true, authenticated: true });
    cached(queryKeys.favorites, ['ours']);
    await failed(queryKeys.auth);
    await failed(queryKeys.savedSearches);
    await failed(queryKeys.search({ query: 'desk' }));
    onScreen(queryKeys.auth);

    onUnlocked(queryClient);

    await vi.waitFor(() => {
      expect(callsOf(queryKeys.auth)).toBe(1);
    });
    // Off screen: back to "never loaded", so the next observer loads it (retryOnMount: false
    // would otherwise keep showing the old failure).
    expect(state(queryKeys.savedSearches)?.status).toBe('pending');
    expect(state(queryKeys.search({ query: 'desk' }))?.status).toBe('pending');
    // Same session, same owner: what loaded before the lock stays until it refetches.
    expect(state(queryKeys.favorites)?.data).toEqual(['ours']);
    expect(state(queryKeys.favorites)?.isInvalidated).toBe(true);
    expect(state(queryKeys.appAuth)?.isInvalidated).toBe(false);
  });
});

describe('savedSearchIncreases (desktop notifications)', () => {
  const saved = (id: number, newCount: number): SavedSearch => ({
    id,
    name: `search ${String(id)}`,
    params: {},
    createdAt: 0,
    autoCheck: true,
    lastCheckedAt: null,
    lastViewedAt: null,
    newCount,
  });
  const ids = (list: readonly SavedSearch[]) => list.map((s) => s.id);

  it('the first check only records; later ones report increases, new searches included', () => {
    const first = savedSearchIncreases(null, null, [saved(1, 2)]);
    expect(first.increased).toEqual([]);
    // Search 2 was created here between checks and has already found something.
    const second = savedSearchIncreases(first.seen, null, [saved(1, 3), saved(2, 4)]);
    expect(ids(second.increased)).toEqual([1, 2]);
    expect(savedSearchIncreases(second.seen, null, [saved(1, 3), saved(2, 0)]).increased).toEqual([]);
  });

  it('the first check after a login or logout only records (the list is another owner\'s)', () => {
    const before = savedSearchIncreases(null, null, [saved(1, 0)]).seen;
    // After logging in, the account's searches from other devices show up with what they found.
    const afterLogin = savedSearchIncreases(before, '100', [saved(1, 0), saved(7, 12)]);
    expect(afterLogin.increased).toEqual([]);
    expect(ids(savedSearchIncreases(afterLogin.seen, '100', [saved(1, 1), saved(7, 12)]).increased)).toEqual([1]);
    expect(savedSearchIncreases(afterLogin.seen, null, [saved(3, 5)]).increased).toEqual([]);
  });
});
